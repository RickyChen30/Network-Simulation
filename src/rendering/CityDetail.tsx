import { useMemo, useState, useEffect, useRef } from 'react'
import { Instances, Instance, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { NetworkNode } from '../types/network'
import { vec3ToLatLong } from '../config/globe'
import { earthLoaded, onEarthLoaded, isWater } from '../config/earthSampler'

interface CityDetailProps {
  node: NetworkNode
}

type V3 = [number, number, number]

function makeRng(seed: string) {
  let a = 0
  for (let i = 0; i < seed.length; i++) a = (a * 31 + seed.charCodeAt(i)) | 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOWER_COLORS = ['#3c4250', '#454b57', '#2f3b46', '#3e4654', '#343a44']
const HOUSE_COLORS = ['#6b5644', '#7a6450', '#5e5346', '#84654a', '#6f5a48', '#574d40']
const LIGHT_COLORS = ['#ffe6a3', '#ffd28a', '#fff4d6', '#cfe3ff']

const R = 1.1
const GROUND_Y = 0.02 // local height of the network layer above the city ground
const UPLINK: V3 = [0, 0.78, 0] // the city's link up to the global internet

interface Bld { x: number; z: number; w: number; h: number; d: number; color: string }
interface Light { x: number; y: number; z: number; color: string }
interface House { pos: V3; dist: V3 }

// --- Animated local-network packets ---------------------------------------
// Small glowing dots that flow house → neighborhood router → city hub → uplink
// (leaving the city), the reverse (arriving), and house ↔ house (local traffic).
function CityPackets({ hub, houses }: { hub: V3; houses: House[] }) {
  const COUNT = 18
  const meshRefs = useRef<(THREE.Mesh | null)[]>([])
  const state = useRef<{ route: V3[]; u: number; speed: number; color: string }[]>([])

  const spawn = () => {
    const pick = () => houses[(Math.random() * houses.length) | 0]
    let route: V3[]
    let color: string
    const r = Math.random()
    if (houses.length === 0) {
      route = [hub, UPLINK]
      color = '#67e8f9'
    } else if (r < 0.42) {
      const h = pick()
      route = [h.pos, h.dist, hub, UPLINK] // upload / request out
      color = '#67e8f9'
    } else if (r < 0.84) {
      const h = pick()
      route = [UPLINK, hub, h.dist, h.pos] // download / response in
      color = '#fde047'
    } else {
      const a = pick()
      const b = pick()
      route = [a.pos, a.dist, b.dist, b.pos] // local traffic
      color = '#a7f3d0'
    }
    // Drop consecutive duplicate points.
    const clean: V3[] = [route[0]]
    for (let i = 1; i < route.length; i++) {
      const p = route[i]
      const q = clean[clean.length - 1]
      if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) clean.push(p)
    }
    if (clean.length < 2) clean.push(UPLINK)
    return { route: clean, u: 0, speed: 0.7 + Math.random() * 0.9, color }
  }

  if (state.current.length === 0) {
    for (let i = 0; i < COUNT; i++) state.current.push(spawn())
  }

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05)
    for (let i = 0; i < COUNT; i++) {
      const p = state.current[i]
      p.u += p.speed * d
      const mesh = meshRefs.current[i]
      if (p.u >= p.route.length - 1) {
        state.current[i] = spawn()
        if (mesh) (mesh.material as THREE.MeshBasicMaterial).color.set(state.current[i].color)
        continue
      }
      const seg = Math.floor(p.u)
      const f = p.u - seg
      const a = p.route[seg]
      const b = p.route[seg + 1]
      if (mesh) mesh.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
    }
  })

  return (
    <>
      {Array.from({ length: COUNT }, (_, i) => (
        <mesh key={i} ref={el => (meshRefs.current[i] = el)}>
          <sphereGeometry args={[0.022, 10, 10]} />
          <meshBasicMaterial color={state.current[i]?.color ?? '#67e8f9'} toneMapped={false} />
        </mesh>
      ))}
    </>
  )
}

