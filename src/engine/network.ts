import type { NetworkNode, NetworkLink } from '../types/network'
import { INITIAL_NODES, INITIAL_LINKS } from '../config/topology'
import { buildForwardingTables, type ForwardingTable } from './routing'

// Network graph manager — owns the authoritative node and link data.
// Rendering reads from here; it never mutates the graph directly.

export class NetworkGraph {
  nodes: NetworkNode[]
  links: NetworkLink[]

  // Cached position lookup for O(1) access during packet animation
  private _positionCache: Map<string, [number, number, number]>
  // Per-router forwarding tables (nodeId → destId → next hop), recomputed
  // whenever the usable topology changes (firewall toggle, reset).
  private _forwarding: Map<string, ForwardingTable>

  constructor() {
    // Deep clone the static topology so resets are cheap and isolated
    this.nodes = INITIAL_NODES.map(n => ({ ...n }))
    this.links = INITIAL_LINKS.map(l => ({ ...l }))
    this._positionCache = this._buildPositionCache()
    this._forwarding = buildForwardingTables(this.getActiveNodes(), this.getActiveLinks())
  }

  private _rebuildForwarding(): void {
    this._forwarding = buildForwardingTables(this.getActiveNodes(), this.getActiveLinks())
  }

  // The per-hop routing decision: the router at `fromId` looks up `destId` in
  // its own table and returns the neighbor to forward to, or null if it has no
  // route (destination unreachable — e.g. behind a raised firewall).
  getNextHop(fromId: string, destId: string): string | null {
    return this._forwarding.get(fromId)?.get(destId) ?? null
  }

  // A node's whole forwarding table (destination → next hop), for the UI.
  // The returned map is live engine state — read, don't mutate.
  getForwardingTable(nodeId: string): ForwardingTable | null {
    return this._forwarding.get(nodeId) ?? null
  }

  // Trace the route hop by hop through the forwarding tables — what a packet
  // will actually experience. Used for planning (loss/RTT estimates), never
  // carried by packets. Null if some router along the way has no route.
  getRoute(srcId: string, dstId: string): string[] | null {
    const route = [srcId]
    let cursor = srcId
    while (cursor !== dstId) {
      const next = this.getNextHop(cursor, dstId)
      if (next === null) return null
      route.push(next)
      cursor = next
      if (route.length > this.nodes.length) return null // table loop guard
    }
    return route
  }

  private _buildPositionCache(): Map<string, [number, number, number]> {
    const map = new Map<string, [number, number, number]>()
    for (const node of this.nodes) map.set(node.id, node.position)
    return map
  }

  getPositionCache(): Map<string, [number, number, number]> {
    return this._positionCache
  }

  // Traffic originates at homes and terminates at servers.
  getHomeIds(): string[] {
    return this.nodes.filter(n => n.type === 'home').map(n => n.id)
  }

  getServerIds(): string[] {
    return this.nodes.filter(n => n.type === 'server').map(n => n.id)
  }

  // Data-center gateways double as firewalls — toggling them simulates
  // an ingress firewall going up (blocking all traffic into the DCs).
  toggleFirewall(): void {
    for (const node of this.nodes) {
      if (node.type === 'datacenter') node.active = !node.active
    }
    // Routers "reconverge" on the new topology: routes through the blocked
    // data centers disappear from every forwarding table.
    this._rebuildForwarding()
  }

  isFirewallUp(): boolean {
    // "Firewall up" = data centers are blocking (inactive)
    return this.nodes.some(n => n.type === 'datacenter' && !n.active)
  }

  getActiveNodes(): NetworkNode[] {
    return this.nodes.filter(n => n.active)
  }

  // Links are usable only when both endpoints are active.
  getActiveLinks(): NetworkLink[] {
    const activeIds = new Set(this.getActiveNodes().map(n => n.id))
    return this.links.filter(
      l => activeIds.has(l.sourceId) && activeIds.has(l.targetId),
    )
  }

  reset(): void {
    this.nodes = INITIAL_NODES.map(n => ({ ...n }))
    this.links = INITIAL_LINKS.map(l => ({ ...l }))
    this._positionCache = this._buildPositionCache()
    this._rebuildForwarding()
  }
}
