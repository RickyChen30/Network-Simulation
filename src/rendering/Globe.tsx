import { memo, Suspense, useEffect, useMemo } from 'react'
import { Line, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { GLOBE_RADIUS, latLongToVec3 } from '../config/globe'

// Textured Earth: NASA "blue marble" land/ocean for realistic continents, a
// topology bump map for terrain relief, and the night-lights map as an emissive
// layer so cities glow on the dark side. Textures live in /public so they load
// locally (no CDN dependency).
function EarthSurface() {
  const textures = useTexture({
    map: '/earth-day.jpg',
    bumpMap: '/earth-bump.png',
    emissiveMap: '/earth-night.jpg',
  })

  // Color maps must be interpreted as sRGB; the bump map stays linear.
  useEffect(() => {
    textures.map.colorSpace = THREE.SRGBColorSpace
    textures.emissiveMap.colorSpace = THREE.SRGBColorSpace
    textures.map.anisotropy = 8
  }, [textures])

  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 96, 96]} />
      <meshStandardMaterial
        map={textures.map}
        bumpMap={textures.bumpMap}
        bumpScale={0.06}
        emissiveMap={textures.emissiveMap}
        emissive={new THREE.Color('#ffd9a0')}
        emissiveIntensity={0.55}
        roughness={0.85}
        metalness={0.05}
      />
    </mesh>
  )
}

// Plain sphere shown while the textures stream in.
function EarthFallback() {
  return (
    <mesh>
      <sphereGeometry args={[GLOBE_RADIUS, 48, 48]} />
      <meshStandardMaterial color="#0a2540" roughness={0.9} metalness={0.1} />
    </mesh>
  )
}

export const Globe = memo(function Globe() {
  // Faint lat/long graticule for orientation, just above the surface.
  const grid = useMemo(() => {
    const r = GLOBE_RADIUS * 1.002
    const lines: THREE.Vector3[][] = []
    for (let long = -180; long < 180; long += 30) {
      const pts: THREE.Vector3[] = []
      for (let lat = -90; lat <= 90; lat += 5) pts.push(new THREE.Vector3(...latLongToVec3(lat, long, r)))
      lines.push(pts)
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: THREE.Vector3[] = []
      for (let long = -180; long <= 180; long += 5) pts.push(new THREE.Vector3(...latLongToVec3(lat, long, r)))
      lines.push(pts)
    }
    return lines
  }, [])

  return (
    <group>
      <Suspense fallback={<EarthFallback />}>
        <EarthSurface />
      </Suspense>

      {/* Subtle graticule */}
      {grid.map((pts, i) => (
        <Line key={i} points={pts} color="#7fb0d0" lineWidth={0.6} transparent opacity={0.1} />
      ))}

      {/* Atmosphere glow (back-side shell) */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.06, 48, 48]} />
        <meshBasicMaterial color="#4aa3ff" transparent opacity={0.12} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  )
})