// The focused city: buildings on the real land, plus a live local network with
// packets running between the houses and in/out of the city.
export function CityDetail({ node }: CityDetailProps) {
  const [ready, setReady] = useState(earthLoaded())
  useEffect(() => {
    if (!ready) onEarthLoaded(() => setReady(true))
  }, [ready])

  const quaternion = useMemo(() => {
    const n = new THREE.Vector3(...node.position).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n)
  }, [node.position])

  const { buildings, lights, houses, links } = useMemo(() => {
    const rng = makeRng(node.id)
    const base = new THREE.Vector3(...node.position)
    const tmp = new THREE.Vector3()
    const buildings: Bld[] = []
    const lights: Light[] = []

    const localLatLong = (lx: number, lz: number): [number, number] => {
      tmp.set(lx, 0, lz).applyQuaternion(quaternion).add(base)
      return vec3ToLatLong([tmp.x, tmp.y, tmp.z])
    }
    const onLand = (lx: number, lz: number) => {
      const [lat, long] = localLatLong(lx, lz)
      return !isWater(lat, long)
    }

    let attempts = 0
    while (buildings.length < 240 && attempts < 2000) {
      attempts++
      const ang = rng() * Math.PI * 2
      const dist = R * Math.pow(rng(), 0.5)
      const lx = Math.cos(ang) * dist
      const lz = Math.sin(ang) * dist
      if (!onLand(lx, lz)) continue

      const centerF = Math.max(0, 1 - dist / R)
      const tower = rng() < centerF * centerF * 0.7
      const w = tower ? 0.035 + rng() * 0.05 : 0.028 + rng() * 0.03
      const d = tower ? 0.035 + rng() * 0.05 : 0.028 + rng() * 0.03
      const h = tower
        ? 0.1 + Math.pow(centerF, 1.2) * 0.5 * (0.4 + rng() * 0.7)
        : 0.025 + rng() * 0.04
      const color = tower
        ? TOWER_COLORS[Math.floor(rng() * TOWER_COLORS.length)]
        : HOUSE_COLORS[Math.floor(rng() * HOUSE_COLORS.length)]
      buildings.push({ x: lx, z: lz, w, h, d, color })

      if (rng() > 0.25) {
        lights.push({
          x: lx + (rng() - 0.5) * w * 0.5,
          y: h + 0.004,
          z: lz + (rng() - 0.5) * d * 0.5,
          color: LIGHT_COLORS[Math.floor(rng() * LIGHT_COLORS.length)],
        })
      }
    }

    // --- Local network: a hub at the city center, neighborhood routers, and
    // houses wired to their nearest router. ---
    const hub: V3 = [0, GROUND_Y, 0]
    const distNodes: V3[] = []
    for (let k = 0; k < 5; k++) {
      let placed = false
      for (let tryI = 0; tryI < 6 && !placed; tryI++) {
        const ang = (k / 5) * Math.PI * 2 + rng() * 0.7
        const rad = 0.35 + tryI * 0.12 + rng() * 0.08
        const lx = Math.cos(ang) * rad
        const lz = Math.sin(ang) * rad
        if (onLand(lx, lz)) {
          distNodes.push([lx, GROUND_Y, lz])
          placed = true
        }
      }
      if (!placed) {
        const ang = (k / 5) * Math.PI * 2
        distNodes.push([Math.cos(ang) * 0.4, GROUND_Y, Math.sin(ang) * 0.4])
      }
    }

    const nearestDist = (x: number, z: number): V3 => {
      let best = distNodes[0]
      let bd = Infinity
      for (const dn of distNodes) {
        const dx = dn[0] - x
        const dz = dn[2] - z
        const dd = dx * dx + dz * dz
        if (dd < bd) {
          bd = dd
          best = dn
        }
      }
      return best
    }

    const candidates = buildings.filter(b => {
      const dd = Math.hypot(b.x, b.z)
      return dd > 0.12 && dd < R * 0.95
    })
    const houses: House[] = []
    const step = Math.max(1, Math.floor(candidates.length / 18))
    for (let i = 0; i < candidates.length && houses.length < 18; i += step) {
      const b = candidates[i]
      houses.push({ pos: [b.x, GROUND_Y, b.z], dist: nearestDist(b.x, b.z) })
    }

    const links: { a: V3; b: V3; trunk: boolean }[] = []
    for (const dn of distNodes) links.push({ a: hub, b: dn, trunk: true })
    for (const h of houses) links.push({ a: h.dist, b: h.pos, trunk: false })

    return { buildings, lights, houses, links, hub }
  }, [node.id, ready, quaternion])

  const hub: V3 = [0, GROUND_Y, 0]

  return (
    <group position={node.position} quaternion={quaternion}>
      {/* Buildings (placed on land, on top of the real map) */}
      <Instances limit={buildings.length} range={buildings.length} castShadow>
        <boxGeometry />
        <meshStandardMaterial roughness={0.75} metalness={0.2} />
        {buildings.map((b, i) => (
          <Instance key={i} position={[b.x, b.h / 2 + 0.004, b.z]} scale={[b.w, b.h, b.d]} color={b.color} />
        ))}
      </Instances>

      {/* Warm window / rooftop lights */}
      <Instances limit={Math.max(1, lights.length)} range={lights.length}>
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} />
        {lights.map((l, i) => (
          <Instance key={i} position={[l.x, l.y, l.z]} scale={[0.015, 0.008, 0.015]} color={l.color} />
        ))}
      </Instances>

      {/* Local network links */}
      {links.map((l, i) => (
        <Line
          key={i}
          points={[l.a, l.b]}
          color={l.trunk ? '#5cc8f5' : '#46a0c4'}
          lineWidth={l.trunk ? 1.4 : 1}
          transparent
          opacity={l.trunk ? 0.8 : 0.5}
        />
      ))}

      {/* Uplink to the global internet (vertical beam) */}
      <Line points={[hub, UPLINK]} color="#5eead4" lineWidth={1.6} transparent opacity={0.75} />
      <mesh position={UPLINK}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshBasicMaterial color="#5eead4" toneMapped={false} />
      </mesh>

      {/* Hub marker */}
      <mesh position={hub}>
        <sphereGeometry args={[0.035, 14, 14]} />
        <meshBasicMaterial color="#5eead4" toneMapped={false} />
      </mesh>

      {/* Live packets */}
      <CityPackets hub={hub} houses={houses} />
    </group>
  )
}
