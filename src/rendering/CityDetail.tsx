import { useMemo } from 'react'
import { Instances, Instance, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { NetworkNode } from '../types/network'

interface CityDetailProps {
  node: NetworkNode
}

// Deterministic PRNG seeded from the city id, so each city's layout is stable.
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

const BUILDING_COLORS = ['#3c4250', '#454b57', '#343a44', '#4a4036', '#2f3b46', '#514a42', '#3e4654']
const ROOF_LIGHT_COLORS = ['#ffe6a3', '#cfe3ff', '#ffd28a', '#fff4d6']

const RADIUS = 1.4
const GRID = 8
const CELL = (RADIUS * 2) / GRID

interface Building { x: number; z: number; w: number; h: number; d: number; color: string }
interface RoofLight { x: number; y: number; z: number; color: string }
interface Patch { x: number; z: number; w: number; d: number; color: string }

// A realistic top-down cityscape laid tangent to the globe at a focused city:
// an asphalt ground, a street grid forming blocks, buildings of varying height
// (taller downtown), a park and a waterfront, and warm rooftop lights. The
// group is oriented so local +Y follows the surface normal.
export function CityDetail({ node }: CityDetailProps) {
  const quaternion = useMemo(() => {
    const normal = new THREE.Vector3(...node.position).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal)
  }, [node.position])

  const { buildings, roofLights, patches, roads } = useMemo(() => {
    const rng = makeRng(node.id)
    const buildings: Building[] = []
    const roofLights: RoofLight[] = []
    const patches: Patch[] = []
    const roads: THREE.Vector3[][] = []

    const coastCol = rng() > 0.5 ? GRID - 1 : 0 // a waterfront edge
    const parkGi = 1 + Math.floor(rng() * (GRID - 2))
    const parkGj = 1 + Math.floor(rng() * (GRID - 2))

    for (let gi = 0; gi < GRID; gi++) {
      for (let gj = 0; gj < GRID; gj++) {
        const cx = -RADIUS + (gi + 0.5) * CELL
        const cz = -RADIUS + (gj + 0.5) * CELL
        if (Math.hypot(cx, cz) > RADIUS) continue

        const distFactor = Math.max(0, 1 - Math.hypot(cx, cz) / RADIUS)

        // Waterfront column → blue water plate.
        if (gi === coastCol) {
          patches.push({ x: cx, z: cz, w: CELL, d: CELL, color: '#0b2a3a' })
          continue
        }
        // A green park block.
        if (gi === parkGi && gj === parkGj) {
          patches.push({ x: cx, z: cz, w: CELL * 0.92, d: CELL * 0.92, color: '#16331f' })
          continue
        }

        // City block → 1 or 2×2 buildings, set back from the streets.
        const lot = CELL * 0.82
        const sub = rng() > 0.55 ? 2 : 1
        const sw = lot / sub
        for (let a = 0; a < sub; a++) {
          for (let b = 0; b < sub; b++) {
            const bx = cx - lot / 2 + sw * (a + 0.5)
            const bz = cz - lot / 2 + sw * (b + 0.5)
            const fw = sw * (0.68 + rng() * 0.26)
            const fd = sw * (0.68 + rng() * 0.26)
            const h = 0.05 + Math.pow(distFactor, 1.2) * 0.55 * (0.4 + rng() * 0.7) + rng() * 0.04
            const color = BUILDING_COLORS[Math.floor(rng() * BUILDING_COLORS.length)]
            buildings.push({ x: bx, z: bz, w: fw, h, d: fd, color })

            // Warm rooftop lights on the taller towers.
            if (h > 0.16 && rng() > 0.45) {
              roofLights.push({
                x: bx + (rng() - 0.5) * fw * 0.4,
                y: h + 0.004,
                z: bz + (rng() - 0.5) * fd * 0.4,
                color: ROOF_LIGHT_COLORS[Math.floor(rng() * ROOF_LIGHT_COLORS.length)],
              })
            }
          }
        }
      }
    }

    // Street grid.
    for (let g = 0; g <= GRID; g++) {
      const o = -RADIUS + g * CELL
      if (Math.abs(o) > RADIUS) continue
      const ext = Math.sqrt(Math.max(0, RADIUS * RADIUS - o * o))
      roads.push([new THREE.Vector3(-ext, 0.006, o), new THREE.Vector3(ext, 0.006, o)])
      roads.push([new THREE.Vector3(o, 0.006, -ext), new THREE.Vector3(o, 0.006, ext)])
    }

    return { buildings, roofLights, patches, roads }
  }, [node.id])

  return (
    <group position={node.position} quaternion={quaternion}>
      {/* Asphalt ground plate */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <circleGeometry args={[RADIUS + 0.1, 64]} />
        <meshStandardMaterial color="#14171d" roughness={0.95} metalness={0.05} />
      </mesh>

      {/* Parks & water */}
      {patches.map((p, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[p.x, 0.004, p.z]}>
          <planeGeometry args={[p.w, p.d]} />
          <meshStandardMaterial color={p.color} roughness={0.8} metalness={p.color === '#0b2a3a' ? 0.4 : 0.1} />
        </mesh>
      ))}

      {/* Streets */}
      {roads.map((pts, i) => (
        <Line key={i} points={pts} color="#3a4658" lineWidth={0.7} transparent opacity={0.5} />
      ))}

      {/* Buildings */}
      <Instances limit={buildings.length} range={buildings.length} castShadow>
        <boxGeometry />
        <meshStandardMaterial roughness={0.72} metalness={0.28} />
        {buildings.map((b, i) => (
          <Instance key={i} position={[b.x, b.h / 2, b.z]} scale={[b.w, b.h, b.d]} color={b.color} />
        ))}
      </Instances>

      {/* Rooftop lights */}
      <Instances limit={roofLights.length} range={roofLights.length}>
        <boxGeometry />
        <meshBasicMaterial toneMapped={false} />
        {roofLights.map((r, i) => (
          <Instance key={i} position={[r.x, r.y, r.z]} scale={[0.022, 0.012, 0.022]} color={r.color} />
        ))}
      </Instances>
    </group>
  )
}
