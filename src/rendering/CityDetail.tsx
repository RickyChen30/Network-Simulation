import { useMemo, useState, useEffect } from 'react'
import { Instances, Instance } from '@react-three/drei'
import * as THREE from 'three'
import type { NetworkNode } from '../types/network'
import { vec3ToLatLong } from '../config/globe'
import { earthLoaded, onEarthLoaded, isWater } from '../config/earthSampler'

interface CityDetailProps {
  node: NetworkNode
}

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

interface Bld { x: number; z: number; w: number; h: number; d: number; color: string }
interface Light { x: number; y: number; z: number; color: string }

// The focused city's built-up area, sitting directly on the real globe map and
// aligned to the surface normal. Buildings are placed only where the Earth
// texture says there's land, so clicking e.g. Miami drops a town onto Florida —
// houses on the coast, none in the sea. Warm lights make the town read clearly.
export function CityDetail({ node }: CityDetailProps) {
  const [ready, setReady] = useState(earthLoaded())
  useEffect(() => {
    if (!ready) onEarthLoaded(() => setReady(true))
  }, [ready])

  const quaternion = useMemo(() => {
    const n = new THREE.Vector3(...node.position).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n)
  }, [node.position])

  const { buildings, lights } = useMemo(() => {
    const rng = makeRng(node.id)
    const base = new THREE.Vector3(...node.position)
    const tmp = new THREE.Vector3()
    const buildings: Bld[] = []
    const lights: Light[] = []

    const localLatLong = (lx: number, lz: number): [number, number] => {
      tmp.set(lx, 0, lz).applyQuaternion(quaternion).add(base)
      return vec3ToLatLong([tmp.x, tmp.y, tmp.z])
    }

    let attempts = 0
    while (buildings.length < 240 && attempts < 2000) {
      attempts++
      const ang = rng() * Math.PI * 2
      const dist = R * Math.pow(rng(), 0.5) // denser toward the city center
      const lx = Math.cos(ang) * dist
      const lz = Math.sin(ang) * dist
      const [lat, long] = localLatLong(lx, lz)
      if (isWater(lat, long)) continue // keep the town on land

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

      // Most buildings show a warm light so the town glows on the map.
      if (rng() > 0.25) {
        lights.push({
          x: lx + (rng() - 0.5) * w * 0.5,
          y: h + 0.004,
          z: lz + (rng() - 0.5) * d * 0.5,
          color: LIGHT_COLORS[Math.floor(rng() * LIGHT_COLORS.length)],
        })
      }
    }

    return { buildings, lights }
  }, [node.id, ready, quaternion])

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
    </group>
  )
}
