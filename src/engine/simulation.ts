import type {
  Packet,
  SimulationStats,
  RoutingMode,
  Protocol,
  Segment,
  TcpCongestionState,
  TcpCongestionInfo,
} from '../types/network'
import { NetworkGraph } from './network'
import { computePathLatency } from './routing'
import { createPacket, resetPacketCounter, stepPacket, type ForwardingContext } from './packet'
import { LinkScheduler } from './queues'
import { TcpEndpoint } from './tcp/endpoint'
import { flagsToLabel, type TcpCtx, type OutSegment } from './tcp/tcb'
import { PORT_HTTP, PORT_HTTPS } from './tcp/tcp-const'
import { MAX_ACTIVE_PACKETS, PACKET_LINGER_MS, LATENCY_WINDOW } from '../config/constants'

// --- Flow model ------------------------------------------------------------
// A "flow" is one logical transmission (a TCP connection, a UDP exchange, or an
// ICMP ping). It owns an ordered list of steps; each step emits one packet. TCP
// and ICMP steps are stop-and-wait (the next step waits for the previous packet
// to arrive), so the handshake plays out in order; UDP datagrams just stream.

interface FlowStep {
  segment: Segment
  dir: 'fwd' | 'ret'
  wait: boolean
  // 'dns' steps ride the short city → resolver path as UDP port 53, regardless
  // of the flow's own protocol. A 'transfer' step is a placeholder for TCP's
  // whole data phase: instead of one packet, it runs the congestion-window
  // machinery until every segment is acked, then the flow moves on to FIN.
  phase?: 'dns' | 'transfer'
}

// Per-flow TCP congestion control (the sender's view of the data transfer).
interface TcpTransfer {
  cwnd: number // congestion window in segments; fractional during additive increase
  ssthresh: number // slow-start threshold
  state: TcpCongestionState
  totalSegments: number // how many DATA segments this connection sends
  nextSeq: number // next unsent sequence number
  ackedCount: number
  // Sent-but-unacked segments: seq → send bookkeeping for timeout/retransmit.
  inFlight: Map<number, { sentAt: number; retx: number }>
  lastDataSent: number
  lastLossResponse: number // so one loss burst halves the window once, not per segment
  lossEvents: number
}

interface Flow {
  id: string
  protocol: Protocol
  srcId: string
  dstId: string
  fwdPath: string[]
  revPath: string[]
  // Path to the city's DNS resolver (its uplink hub), when this flow had to
  // resolve the server's name first; null on a resolver-cache hit.
  dnsPath: string[] | null
  dnsRevPath: string[] | null
  srcPort: number
  dstPort: number
  steps: FlowStep[]
  stepIndex: number
  awaiting: boolean
  awaitingPacketId: string | null
  awaitingStep: FlowStep | null
  awaitingSince: number
  retxCount: number
  rttRecorded: boolean
  lastEmit: number
  lossProb: number // per-packet loss probability for this flow's path
  dnsLossProb: number // same, for the short DNS path
  tcp: TcpTransfer | null // congestion-control state (TCP flows only)
  done: boolean
}

const FLOW_SPAWN_RATE = 1.3 // new flows per real second
const MAX_FLOWS = 26
const TCP_TIMEOUT_MS = 1100 // retransmit timeout for an un-acked TCP segment
const UDP_STAGGER_MS = 110 // gap between UDP datagrams
const MAX_RETX = 4
// --- TCP congestion control ---
const TCP_INITIAL_CWND = 1 // segments — every connection starts probing from 1
const TCP_INITIAL_SSTHRESH = 8 // segments — where slow start hands over to additive increase
const TCP_DATA_STAGGER_MS = 90 // spacing within a window burst (so trains are visible)
// DDoS drops are not faked with a loss multiplier: the flood's packets
// genuinely overflow the victim's router queues (see queues.ts), and those
// tail drops are what TCP senders back off from.
const DDOS_SPAWN_MULTIPLIER = 6
// How long a resolved name stays in a city's DNS cache — flows from that city
// to the same server within the TTL skip the lookup.
const DNS_TTL_MS = 45_000
// How often engine state is pushed to React (HUD, inspector). Rendering reads
// live engine state every frame regardless — pushing at 60 Hz only forced the
// whole React tree through reconciliation per frame for no visual gain.
const STATS_PUSH_INTERVAL_MS = 125

