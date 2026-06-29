// Globe geometry helpers — pure math, no Three.js, so the engine stays
// framework-free and testable.

export const GLOBE_RADIUS = 10

type Vec3 = [number, number, number]

const DEG2RAD = Math.PI / 180

// Convert latitude/longitude to a 3D point on a sphere of the given radius.
export function latLongToVec3(lat: number, long: number, radius = GLOBE_RADIUS): Vec3 {
  const phi = (90 - lat) * DEG2RAD // polar angle from the north pole
  const theta = (long + 180) * DEG2RAD // azimuth
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ]
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Angular (great-circle) distance between two surface points, in radians.
export function angularDistance(a: Vec3, b: Vec3): number {
  const na = normalize(a)
  const nb = normalize(b)
  return Math.acos(clamp(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2], -1, 1))
}

// Point at parameter t (0..1) along the great-circle arc between two surface
// points, lifted above the surface so longer "cables" bow further out. The
// endpoints (t=0, t=1) stay on the surface. Used by both the link arcs and the
// packets so they share the exact same path.
export function arcPoint(a: Vec3, b: Vec3, t: number): Vec3 {
  const na = normalize(a)
  const nb = normalize(b)
  const omega = angularDistance(a, b)

  let p: Vec3
  if (omega < 1e-4) {
    p = na
  } else {
    const s = Math.sin(omega)
    const w0 = Math.sin((1 - t) * omega) / s
    const w1 = Math.sin(t * omega) / s
    p = [na[0] * w0 + nb[0] * w1, na[1] * w0 + nb[1] * w1, na[2] * w0 + nb[2] * w1]
  }
  const pn = normalize(p)

  // Bow the arc outward; height scales with how far the link spans.
  const lift = GLOBE_RADIUS * (1 + 0.22 * (omega / Math.PI) * Math.sin(t * Math.PI))
  return [pn[0] * lift, pn[1] * lift, pn[2] * lift]
}
