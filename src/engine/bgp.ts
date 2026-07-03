import type { BgpRouteView } from '../types/network'
import { BGP_UPDATE_DELAY_MS, BGP_UPDATE_JITTER_MS, BGP_MRAI_MS } from '../config/constants'

// ============================================================================
// BGP between autonomous systems (each continent is one AS).
//
// Every AS originates its own prefix and learns routes to the others from its
// eBGP neighbors. An advertisement carries the full AS_PATH; a receiver
// rejects any path containing its own AS number (loop prevention), keeps one
// candidate per neighbor, and selects a best route: shortest AS_PATH first,
// then lowest next-hop AS as the deterministic tie-break.
//
// The dynamics are what make it realistic: updates between ASes are messages
// with a per-session propagation delay, paced by an MRAI timer, so a change
// (a cable cut, a session coming back) ripples outward AS by AS over seconds.
// During that window ASes route on stale information — packets get black-holed
// or briefly loop — and "path hunting" (an AS trying progressively longer
// stale alternatives before settling) emerges on its own.
// ============================================================================

interface BgpUpdate {
  deliverAt: number
  fromAs: string
  toAs: string
  destAs: string
  // The sender's advertised AS path ([sender, ..., dest]); null = withdrawal.
  asPath: string[] | null
}

export interface BgpRoute {
  destAs: string
  asPath: string[] // path this AS would use, starting at the next-hop AS
  nextHopAs: string
}

export class BgpEngine {
  private _ases: string[]
  private _neighbors: Map<string, Set<string>>
  // as → destAs → neighborAs → the path that neighbor advertised (Adj-RIB-In)
  private _learned: Map<string, Map<string, Map<string, string[]>>>
  // as → destAs → currently selected best route (Loc-RIB)
  private _best: Map<string, Map<string, BgpRoute>>
  private _inflight: BgpUpdate[]
  // "from>to>dest" → when the last update for it was scheduled (MRAI pacing)
  private _lastScheduled: Map<string, number>
  updatesDelivered = 0

  constructor(ases: string[], adjacency: Map<string, Set<string>>) {
    this._ases = [...ases]
    this._neighbors = new Map([...adjacency].map(([a, s]) => [a, new Set(s)]))
    this._learned = new Map(this._ases.map(a => [a, new Map()]))
    this._best = new Map(this._ases.map(a => [a, new Map()]))
    this._inflight = []
    this._lastScheduled = new Map()
    this._convergeInstantly()
  }

  // Initial convergence is done synchronously — the sim starts at the steady
  // state real operators live in. Only *changes* (cuts, repairs) propagate
  // with realistic delay. Plain Bellman-Ford-style rounds over the AS graph.
  private _convergeInstantly(): void {
    for (let round = 0; round < this._ases.length + 1; round++) {
      let changed = false
      for (const as of this._ases) {
        for (const neighbor of this._neighbors.get(as) ?? []) {
          // `neighbor` advertises its best route for every dest to `as`.
          for (const dest of this._ases) {
            if (dest === as) continue
            const advertised = this._advertisedPath(neighbor, dest)
            if (this._storeLearned(as, dest, neighbor, advertised)) changed = true
          }
        }
      }
      for (const as of this._ases) {
        for (const dest of this._ases) {
          if (dest !== as && this._reselect(as, dest)) changed = true
        }
      }
      if (!changed) break
    }
  }

  // What `as` would put on the wire for `dest`: its own AS prepended to its
  // best path (or just itself when it originates the prefix). Null = no route.
  private _advertisedPath(as: string, dest: string): string[] | null {
    if (dest === as) return [as]
    const best = this._best.get(as)?.get(dest)
    return best ? [as, ...best.asPath] : null
  }

  // Store/replace/withdraw a learned path. Returns true if anything changed.
  private _storeLearned(as: string, dest: string, neighbor: string, path: string[] | null): boolean {
    const perDest = this._learned.get(as)!
    if (!perDest.has(dest)) perDest.set(dest, new Map())
    const perNeighbor = perDest.get(dest)!
    const prev = perNeighbor.get(neighbor)
    if (path === null) {
      if (prev === undefined) return false
      perNeighbor.delete(neighbor)
      return true
    }
    if (prev !== undefined && prev.join('|') === path.join('|')) return false
    perNeighbor.set(neighbor, path)
    return true
  }

