import type { Packet, SimulationStats, RoutingMode, Protocol, Segment } from '../types/network'
import { NetworkGraph } from './network'
import { computePathLatency } from './routing'
import { createPacket, resetPacketCounter, stepPacket } from './packet'
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
  // 'dns' steps ride the short city → resolver path as UDP port 53,
  // regardless of the flow's own protocol.
  phase?: 'dns'
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
  done: boolean
}

const FLOW_SPAWN_RATE = 1.3 // new flows per real second
const MAX_FLOWS = 26
const TCP_TIMEOUT_MS = 1100 // retransmit timeout for an un-acked TCP segment
const UDP_STAGGER_MS = 110 // gap between UDP datagrams
const MAX_RETX = 4
const DDOS_CONGESTION = 6 // loss multiplier while a link is being flooded
// How long a resolved name stays in a city's DNS cache — flows from that city
// to the same server within the TTL skip the lookup.
const DNS_TTL_MS = 45_000

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
    const steps: FlowStep[] = [
      { segment: 'SYN', dir: 'fwd', wait: true },
      { segment: 'SYN-ACK', dir: 'ret', wait: true },
      { segment: 'ACK', dir: 'fwd', wait: true },
    ]
    const dataCount = 2 + Math.floor(Math.random() * 4)
    for (let i = 0; i < dataCount; i++) {
      steps.push({ segment: 'DATA', dir: 'fwd', wait: true })
      steps.push({ segment: 'DATA-ACK', dir: 'ret', wait: true })
    }
    steps.push({ segment: 'FIN', dir: 'fwd', wait: true })
    steps.push({ segment: 'FIN-ACK', dir: 'ret', wait: true })
    return steps
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

export class SimulationEngine {
  graph: NetworkGraph
  packets: Packet[]

  private _flows: Flow[]
  private _isPaused: boolean
  private _routingMode: RoutingMode
  private _isDDoS: boolean

  private _completed: number
  private _dropped: number
  private _retransmits: number
  private _dnsLookups: number
  private _recentRtts: number[]
  private _spawnAccumulator: number
  private _lingerTimers: Map<string, number>
  // Per-city resolver cache: "srcId>dstId" → sim time (ms) the entry expires.
  private _dnsCache: Map<string, number>

  onStateChange?: (stats: SimulationStats, packets: Packet[]) => void

  constructor() {
    this.graph = new NetworkGraph()
    this.packets = []
    this._flows = []
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    this._completed = 0
    this._dropped = 0
    this._retransmits = 0
    this._dnsLookups = 0
    this._recentRtts = []
    this._spawnAccumulator = 0
    this._lingerTimers = new Map()
    this._dnsCache = new Map()
  }

  tick(deltaSeconds: number, realTimeMs: number): void {
    if (this._isPaused) return

    this._spawnFlows(deltaSeconds, realTimeMs)
    this._processFlows(realTimeMs)
    this._stepPackets(deltaSeconds, realTimeMs)
    this._pruneLingeredPackets(realTimeMs)
    this._pruneFlows()

    this.onStateChange?.(this._buildStats(), this.packets)
  }

  private _hasInflight(flowId: string): boolean {
    return this.packets.some(p => p.flowId === flowId && p.status === 'in-flight')
  }

  private _spawnFlows(deltaSeconds: number, now: number): void {
    const active = this._flows.filter(f => !f.done).length
    if (active >= MAX_FLOWS) return
    if (this.packets.filter(p => p.status === 'in-flight').length >= MAX_ACTIVE_PACKETS) return

    const rate = this._isDDoS ? FLOW_SPAWN_RATE * 4 : FLOW_SPAWN_RATE
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
    const dstId = servers[Math.floor(Math.random() * servers.length)]
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

  private _emit(flow: Flow, step: FlowStep, now: number, retx: boolean): void {
    const dns = step.phase === 'dns'
    const path = dns
      ? (step.dir === 'fwd' ? flow.dnsPath! : flow.dnsRevPath!)
      : (step.dir === 'fwd' ? flow.fwdPath : flow.revPath)
    const baseLoss = dns ? flow.dnsLossProb : flow.lossProb
    const lossProb = baseLoss * (this._isDDoS ? DDOS_CONGESTION : 1)
    const lossAt = Math.random() < lossProb ? 0.3 + Math.random() * 0.5 : null

    // The sending host makes only the first routing decision; every later hop
    // is chosen by the router the packet lands on. No route at the source
    // (e.g. firewall raised mid-flow) → the send fails outright, and TCP's
    // retransmit timer will retry / give up as usual.
    const destinationId = path[path.length - 1]
    const firstHopId = this.graph.getNextHop(path[0], destinationId)
    if (firstHopId === null) {
      this._dropped++
      return
    }

    const packet = createPacket({
      flowId: flow.id,
      protocol: dns ? 'UDP' : flow.protocol, // DNS rides UDP whatever the flow is
      segment: retx ? 'RETX' : step.segment,
      sourceId: path[0],
      destinationId,
      srcPort: flow.srcPort,
      dstPort: dns ? 53 : flow.dstPort,
      firstHopId,
      expectedHops: path.length - 1,
      links: this.graph.links,
      simulationTimeMs: now,
      lossProb: baseLoss,
      lossAt,
    })
    this.packets.push(packet)
    if (step.wait) flow.awaitingPacketId = packet.id
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

  private _stepPackets(deltaSeconds: number, realTimeMs: number): void {
    // Each router a packet reaches makes its own forwarding decision by
    // looking the destination up in that node's forwarding table.
    const lookup = (fromId: string, destId: string) => this.graph.getNextHop(fromId, destId)
    for (const packet of this.packets) {
      if (packet.status !== 'in-flight') continue
      const result = stepPacket(packet, deltaSeconds, lookup, this.graph.links)
      if (result === 'delivered') {
        this._onDelivered(packet, realTimeMs)
        this._lingerTimers.set(packet.id, realTimeMs + PACKET_LINGER_MS)
      } else if (result === 'dropped') {
        this._dropped++
        this._lingerTimers.set(packet.id, realTimeMs + 200)
      }
    }
  }

  private _onDelivered(packet: Packet, now: number): void {
    const flow = this._flows.find(f => f.id === packet.flowId)
    if (!flow) return

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
      if (p.status === 'in-flight') return true
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
    for (const p of this.packets) {
      if (p.status !== 'in-flight') continue
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
      retransmits: this._retransmits,
      dnsLookups: this._dnsLookups,
      averageLatency: Math.round(avg),
      protocolMix,
      routingMode: this._routingMode,
      isPaused: this._isPaused,
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
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleFirewall(): void {
    this.graph.toggleFirewall()
  }

  reset(): void {
    this.graph.reset()
    this.packets = []
    this._flows = []
    this._completed = 0
    this._dropped = 0
    this._retransmits = 0
    this._dnsLookups = 0
    this._recentRtts = []
    this._spawnAccumulator = 0
    this._lingerTimers.clear()
    this._dnsCache.clear()
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    resetPacketCounter()
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  getPositionCache(): Map<string, [number, number, number]> {
    return this.graph.getPositionCache()
  }
}
