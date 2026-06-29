import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { NetworkLink, NetworkNode } from '../types/network'
import { arcPoint } from '../config/globe'

interface LinkMeshProps {
  link: NetworkLink
  nodes: NetworkNode[]
}

// A network link drawn as a lifted great-circle arc between two cities — the
// way submarine and terrestrial cables span the globe. A faint solid arc shows
// the route; an animated dashed overlay suggests live data flowing along it.
export function LinkMesh({ link, nodes }: LinkMeshProps) {
  const source = nodes.find(n => n.id === link.sourceId)
  const target = nodes.find(n => n.id === link.targetId)
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

  const isActive = source.active && target.active
  const baseOpacity = isActive ? 0.18 : 0.04
  const flowOpacity = isActive ? 0.55 : 0

  return (
    <group>
      <Line points={points} color="#1f5e86" lineWidth={1} transparent opacity={baseOpacity} />
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
}
