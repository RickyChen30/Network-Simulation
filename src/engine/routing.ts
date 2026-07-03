import type { NetworkNode, NetworkLink } from '../types/network'

// Dijkstra's shortest-path algorithm over the network graph.
// Edge weight = link latency (lower latency = preferred path).

interface AdjacencyEntry {
  neighborId: string
  latency: number
}

function buildAdjacency(
  nodes: NetworkNode[],
  links: NetworkLink[],
): Map<string, AdjacencyEntry[]> {
  const adj = new Map<string, AdjacencyEntry[]>()

  for (const node of nodes) {
    adj.set(node.id, [])
  }

  // Links are bidirectional — packets can travel either direction
  for (const link of links) {
    adj.get(link.sourceId)?.push({ neighborId: link.targetId, latency: link.latency })
    adj.get(link.targetId)?.push({ neighborId: link.sourceId, latency: link.latency })
  }

  return adj
}

// Full single-source Dijkstra: returns cumulative latency and the predecessor
// of every reachable node. `stopAt` allows an early exit for single-pair queries.
function dijkstraFrom(
  sourceId: string,
  nodes: NetworkNode[],
  adj: Map<string, AdjacencyEntry[]>,
  stopAt?: string,
): { dist: Map<string, number>; prev: Map<string, string | null> } {
  // Distance map: nodeId → cumulative latency from source
  const dist = new Map<string, number>()
  const prev = new Map<string, string | null>()

  for (const node of nodes) {
    dist.set(node.id, Infinity)
    prev.set(node.id, null)
  }
  dist.set(sourceId, 0)

  // Simple priority queue using a sorted array (fine for small graphs)
  const queue: { id: string; cost: number }[] = [{ id: sourceId, cost: 0 }]

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost)
    const current = queue.shift()!

    if (current.id === stopAt) break
    if (current.cost > (dist.get(current.id) ?? Infinity)) continue

    for (const { neighborId, latency } of adj.get(current.id) ?? []) {
      const candidate = current.cost + latency
      if (candidate < (dist.get(neighborId) ?? Infinity)) {
        dist.set(neighborId, candidate)
        prev.set(neighborId, current.id)
        queue.push({ id: neighborId, cost: candidate })
      }
    }
  }

  return { dist, prev }
}

// Returns the ordered list of node IDs forming the lowest-latency path,
// or null if no path exists (e.g. firewall blocks all routes).
export function findShortestPath(
  sourceId: string,
  destId: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
): string[] | null {
  const adj = buildAdjacency(nodes, links)
  const { dist, prev } = dijkstraFrom(sourceId, nodes, adj, destId)

  // Reconstruct path by walking prev pointers backward
  if (dist.get(destId) === Infinity) return null

  const path: string[] = []
  let cursor: string | null = destId
  while (cursor !== null) {
    path.unshift(cursor)
    cursor = prev.get(cursor) ?? null
  }

  return path
}

// Cumulative latency from `sourceId` to every reachable node (Infinity when
// unreachable). Used for hot-potato egress selection in the BGP layer.
export function shortestDistances(
  sourceId: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
): Map<string, number> {
  const adj = buildAdjacency(nodes, links)
  return dijkstraFrom(sourceId, nodes, adj).dist
}

// A router's forwarding table: destination node ID → next-hop neighbor ID.
export type ForwardingTable = Map<string, string>

// Build every router's forwarding table (nodeId → its ForwardingTable), the way
// a converged link-state protocol (OSPF/IS-IS) would: each router ends up
// knowing, for every destination, only which neighbor to hand the packet to.
//
// One Dijkstra per *destination* fills in that column of every router's table:
// links are symmetric, so on the shortest path source → D, a node's predecessor
// in the tree rooted at D is exactly its next hop toward D.
export function buildForwardingTables(
  nodes: NetworkNode[],
  links: NetworkLink[],
): Map<string, ForwardingTable> {
  const adj = buildAdjacency(nodes, links)
  const tables = new Map<string, ForwardingTable>()
  for (const node of nodes) tables.set(node.id, new Map())

  for (const dest of nodes) {
    const { dist, prev } = dijkstraFrom(dest.id, nodes, adj)
    for (const node of nodes) {
      if (node.id === dest.id) continue
      if ((dist.get(node.id) ?? Infinity) === Infinity) continue
      tables.get(node.id)!.set(dest.id, prev.get(node.id)!)
    }
  }

  return tables
}

// Returns the total simulated latency (ms) for a given path
export function computePathLatency(
  path: string[],
  links: NetworkLink[],
): number {
  let total = 0

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const link = links.find(
      l =>
        (l.sourceId === a && l.targetId === b) ||
        (l.sourceId === b && l.targetId === a),
    )
    if (link) total += link.latency
  }

  return total
}
