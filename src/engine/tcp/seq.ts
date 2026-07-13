// 32-bit TCP sequence-number arithmetic ("serial number" comparisons, RFC 1982).
//
// Sequence numbers wrap at 2^32. Comparisons are only meaningful for values
// within 2^31 of each other, which always holds for a live connection's window.
// The trick: coerce the difference to a signed 32-bit int with `| 0` and test
// its sign — that handles wraparound correctly.

const MOD = 0x1_0000_0000

/** a + n, wrapped into [0, 2^32). */
export function seqAdd(a: number, n: number): number {
  return (a + n) >>> 0
}

/** Signed distance a - b (how far a is ahead of b), in [-2^31, 2^31). */
export function seqDiff(a: number, b: number): number {
  return (a - b) | 0
}

export function seqLt(a: number, b: number): boolean {
  return ((a - b) | 0) < 0
}
export function seqLeq(a: number, b: number): boolean {
  return ((a - b) | 0) <= 0
}
export function seqGt(a: number, b: number): boolean {
  return ((a - b) | 0) > 0
}
export function seqGeq(a: number, b: number): boolean {
  return ((a - b) | 0) >= 0
}

/** A random Initial Send Sequence number. */
export function randomIsn(): number {
  return Math.floor(Math.random() * MOD) >>> 0
}
