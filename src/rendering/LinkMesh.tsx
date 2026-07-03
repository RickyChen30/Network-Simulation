import { memo, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { NetworkLink, NetworkNode } from '../types/network'
import { arcPoint } from '../config/globe'

interface LinkMeshProps {
  link: NetworkLink
  source: NetworkNode | undefined
  target: NetworkNode | undefined
  // Passed as scalars (not read off the mutated link/node objects) so the
  // memoized component re-renders exactly when they change.
  active: boolean
  cut: boolean
}

// A network link drawn as a lifted great-circle arc between two cities — the
// way submarine and terrestrial cables span the globe. A faint solid arc shows
// the route; an animated dashed overlay suggests live data flowing along it.
// Memoized: the scene re-renders on every HUD update, but a link only changes
// when it's cut or an endpoint goes down.
export const LinkMesh = memo(function LinkMesh({ link, source, target, active, cut }: LinkMeshProps) {
  const flowLineRef = useRef<{ material: { dashOffset: number } } | null>(null)

  const points = useMemo<THREE.Vector3[]>(() => {
    if (!source || !target) return []
    const steps = 48
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= steps; i++) {
      pts.push(new THREE.Vector3(...arcPoint(source.position, target.position, i / steps)))
    }
    return pts
  }, [source, target])

  const flowSpeed = useMemo(() => 0.4 + (link.bandwidth / 800) * 1.6, [link.bandwidth])

  useFrame((_, delta) => {
    if (flowLineRef.current) flowLineRef.current.material.dashOffset -= delta * flowSpeed
  })

  if (points.length < 2 || !source || !target) return null

  const isCut = cut
  const isActive = active && !isCut
  const baseOpacity = isCut ? 0.45 : isActive ? 0.18 : 0.04
  const flowOpacity = isActive ? 0.55 : 0

  return (
    <group>
      {/* A cut submarine cable glows red with no data flowing on it */}
      <Line
        points={points}
        color={isCut ? '#b91c1c' : '#1f5e86'}
        lineWidth={isCut ? 1.6 : 1}
        transparent
        opacity={baseOpacity}
      />
      <Line
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={flowLineRef as any}
        points={points}
        color="#7dd3fc"
        lineWidth={1.5}
        transparent
        opacity={flowOpacity}
        dashed
        dashSize={0.5}
        gapSize={0.9}
      />
    </group>
  )
})
