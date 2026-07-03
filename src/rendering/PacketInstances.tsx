import { useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { Packet } from '../types/network'
import type { SimulationEngine } from '../engine/simulation'
import { getPacketWorldPosition } from '../engine/packet'
import { PACKET_RADIUS } from '../config/constants'

// ============================================================================
// Every packet on the globe, drawn in THREE draw calls total — regardless of
// how many packets are alive:
//   1. one InstancedMesh of glowing spheres (per-instance color + scale)
//   2. one InstancedMesh of fading "ghost" dots forming short comet tails
//   3. one invisible, oversized InstancedMesh used only for forgiving clicks
// Positions are written straight into the instance buffers every frame from
// live engine state — React is not involved in packet motion or count at all.
// The ridden packet additionally gets the fancy PacketMesh overlay (halo +
// long trail), rendered separately by NetworkScene.
// ============================================================================

const MAX_PACKETS = 2048
const TRAIL_DOTS = 6 // ghost dots per packet
const TRAIL_SAMPLE_MS = 45 // history sampling interval
const HIT_SCALE = 3.2 // clickable radius multiplier

interface TrailHistory {
  pts: Float32Array // ring buffer of TRAIL_DOTS xyz samples
  head: number
  filled: number
  lastSample: number
}

interface PacketInstancesProps {
  engine: SimulationEngine
  onSelect: (packet: Packet) => void
}

const _mat = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _color = new THREE.Color()

export function PacketInstances({ engine, onSelect }: PacketInstancesProps) {
  const bodyRef = useRef<THREE.InstancedMesh>(null)
  const trailRef = useRef<THREE.InstancedMesh>(null)
  const hitRef = useRef<THREE.InstancedMesh>(null)
  // Which packet each body/hit instance slot currently represents (for clicks).
  const slotPacketRef = useRef<Packet[]>([])
  const historiesRef = useRef(new Map<string, TrailHistory>())

  // Shared resources, created once.
  const { sphereGeo, bodyMat, hitMat } = useMemo(() => {
    const sphereGeo = new THREE.SphereGeometry(1, 12, 12)
    // Unlit + toneMapped:false so per-instance colors can exceed 1.0 and read
    // as emissive under the bloom pass, like the old per-packet material did.
    const bodyMat = new THREE.MeshBasicMaterial({ toneMapped: false })
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    })
    return { sphereGeo, bodyMat, hitMat }
  }, [])

  const positionCache = engine.getPositionCache()

  useFrame(() => {
    const body = bodyRef.current
    const trail = trailRef.current
    const hit = hitRef.current
    if (!body || !trail || !hit) return

    const now = performance.now()
    const packets = engine.packets
    const histories = historiesRef.current
    const slots = slotPacketRef.current
    let n = 0
    let t = 0

    for (const packet of packets) {
      if (n >= MAX_PACKETS) break
      const pos = getPacketWorldPosition(packet, positionCache)
      _pos.set(pos[0], pos[1], pos[2])

      // Match the old PacketMesh look: dropped flashes red, delivered fades,
      // queued dims while parked; control segments are smaller than data.
      const dropped = packet.status === 'dropped'
      const brightness =
        packet.status === 'delivered' ? 0.35 : packet.status === 'queued' ? 0.7 : 1.7
      _color.set(dropped ? '#ef4444' : packet.color).multiplyScalar(dropped ? 1.7 : brightness)
      const radius = PACKET_RADIUS * (packet.control ? 0.7 : 1.1)

      _scale.setScalar(radius)
      _mat.compose(_pos, _quat, _scale)
      body.setMatrixAt(n, _mat)
      body.setColorAt(n, _color)
      _scale.setScalar(radius * HIT_SCALE)
      _mat.compose(_pos, _quat, _scale)
      hit.setMatrixAt(n, _mat)
      slots[n] = packet
      n++

      // Comet tail: sample recent positions while the packet is moving.
      if (packet.status === 'in-flight') {
        let h = histories.get(packet.id)
        if (!h) {
          h = { pts: new Float32Array(TRAIL_DOTS * 3), head: 0, filled: 0, lastSample: 0 }
          histories.set(packet.id, h)
        }
        if (now - h.lastSample >= TRAIL_SAMPLE_MS) {
          h.lastSample = now
          h.pts[h.head * 3] = pos[0]
          h.pts[h.head * 3 + 1] = pos[1]
          h.pts[h.head * 3 + 2] = pos[2]
          h.head = (h.head + 1) % TRAIL_DOTS
          if (h.filled < TRAIL_DOTS) h.filled++
        }
        // Newest → oldest ghost dots, shrinking and dimming.
        for (let i = 0; i < h.filled && t < MAX_PACKETS * TRAIL_DOTS; i++) {
          const idx = (h.head - 1 - i + TRAIL_DOTS * 2) % TRAIL_DOTS
          const age = (i + 1) / (TRAIL_DOTS + 1)
          _pos.set(h.pts[idx * 3], h.pts[idx * 3 + 1], h.pts[idx * 3 + 2])
          _scale.setScalar(radius * (1 - age) * 0.8)
          _mat.compose(_pos, _quat, _scale)
          trail.setMatrixAt(t, _mat)
          _color.set(packet.color).multiplyScalar(1.2 * (1 - age))
          trail.setColorAt(t, _color)
          t++
        }
      }
    }

    body.count = n
    hit.count = n
    trail.count = t
    body.instanceMatrix.needsUpdate = true
    hit.instanceMatrix.needsUpdate = true
    trail.instanceMatrix.needsUpdate = true
    if (body.instanceColor) body.instanceColor.needsUpdate = true
    if (trail.instanceColor) trail.instanceColor.needsUpdate = true

    // Drop trail history for packets that no longer exist (cheap: id set).
    if (histories.size > packets.length + 32) {
      const liveIds = new Set(packets.map(p => p.id))
      for (const id of histories.keys()) if (!liveIds.has(id)) histories.delete(id)
    }
  })

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    if (e.instanceId === undefined) return
    const packet = slotPacketRef.current[e.instanceId]
    if (packet) onSelect(packet)
  }

  return (
    <group>
      <instancedMesh
        ref={bodyRef}
        args={[sphereGeo, bodyMat, MAX_PACKETS]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={trailRef}
        args={[sphereGeo, bodyMat, MAX_PACKETS * TRAIL_DOTS]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={hitRef}
        args={[sphereGeo, hitMat, MAX_PACKETS]}
        frustumCulled={false}
        onClick={handleClick}
      />
    </group>
  )
}
