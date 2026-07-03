import type { NetworkNode, NetworkLink, BgpRouteView } from '../types/network'
import { INITIAL_NODES, INITIAL_LINKS } from '../config/topology'
import { buildForwardingTables, shortestDistances, type ForwardingTable } from './routing'
import { BgpEngine } from './bgp'

// Network graph manager — owns the authoritative node and link data plus the
// two-level routing hierarchy that fills every router's forwarding table:
//
//   · intra-AS (IGP): plain latency-weighted Dijkstra inside each continent-AS
//   · inter-AS (BGP): each AS picks a best AS path per destination AS; routers
//     forward external traffic to their nearest egress toward the next-hop AS
//     (hot potato), and the border router hands it across the cable.
//
// Rendering reads from here; it never mutates the graph directly.

export class NetworkGraph {
  nodes: NetworkNode[]
  links: NetworkLink[]
  bgp: BgpEngine

  // Cached position lookup for O(1) access during packet animation
  private _positionCache: Map<string, [number, number, number]>
  // Per-router forwarding tables (nodeId → destId → next hop). Recomputed when
  // the IGP topology changes (firewall, cable cut) or BGP selects new routes.
  private _forwarding: Map<string, ForwardingTable>
  private _asOf: Map<string, string>
  private _cutLinkId: string | null

  constructor() {
    // Deep clone the static topology so resets are cheap and isolated
    this.nodes = INITIAL_NODES.map(n => ({ ...n }))
    this.links = INITIAL_LINKS.map(l => ({ ...l }))
    this._positionCache = this._buildPositionCache()
    this._cutLinkId = null
    this._asOf = this._assignAses()
    this.bgp = new BgpEngine(this._allAses(), this._asAdjacency())
    this._forwarding = new Map()
    this._rebuildForwarding()
  }

  // --- AS membership ---------------------------------------------------------

  // Each continent is an AS. A user city whose nearest uplink hub sits on a
  // different continent joins the hub's AS instead — it's a single-homed
  // customer of that provider, so its access link stays intra-AS.
  private _assignAses(): Map<string, string> {
    const asOf = new Map<string, string>()
    for (const node of this.nodes) asOf.set(node.id, node.continent)
    for (const node of this.nodes) {
      if (node.type !== 'home') continue
      const uplink = this.links.find(l => l.sourceId === node.id || l.targetId === node.id)
      if (!uplink) continue
      const hubId = uplink.sourceId === node.id ? uplink.targetId : uplink.sourceId
      const hubAs = this.nodes.find(n => n.id === hubId)?.continent
      if (hubAs) asOf.set(node.id, hubAs)
    }
    // Publish on the nodes so the UI can read a node's AS straight off nodeMap.
    for (const node of this.nodes) node.as = asOf.get(node.id)
    return asOf
  }

  getAsOf(nodeId: string): string | null {
    return this._asOf.get(nodeId) ?? null
  }

  private _allAses(): string[] {
    return [...new Set(this._asOf.values())]
  }

  // Links whose endpoints route in different ASes — the submarine cables that
  // carry eBGP sessions. Only live (uncut, both ends active) ones count.
  private _interAsLinks(): NetworkLink[] {
    return this.getActiveLinks().filter(
      l => this._asOf.get(l.sourceId) !== this._asOf.get(l.targetId),
    )
  }