// Realistic per-link packet-loss probability, driven by link quality: fiber
// backbone and subsea cables are near-lossless; access / last-mile links lose a
// little more. Crossing a whole path, these compound to a fraction of a percent.
function linkLossRate(bandwidth: number): number {
  if (bandwidth >= 400) return 0.0003 // backbone / subsea / data-center fiber (~0.03%)
  if (bandwidth >= 200) return 0.0008 // regional backbone (~0.08%)
  return 0.003 // last-mile / access links (~0.3%)
}

let _flowCounter = 0

function pickProtocol(ddos: boolean): Protocol {
  if (ddos) return 'TCP' // DDoS = SYN flood
  const r = Math.random()
  if (r < 0.6) return 'TCP'
  if (r < 0.9) return 'UDP'
  return 'ICMP'
}

function destPort(protocol: Protocol): number {
  if (protocol === 'TCP') return Math.random() < 0.5 ? 443 : 80
  if (protocol === 'UDP') return Math.random() < 0.5 ? 53 : 443
  return 0
}

function buildSteps(protocol: Protocol): FlowStep[] {
  if (protocol === 'TCP') {
    // Handshake, then the whole windowed data phase (driven by the congestion
    // window, not by steps), then teardown.
    return [
      { segment: 'SYN', dir: 'fwd', wait: true },
      { segment: 'SYN-ACK', dir: 'ret', wait: true },
      { segment: 'ACK', dir: 'fwd', wait: true },
      { segment: 'DATA', dir: 'fwd', wait: false, phase: 'transfer' },
      { segment: 'FIN', dir: 'fwd', wait: true },
      { segment: 'FIN-ACK', dir: 'ret', wait: true },
    ]
  }
  if (protocol === 'UDP') {
    const n = 3 + Math.floor(Math.random() * 6)
    return Array.from({ length: n }, () => ({ segment: 'DATAGRAM' as Segment, dir: 'fwd' as const, wait: false }))
  }
  // ICMP echo / reply, a few rounds
  const rounds = 1 + Math.floor(Math.random() * 3)
  const steps: FlowStep[] = []
  for (let i = 0; i < rounds; i++) {
    steps.push({ segment: 'ECHO', dir: 'fwd', wait: true })
    steps.push({ segment: 'REPLY', dir: 'ret', wait: true })
  }
  return steps
}

// Arguments for _injectSegment — the shared "put one segment on the wire" call.
// The TCP header fields are optional so legacy flow-model traffic omits them.
interface InjectArgs {
  protocol: Protocol
  segment: Segment
  sourceId: string
  destinationId: string
  srcPort: number
  dstPort: number
  simulationTimeMs: number
  lossProb: number
  flowId?: string
  expectedHops?: number // omit to trace it live via the forwarding tables
  lossAt?: number | null
  seq?: number
  ackNo?: number
  tcpFlags?: number
  window?: number
  payloadLen?: number
  checksum?: number
}

export class SimulationEngine {
  graph: NetworkGraph
  packets: Packet[]

  private _flows: Flow[]
  private _scheduler: LinkScheduler
  // Per-host TCP endpoints (home + server nodes).
  private _endpoints: Map<string, TcpEndpoint>
  private _tcpTestLoss: number | null = null
  private _isPaused: boolean
  private _routingMode: RoutingMode
  private _isDDoS: boolean
  // The flood's victim: while DDoS is on, every new flow targets this server,
  // so its uplink queues genuinely saturate and overflow.
  private _ddosTargetId: string | null

  private _nowMs: number
  private _lastStatsPush: number
  private _completed: number
  private _dropped: number
  private _queueDrops: number
  private _retransmits: number
  private _dnsLookups: number
  private _recentRtts: number[]
  private _spawnAccumulator: number
  private _lingerTimers: Map<string, number>
  // Per-city resolver cache: "srcId>dstId" → sim time (ms) the entry expires.
  private _dnsCache: Map<string, number>
  // Alive-packet index so flow bookkeeping doesn't scan the whole packet array
  // per flow per tick: flowId → alive count, and flowId → seq → alive count.
  private _aliveByFlow: Map<string, number>
  private _aliveSeqs: Map<string, Map<number, number>>

  onStateChange?: (stats: SimulationStats, packets: Packet[]) => void