  // BGP decision process for (as, dest). Returns true if the best changed.
  private _reselect(as: string, dest: string): boolean {
    const candidates: BgpRoute[] = []
    for (const [neighbor, path] of this._learned.get(as)?.get(dest) ?? []) {
      if (!this._neighbors.get(as)?.has(neighbor)) continue // session down
      if (path.includes(as)) continue // AS_PATH loop prevention
      candidates.push({ destAs: dest, asPath: path, nextHopAs: neighbor })
    }
    candidates.sort(
      (a, b) => a.asPath.length - b.asPath.length || a.nextHopAs.localeCompare(b.nextHopAs),
    )
    const next = candidates[0] ?? null
    const prev = this._best.get(as)!.get(dest) ?? null
    const same =
      prev === next ||
      (prev !== null && next !== null && prev.asPath.join('|') === next.asPath.join('|'))
    if (same) return false
    if (next === null) this._best.get(as)!.delete(dest)
    else this._best.get(as)!.set(dest, next)
    return true
  }

  // Queue an update from `as` to each of its neighbors about `dest`, with the
  // session's propagation delay and MRAI pacing. A still-undelivered update
  // for the same (session, dest) is replaced in place — updates coalesce the
  // way a paced BGP speaker only sends its latest best.
  private _scheduleAdverts(as: string, dest: string, now: number): void {
    for (const neighbor of this._neighbors.get(as) ?? []) {
      const key = `${as}>${neighbor}>${dest}`
      const delay = BGP_UPDATE_DELAY_MS + Math.random() * BGP_UPDATE_JITTER_MS
      const earliest = (this._lastScheduled.get(key) ?? -Infinity) + BGP_MRAI_MS
      const deliverAt = Math.max(now + delay, earliest)
      const path = this._advertisedPath(as, dest)
      const pending = this._inflight.find(
        u => u.fromAs === as && u.toAs === neighbor && u.destAs === dest,
      )
      if (pending) {
        pending.asPath = path
        pending.deliverAt = Math.max(pending.deliverAt, now + delay)
      } else {
        this._inflight.push({ deliverAt, fromAs: as, toAs: neighbor, destAs: dest, asPath: path })
        this._lastScheduled.set(key, deliverAt)
      }
    }
  }

  // An eBGP session went down (last cable between the pair was cut): both
  // sides lose everything learned from the other and start re-converging.
  sessionDown(a: string, b: string, now: number): void {
    this._neighbors.get(a)?.delete(b)
    this._neighbors.get(b)?.delete(a)
    for (const [side, gone] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const dest of this._ases) {
        if (dest === side) continue
        this._storeLearned(side, dest, gone, null)
        // Only a changed best is worth telling the neighbors about.
        if (this._reselect(side, dest)) this._scheduleAdverts(side, dest, now)
      }
    }
  }

  // A session came (back) up: both sides advertise their full best tables to
  // each other — including their own originated prefix — delivered with the
  // usual delay, so reconvergence is gradual.
  sessionUp(a: string, b: string, now: number): void {
    this._neighbors.get(a)?.add(b)
    this._neighbors.get(b)?.add(a)
    for (const dest of this._ases) {
      this._scheduleAdverts(a, dest, now)
      this._scheduleAdverts(b, dest, now)
    }
  }

  // Deliver due updates and run the decision process. Returns true if any
  // AS's best route changed (the caller must reinstall FIBs).
  tick(now: number): boolean {
    if (this._inflight.length === 0) return false
    let anyBestChanged = false
    const due = this._inflight.filter(u => u.deliverAt <= now)
    if (due.length === 0) return false
    this._inflight = this._inflight.filter(u => u.deliverAt > now)

    for (const u of due) {
      this.updatesDelivered++
      // The session may have gone down while the update was in flight.
      if (!this._neighbors.get(u.toAs)?.has(u.fromAs)) continue
      this._storeLearned(u.toAs, u.destAs, u.fromAs, u.asPath)
      if (this._reselect(u.toAs, u.destAs)) {
        anyBestChanged = true
        this._scheduleAdverts(u.toAs, u.destAs, now)
      }
    }
    return anyBestChanged
  }

  isConverging(): boolean {
    return this._inflight.length > 0
  }

  getBest(as: string, dest: string): BgpRoute | null {
    if (as === dest) return { destAs: dest, asPath: [], nextHopAs: as }
    return this._best.get(as)?.get(dest) ?? null
  }

  // The AS's selected routes, for the UI panel (sorted by destination).
  getTable(as: string): BgpRouteView[] {
    return this._ases
      .filter(dest => dest !== as)
      .map(dest => this._best.get(as)?.get(dest))
      .filter((r): r is BgpRoute => r !== undefined)
      .map(r => ({ destAs: r.destAs, asPath: r.asPath, nextHopAs: r.nextHopAs }))
      .sort((a, b) => a.destAs.localeCompare(b.destAs))
  }

  getAses(): string[] {
    return [...this._ases]
  }
}
