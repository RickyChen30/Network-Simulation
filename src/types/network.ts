// Core domain types for the network simulation.
// One central place for the full data model keeps the engine and renderer in sync.

// The network is modeled as the global internet hierarchy:
//   user city → backbone/IXP → submarine-cable landing → ocean crossing →
//   IXP on another continent → datacenter → server.
// (home-router / isp-router exist for completeness but are unused at this scale.)
export type NodeType =
  | 'home'         // a user city generating traffic
  | 'home-router'  // consumer gateway (unused at global scale)
  | 'isp-router'   // metro ISP access (unused at global scale)
  | 'core-router'  // backbone router at a city POP / internet exchange
  | 'datacenter'   // hyperscale data-center facility (also acts as a firewall)
  | 'server'       // application / CDN server inside a data center
  | 'gateway'      // submarine-cable landing / transit hub between continents

export type RoutingMode = 'shortest-path' | 'adaptive' | 'ddos'

// Packets come in two flavors so traffic looks bidirectional and realistic:
//   request  — a home asking a server for data
//   response — the server's reply traveling back to the home
export type PacketKind = 'request' | 'response'

export type PacketStatus = 'in-flight' | 'delivered' | 'dropped'

export interface NetworkNode {
  id: string
  type: NodeType
  label: string
  // Optional secondary label (e.g. the Chinese city / operator name)
  subLabel?: string
  // 3D position in world space (X = east, Z = south, Y = up)
  position: [number, number, number]
  // Whether this node is currently forwarding traffic (firewall toggle flips datacenters)
  active: boolean
}

export interface NetworkLink {
  id: string
  sourceId: string
  targetId: string
  // Base propagation + processing delay in milliseconds (simulated, one-way)
  latency: number
  // Relative capacity unit (packets the link can carry comfortably)
  bandwidth: number
}

// A packet travels along a pre-computed path from source to destination.
export interface Packet {
  id: string
  kind: PacketKind
  sourceId: string
  destinationId: string
  // Ordered list of node IDs the packet will traverse
  path: string[]
  // How long (real seconds) each path segment takes — derived from link latency,
  // so backbone hops are fast and last-mile home hops are slow.
  segmentDurations: number[]
  // Index into path indicating which link we're currently on
  pathIndex: number
  // 0.0 = start of current link, 1.0 = end of current link
  progress: number
  createdAt: number // simulation time in ms
  status: PacketStatus
  color: string
}

export interface SimulationStats {
  activePackets: number
  deliveredPackets: number   // completed round-trips (response reached home)
  droppedPackets: number     // requests with no available route (e.g. firewall down)
  // Rolling average round-trip time over recently completed exchanges
  averageLatency: number
  routingMode: RoutingMode
  isPaused: boolean
}