  constructor() {
    this.graph = new NetworkGraph()
    this.packets = []
    this._flows = []
    this._scheduler = new LinkScheduler(this.graph.links)
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    this._ddosTargetId = null
    this._nowMs = 0
    this._lastStatsPush = -Infinity
    this._completed = 0
    this._dropped = 0
    this._queueDrops = 0
    this._retransmits = 0
    this._dnsLookups = 0
    this._recentRtts = []
    this._spawnAccumulator = 0
    this._lingerTimers = new Map()
    this._dnsCache = new Map()
    this._aliveByFlow = new Map()
    this._aliveSeqs = new Map()
    this._endpoints = this._buildEndpoints()
  }

  // Give every host node (traffic source or server) a TCP endpoint. Servers
  // listen on the well-known web ports. Inert until Milestone 2.
  private _buildEndpoints(): Map<string, TcpEndpoint> {
    const eps = new Map<string, TcpEndpoint>()
    for (const id of this.graph.getHomeIds()) eps.set(id, new TcpEndpoint(id))
    for (const id of this.graph.getServerIds()) {
      const ep = new TcpEndpoint(id)
      ep.listen(PORT_HTTP)
      ep.listen(PORT_HTTPS)
      eps.set(id, ep)
    }
    return eps
  }

  /** The TCP endpoint hosted on a node, if it is a host (home/server). */
  getTcpEndpoint(nodeId: string): TcpEndpoint | undefined {
    return this._endpoints.get(nodeId)
  }

  private _aliveInc(p: Packet): void {
    this._aliveByFlow.set(p.flowId, (this._aliveByFlow.get(p.flowId) ?? 0) + 1)
    if (p.seq === undefined) return
    let seqs = this._aliveSeqs.get(p.flowId)
    if (!seqs) {
      seqs = new Map()
      this._aliveSeqs.set(p.flowId, seqs)
    }
    seqs.set(p.seq, (seqs.get(p.seq) ?? 0) + 1)
  }

  private _aliveDec(p: Packet): void {
    const count = this._aliveByFlow.get(p.flowId)
    if (count !== undefined) {
      if (count <= 1) this._aliveByFlow.delete(p.flowId)
      else this._aliveByFlow.set(p.flowId, count - 1)
    }
    if (p.seq === undefined) return
    const seqs = this._aliveSeqs.get(p.flowId)
    const seqCount = seqs?.get(p.seq)
    if (seqs && seqCount !== undefined) {
      if (seqCount <= 1) seqs.delete(p.seq)
      else seqs.set(p.seq, seqCount - 1)
      if (seqs.size === 0) this._aliveSeqs.delete(p.flowId)
    }
  }

  tick(deltaSeconds: number, realTimeMs: number): void {
    if (this._isPaused) return
    this._nowMs = realTimeMs

    // Deliver due BGP updates first — forwarding tables may change under the
    // packets already in flight (that's the convergence realism).
    this.graph.tick(realTimeMs)

    this._spawnFlows(deltaSeconds, realTimeMs)
    this._processFlows(realTimeMs)
    this._tickEndpoints(realTimeMs)
    this._drainQueues(realTimeMs)
    this._stepPackets(deltaSeconds, realTimeMs)
    this._pruneLingeredPackets(realTimeMs)
    this._pruneFlows()

    // Throttled: user actions (pause, reset, toggles) still push immediately.
    if (realTimeMs - this._lastStatsPush >= STATS_PUSH_INTERVAL_MS) {
      this._lastStatsPush = realTimeMs
      this.onStateChange?.(this._buildStats(), this.packets)
    }
  }

  // A packet parked in a router queue is still "alive" for flow bookkeeping.
  private _isAlive(p: Packet): boolean {
    return p.status === 'in-flight' || p.status === 'queued'
  }

  private _hasInflight(flowId: string): boolean {
    return (this._aliveByFlow.get(flowId) ?? 0) > 0
  }

  private _spawnFlows(deltaSeconds: number, now: number): void {
    // A flood brings far more concurrent connections than normal traffic.
    const maxFlows = this._isDDoS ? MAX_FLOWS * 2 : MAX_FLOWS
    const maxAlive = this._isDDoS ? MAX_ACTIVE_PACKETS * 2 : MAX_ACTIVE_PACKETS
    const active = this._flows.filter(f => !f.done).length
    if (active >= maxFlows) return
    if (this.packets.filter(p => this._isAlive(p)).length >= maxAlive) return

    const rate = this._isDDoS ? FLOW_SPAWN_RATE * DDOS_SPAWN_MULTIPLIER : FLOW_SPAWN_RATE
    this._spawnAccumulator += rate * deltaSeconds
    while (this._spawnAccumulator >= 1) {
      this._spawnAccumulator -= 1
      this._createFlow(now)
    }
  }

