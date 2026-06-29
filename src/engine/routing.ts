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

// Returns the ordered list of node IDs forming the lowest-latency path,
// or null if no path exists (e.g. firewall blocks all routes).
export function findShortestPath(
  sourceId: string,
  destId: string,
  nodes: NetworkNode[],
  links: NetworkLink[],
): string[] | null {
  const adj = buildAdjacency(nodes, links)

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

    if (current.id === destId) break
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
