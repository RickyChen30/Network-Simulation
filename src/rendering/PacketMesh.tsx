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

  const fading = packet.status === 'delivered' ? 0.25 : 1

  return (
    <Trail
      width={packet.kind === 'response' ? 2.0 : 1.7}
      length={5}
      color={new THREE.Color(packet.color)}
      attenuation={w => w * w}
      decay={1.2}
    >
      <mesh ref={meshRef}>
        <sphereGeometry args={[PACKET_RADIUS, 14, 14]} />
        <meshStandardMaterial
          color={packet.color}
          emissive={packet.color}
          emissiveIntensity={2.2 * fading}
          roughness={0.1}
          metalness={0.3}
          toneMapped={false}
        />
      </mesh>
    </Trail>
  )
}
