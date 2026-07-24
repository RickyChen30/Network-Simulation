import type {
  Packet,
  SimulationStats,
  RoutingMode,
  Protocol,
  Segment,
  TcpCongestionInfo,
} from '../types/network'
import { NetworkGraph } from './network'
import { computePathLatency } from './routing'
import { createPacket, resetPacketCounter, stepPacket, type ForwardingContext } from './packet'
import { LinkScheduler } from './queues'
import { TcpEndpoint } from './tcp/endpoint'
import type { WasmTcpStack } from './tcp/wasm-loader'
import { flagsToLabel, type TcpCtx, type OutSegment, type Tcb } from './tcp/tcb'
import { PORT_HTTP, PORT_HTTPS, MSS as TCP_MSS } from './tcp/tcp-const'
import { MAX_ACTIVE_PACKETS, PACKET_LINGER_MS, LATENCY_WINDOW } from '../config/constants'

// --- Flow model ------------------------------------------------------------
// A "flow" is one logical transmission (a TCP connection, a UDP exchange, or an
// ICMP ping). It owns an ordered list of steps; each step emits one packet. TCP
// and ICMP steps are stop-and-wait (the next step waits for the previous packet
// to arrive), so the handshake plays out in order; UDP datagrams just stream.

// Since Milestone 4, TCP runs on the real per-endpoint stack (engine/tcp/*).
// Flows now model only the connectionless protocols — UDP datagram exchanges,
// ICMP echo/reply pings, and standalone DNS lookups.
interface FlowStep {
  segment: Segment
  dir: 'fwd' | 'ret'
  wait: boolean
}

interface Flow {
  id: string
  protocol: Protocol
  srcId: string
  dstId: string
  fwdPath: string[]
  revPath: string[]
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
  internal: boolean // infrastructure traffic (DNS lookups) — not a user "connection"
  done: boolean
}

const FLOW_SPAWN_RATE = 1.6 // new traffic sessions per real second
const MAX_FLOWS = 26 // concurrent UDP/ICMP/DNS flows
const MAX_TCP_CONNS = 16 // concurrent real TCP connections
const FLOW_RETX_TIMEOUT_MS = 1100 // retransmit timeout for an un-acked flow packet
const UDP_STAGGER_MS = 110 // gap between UDP datagrams
const MAX_RETX = 4
// New TCP connections transfer a small web-request-sized object.
const TCP_XFER_MIN = 2_000
const TCP_XFER_SPAN = 18_000
// DDoS drops are not faked with a loss multiplier: the flood's connections
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

