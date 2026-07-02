import { useRef, useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Stars, Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { Packet, SimulationStats, NetworkNode } from '../types/network'
import { SimulationEngine } from '../engine/simulation'
import { angularDistance, GLOBE_RADIUS, arcPoint } from '../config/globe'
import { getPacketWorldPosition } from '../engine/packet'
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
  viewMode: 'city' | 'continent'
  onFocus: (id: string | null) => void
  selectedFlowId: string | null
  onSelectPacket: (packet: Packet | null) => void
}

// Reusable scratch vector (avoid per-frame allocation).
const _p = new THREE.Vector3()
const DEFAULT_CAM = new THREE.Vector3(...CAMERA_POSITION)
const DEFAULT_TGT = new THREE.Vector3(...CAMERA_TARGET)
// Distance from globe center for the full-world view.
const GLOBAL_DIST = Math.hypot(...CAMERA_POSITION)

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
export function NetworkScene({
  engine,
  onStatsChange,
  focusedId,
  viewMode,
  onFocus,
  selectedFlowId,
  onSelectPacket,
}: NetworkSceneProps) {
  const clockRef = useRef(new THREE.Clock())
  const realTimeRef = useRef(0)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null)
  const animatingRef = useRef(false)
  const prevFocusRef = useRef<string | null>(null)
  const desiredCam = useRef(new THREE.Vector3())
  const desiredTgt = useRef(new THREE.Vector3())
  // Direction of the last clicked city, so ESC returns to a world view centered
  // on it rather than always snapping back to the default (Americas) view.
  const returnDirRef = useRef<THREE.Vector3 | null>(null)
  // Whether the ride-along (follow a packet) camera is currently driving.
  const followActiveRef = useRef(false)
  const followLastSeenRef = useRef(0)
  const followPosRef = useRef(new THREE.Vector3())
  const followAheadRef = useRef(new THREE.Vector3())

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

  // Camera framing for the focus target: a single city, or the whole continent.
  const focusView = useMemo(() => {
    if (!focusedNode) return null

    if (viewMode === 'city') {
      // Fly down close to the single clicked city (near-vertical).
      const p = new THREE.Vector3(...focusedNode.position)
      const n = p.clone().normalize()
      let t = new THREE.Vector3(0, 1, 0).cross(n)
      if (t.lengthSq() < 1e-4) t = new THREE.Vector3(1, 0, 0).cross(n)
      t.normalize()
      const cam = p.clone().addScaledVector(n, 2.5).addScaledVector(t, 0.45)
      const tgt = p.clone().addScaledVector(n, 0.05)
      return { cam, tgt }
    }

    // Continent view: frame the whole continent (centroid + bounding radius).
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
  }, [focusedNode, viewMode, continentCities])

  // Fill desiredCam / desiredTgt for the current focus target.
  const fillDesired = () => {
    if (focusView) {
      desiredCam.current.copy(focusView.cam)
      desiredTgt.current.copy(focusView.tgt)
    } else if (returnDirRef.current) {
      // Zoom back out but keep the clicked city centered in the world view.
      desiredCam.current.copy(returnDirRef.current).multiplyScalar(GLOBAL_DIST)
      desiredTgt.current.set(0, 0, 0)
    } else {
      desiredCam.current.copy(DEFAULT_CAM)
      desiredTgt.current.copy(DEFAULT_TGT)
    }
  }

  // Stop riding a packet and animate the camera back out to the world view.
  const startReturnToWorld = () => {
    const controls = controlsRef.current
    followActiveRef.current = false
    onSelectPacket(null)
    onFocus(null)
    animatingRef.current = true
    if (controls) {
      controls.enabled = false
      controls.autoRotate = false
      controls.minDistance = 0.4
      controls.maxDistance = 60
    }
  }

  useFrame(({ camera }) => {
    const delta = Math.min(clockRef.current.getDelta(), 0.1)
    realTimeRef.current += delta * 1000
    engine.tick(delta, realTimeRef.current)

    const controls = controlsRef.current
    if (!controls) return

    // --- Ride along a selected packet's flow ---
    if (selectedFlowId) {
      // Queued packets count too — the chase cam holds at the router while the
      // ridden packet waits in an output queue.
      const pkt = engine.packets.find(
        p => p.flowId === selectedFlowId && (p.status === 'in-flight' || p.status === 'queued'),
      )
      if (pkt) {
        controls.enabled = false
        controls.autoRotate = false
        followActiveRef.current = true
        followLastSeenRef.current = realTimeRef.current
        animatingRef.current = false

        const p0 = getPacketWorldPosition(pkt, positionCache)
        const fromId = pkt.path[pkt.pathIndex]
        const toId = pkt.path[pkt.pathIndex + 1]
        const from = positionCache.get(fromId) ?? p0
        const to = positionCache.get(toId) ?? p0
        const p1 = arcPoint(from, to, Math.min(1, pkt.progress + 0.06))

        followPosRef.current.set(...p0)
        followAheadRef.current.set(...p1)
        const outward = followPosRef.current.clone().normalize()
        const dir = followAheadRef.current.clone().sub(followPosRef.current)
        if (dir.lengthSq() < 1e-6) dir.copy(outward)
        dir.normalize()

        // Chase cam: kept well behind and above the packet so there's context
        // around it (not glued to the surface), looking ahead along its path.
        const camPos = followPosRef.current
          .clone()
          .addScaledVector(dir, -3.2)
          .addScaledVector(outward, 3.0)
        camera.position.lerp(camPos, 0.15)
        camera.lookAt(followAheadRef.current)
        return
      }
      // No in-flight packet right now. TCP is stop-and-wait, so hold through the
      // brief gaps between segments; only release once the flow is truly done.
      if (followActiveRef.current && realTimeRef.current - followLastSeenRef.current < 2500) {
        return
      }
      if (followActiveRef.current) {
        // The flow finished — fly back out to the world view.
        startReturnToWorld()
      }
      return
    }
    if (followActiveRef.current) {
      // Deselected by the user — fly back out to the world view.
      startReturnToWorld()
      return
    }

    // Begin a fly whenever the focus target or view mode changes.
    const key = focusedId ? `${focusedId}:${viewMode}` : null
    if (prevFocusRef.current !== key) {
      prevFocusRef.current = key
      // Remember the clicked city's direction for the ESC return view.
      if (focusedId) {
        const fn = nodeMap.get(focusedId)
        if (fn) returnDirRef.current = new THREE.Vector3(...fn.position).normalize()
      }
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
        controls.minDistance = focusedId ? (viewMode === 'continent' ? 3 : 0.8) : 12
        controls.maxDistance = focusedId ? (viewMode === 'continent' ? 55 : 14) : 45
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

      {/* City view: just the clicked city, with its detailed local network. */}
      {focusedNode && viewMode === 'city' && <CityDetail node={focusedNode} />}

      {/* Continent view: every city on the continent as a compact building
          cluster (no per-city local network). */}
      {viewMode === 'continent' &&
        continentCities.map(city => (
          <CityDetail key={city.id} node={city} radius={0.55} maxBuildings={80} showNetwork={false} />
        ))}

      {/* Cable arcs first, then city markers on top */}
      {links.map(link => (
        <LinkMesh key={link.id} link={link} nodes={nodes} />
      ))}

      {/* City markers — de-duplicated so each metro shows one point. Hidden for
          the focused city (city view) or the whole continent (continent view),
          since their building clusters stand in. */}
      {markerNodes
        .filter(node =>
          viewMode === 'continent' ? node.continent !== focusedContinent : node.id !== focusedId,
        )
        .map(node => (
          <NodeMesh
            key={node.id}
            node={node}
            showLabel={!focusedId && !selectedFlowId}
            onFocus={onFocus}
          />
        ))}

      {packets.map(packet => (
        <PacketMesh
          key={packet.id}
          packet={packet}
          positionCache={positionCache}
          selected={packet.flowId === selectedFlowId}
          onSelect={onSelectPacket}
        />
      ))}

      {/* Post-processing: bloom + vignette */}
      <EffectComposer>
        <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.2} luminanceSmoothing={0.9} radius={0.7} />
        <Vignette offset={0.25} darkness={0.72} eskil={false} />
      </EffectComposer>
    </>
  )
}
