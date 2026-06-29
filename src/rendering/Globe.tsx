import { memo, useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { GLOBE_RADIUS, latLongToVec3 } from '../config/globe'

// The Earth: a dark ocean sphere, a lat/long graticule, and a soft atmosphere
// glow. Continents are implied by the labeled cities and the cable arcs above.
export const Globe = memo(function Globe() {
  // Graticule: meridians (constant longitude) + parallels (constant latitude),
  // sampled just above the surface so they read as grid lines on the globe.
  const grid = useMemo(() => {
    const r = GLOBE_RADIUS * 1.001
    const lines: THREE.Vector3[][] = []

    for (let long = -180; long < 180; long += 30) {
      const pts: THREE.Vector3[] = []
      for (let lat = -90; lat <= 90; lat += 5) {
        pts.push(new THREE.Vector3(...latLongToVec3(lat, long, r)))
      }
      lines.push(pts)
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: THREE.Vector3[] = []
      for (let long = -180; long <= 180; long += 5) {
        pts.push(new THREE.Vector3(...latLongToVec3(lat, long, r)))
      }
      lines.push(pts)
    }
    return lines
  }, [])

  return (
    <group>
      {/* Ocean sphere */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS, 64, 64]} />
        <meshStandardMaterial color="#0a2540" emissive="#06121f" emissiveIntensity={0.5} roughness={0.85} metalness={0.1} />
      </mesh>

      {/* Equator highlight */}
      <Line
        points={Array.from({ length: 145 }, (_, i) =>
          new THREE.Vector3(...latLongToVec3(0, -180 + i * 2.5, GLOBE_RADIUS * 1.002)),
        )}
        color="#2dd4bf"
        lineWidth={1.2}
        transparent
        opacity={0.5}
      />

      {/* Graticule */}
      {grid.map((pts, i) => (
        <Line key={i} points={pts} color="#1d4e6b" lineWidth={0.7} transparent opacity={0.35} />
      ))}

      {/* Atmosphere glow (back-side shell) */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.05, 48, 48]} />
        <meshBasicMaterial color="#3aa0ff" transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  )
})
