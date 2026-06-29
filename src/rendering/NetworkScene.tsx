import { useRef, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { Packet, SimulationStats } from '../types/network'
import { SimulationEngine } from '../engine/simulation'
import { NodeMesh } from './NodeMesh'
import { LinkMesh } from './LinkMesh'
import { PacketMesh } from './PacketMesh'
import { Globe } from './Globe'
import { CAMERA_TARGET } from '../config/constants'

interface NetworkSceneProps {
  engine: SimulationEngine
  onStatsChange: (stats: SimulationStats, packets: Packet[]) => void
}

// Root of the 3D world: the globe, the network laid over it, lighting, and the
// post-processing chain. The engine tick runs here via useFrame so simulation
// and render stay in sync.
export function NetworkScene({ engine, onStatsChange }: NetworkSceneProps) {
  const clockRef = useRef(new THREE.Clock())
  const realTimeRef = useRef(0)

  useEffect(() => {
    engine.onStateChange = onStatsChange
  }, [engine, onStatsChange])

  useFrame(() => {
    const delta = Math.min(clockRef.current.getDelta(), 0.1) // clamp big stalls
    realTimeRef.current += delta * 1000
    engine.tick(delta, realTimeRef.current)
  })

  const { nodes, links } = engine.graph
  const packets = engine.packets
  const positionCache = engine.getPositionCache()

  return (
    <>
      {/* Navigate the globe: drag to spin, scroll to zoom. Gentle auto-spin. */}
      <OrbitControls
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.5}
        zoomSpeed={0.8}
        autoRotate
        autoRotateSpeed={0.25}
        maxDistance={45}
        minDistance={12}
        target={CAMERA_TARGET}
      />

      {/* Lighting */}
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#9ecbff', '#0a1024', 0.5]} />
      <directionalLight position={[20, 16, 14]} intensity={1.1} color="#dce9ff" />
      <pointLight position={[-18, -6, -12]} intensity={0.5} color="#2dd4bf" distance={70} />

      {/* Procedural environment for reflections (no HDR download) */}
      <Environment resolution={256} frames={1}>
        <Lightformer intensity={2} position={[0, 6, -14]} scale={[16, 10, 1]} color="#9fc0ff" />
        <Lightformer intensity={1.4} position={[-14, 2, 8]} scale={[8, 8, 1]} color="#ffffff" />
        <Lightformer intensity={1.4} position={[14, 2, 8]} scale={[8, 8, 1]} color="#ffd9b3" />
      </Environment>

      {/* Deep-space backdrop */}
      <Stars radius={140} depth={70} count={3000} factor={4} fade speed={0.2} />

      {/* The Earth */}
      <Globe />

      {/* Cable arcs first, then city markers on top */}
      {links.map(link => (
        <LinkMesh key={link.id} link={link} nodes={nodes} />
      ))}

      {nodes.map(node => (
        <NodeMesh key={node.id} node={node} />
      ))}

      {packets.map(packet => (
        <PacketMesh key={packet.id} packet={packet} positionCache={positionCache} />
      ))}

      {/* Post-processing: bloom + vignette */}
      <EffectComposer>
        <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.2} luminanceSmoothing={0.9} radius={0.7} />
        <Vignette offset={0.25} darkness={0.72} eskil={false} />
      </EffectComposer>
    </>
  )
}
