import { memo, useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { NetworkNode } from '../types/network'
import { NODE_COLORS } from '../config/topology'
import { NODE_SIZE, NODE_GLOW } from '../config/constants'

interface NodeMeshProps {
  node: NetworkNode
  // Scalar mirror of node.active (the node object mutates in place), so the
  // memoized component re-renders exactly when the firewall flips it.
  active: boolean
  showLabel: boolean
  onFocus: (id: string) => void
}

// A glowing marker sitting on the globe surface, with a soft pulsing halo and a
// clickable label offset radially outward. Clicking the marker or its label
// flies the camera into that city. The label fades out when the city rotates to
// the far side of the globe so it never shows through the planet.
// Memoized: markers only change when the firewall or label visibility flips,
// not on every HUD update.
export const NodeMesh = memo(function NodeMesh({ node, active, showLabel, onFocus }: NodeMeshProps) {
  const haloRef = useRef<THREE.Mesh>(null)
  const labelRef = useRef<HTMLDivElement>(null)

  const color = NODE_COLORS[node.type]
  const size = NODE_SIZE[node.type]
  const glow = NODE_GLOW[node.type]
  const opacity = active ? 1 : 0.2
  const labelOpacity = active ? 0.95 : 0.45

  // Surface-normal direction (node sits on a sphere centered at the origin).
  const normal = useMemo<[number, number, number]>(() => {
    const [x, y, z] = node.position
    const len = Math.hypot(x, y, z) || 1
    return [x / len, y / len, z / len]
  }, [node.position])

  const labelPos = useMemo<[number, number, number]>(() => {
    const off = size + 0.35
    return [normal[0] * off, normal[1] * off, normal[2] * off]
  }, [normal, size])

  const phase = useMemo(() => Math.random() * Math.PI * 2, [])

  // Metro cities label only when zoomed in (avoids a wall of labels on the
  // full-globe view); backbone hubs / data centers / servers always label.
  const isCity = node.type === 'home'

  useFrame(({ clock, camera }) => {
    if (haloRef.current) {
      const t = clock.getElapsedTime()
      haloRef.current.scale.setScalar(1 + Math.sin(t * 2 + phase) * 0.18)
    }
    if (labelRef.current) {
      const cp = camera.position
      const cl = Math.hypot(cp.x, cp.y, cp.z) || 1
      // Hide labels on the far hemisphere, and city labels when zoomed out.
      const facing = (normal[0] * cp.x + normal[1] * cp.y + normal[2] * cp.z) / cl
      const visible = facing > 0.05 && !(isCity && cl > 22)
      labelRef.current.style.opacity = String(visible ? labelOpacity : 0)
    }
  })

  const focus = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onFocus(node.id)
  }

  return (
    <group position={node.position}>
      {/* Soft halo */}
      <mesh ref={haloRef}>
        <sphereGeometry args={[size * 2, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.18 * opacity} depthWrite={false} />
      </mesh>

      {/* Marker core (clickable) */}
      <mesh
        onClick={focus}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = 'auto')}
      >
        <sphereGeometry args={[size, 20, 20]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={glow * opacity}
          roughness={0.3}
          metalness={0.4}
          toneMapped={false}
        />
      </mesh>

      {/* Label (clickable) — hidden while a city is focused, to keep it clean */}
      {showLabel && (
        <Html position={labelPos} center distanceFactor={22} zIndexRange={[10, 0]}>
          <div
            ref={labelRef}
            onClick={focus}
            style={{ cursor: 'pointer', pointerEvents: 'auto', opacity: labelOpacity }}
            className="px-1.5 py-0.5 rounded text-center whitespace-nowrap text-slate-100 bg-slate-950/65 border border-white/10 hover:border-teal-300/60 transition-colors"
          >
            <div className="text-[11px] font-medium tracking-wide leading-tight">{node.label}</div>
          </div>
        </Html>
      )}
    </group>
  )
})
