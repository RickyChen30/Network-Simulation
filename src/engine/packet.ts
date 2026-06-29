import type { Packet, PacketKind, NetworkLink } from '../types/network'
import { PACKET_COLORS } from '../config/topology'
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

// Look up the latency of the link connecting two adjacent path nodes.
function linkLatency(a: string, b: string, links: NetworkLink[]): number {
  const link = links.find(
    l =>
      (l.sourceId === a && l.targetId === b) ||
      (l.sourceId === b && l.targetId === a),
  )
  return link?.latency ?? 10
}

// Convert each hop's latency into a real-time travel duration so that
// fast backbone links zip and slow last-mile links crawl.
function computeSegmentDurations(path: string[], links: NetworkLink[]): number[] {
  const durations: number[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const latency = linkLatency(path[i], path[i + 1], links)
    const seconds = clamp(
      SEGMENT_BASE_SECONDS + latency * SEGMENT_LATENCY_SCALE,
      SEGMENT_MIN_SECONDS,
      SEGMENT_MAX_SECONDS,
    )
    durations.push(seconds)
  }
  return durations
}

export function createPacket(
  kind: PacketKind,
  sourceId: string,
  destinationId: string,
  path: string[],
  links: NetworkLink[],
  simulationTimeMs: number,
): Packet {
  _packetCounter++

  return {
    id: `pkt-${_packetCounter}`,
    kind,
    sourceId,
    destinationId,
    path,
    segmentDurations: computeSegmentDurations(path, links),
    pathIndex: 0,
    progress: 0,
    createdAt: simulationTimeMs,
    status: 'in-flight',
    color: PACKET_COLORS[kind],
  }
}

export function resetPacketCounter(): void {
  _packetCounter = 0
}

// Advance a packet along its path by deltaSeconds of real time.
// Returns true the moment it reaches its destination node.
export function stepPacket(packet: Packet, deltaSeconds: number): boolean {
  if (packet.status !== 'in-flight') return false

  const duration = packet.segmentDurations[packet.pathIndex] ?? 0.3
  packet.progress += deltaSeconds / duration

  // Handle crossing one or more node boundaries in a single tick
  while (packet.progress >= 1) {
    packet.pathIndex++
    packet.progress -= 1

    if (packet.pathIndex >= packet.path.length - 1) {
      packet.status = 'delivered'
      packet.progress = 0
      return true
    }
  }

  return false
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
