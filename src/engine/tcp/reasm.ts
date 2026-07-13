import { seqLt, seqLeq, seqGt } from './seq'

// Receive-side reassembly of out-of-order data.
//
// TCP delivers a byte stream in order, but segments can arrive with gaps (a
// middle segment was dropped) or overlaps (a retransmission). This tracks the
// byte RANGES that have arrived past `rcvNxt` as a sorted list of disjoint,
// non-adjacent [start, end) intervals in 32-bit sequence space. When the gap in
// front of `rcvNxt` fills, `advance()` reports how far the contiguous, in-order
// data now extends.
//
// Content is not stored — GlobeNet's payload is a pure function of stream offset
// (see the plan), so only which ranges arrived matters for correctness.

interface Range {
  start: number // inclusive, 32-bit seq
  end: number // exclusive
}

export class Reasm {
  private ranges: Range[] = []

  /** Record that bytes [seq, seq+len) have arrived. len may be 0 (no-op). */
  insert(seq: number, len: number): void {
    if (len <= 0) return
    const start = seq
    const end = (seq + len) >>> 0

    // Insert then coalesce with any ranges it touches or overlaps. Kept simple
    // (linear) — a connection has at most a handful of outstanding holes.
    const next: Range[] = []
    let ns = start
    let ne = end
    let placed = false
    for (const r of this.ranges) {
      if (seqLt(r.end, ns) && !adjacent(r.end, ns)) {
        // r is entirely before the new range, with a real gap → keep as-is.
        next.push(r)
      } else if (seqGt(r.start, ne) && !adjacent(ne, r.start)) {
        // r is entirely after → flush the merged range first (once).
        if (!placed) {
          next.push({ start: ns, end: ne })
          placed = true
        }
        next.push(r)
      } else {
        // Overlap or adjacency → merge into the running range.
        if (seqLt(r.start, ns)) ns = r.start
        if (seqGt(r.end, ne)) ne = r.end
      }
    }
    if (!placed) next.push({ start: ns, end: ne })
    // Keep sorted by start (serial order) for the advance scan.
    next.sort((a, b) => (seqLt(a.start, b.start) ? -1 : seqGt(a.start, b.start) ? 1 : 0))
    this.ranges = next
  }

  /**
   * Given the current in-order boundary `rcvNxt`, absorb any buffered range that
   * begins at or before it, and return the new `rcvNxt`. Bytes fully below the
   * boundary (pure duplicates) are discarded.
   */
  advance(rcvNxt: number): number {
    let nxt = rcvNxt
    const keep: Range[] = []
    for (const r of this.ranges) {
      if (seqLeq(r.end, nxt)) continue // wholly delivered already
      if (seqLeq(r.start, nxt)) {
        if (seqGt(r.end, nxt)) nxt = r.end // extends the contiguous region
      } else {
        keep.push(r) // still a gap in front of it
      }
    }
    this.ranges = keep
    return nxt
  }

  /** True if any out-of-order (gapped) data is buffered — sender should dup-ACK. */
  hasGaps(): boolean {
    return this.ranges.length > 0
  }

  reset(): void {
    this.ranges = []
  }
}

// Two boundaries are adjacent when one range ends exactly where the next begins.
function adjacent(end: number, start: number): boolean {
  return end === start
}
