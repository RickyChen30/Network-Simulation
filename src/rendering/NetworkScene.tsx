import { useRef, useEffect, useMemo } from 'react'
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
import { CityDetail } from './CityDetail'
import { CAMERA_POSITION, CAMERA_TARGET } from '../config/constants'

interface NetworkSceneProps {
  engine: SimulationEngine
  onStatsChange: (stats: SimulationStats, packets: Packet[]) => void
  focusedId: string | null
  onFocus: (id: string | null) => void
}

// Reusable scratch vectors (avoid per-frame allocation during the camera fly).
const _p = new THREE.Vector3()
const _n = new THREE.Vector3()
const _t = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _x = new THREE.Vector3(1, 0, 0)
const DEFAULT_CAM = new THREE.Vector3(...CAMERA_POSITION)
const DEFAULT_TGT = new THREE.Vector3(...CAMERA_TARGET)

// Root of the 3D world: the globe, the network laid over it, the camera fly-to,
// and post-processing. The engine tick runs here via useFrame so simulation and
// render stay in sync.
export function NetworkScene({ engine, onStatsChange, focusedId, onFocus }: NetworkSceneProps) {
  const clockRef = useRef(new THREE.Clock())
  const realTimeRef = useRef(0)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null)
  const animatingRef = useRef(false)
  const prevFocusRef = useRef<string | null>(null)
  const desiredCam = useRef(new THREE.Vector3())
  const desiredTgt = useRef(new THREE.Vector3())

  useEffect(() => {
    engine.onStateChange = onStatsChange
  }, [engine, onStatsChange])

  const { nodes, links } = engine.graph
  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const focusedNode = focusedId ? nodeMap.get(focusedId) : undefined

  // Fill desiredCam / desiredTgt for the current focus target.
  const fillDesired = () => {
    const node = focusedId ? nodeMap.get(focusedId) : undefined
    if (!node) {
      desiredCam.current.copy(DEFAULT_CAM)
      desiredTgt.current.copy(DEFAULT_TGT)
      return
    }
    _p.set(...node.position)
    _n.copy(_p).normalize()
    _t.copy(_up).cross(_n)
    if (_t.lengthSq() < 1e-4) _t.copy(_x).cross(_n)
    _t.normalize()
    // Look down almost vertically so the city reads cleanly on the map (a small
    // tangential offset keeps a hint of 3D rather than a perfectly flat view).
    desiredCam.current.copy(_p).addScaledVector(_n, 2.5).addScaledVector(_t, 0.45)
    desiredTgt.current.copy(_p).addScaledVector(_n, 0.05)
  }

  useFrame(({ camera }) => {
    const delta = Math.min(clockRef.current.getDelta(), 0.1)
    realTimeRef.current += delta * 1000
    engine.tick(delta, realTimeRef.current)

    const controls = controlsRef.current
    if (!controls) return

    // Begin a fly whenever the focus target changes.
    if (prevFocusRef.current !== focusedId) {
      prevFocusRef.current = focusedId
      animatingRef.current = true
      controls.enabled = false
      controls.autoRotate = false
      controls.minDistance = 0.4
      controls.maxDistance = 60
    }

    if (animatingRef.current) {
      fillDesired()
      camera.position.lerp(desiredCam.current, 0.1)
      controls.target.lerp(desiredTgt.current, 0.1)
      camera.lookAt(controls.target)

      if (
        camera.position.distanceTo(desiredCam.current) < 0.04 &&
        controls.target.distanceTo(desiredTgt.current) < 0.04
      ) {
        animatingRef.current = false
        controls.enabled = true
        controls.autoRotate = !focusedId
        controls.minDistance = focusedId ? 0.8 : 12
        controls.maxDistance = focusedId ? 12 : 45
        controls.update()
      }
    }
  })

  const packets = engine.packets
  const positionCache = engine.getPositionCache()

  return (
    <>
      {/* Navigate the globe: drag to spin, scroll to zoom. Gentle auto-spin. */}
      <OrbitControls
        ref={controlsRef}
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

      {/* A detailed city appears at the focused location */}
      {focusedNode && <CityDetail node={focusedNode} />}

      {/* Cable arcs first, then city markers on top */}
      {links.map(link => (
        <LinkMesh key={link.id} link={link} nodes={nodes} />
      ))}

      {nodes.map(node => (
        <NodeMesh key={node.id} node={node} showLabel={!focusedId} onFocus={onFocus} />
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
