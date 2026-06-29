import type { NetworkNode, NetworkLink } from '../types/network'
import { INITIAL_NODES, INITIAL_LINKS } from '../config/topology'

// Network graph manager — owns the authoritative node and link data.
// Rendering reads from here; it never mutates the graph directly.

export class NetworkGraph {
  nodes: NetworkNode[]
  links: NetworkLink[]

  // Cached position lookup for O(1) access during packet animation
  private _positionCache: Map<string, [number, number, number]>

  constructor() {
    // Deep clone the static topology so resets are cheap and isolated
    this.nodes = INITIAL_NODES.map(n => ({ ...n }))
    this.links = INITIAL_LINKS.map(l => ({ ...l }))
    this._positionCache = this._buildPositionCache()
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
  }
}