  // A city's uplink hub doubles as its ISP's recursive DNS resolver, so a
  // lookup is one short hop up the access link and back.
  private _resolverPath(cityId: string): string[] | null {
    const link = this.graph
      .getActiveLinks()
      .find(l => l.sourceId === cityId || l.targetId === cityId)
    if (!link) return null
    return [cityId, link.sourceId === cityId ? link.targetId : link.sourceId]
  }

  private _createFlow(now: number): void {
    const homes = this.graph.getHomeIds()
    const servers = this.graph.getServerIds()
    if (homes.length === 0 || servers.length === 0) return

    const srcId = homes[Math.floor(Math.random() * homes.length)]
    // A DDoS flood converges on one victim server; normal traffic spreads out.
    const dstId =
      this._isDDoS && this._ddosTargetId
        ? this._ddosTargetId
        : servers[Math.floor(Math.random() * servers.length)]
    // Planned route, traced through the routers' forwarding tables. The flow
    // keeps it only for estimates (loss probability, RTT); packets themselves
    // are forwarded hop by hop and never carry it.
    const fwdPath = this.graph.getRoute(srcId, dstId)

    // No route (e.g. firewall up) → the connection attempt fails immediately.
    if (!fwdPath) {
      this._dropped++
      return
    }

    const protocol = pickProtocol(this._isDDoS)
    const dstPort = destPort(protocol)

    // DNS resolution: before the city can open the flow it must resolve the
    // server's name at its local resolver, unless the answer is still cached.
    // Flows already destined to port 53 ARE DNS traffic and skip this.
    const cached = (this._dnsCache.get(`${srcId}>${dstId}`) ?? 0) > now
    const dnsPath = dstPort !== 53 && !cached ? this._resolverPath(srcId) : null
    const steps = buildSteps(protocol)
    if (dnsPath) {
      steps.unshift(
        { segment: 'DNS-QUERY', dir: 'fwd', wait: true, phase: 'dns' },
        { segment: 'DNS-RESPONSE', dir: 'ret', wait: true, phase: 'dns' },
      )
      this._dnsLookups++
    }

    _flowCounter++
    this._flows.push({
      id: `flow-${_flowCounter}`,
      protocol,
      srcId,
      dstId,
      fwdPath,
      revPath: [...fwdPath].reverse(),
      dnsPath,
      dnsRevPath: dnsPath ? [...dnsPath].reverse() : null,
      srcPort: 49152 + Math.floor(Math.random() * 16000),
      dstPort,
      steps,
      stepIndex: 0,
      awaiting: false,
      awaitingPacketId: null,
      awaitingStep: null,
      awaitingSince: 0,
      retxCount: 0,
      rttRecorded: false,
      lastEmit: 0,
      lossProb: this._pathLossProb(fwdPath),
      dnsLossProb: dnsPath ? this._pathLossProb(dnsPath) : 0,
      tcp:
        protocol === 'TCP'
          ? {
              cwnd: TCP_INITIAL_CWND,
              ssthresh: TCP_INITIAL_SSTHRESH,
              state: 'slow-start',
              totalSegments: 10 + Math.floor(Math.random() * 7), // 10–16
              nextSeq: 0,
              ackedCount: 0,
              inFlight: new Map(),
              lastDataSent: 0,
              lastLossResponse: 0,
              lossEvents: 0,
            }
          : null,
      done: false,
    })
  }

