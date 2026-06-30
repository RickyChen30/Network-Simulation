import { useRef, useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { Packet, SimulationStats, NetworkNode } from '../types/network'
import { SimulationEngine } from '../engine/simulation'
import { angularDistance, GLOBE_RADIUS } from '../config/globe'
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

// Reusable scratch vector (avoid per-frame allocation).
const _p = new THREE.Vector3()
const DEFAULT_CAM = new THREE.Vector3(...CAMERA_POSITION)
const DEFAULT_TGT = new THREE.Vector3(...CAMERA_TARGET)

// Decide which nodes get a visible marker so co-located infrastructure doesn't
// stack up (e.g. New York's IXP, its data center and servers become one city).
// Servers are never drawn; other nodes are dropped if a higher-priority marker
// already sits within ~140 km. Hidden nodes still exist for routing.
const MARKER_PRIORITY: Record<string, number> = {
  gateway: 4,
  'core-router': 4,
  home: 3,
  'isp-router': 2,
  'home-router': 1,
  datacenter: 1,
  server: -1,
}
const MARKER_MIN_ANGLE = 0.022 // radians (~140 km)

function dedupeMarkers(nodes: NetworkNode[]): NetworkNode[] {
  const sorted = [...nodes].sort(
    (a, b) => (MARKER_PRIORITY[b.type] ?? 0) - (MARKER_PRIORITY[a.type] ?? 0),
  )
  const kept: NetworkNode[] = []
  for (const n of sorted) {
    if (n.type === 'server') continue
    let overlaps = false
    for (const k of kept) {
      if (angularDistance(n.position, k.position) < MARKER_MIN_ANGLE) {
        overlaps = true
        break
      }
    }
    if (!overlaps) kept.push(n)
  }
  return kept
}

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
  const markerNodes = useMemo(() => dedupeMarkers(nodes), [nodes])

  // The continent of the clicked city, and its visible cities.
  const focusedContinent = focusedNode?.continent
  const continentCities = useMemo(
    () => (focusedContinent ? markerNodes.filter(n => n.continent === focusedContinent) : []),
    [markerNodes, focusedContinent],
  )

  // Camera framing for the focused continent (centroid + bounding radius).
  const focusView = useMemo(() => {
    if (continentCities.length === 0) return null
    const sum = new THREE.Vector3()
    for (const c of continentCities) sum.add(_p.set(...c.position))
    const cn = sum.normalize()
    const surface = cn.clone().multiplyScalar(GLOBE_RADIUS)
    const surfaceArr: [number, number, number] = [surface.x, surface.y, surface.z]
    let theta = 0
    for (const c of continentCities) theta = Math.max(theta, angularDistance(surfaceArr, c.position))
    const height = Math.min(28, Math.max(6, theta * 24 + 3))
    let t = new THREE.Vector3(0, 1, 0).cross(cn)
    if (t.lengthSq() < 1e-4) t = new THREE.Vector3(1, 0, 0).cross(cn)
    t.normalize()
    const cam = surface.clone().addScaledVector(cn, height).addScaledVector(t, height * 0.12)
    return { cam, tgt: surface.clone() }
  }, [continentCities])

  // Fill desiredCam / desiredTgt for the current focus target.
  const fillDesired = () => {
    if (focusView) {
      desiredCam.current.copy(focusView.cam)
      desiredTgt.current.copy(focusView.tgt)
    } else {
      desiredCam.current.copy(DEFAULT_CAM)
      desiredTgt.current.copy(DEFAULT_TGT)
    }
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
        controls.minDistance = focusedId ? 3 : 12
        controls.maxDistance = focusedId ? 55 : 45
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

      {/* Continent view: when a city is clicked, every city on its continent
          becomes a building cluster (compact, no per-city local network). */}
      {continentCities.map(city => (
        <CityDetail key={city.id} node={city} radius={0.55} maxBuildings={80} showNetwork={false} />
      ))}

      {/* Cable arcs first, then city markers on top */}
      {links.map(link => (
        <LinkMesh key={link.id} link={link} nodes={nodes} />
      ))}

      {/* City markers — de-duplicated so each metro shows one point. Cities on
          the focused continent are hidden (their building clusters stand in). */}
      {markerNodes
        .filter(node => node.continent !== focusedContinent)
        .map(node => (
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
