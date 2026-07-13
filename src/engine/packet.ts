import type { Packet, Protocol, Segment, NetworkLink } from '../types/network'
import { PROTOCOL_COLORS } from '../config/topology'
import { arcPoint } from '../config/globe'
import {
  SEGMENT_BASE_SECONDS,
  SEGMENT_LATENCY_SCALE,
  SEGMENT_MIN_SECONDS,
  SEGMENT_MAX_SECONDS,
  TTL_MAX_HOPS,
} from '../config/constants'

let _packetCounter = 0

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// Metrics for one hop a → b: animation duration, simulated one-way latency,
// and the link's bandwidth. Appended to the packet each time a router forwards it.
function hopMetrics(a: string, b: string, links: NetworkLink[]) {
  const link = links.find(
    l => (l.sourceId === a && l.targetId === b) || (l.sourceId === b && l.targetId === a),
  )
  const latency = link?.latency ?? 10
  const duration = clamp(
    SEGMENT_BASE_SECONDS + latency * SEGMENT_LATENCY_SCALE,
    SEGMENT_MIN_SECONDS,
    SEGMENT_MAX_SECONDS,
  )
  return { duration, latency, bandwidth: link?.bandwidth ?? 100 }
}

// Record the hop a → b on the packet: the router at `a` has decided to forward
// to `b`, so the traveled path and its per-hop metrics grow by one entry.
function takeHop(packet: Packet, b: string, links: NetworkLink[]): void {
  const a = packet.path[packet.path.length - 1]
  const { duration, latency, bandwidth } = hopMetrics(a, b, links)
  packet.path.push(b)
  packet.segmentDurations.push(duration)
  packet.hopLatencies.push(latency)
  packet.bottleneckBw = Math.min(packet.bottleneckBw, bandwidth)
}

// Control segments (handshake / ack / teardown) carry no payload.
const CONTROL_SEGMENTS = new Set<Segment>([
  'SYN', 'SYN-ACK', 'ACK', 'DATA-ACK', 'FIN', 'FIN-ACK', 'RST',
])

// Realistic packet sizes (bytes): control packets are tiny, data is MTU-ish.
function packetSize(segment: Segment): number {
  if (CONTROL_SEGMENTS.has(segment)) return 40 + Math.floor(Math.random() * 20) // 40–60 B
  if (segment === 'ECHO' || segment === 'REPLY') return 64
  if (segment === 'DNS-QUERY') return 60 + Math.floor(Math.random() * 20) // 60–80 B
  if (segment === 'DNS-RESPONSE') return 120 + Math.floor(Math.random() * 60) // 120–180 B
  return 512 + Math.floor(Math.random() * 988) // 512–1500 B payload
}

export interface CreatePacketArgs {
  flowId: string
  protocol: Protocol
  segment: Segment
  sourceId: string
  destinationId: string
  srcPort: number
  dstPort: number
  // The sending host's routing decision — its forwarding-table next hop toward
  // the destination. The rest of the route is decided router by router.
  firstHopId: string
  // Hop count of the planned route at send time (drives the loss model).
  expectedHops: number
  links: NetworkLink[]
  simulationTimeMs: number
  lossProb: number
  lossAt?: number | null
  seq?: number
  // Real TCP segment header fields (per-endpoint stack). Optional so legacy
  // flow-model callers are unaffected.
  ackNo?: number
  tcpFlags?: number
  window?: number
  payloadLen?: number
  checksum?: number
}

export function createPacket(args: CreatePacketArgs): Packet {
  _packetCounter++
  const control = CONTROL_SEGMENTS.has(args.segment)

  const packet: Packet = {
    id: `pkt-${_packetCounter}`,
    flowId: args.flowId,
    protocol: args.protocol,
    segment: args.segment,
    control,
    sourceId: args.sourceId,
    destinationId: args.destinationId,
    srcPort: args.srcPort,
    dstPort: args.dstPort,
    path: [args.sourceId],
    expectedHops: args.expectedHops,
    segmentDurations: [],
    pathIndex: 0,
    progress: 0,
    createdAt: args.simulationTimeMs,
    status: 'in-flight',
    lossAt: args.lossAt ?? null,
    color: PROTOCOL_COLORS[args.protocol],
    size: packetSize(args.segment),
    lossProb: args.lossProb,
    hopLatencies: [],
    bottleneckBw: Infinity,
    seq: args.seq,
    ackNo: args.ackNo,
    tcpFlags: args.tcpFlags,
    window: args.window,
    payloadLen: args.payloadLen,
    checksum: args.checksum,
  }
  takeHop(packet, args.firstHopId, args.links)
  return packet
}