  private _asAdjacency(): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>(this._allAses().map(a => [a, new Set<string>()]))
    for (const l of this._interAsLinks()) {
      const a = this._asOf.get(l.sourceId)!
      const b = this._asOf.get(l.targetId)!
      adj.get(a)?.add(b)
      adj.get(b)?.add(a)
    }
    return adj
  }

  // --- FIB installation (RIB → forwarding tables) ------------------------------

  private _rebuildForwarding(): void {
    const activeNodes = this.getActiveNodes()
    const activeLinks = this.getActiveLinks()
    const tables = new Map<string, ForwardingTable>()
    for (const n of activeNodes) tables.set(n.id, new Map())

    // Group the live topology by AS.
    const asMembers = new Map<string, NetworkNode[]>()
    for (const n of activeNodes) {
      const as = this._asOf.get(n.id)!
      if (!asMembers.has(as)) asMembers.set(as, [])
      asMembers.get(as)!.push(n)
    }
    const intraLinks = new Map<string, NetworkLink[]>()
    for (const l of activeLinks) {
      const a = this._asOf.get(l.sourceId)!
      if (a !== this._asOf.get(l.targetId)) continue
      if (!intraLinks.has(a)) intraLinks.set(a, [])
      intraLinks.get(a)!.push(l)
    }

    // Border inventory: for each AS, its links toward each neighboring AS.
    const borderLinks = new Map<string, Map<string, { localId: string; remoteId: string; latency: number }[]>>()
    for (const l of this._interAsLinks()) {
      for (const [localId, remoteId] of [
        [l.sourceId, l.targetId],
        [l.targetId, l.sourceId],
      ] as const) {
        const localAs = this._asOf.get(localId)!
        const remoteAs = this._asOf.get(remoteId)!
        if (!borderLinks.has(localAs)) borderLinks.set(localAs, new Map())
        const perNeighbor = borderLinks.get(localAs)!
        if (!perNeighbor.has(remoteAs)) perNeighbor.set(remoteAs, [])
        perNeighbor.get(remoteAs)!.push({ localId, remoteId, latency: l.latency })
      }
    }

    for (const [as, members] of asMembers) {
      const links = intraLinks.get(as) ?? []

      // IGP: full intra-AS shortest-path tables.
      const igp = buildForwardingTables(members, links)
      for (const n of members) {
        const table = tables.get(n.id)!
        for (const [dest, hop] of igp.get(n.id) ?? []) table.set(dest, hop)
      }

      // Hot-potato metric: intra-AS distance from every border router.
      const egresses = borderLinks.get(as) ?? new Map()
      const borderDist = new Map<string, Map<string, number>>()
      for (const perNeighbor of egresses.values()) {
        for (const { localId } of perNeighbor) {
          if (!borderDist.has(localId)) {
            borderDist.set(localId, shortestDistances(localId, members, links))
          }
        }
      }

      // BGP: for every external AS with a selected route, send traffic to the
      // nearest egress toward the next-hop AS; the egress hands it across.
      for (const [destAs, destMembers] of asMembers) {
        if (destAs === as) continue
        const best = this.bgp.getBest(as, destAs)
        if (!best) continue // withdrawn / not yet learned — black hole
        const candidates = egresses.get(best.nextHopAs) ?? []
        if (candidates.length === 0) continue

        for (const n of members) {
          // Nearest egress from this router (hot potato); the border router's
          // own tie-break is the lowest-latency cable to the neighbor AS.
          let bestEgress: { localId: string; remoteId: string; latency: number } | null = null
          let bestCost = Infinity
          for (const c of candidates) {
            const d = borderDist.get(c.localId)?.get(n.id) ?? Infinity
            const cost = d + c.latency
            if (cost < bestCost) {
              bestCost = cost
              bestEgress = c
            }
          }
          if (!bestEgress || bestCost === Infinity) continue

          const hop =
            n.id === bestEgress.localId
              ? bestEgress.remoteId
              : tables.get(n.id)!.get(bestEgress.localId)
          if (!hop) continue
          const table = tables.get(n.id)!
          for (const d of destMembers) table.set(d.id, hop)
        }
      }
    }

    this._forwarding = tables
  }

  // --- BGP dynamics ------------------------------------------------------------

  // Deliver due BGP updates; when any AS changes its mind, reinstall FIBs.
  tick(nowMs: number): void {
    if (this.bgp.tick(nowMs)) this._rebuildForwarding()
  }

  isBgpConverging(): boolean {
    return this.bgp.isConverging()
  }

  getBgpTable(asId: string): BgpRouteView[] {
    return this.bgp.getTable(asId)
  }

  // Cut one submarine cable (or repair the cut one). Prefers a cable that is
  // the *only* link between its two ASes — cutting it drops the eBGP session
  // and triggers genuine route withdrawals — while never partitioning the AS
  // graph outright. Returns the affected link, or null if nothing changed.
  toggleCableCut(nowMs: number): NetworkLink | null {
    if (this._cutLinkId) return this.repairCable(nowMs)
    return this.cutCable(nowMs)
  }

  cutCable(nowMs: number, linkId?: string): NetworkLink | null {
    if (this._cutLinkId) return null
    const inter = this._interAsLinks()
    let target: NetworkLink | undefined
    if (linkId) {
      target = inter.find(l => l.id === linkId)
    } else {
      const pairKey = (l: NetworkLink) =>
        [this._asOf.get(l.sourceId)!, this._asOf.get(l.targetId)!].sort().join('|')
      const perPair = new Map<string, NetworkLink[]>()
      for (const l of inter) {
        const k = pairKey(l)
        if (!perPair.has(k)) perPair.set(k, [])
        perPair.get(k)!.push(l)
      }
      // Sole-cable adjacencies whose loss leaves every AS still connected.
      const candidates = inter.filter(l => {
        if (perPair.get(pairKey(l))!.length !== 1) return false
        return this._asGraphConnectedWithout(l)
      })
      const pool = candidates.length > 0 ? candidates : inter
      target = pool[Math.floor(Math.random() * pool.length)]
    }
    if (!target) return null

    const before = this._asAdjacency()
    target.cut = true
    this._cutLinkId = target.id
    const a = this._asOf.get(target.sourceId)!
    const b = this._asOf.get(target.targetId)!
    // Session drops only when that was the last cable between the two ASes.
    if (before.get(a)?.has(b) && !this._asAdjacency().get(a)?.has(b)) {
      this.bgp.sessionDown(a, b, nowMs)
    }
    this._rebuildForwarding()
    return target
  }

  repairCable(nowMs: number): NetworkLink | null {
    if (!this._cutLinkId) return null
    const link = this.links.find(l => l.id === this._cutLinkId)
    this._cutLinkId = null
    if (!link) return null
    const before = this._asAdjacency()
    link.cut = false
    const a = this._asOf.get(link.sourceId)!
    const b = this._asOf.get(link.targetId)!
    if (!before.get(a)?.has(b) && this._asAdjacency().get(a)?.has(b)) {
      this.bgp.sessionUp(a, b, nowMs)
    }
    this._rebuildForwarding()
    return link
  }

  getCutCableLabel(): string | null {
    if (!this._cutLinkId) return null
    const link = this.links.find(l => l.id === this._cutLinkId)
    if (!link) return null
    const name = (id: string) => this.nodes.find(n => n.id === id)?.label ?? id
    return `${name(link.sourceId)} — ${name(link.targetId)}`
  }

  // Would the AS-level graph stay connected if this cable were removed?
  private _asGraphConnectedWithout(cut: NetworkLink): boolean {
    const adj = new Map<string, Set<string>>(this._allAses().map(a => [a, new Set<string>()]))
    for (const l of this._interAsLinks()) {
      if (l.id === cut.id) continue
      const a = this._asOf.get(l.sourceId)!
      const b = this._asOf.get(l.targetId)!
      adj.get(a)?.add(b)
      adj.get(b)?.add(a)
    }
    const ases = this._allAses()
    const seen = new Set<string>([ases[0]])
    const stack = [ases[0]]
    while (stack.length > 0) {
      for (const nb of adj.get(stack.pop()!) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    return seen.size === ases.length
  }

  // --- Lookups -----------------------------------------------------------------

  // The per-hop routing decision: the router at `fromId` looks up `destId` in
  // its own table and returns the neighbor to forward to, or null if it has no
  // route (destination unreachable — e.g. withdrawn or behind a firewall).
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
  // carried by packets. Null if some router along the way has no route (or the
  // tables transiently loop during BGP convergence).
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
    // An IGP-level event: the DC hosts drop out of the intra-AS tables. BGP is
    // untouched — the AS still advertises its prefix, like the real thing.
    this._rebuildForwarding()
  }

  isFirewallUp(): boolean {
    // "Firewall up" = data centers are blocking (inactive)
    return this.nodes.some(n => n.type === 'datacenter' && !n.active)
  }

  getActiveNodes(): NetworkNode[] {
    return this.nodes.filter(n => n.active)
  }

  // Links are usable only when both endpoints are active and the cable intact.
  getActiveLinks(): NetworkLink[] {
    const activeIds = new Set(this.getActiveNodes().map(n => n.id))
    return this.links.filter(
      l => !l.cut && activeIds.has(l.sourceId) && activeIds.has(l.targetId),
    )
  }

  reset(): void {
    this.nodes = INITIAL_NODES.map(n => ({ ...n }))
    this.links = INITIAL_LINKS.map(l => ({ ...l }))
    this._positionCache = this._buildPositionCache()
    this._cutLinkId = null
    this._asOf = this._assignAses()
    this.bgp = new BgpEngine(this._allAses(), this._asAdjacency())
    this._rebuildForwarding()
  }
}
