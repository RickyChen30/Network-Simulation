import { useState, useCallback, useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import type { Packet, SimulationStats } from './types/network'
import { SimulationEngine } from './engine/simulation'
import { NetworkScene } from './rendering/NetworkScene'
import { Dashboard } from './ui/Dashboard'
import { Controls } from './ui/Controls'
import { Legend } from './ui/Legend'
import { CAMERA_POSITION } from './config/constants'

const DEFAULT_STATS: SimulationStats = {
  activePackets: 0,
  deliveredPackets: 0,
  droppedPackets: 0,
  averageLatency: 0,
  routingMode: 'shortest-path',
  isPaused: false,
}

export default function App() {
  // Engine lives outside React state — a stable singleton for this mount.
  const engine = useMemo(() => new SimulationEngine(), [])

  const [stats, setStats] = useState<SimulationStats>(DEFAULT_STATS)
  // Packet array is tracked only for React key reconciliation; positions are
  // updated imperatively in PacketMesh, bypassing React state for performance.
  const [, setPackets] = useState<Packet[]>([])

  const handleStatsChange = useCallback((newStats: SimulationStats, newPackets: Packet[]) => {
    setStats(newStats)
    setPackets(newPackets)
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          engine.togglePause()
          break
        case 'KeyR':
          engine.reset()
          setStats(DEFAULT_STATS)
          setPackets([])
          break
        case 'KeyA':
          engine.toggleAdaptiveRouting()
          break
        case 'KeyD':
          engine.toggleDDoS()
          break
        case 'KeyF':
          engine.toggleFirewall()
          break
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [engine])

  return (
    <div className="relative w-screen h-screen bg-[#020817] overflow-hidden">
      <Canvas
        camera={{ position: CAMERA_POSITION, fov: 50, near: 0.1, far: 240 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%' }}
      >
        <color attach="background" args={['#01030a']} />
        <NetworkScene engine={engine} onStatsChange={handleStatsChange} />
      </Canvas>

      {/* HUD overlays */}
      <Dashboard stats={stats} />
      <Legend />
      <Controls />

      {/* Title */}
      <div className="absolute bottom-4 right-4 text-right pointer-events-none select-none">
        <p className="text-xl font-bold text-white tracking-[0.25em] uppercase">
          Globe<span className="text-teal-400">Net</span>
        </p>
        <p className="text-[11px] text-slate-500 tracking-wide">Global Internet Packet Simulator</p>
      </div>
    </div>
  )
}