export function resetPacketCounter(): void {
  _packetCounter = 0
}

// What a router does with an arriving packet, supplied by the engine:
// `nextHop` is the forwarding-table lookup (null = destination unreachable);
// `transmit` asks the chosen output port for a slot — 'sent' proceeds now,
// 'queued' parks the packet at the router, 'dropped' is a queue-overflow drop.
export interface ForwardingContext {
  nextHop: (fromId: string, destId: string) => string | null
  transmit: (packet: Packet, fromId: string, toId: string) => 'sent' | 'queued' | 'dropped'
}

// Advance a packet by deltaSeconds of real time. Each time it reaches a node,
// that router looks the destination up, picks the next hop, and contends for
// the output link — the packet never knows its route in advance. Returns
// 'delivered' when it reaches the destination, 'dropped' if it is lost in
// transit / routed into a black hole / tail-dropped by a full queue, or null
// while still in flight (possibly parked in a router queue).
export function stepPacket(
  packet: Packet,
  deltaSeconds: number,
  ctx: ForwardingContext,
  links: NetworkLink[],
): 'delivered' | 'dropped' | null {
  if (packet.status !== 'in-flight') return null

  const duration = packet.segmentDurations[packet.pathIndex] ?? 0.3
  packet.progress += deltaSeconds / duration

  // Lost packet: vanish once it passes its loss point (a fraction of the
  // planned route, since the actual route unfolds hop by hop).
  if (packet.lossAt !== null) {
    const segCount = Math.max(1, packet.expectedHops)
    const overall = (packet.pathIndex + Math.min(packet.progress, 1)) / segCount
    if (overall >= packet.lossAt) {
      packet.status = 'dropped'
      return 'dropped'
    }
  }

  while (packet.progress >= 1) {
    packet.pathIndex++
    packet.progress -= 1

    // Arrived at a node: destination, or a router that must forward us.
    const hereId = packet.path[packet.pathIndex]
    if (hereId === packet.destinationId) {
      packet.status = 'delivered'
      packet.progress = 0
      return 'delivered'
    }

    // TTL exceeded: kills packets caught in transient forwarding loops while
    // BGP re-converges (each router decrements the TTL like real IP).
    if (packet.pathIndex >= TTL_MAX_HOPS) {
      packet.status = 'dropped'
      packet.progress = 0
      return 'dropped'
    }

    const nextId = ctx.nextHop(hereId, packet.destinationId)
    if (nextId === null) {
      // This router has no route (e.g. the firewall came up mid-flight).
      packet.status = 'dropped'
      packet.progress = 0
      return 'dropped'
    }
    takeHop(packet, nextId, links)

    // Contend for the output link's bandwidth.
    const slot = ctx.transmit(packet, hereId, nextId)
    if (slot === 'dropped') {
      // The router's output queue is full — congestion tail drop.
      packet.status = 'dropped'
      packet.progress = 0
      return 'dropped'
    }
    if (slot === 'queued') {
      // Parked at the router until the link frees up; the engine's queue
      // drain flips it back to in-flight.
      packet.status = 'queued'
      packet.progress = 0
      return null
    }
  }

  return null
}

// World-space position of a packet on its current link. Follows the same
// lifted great-circle arc the link is drawn with, so packets ride the cables.
export function getPacketWorldPosition(
  packet: Packet,
  nodePositions: Map<string, [number, number, number]>,
): [number, number, number] {
  const fromId = packet.path[packet.pathIndex]
  const toId = packet.path[packet.pathIndex + 1]

  const from = nodePositions.get(fromId) ?? [0, 0, 0]
  const to = nodePositions.get(toId) ?? from

  return arcPoint(from, to, packet.progress)
}
