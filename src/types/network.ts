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

// Transport protocols modeled by the simulation.
export type Protocol = 'TCP' | 'UDP' | 'ICMP'

// A packet belongs to a flow and carries one protocol segment. The segment is
// what makes a transmission look real: TCP does a SYN/SYN-ACK/ACK handshake,
// streams DATA that gets ACKed, then tears down with FIN/FIN-ACK; UDP just fires
// datagrams; ICMP is an echo/reply ping.
export type Segment =
  | 'SYN'
  | 'SYN-ACK'
  | 'ACK'
  | 'DATA'
  | 'DATA-ACK'
  | 'FIN'
  | 'FIN-ACK'
  | 'RETX' // a TCP retransmission after a lost segment
  | 'DATAGRAM' // UDP
  | 'ECHO' // ICMP request
  | 'REPLY' // ICMP reply

export type PacketStatus = 'in-flight' | 'delivered' | 'dropped'

export interface NetworkNode {
  id: string
  type: NodeType
  label: string
  // Optional secondary label (e.g. the operator / region name)
  subLabel?: string
  // Assigned IP address (for a realistic, inspectable network)
  ip: string
  // Continent the node sits on (used to group the continent zoom view)
  continent: string
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

// A packet is one segment of a flow, traveling a pre-computed path.
export interface Packet {
  id: string
  flowId: string
  protocol: Protocol
  segment: Segment
  control: boolean // true for handshake/ack/teardown (vs payload data)
  sourceId: string
  destinationId: string
  // Ordered list of node IDs the packet will traverse
  path: string[]
  // How long (real seconds) each path segment takes — derived from link latency.
  segmentDurations: number[]
  // Index into path indicating which link we're currently on
  pathIndex: number
  // 0.0 = start of current link, 1.0 = end of current link
  progress: number
  createdAt: number // simulation time in ms
  status: PacketStatus
  // If set (0..1), the packet is "lost" and vanishes when progress passes this.
  lossAt: number | null
  color: string
}

export interface SimulationStats {
  activePackets: number
  connections: number      // open flows (TCP connections / UDP+ICMP exchanges)
  completed: number        // flows that finished successfully
  droppedPackets: number   // packets lost in transit (or with no route)
  retransmits: number      // TCP segments resent after loss
  // Rolling average round-trip time (ms), measured SYN → SYN-ACK etc.
  averageLatency: number
  // Live packet count per protocol
  protocolMix: Record<Protocol, number>
  routingMode: RoutingMode
  isPaused: boolean
}