// Steps for the connectionless flow protocols (UDP datagrams / ICMP ping).
function buildSteps(protocol: 'UDP' | 'ICMP'): FlowStep[] {
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
  // When set, live TCP runs on the C core compiled to WASM instead of the TS
  // endpoints (the hybrid). Enabled by the browser once tcp_core.wasm loads;
  // tests keep the TS stack. See src/engine/tcp/wasm-loader.ts.
  private _wasmTcp: WasmTcpStack | null = null
  private _homeIds?: Set<string>
  private _tcpTestLoss: number | null = null
  private _autoTraffic = true // live spawner (tests disable it for isolation)
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

  // Switch live TCP over to the C core (WASM). The servers are re-registered as
  // listeners in the C stack; from here on the spawner opens real C connections,
  // and delivery / ticking / stats read from the C stack instead of the TS one.
  useWasmTcp(stack: WasmTcpStack): void {
    for (const id of this.graph.getServerIds()) {
      stack.listen(id, PORT_HTTP)
      stack.listen(id, PORT_HTTPS)
    }
    this._wasmTcp = stack
  }

  get tcpBackend(): 'ts' | 'wasm-c' {
    return this._wasmTcp ? 'wasm-c' : 'ts'
  }

  // The seam the WASM stack's host_emit calls to put a C-decided segment on the
  // simulated wire (fires during tick/deliver, when _nowMs is current).
  injectTcpSegment(seg: OutSegment): void {
    this._injectTcpSegment(seg, this._nowMs)
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
    if (!this._autoTraffic) return
    if (this.packets.filter(p => this._isAlive(p)).length >= this._maxAlive()) return

    const rate = this._isDDoS ? FLOW_SPAWN_RATE * DDOS_SPAWN_MULTIPLIER : FLOW_SPAWN_RATE
    this._spawnAccumulator += rate * deltaSeconds
    while (this._spawnAccumulator >= 1) {
      this._spawnAccumulator -= 1
      this._spawnTraffic(now)
    }
  }

  private _maxAlive(): number {
    return this._isDDoS ? MAX_ACTIVE_PACKETS * 2 : MAX_ACTIVE_PACKETS
  }

  // Total live TCP connections.
  private _activeConnCount(): number {
    if (this._wasmTcp) return this._wasmTcp.activeConns()
    let n = 0
    for (const ep of this._endpoints.values()) {
      for (const tcb of ep.conns.values()) if (!tcb.done) n++
    }
    return n
  }

  // Start one new traffic session: a real TCP connection, or a connectionless
  // UDP/ICMP flow. DDoS floods TCP connections at one victim (a SYN flood).
  private _spawnTraffic(now: number): void {
    const homes = this.graph.getHomeIds()
    const servers = this.graph.getServerIds()
    if (homes.length === 0 || servers.length === 0) return

    const srcId = homes[Math.floor(Math.random() * homes.length)]
    const dstId =
      this._isDDoS && this._ddosTargetId
        ? this._ddosTargetId
        : servers[Math.floor(Math.random() * servers.length)]
    if (!this.graph.getRoute(srcId, dstId)) {
      this._dropped++ // no route (e.g. firewall up) → the attempt fails outright
      return
    }

    const protocol = pickProtocol(this._isDDoS)
    if (protocol === 'TCP') this._startTcpApp(srcId, dstId, now)
    else this._createFlow(srcId, dstId, protocol, now)
  }

  // Open a real TCP connection (per-endpoint stack). A cache-miss on the server
  // name first fires an ambient DNS lookup (visible traffic + counter); the
  // connection itself is opened right away.
  private _startTcpApp(srcId: string, dstId: string, now: number): void {
    if (this._activeConnCount() >= (this._isDDoS ? MAX_TCP_CONNS * 3 : MAX_TCP_CONNS)) return

    if (!this._isDDoS) {
      const cached = (this._dnsCache.get(`${srcId}>${dstId}`) ?? 0) > now
      if (!cached) {
        this._dnsCache.set(`${srcId}>${dstId}`, now + DNS_TTL_MS)
        this._spawnDnsLookup(srcId, now)
      }
    }
    const port = Math.random() < 0.5 ? PORT_HTTPS : PORT_HTTP
    const bytes = TCP_XFER_MIN + Math.floor(Math.random() * TCP_XFER_SPAN)

    if (this._wasmTcp) {
      this._wasmTcp.connect(srcId, dstId, port, bytes) // C core (WASM)
      return
    }
    this._endpoints.get(srcId)?.connect(dstId, port, bytes)
  }

  // A DNS lookup: a short UDP :53 round-trip up the city's access link to its
  // ISP resolver and back. Modeled as an internal two-step flow.
  private _spawnDnsLookup(cityId: string, now: number): void {
    const link = this.graph
      .getActiveLinks()
      .find(l => l.sourceId === cityId || l.targetId === cityId)
    if (!link) return
    const resolver = link.sourceId === cityId ? link.targetId : link.sourceId
    const path = [cityId, resolver]
    this._dnsLookups++
    this._pushFlow({
      protocol: 'UDP',
      srcId: cityId,
      dstId: resolver,
      fwdPath: path,
      dstPort: 53,
      steps: [
        { segment: 'DNS-QUERY', dir: 'fwd', wait: true },
        { segment: 'DNS-RESPONSE', dir: 'ret', wait: true },
      ],
      internal: true,
      now,
    })
  }

  // A connectionless UDP/ICMP flow between a city and a server.
  private _createFlow(srcId: string, dstId: string, protocol: 'UDP' | 'ICMP', now: number): void {
    if (this._flows.filter(f => !f.done).length >= (this._isDDoS ? MAX_FLOWS * 2 : MAX_FLOWS)) return
    const fwdPath = this.graph.getRoute(srcId, dstId)
    if (!fwdPath) {
      this._dropped++
      return
    }
    const dstPort = protocol === 'UDP' ? (Math.random() < 0.5 ? 53 : 443) : 0
    this._pushFlow({ protocol, srcId, dstId, fwdPath, dstPort, steps: buildSteps(protocol), internal: false, now })
  }

  private _pushFlow(a: {
    protocol: Protocol
    srcId: string
    dstId: string
    fwdPath: string[]
    dstPort: number
    steps: FlowStep[]
    internal: boolean
    now: number
  }): void {
    _flowCounter++
    this._flows.push({
      id: `flow-${_flowCounter}`,
      protocol: a.protocol,
      srcId: a.srcId,
      dstId: a.dstId,
      fwdPath: a.fwdPath,
      revPath: [...a.fwdPath].reverse(),
      srcPort: 49152 + Math.floor(Math.random() * 16000),
      dstPort: a.dstPort,
      steps: a.steps,
      stepIndex: 0,
      awaiting: false,
      awaitingPacketId: null,
      awaitingStep: null,
      awaitingSince: 0,
      retxCount: 0,
      rttRecorded: false,
      lastEmit: 0,
      lossProb: this._pathLossProb(a.fwdPath),
      internal: a.internal,
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
  // that will send `bytes` bytes and then close. Returns the client control
  // block (hold the reference — finished connections are reaped from the table),
  // or null if the source is not a host endpoint. Used by tests; the live
  // spawner uses the same endpoints via _startTcpApp.
  appConnect(srcId: string, dstId: string, port: number, bytes: number): Tcb | null {
    const ep = this._endpoints.get(srcId)
    if (!ep) return null
    return ep.connect(dstId, port, bytes)
  }

  // Run every endpoint's timers + sender for this tick.
  private _tickEndpoints(now: number): void {
    if (this._wasmTcp) {
      // Live TCP runs on the C core: tick it, then reap finished connections.
      this._wasmTcp.tick(now)
      this._completed += this._wasmTcp.reap()
      return
    }
    const ctx = this._tcpCtx(now)
    const homes = this._homeIds ?? (this._homeIds = new Set(this.graph.getHomeIds()))
    for (const [nodeId, ep] of this._endpoints) {
      ep.tick(ctx)
      const isClient = homes.has(nodeId)
      for (const [key, tcb] of ep.conns) {
        // Sample each connection's measured RTT once, into the latency readout.
        if (isClient && !tcb.rttSampled && tcb.srtt > 0) {
          tcb.rttSampled = true
          this._recentRtts.push(tcb.srtt)
          if (this._recentRtts.length > LATENCY_WINDOW) this._recentRtts.shift()
        }
        // Reap finished connections; a client's completion counts as a session.
        if (tcb.done) {
          if (isClient && tcb.finSent) this._completed++
          ep.conns.delete(key)
        }
      }
    }
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
    if (seg.retx) this._retransmits++
    this._injectSegment({
      protocol: 'TCP',
      segment: flagsToLabel(seg.flags, hasData, seg.retx),
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

  private _emit(flow: Flow, step: FlowStep, now: number, retx: boolean): Packet | null {
    const path = step.dir === 'fwd' ? flow.fwdPath : flow.revPath
    const lossAt = Math.random() < flow.lossProb ? 0.3 + Math.random() * 0.5 : null

    const packet = this._injectSegment({
      flowId: flow.id,
      protocol: flow.protocol,
      segment: retx ? 'RETX' : step.segment,
      sourceId: path[0],
      destinationId: path[path.length - 1],
      srcPort: flow.srcPort,
      dstPort: flow.dstPort,
      expectedHops: path.length - 1,
      simulationTimeMs: now,
      lossProb: flow.lossProb,
      lossAt,
    })
    if (packet && step.wait) flow.awaitingPacketId = packet.id
    return packet
  }

  private _processFlows(now: number): void {
    for (const flow of this._flows) {
      if (flow.done) continue

      // Finished emitting all steps → done once nothing is still in flight.
      if (flow.stepIndex >= flow.steps.length) {
        if (!this._hasInflight(flow.id)) {
          flow.done = true
          if (!flow.internal) this._completed++ // DNS lookups aren't "connections"
        }
        continue
      }

      if (flow.awaiting) {
        // Awaited packet lost? Retransmit until we give up (ICMP/DNS reliability).
        if (now - flow.awaitingSince > FLOW_RETX_TIMEOUT_MS && !this._hasInflight(flow.id) && flow.awaitingStep) {
          if (flow.retxCount < MAX_RETX) {
            flow.retxCount++
            this._retransmits++
            this._emit(flow, flow.awaitingStep, now, true)
            flow.awaitingSince = now
          } else {
            flow.done = true // exchange abandoned
          }
        }
        continue
      }

      const step = flow.steps[flow.stepIndex]

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
          // Real TCP segment → hand it to the destination host's stack (the C
          // core when WASM is enabled, else the TS endpoints).
          if (this._wasmTcp) {
            this._wasmTcp.deliver(realTimeMs, packet.destinationId, packet.sourceId,
              packet.srcPort, packet.dstPort, packet.seq ?? 0, packet.ackNo ?? 0,
              packet.tcpFlags, packet.window ?? 0, packet.payloadLen ?? 0)
          } else {
            this._endpoints.get(packet.destinationId)?.deliver(packet, tcpCtx)
          }
        } else {
          this._onDelivered(packet)
        }
        this._lingerTimers.set(packet.id, realTimeMs + PACKET_LINGER_MS)
      } else if (result === 'dropped') {
        this._aliveDec(packet)
        this._dropped++
        this._lingerTimers.set(packet.id, realTimeMs + 200)
      }
    }
  }

  private _onDelivered(packet: Packet): void {
    const flow = this._flows.find(f => f.id === packet.flowId)
    if (!flow) return

    // Record RTT when an ICMP reply comes back (TCP RTT is sampled from the real
    // stack's SRTT in _tickEndpoints).
    if (!flow.rttRecorded && packet.segment === 'REPLY') {
      const rtt =
        computePathLatency(flow.fwdPath, this.graph.links) +
        computePathLatency(flow.revPath, this.graph.links)
      this._recentRtts.push(rtt)
      if (this._recentRtts.length > LATENCY_WINDOW) this._recentRtts.shift()
      flow.rttRecorded = true
    }

    if (flow.awaiting && packet.id === flow.awaitingPacketId) {
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

    // Live "connections" = real TCP connections + connectionless UDP/ICMP
    // exchanges (DNS lookups are infrastructure, not counted).
    const flows = this._flows.filter(f => !f.done && !f.internal).length
    return {
      activePackets: active,
      connections: this._activeConnCount() + flows,
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
      tcpBackend: this._wasmTcp ? 'wasm-c' : 'ts',
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
    this._homeIds = undefined
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    this._ddosTargetId = null
    this._lastStatsPush = -Infinity
    resetPacketCounter()
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  // Disable the live traffic spawner (tests drive a single connection in
  // isolation via appConnect).
  setAutoTraffic(on: boolean): void {
    this._autoTraffic = on
  }

  // Live congestion-control snapshot for the packet inspector — now sourced from
  // the real per-endpoint TCP control block for the connection a segment belongs
  // to. Its flowId is `tcp:${src}:${srcPort}>${dst}:${dstPort}`.
  getTcpInfo(flowId: string): TcpCongestionInfo | null {
    if (this._wasmTcp) return this._wasmTcp.getInfo(flowId)
    const m = /^tcp:(.+):(\d+)>(.+):(\d+)$/.exec(flowId)
    if (!m) return null
    const [, a, aPort, b, bPort] = m
    // The segment could be in either direction; find whichever end holds the
    // sending TCB (the one with data to deliver).
    const tcb =
      this._endpoints.get(a)?.conns.get(`${aPort}:${b}:${bPort}`) ??
      this._endpoints.get(b)?.conns.get(`${bPort}:${a}:${aPort}`)
    if (!tcb) return null
    const cwndSeg = Math.max(1, Math.round(tcb.cwnd / TCP_MSS))
    return {
      cwnd: cwndSeg,
      ssthresh: Math.round(tcb.ssthresh / TCP_MSS),
      state: tcb.cwnd < tcb.ssthresh ? 'slow-start' : 'congestion-avoidance',
      inFlightSegments: Math.round(((tcb.sndNxt - tcb.sndUna) | 0) / TCP_MSS),
      ackedSegments: Math.max(0, Math.round(((tcb.sndUna - tcb.iss - 1) | 0) / TCP_MSS)),
      totalSegments: Math.max(1, Math.round(tcb.appToSend / TCP_MSS)),
      lossEvents: tcb.lossEvents,
    }
  }

  getPositionCache(): Map<string, [number, number, number]> {
    return this.graph.getPositionCache()
  }
}