  // Compound per-link loss along a path into a single per-packet probability.
  private _pathLossProb(path: string[]): number {
    let survive = 1
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]
      const b = path[i + 1]
      const link = this.graph.links.find(
        l => (l.sourceId === a && l.targetId === b) || (l.sourceId === b && l.targetId === a),
      )
      if (link) survive *= 1 - linkLossRate(link.bandwidth)
    }
    return 1 - survive
  }

  // --- Per-endpoint TCP wiring (Milestone 2) --------------------------------

  // Open a real TCP connection from a host node to a server:port, with an app
  // that will send `bytes` bytes and then close. Returns false if the source is
  // not a host endpoint. (Drives one connection for now; the live spawner is
  // cut over to endpoints in a later milestone.)
  appConnect(srcId: string, dstId: string, port: number, bytes: number): boolean {
    const ep = this._endpoints.get(srcId)
    if (!ep) return false
    ep.connect(dstId, port, bytes)
    return true
  }

  // Run every endpoint's timers + sender for this tick.
  private _tickEndpoints(now: number): void {
    const ctx = this._tcpCtx(now)
    for (const ep of this._endpoints.values()) ep.tick(ctx)
  }

  // The seam the endpoints use to reach the network (routing + segment inject).
  private _tcpCtx(now: number): TcpCtx {
    return {
      now,
      nextHop: (from, to) => this.graph.getNextHop(from, to),
      route: (from, to) => this.graph.getRoute(from, to),
      links: this.graph.links,
      inject: seg => this._injectTcpSegment(seg, now),
    }
  }

  // Test hook: force a fixed per-segment loss probability for endpoint TCP
  // (null = use the realistic per-path model). Lets tests exercise retransmission
  // deterministically. Not used by the live simulation.
  setTcpTestLoss(prob: number | null): void {
    this._tcpTestLoss = prob
  }

  // Turn one endpoint OutSegment into a Packet on the wire, rolling per-path loss
  // so real segments can drop (and be retransmitted) like legacy traffic.
  private _injectTcpSegment(seg: OutSegment, now: number): void {
    const route = this.graph.getRoute(seg.srcNode, seg.dstNode)
    const lossProb = this._tcpTestLoss ?? (route ? this._pathLossProb(route) : 0)
    const lossAt = Math.random() < lossProb ? 0.3 + Math.random() * 0.5 : null
    const hasData = seg.payloadLen > 0
    this._injectSegment({
      protocol: 'TCP',
      segment: flagsToLabel(seg.flags, hasData, false),
      sourceId: seg.srcNode,
      destinationId: seg.dstNode,
      srcPort: seg.srcPort,
      dstPort: seg.dstPort,
      simulationTimeMs: now,
      lossProb,
      lossAt,
      flowId: `tcp:${seg.srcNode}:${seg.srcPort}>${seg.dstNode}:${seg.dstPort}`,
      seq: seg.seq,
      ackNo: seg.ackNo,
      tcpFlags: seg.flags,
      window: seg.window,
      payloadLen: seg.payloadLen,
    })
  }

  // Inject one segment into the simulated network: pick the source's first hop,
  // build the Packet, and hand it to the local uplink's output queue. Shared by
  // the legacy flow model (via _emit) and the per-endpoint TCP stack. Returns
  // the Packet, or null if the source has no route (a send failure → a drop).
  private _injectSegment(a: InjectArgs): Packet | null {
    // The sending host makes only the first routing decision; every later hop is
    // chosen by the router the packet lands on. No route (e.g. firewall raised
    // mid-flow) → the send fails outright and the sender's timer retries.
    const firstHopId = this.graph.getNextHop(a.sourceId, a.destinationId)
    if (firstHopId === null) {
      this._dropped++
      return null
    }
    let expectedHops = a.expectedHops
    if (expectedHops === undefined) {
      const route = this.graph.getRoute(a.sourceId, a.destinationId)
      expectedHops = route ? route.length - 1 : 1
    }

    const packet = createPacket({
      flowId: a.flowId ?? '',
      protocol: a.protocol,
      segment: a.segment,
      sourceId: a.sourceId,
      destinationId: a.destinationId,
      srcPort: a.srcPort,
      dstPort: a.dstPort,
      firstHopId,
      expectedHops,
      links: this.graph.links,
      simulationTimeMs: a.simulationTimeMs,
      lossProb: a.lossProb,
      lossAt: a.lossAt,
      seq: a.seq,
      ackNo: a.ackNo,
      tcpFlags: a.tcpFlags,
      window: a.window,
      payloadLen: a.payloadLen,
      checksum: a.checksum,
    })
    this.packets.push(packet)

    // The sending host contends for its own uplink like everyone else: the
    // packet may go straight out, sit in the local queue, or be tail-dropped.
    const slot = this._scheduler.send(packet, a.sourceId, firstHopId, a.simulationTimeMs)
    if (slot === 'queued') {
      packet.status = 'queued'
    } else if (slot === 'dropped') {
      packet.status = 'dropped'
      this._dropped++
      this._queueDrops++
      this._lingerTimers.set(packet.id, a.simulationTimeMs + 200)
    }
    if (this._isAlive(packet)) this._aliveInc(packet)
    return packet
  }

  private _emit(flow: Flow, step: FlowStep, now: number, retx: boolean, seq?: number): Packet | null {
    const dns = step.phase === 'dns'
    const path = dns
      ? (step.dir === 'fwd' ? flow.dnsPath! : flow.dnsRevPath!)
      : (step.dir === 'fwd' ? flow.fwdPath : flow.revPath)
    const baseLoss = dns ? flow.dnsLossProb : flow.lossProb
    const lossAt = Math.random() < baseLoss ? 0.3 + Math.random() * 0.5 : null

    const packet = this._injectSegment({
      flowId: flow.id,
      protocol: dns ? 'UDP' : flow.protocol, // DNS rides UDP whatever the flow is
      segment: retx ? 'RETX' : step.segment,
      sourceId: path[0],
      destinationId: path[path.length - 1],
      srcPort: flow.srcPort,
      dstPort: dns ? 53 : flow.dstPort,
      expectedHops: path.length - 1,
      simulationTimeMs: now,
      lossProb: baseLoss,
      lossAt,
      seq,
    })
    if (packet && step.wait) flow.awaitingPacketId = packet.id
    return packet
  }

  // One tick of TCP's congestion-controlled data phase for a flow: retransmit
  // timed-out segments (halving the window — multiplicative decrease), then
  // send new segments while the window has room.
  private _tickTransfer(flow: Flow, now: number): void {
    const tcp = flow.tcp!

    // Loss detection: an unacked segment past the timeout whose packets (the
    // DATA or its returning ACK) are no longer in flight was lost somewhere.
    for (const [seq, seg] of tcp.inFlight) {
      if (now - seg.sentAt <= TCP_TIMEOUT_MS) continue
      const stillFlying = (this._aliveSeqs.get(flow.id)?.get(seq) ?? 0) > 0
      if (stillFlying) continue

      if (seg.retx >= MAX_RETX) {
        flow.done = true // too many losses on one segment: connection reset
        return
      }

      // Congestion response — once per loss burst, not per lost segment:
      // ssthresh drops to half the window, and the window restarts there.
      if (now - tcp.lastLossResponse > TCP_TIMEOUT_MS) {
        tcp.ssthresh = Math.max(1, Math.floor(tcp.cwnd / 2))
        tcp.cwnd = tcp.ssthresh
        tcp.state = 'congestion-avoidance'
        tcp.lossEvents++
        tcp.lastLossResponse = now
      }

      this._retransmits++
      seg.retx++
      seg.sentAt = now
      this._emit(flow, { segment: 'DATA', dir: 'fwd', wait: false }, now, true, seq)
      break // at most one retransmission per tick
    }
    if (flow.done) return

    // Slow start / congestion avoidance both cap outstanding data at cwnd.
    // Normal senders stagger their sends so a window burst reads as a packet
    // train; a DDoS flood doesn't pace itself — full-window bursts are exactly
    // what overflows the victim's router queues.
    const stagger = this._isDDoS ? 0 : TCP_DATA_STAGGER_MS
    const window = Math.max(1, Math.floor(tcp.cwnd))
    if (
      tcp.nextSeq < tcp.totalSegments &&
      tcp.inFlight.size < window &&
      now - tcp.lastDataSent >= stagger
    ) {
      const seq = tcp.nextSeq
      tcp.nextSeq++
      tcp.lastDataSent = now
      tcp.inFlight.set(seq, { sentAt: now, retx: 0 })
      this._emit(flow, { segment: 'DATA', dir: 'fwd', wait: false }, now, false, seq)
    }
  }

  private _processFlows(now: number): void {
    for (const flow of this._flows) {
      if (flow.done) continue

      // Finished emitting all steps → done once nothing is still in flight.
      if (flow.stepIndex >= flow.steps.length) {
        if (!this._hasInflight(flow.id)) {
          flow.done = true
          this._completed++
        }
        continue
      }

      if (flow.awaiting) {
        // Awaited packet lost? Retransmit (TCP reliability) until we give up.
        if (now - flow.awaitingSince > TCP_TIMEOUT_MS && !this._hasInflight(flow.id) && flow.awaitingStep) {
          if (flow.retxCount < MAX_RETX) {
            flow.retxCount++
            this._retransmits++
            this._emit(flow, flow.awaitingStep, now, true)
            flow.awaitingSince = now
          } else {
            flow.done = true // connection reset / abandoned
          }
        }
        continue
      }

      const step = flow.steps[flow.stepIndex]

      // TCP data phase: run the congestion window instead of emitting one
      // packet, and only advance to teardown once every segment is acked.
      if (step.phase === 'transfer') {
        if (!flow.tcp) {
          flow.stepIndex++
          continue
        }
        this._tickTransfer(flow, now)
        if (flow.tcp.ackedCount >= flow.tcp.totalSegments) flow.stepIndex++
        continue
      }

      if (!step.wait && now - flow.lastEmit < UDP_STAGGER_MS) continue

      this._emit(flow, step, now, false)
      flow.lastEmit = now
      flow.stepIndex++
      if (step.wait) {
        flow.awaiting = true
        flow.awaitingStep = step
        flow.awaitingSince = now
      }
    }
  }

  // Put queued packets whose transmission slot arrived back in flight.
  private _drainQueues(realTimeMs: number): void {
    for (const packet of this._scheduler.drain(realTimeMs)) {
      if (packet.status === 'queued') packet.status = 'in-flight'
    }
  }

  private _stepPackets(deltaSeconds: number, realTimeMs: number): void {
    // Each router a packet reaches makes its own forwarding decision (its
    // forwarding table) and then contends for the output link's bandwidth
    // (its output queue).
    const ctx: ForwardingContext = {
      nextHop: (fromId, destId) => this.graph.getNextHop(fromId, destId),
      transmit: (packet, fromId, toId) => {
        const slot = this._scheduler.send(packet, fromId, toId, realTimeMs)
        if (slot === 'dropped') this._queueDrops++
        return slot
      },
    }
    const tcpCtx = this._tcpCtx(realTimeMs)
    // Fixed length: endpoints inject reply segments (ACKs, SYN-ACK, FIN) while we
    // iterate, and those newcomers should be stepped next tick, not this one.
    const list = this.packets
    const n = list.length
    for (let i = 0; i < n; i++) {
      const packet = list[i]
      if (packet.status !== 'in-flight') continue
      const result = stepPacket(packet, deltaSeconds, ctx, this.graph.links)
      if (result === 'delivered') {
        this._aliveDec(packet)
        if (packet.tcpFlags !== undefined) {
          // Real per-endpoint TCP: hand the segment to the destination host's stack.
          this._endpoints.get(packet.destinationId)?.deliver(packet, tcpCtx)
        } else {
          this._onDelivered(packet, realTimeMs)
        }
        this._lingerTimers.set(packet.id, realTimeMs + PACKET_LINGER_MS)
      } else if (result === 'dropped') {
        this._aliveDec(packet)
        this._dropped++
        this._lingerTimers.set(packet.id, realTimeMs + 200)
      }
    }
  }

  private _onDelivered(packet: Packet, now: number): void {
    const flow = this._flows.find(f => f.id === packet.flowId)
    if (!flow) return

    // TCP data transfer (packets carrying a sequence number):
    if (flow.tcp && packet.seq !== undefined) {
      if (packet.destinationId === flow.dstId) {
        // Receiver: every DATA (or retransmitted) segment that arrives is acked.
        this._emit(flow, { segment: 'DATA-ACK', dir: 'ret', wait: false }, now, false, packet.seq)
      } else if (packet.segment === 'DATA-ACK') {
        // Sender: a new ACK opens the congestion window. Duplicate ACKs from
        // spurious retransmissions are ignored (seq no longer outstanding).
        const tcp = flow.tcp
        if (tcp.inFlight.delete(packet.seq)) {
          tcp.ackedCount++
          if (tcp.state === 'slow-start') {
            tcp.cwnd += 1 // +1 per ACK ⇒ the window doubles every RTT
            if (tcp.cwnd >= tcp.ssthresh) tcp.state = 'congestion-avoidance'
          } else {
            tcp.cwnd += 1 / tcp.cwnd // additive increase: ~+1 per RTT
          }
        }
      }
    }

    // Record RTT when the first reply of the exchange comes back.
    if (!flow.rttRecorded && (packet.segment === 'SYN-ACK' || packet.segment === 'REPLY')) {
      const rtt =
        computePathLatency(flow.fwdPath, this.graph.links) +
        computePathLatency(flow.revPath, this.graph.links)
      this._recentRtts.push(rtt)
      if (this._recentRtts.length > LATENCY_WINDOW) this._recentRtts.shift()
      flow.rttRecorded = true
    }

    if (flow.awaiting && packet.id === flow.awaitingPacketId) {
      // The resolver's answer made it back to the city → cache it there.
      // (Checked via the awaited step so a retransmitted answer counts too.)
      if (flow.awaitingStep?.segment === 'DNS-RESPONSE') {
        this._dnsCache.set(`${flow.srcId}>${flow.dstId}`, now + DNS_TTL_MS)
      }
      flow.awaiting = false
      flow.awaitingPacketId = null
      flow.awaitingStep = null
      flow.retxCount = 0
    }
  }

  private _pruneLingeredPackets(realTimeMs: number): void {
    this.packets = this.packets.filter(p => {
      if (this._isAlive(p)) return true
      const removeAt = this._lingerTimers.get(p.id) ?? 0
      if (realTimeMs >= removeAt) {
        this._lingerTimers.delete(p.id)
        return false
      }
      return true
    })
  }

  private _pruneFlows(): void {
    if (this._flows.length < 60) return
    this._flows = this._flows.filter(f => !f.done || this._hasInflight(f.id))
  }

  private _buildStats(): SimulationStats {
    const protocolMix: Record<Protocol, number> = { TCP: 0, UDP: 0, ICMP: 0 }
    let active = 0
    let queued = 0
    for (const p of this.packets) {
      if (p.status === 'queued') queued++
      if (!this._isAlive(p)) continue
      active++
      protocolMix[p.protocol]++
    }
    const avg =
      this._recentRtts.length > 0
        ? this._recentRtts.reduce((a, b) => a + b, 0) / this._recentRtts.length
        : 0

    return {
      activePackets: active,
      connections: this._flows.filter(f => !f.done).length,
      completed: this._completed,
      droppedPackets: this._dropped,
      queuedPackets: queued,
      queueDrops: this._queueDrops,
      retransmits: this._retransmits,
      dnsLookups: this._dnsLookups,
      averageLatency: Math.round(avg),
      protocolMix,
      routingMode: this._routingMode,
      isPaused: this._isPaused,
      bgpConverging: this.graph.isBgpConverging(),
      cutCable: this.graph.getCutCableLabel(),
    }
  }

  // --- Controls ---

  togglePause(): void {
    this._isPaused = !this._isPaused
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleAdaptiveRouting(): void {
    this._routingMode = this._routingMode === 'adaptive' ? 'shortest-path' : 'adaptive'
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleDDoS(): void {
    this._isDDoS = !this._isDDoS
    const servers = this.graph.getServerIds()
    this._ddosTargetId =
      this._isDDoS && servers.length > 0
        ? servers[Math.floor(Math.random() * servers.length)]
        : null
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleFirewall(): void {
    this.graph.toggleFirewall()
  }

  // Cut a random submarine cable (or repair the one that's cut). Dropping the
  // last cable between two ASes kills the eBGP session: routes are withdrawn
  // and re-selected around the break, propagating with realistic delay.
  toggleCableCut(): void {
    this.graph.toggleCableCut(this._nowMs)
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  reset(): void {
    this.graph.reset()
    this.packets = []
    this._flows = []
    this._scheduler.rebuild(this.graph.links)
    this._completed = 0
    this._dropped = 0
    this._queueDrops = 0
    this._retransmits = 0
    this._dnsLookups = 0
    this._recentRtts = []
    this._spawnAccumulator = 0
    this._lingerTimers.clear()
    this._dnsCache.clear()
    this._aliveByFlow.clear()
    this._aliveSeqs.clear()
    this._endpoints = this._buildEndpoints()
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    this._ddosTargetId = null
    this._lastStatsPush = -Infinity
    resetPacketCounter()
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  // Live congestion-control snapshot for the packet inspector (null for
  // non-TCP flows or flows that have been pruned).
  getTcpInfo(flowId: string): TcpCongestionInfo | null {
    const tcp = this._flows.find(f => f.id === flowId)?.tcp
    if (!tcp) return null
    return {
      cwnd: tcp.cwnd,
      ssthresh: tcp.ssthresh,
      state: tcp.state,
      inFlightSegments: tcp.inFlight.size,
      ackedSegments: tcp.ackedCount,
      totalSegments: tcp.totalSegments,
      lossEvents: tcp.lossEvents,
    }
  }

  getPositionCache(): Map<string, [number, number, number]> {
    return this.graph.getPositionCache()
  }
}
