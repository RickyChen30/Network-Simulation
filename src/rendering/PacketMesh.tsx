import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Trail } from '@react-three/drei'
import * as THREE from 'three'
import type { Packet } from '../types/network'
import { PACKET_RADIUS } from '../config/constants'
import { getPacketWorldPosition } from '../engine/packet'

interface PacketMeshProps {
  packet: Packet
  positionCache: Map<string, [number, number, number]>
  selected: boolean
  onSelect: (packet: Packet) => void
}

// A packet is a small glowing sphere that leaves a comet-like trail as it
// interpolates between nodes. Position comes straight from engine state each
// frame, so React never re-renders just to move a packet. Clicking a packet
// selects its flow (a larger invisible sphere makes the tiny target easier).
export function PacketMesh({ packet, positionCache, selected, onSelect }: PacketMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const haloRef = useRef<THREE.Mesh>(null)

  useFrame(({ clock }) => {
    if (!meshRef.current || packet.status !== 'in-flight') return
    const pos = getPacketWorldPosition(packet, positionCache)
    meshRef.current.position.set(...pos)
    if (selected && haloRef.current) {
      haloRef.current.scale.setScalar(1 + Math.sin(clock.getElapsedTime() * 6) * 0.15)
    }
  })

  // Dropped packets flash red and fade; control segments are smaller than data.
  const dropped = packet.status === 'dropped'
  const fading = packet.status === 'delivered' ? 0.3 : 1
  const color = dropped ? '#ef4444' : packet.color
  const radius = PACKET_RADIUS * (packet.control ? 0.7 : 1.1) * (selected ? 1.5 : 1)

  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onSelect(packet)
  }

  return (
    <Trail
      width={(packet.control ? 1.4 : 2.2) * (selected ? 1.6 : 1)}
      length={selected ? 8 : 5}
      color={new THREE.Color(selected ? '#ffffff' : color)}
      attenuation={w => w * w}
      decay={1.2}
    >
      <mesh ref={meshRef}>
        <sphereGeometry args={[radius, 14, 14]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={2.2 * fading}
          roughness={0.1}
          metalness={0.3}
          toneMapped={false}
        />

        {/* Selection halo */}
        {selected && (
          <mesh ref={haloRef}>
            <sphereGeometry args={[radius * 2.2, 16, 16]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        )}

        {/* Enlarged invisible hit target for easier clicking */}
        <mesh
          onClick={handleClick}
          onPointerOver={() => (document.body.style.cursor = 'pointer')}
          onPointerOut={() => (document.body.style.cursor = 'auto')}
        >
          <sphereGeometry args={[PACKET_RADIUS * 3.5, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </mesh>
    </Trail>
  )
}
