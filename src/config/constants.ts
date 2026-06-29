import type { NodeType } from '../types/network'

// Simulation tuning constants — adjust feel without touching logic.

// Target packet generation rate (new request packets per real second)
export const PACKET_SPAWN_RATE = 2.2

// How many recently-completed round-trips to average for the latency readout
export const LATENCY_WINDOW = 25

// Cap on simultaneously alive packets (protects against runaway growth)
export const MAX_ACTIVE_PACKETS = 80

// How long a delivered packet lingers (fades) before removal — real ms
export const PACKET_LINGER_MS = 350

// --- Per-segment travel timing ---------------------------------------------
// Real seconds a packet takes to cross one link, derived from link latency.
// duration = BASE + latency * SCALE, clamped — so a 2ms backbone hop is quick
// and an 18ms last-mile hop visibly drags.
export const SEGMENT_BASE_SECONDS = 0.12
export const SEGMENT_LATENCY_SCALE = 0.018
export const SEGMENT_MIN_SECONDS = 0.14
export const SEGMENT_MAX_SECONDS = 0.55

// --- Visual sizing per node type -------------------------------------------
// Marker radius for the glowing pin sitting on the globe surface.
export const NODE_SIZE: Record<NodeType, number> = {
  home: 0.12,
  'home-router': 0.1,
  'isp-router': 0.13,
  'core-router': 0.16,
  datacenter: 0.2,
  server: 0.1,
  gateway: 0.16,
}

// Emissive glow intensity per node type
export const NODE_GLOW: Record<NodeType, number> = {
  home: 1.4,
  'home-router': 1.2,
  'isp-router': 1.2,
  'core-router': 1.8,
  datacenter: 1.8,
  server: 1.4,
  gateway: 1.8,
}

// Packet sphere radius
export const PACKET_RADIUS = 0.09

// Camera starting position — pulled back to frame the whole globe (radius 10)
export const CAMERA_POSITION: [number, number, number] = [16, 12, 20]
export const CAMERA_TARGET: [number, number, number] = [0, 0, 0]
