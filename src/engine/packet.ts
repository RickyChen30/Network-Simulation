import type { Packet, Protocol, Segment, NetworkLink } from '../types/network'
import { PROTOCOL_COLORS } from '../config/topology'
import { arcPoint } from '../config/globe'
import {
  SEGMENT_BASE_SECONDS,
  SEGMENT_LATENCY_SCALE,
  SEGMENT_MIN_SECONDS,
  SEGMENT_MAX_SECONDS,
} from '../config/constants'

let _packetCounter = 0

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// Per-hop metrics for a path: the animation duration, the simulated one-way
// latency, and the bottleneck (minimum) bandwidth along it.
function computePathMetrics(path: string[], links: NetworkLink[]) {
  const durations: number[] = []
  const latencies: number[] = []
  let bottleneckBw = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const link = links.find(
      l =>
        (l.sourceId === path[i] && l.targetId === path[i + 1]) ||
        (l.sourceId === path[i + 1] && l.targetId === path[i]),
    )
    const latency = link?.latency ?? 10
    latencies.push(latency)
    durations.push(
      clamp(
        SEGMENT_BASE_SECONDS + latency * SEGMENT_LATENCY_SCALE,
        SEGMENT_MIN_SECONDS,
        SEGMENT_MAX_SECONDS,
      ),
    )
    bottleneckBw = Math.min(bottleneckBw, link?.bandwidth ?? 100)
  }
  return { durations, latencies, bottleneckBw: Number.isFinite(bottleneckBw) ? bottleneckBw : 0 }
}

// Control segments (handshake / ack / teardown) carry no payload.
const CONTROL_SEGMENTS = new Set<Segment>([
  'SYN', 'SYN-ACK', 'ACK', 'DATA-ACK', 'FIN', 'FIN-ACK',
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
  path: string[]
  links: NetworkLink[]
  simulationTimeMs: number
  lossProb: number
  lossAt?: number | null
}

export function createPacket(args: CreatePacketArgs): Packet {
  _packetCounter++
  const control = CONTROL_SEGMENTS.has(args.segment)
  const { durations, latencies, bottleneckBw } = computePathMetrics(args.path, args.links)

  return {
    id: `pkt-${_packetCounter}`,
    flowId: args.flowId,
    protocol: args.protocol,
    segment: args.segment,
    control,
    sourceId: args.sourceId,
    destinationId: args.destinationId,
    srcPort: args.srcPort,
    dstPort: args.dstPort,
    path: args.path,
    segmentDurations: durations,
    pathIndex: 0,
    progress: 0,
    createdAt: args.simulationTimeMs,
    status: 'in-flight',
    lossAt: args.lossAt ?? null,
    color: PROTOCOL_COLORS[args.protocol],
    size: packetSize(args.segment),
    lossProb: args.lossProb,
    hopLatencies: latencies,
    bottleneckBw,
  }
}

export function resetPacketCounter(): void {
  _packetCounter = 0
}

// Advance a packet along its path by deltaSeconds of real time.
// Returns 'delivered' when it reaches the destination, 'dropped' if it is lost
// in transit, or null while still in flight.
export function stepPacket(packet: Packet, deltaSeconds: number): 'delivered' | 'dropped' | null {
  if (packet.status !== 'in-flight') return null

  // Overall progress along the whole path (for the loss check).
  const segCount = Math.max(1, packet.path.length - 1)
  const duration = packet.segmentDurations[packet.pathIndex] ?? 0.3
  packet.progress += deltaSeconds / duration

  // Lost packet: vanish once it passes its loss point.
  if (packet.lossAt !== null) {
    const overall = (packet.pathIndex + Math.min(packet.progress, 1)) / segCount
    if (overall >= packet.lossAt) {
      packet.status = 'dropped'
      return 'dropped'
    }
  }

  while (packet.progress >= 1) {
    packet.pathIndex++
    packet.progress -= 1

    if (packet.pathIndex >= packet.path.length - 1) {
      packet.status = 'delivered'
      packet.progress = 0
      return 'delivered'
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
