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
}

// A packet is a small glowing sphere that leaves a comet-like trail as it
// interpolates between nodes. Position comes straight from engine state each
// frame, so React never re-renders just to move a packet.
export function PacketMesh({ packet, positionCache }: PacketMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame(() => {
    if (!meshRef.current || packet.status !== 'in-flight') return
    const pos = getPacketWorldPosition(packet, positionCache)
    meshRef.current.position.set(...pos)
  })

  // Dropped packets flash red and fade; control segments are smaller than data.
  const dropped = packet.status === 'dropped'
  const fading = packet.status === 'delivered' ? 0.3 : 1
  const color = dropped ? '#ef4444' : packet.color
  const radius = PACKET_RADIUS * (packet.control ? 0.7 : 1.1)

  return (
    <Trail
      width={packet.control ? 1.4 : 2.2}
      length={5}
      color={new THREE.Color(color)}
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
      </mesh>
    </Trail>
  )
}
