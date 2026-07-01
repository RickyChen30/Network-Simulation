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
  connections: 0,
  completed: 0,
  droppedPackets: 0,
  retransmits: 0,
  averageLatency: 0,
  protocolMix: { TCP: 0, UDP: 0, ICMP: 0 },
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

  // Which city the camera has flown into (null = whole-globe view), and whether
  // we're viewing just that city or its whole continent.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'city' | 'continent'>('city')
  const focusedNode = focusedId ? engine.graph.nodes.find(n => n.id === focusedId) : undefined

  const handleStatsChange = useCallback((newStats: SimulationStats, newPackets: Packet[]) => {
    setStats(newStats)
    setPackets(newPackets)
  }, [])

  // Clicking a city always drops into the single-city view.
  const handleFocus = useCallback((id: string | null) => {
    setFocusedId(id)
    if (id) setViewMode('city')
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
        case 'Escape':
          setFocusedId(null)
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
        onPointerMissed={() => setFocusedId(null)}
      >
        <color attach="background" args={['#01030a']} />
        <NetworkScene
          engine={engine}
          onStatsChange={handleStatsChange}
          focusedId={focusedId}
          viewMode={viewMode}
          onFocus={handleFocus}
        />
      </Canvas>

      {/* HUD overlays */}
      <Dashboard stats={stats} />
      <Legend />
      <Controls />

      {/* Focused city / continent toolbar */}
      {focusedNode ? (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-slate-950/75 backdrop-blur-md border border-white/10 rounded-xl px-4 py-2.5 shadow-2xl">
          <div className="text-center min-w-[7rem]">
            {viewMode === 'city' ? (
              <>
                <div className="text-sm font-semibold text-white tracking-wide">{focusedNode.label}</div>
                <div className="text-[11px] text-teal-300/80 font-mono">
                  {focusedNode.ip}
                  {focusedNode.subLabel ? ` · ${focusedNode.subLabel}` : ''}
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-white tracking-wide">{focusedNode.continent}</div>
                <div className="text-[11px] text-teal-300/80">from {focusedNode.label}</div>
              </>
            )}
          </div>
          {viewMode === 'city' ? (
            <button
              onClick={() => setViewMode('continent')}
              className="text-xs text-teal-200 hover:text-white bg-teal-400/15 hover:bg-teal-400/25 border border-teal-300/25 rounded-lg px-2.5 py-1 transition-colors"
            >
              View continent
            </button>
          ) : (
            <button
              onClick={() => setViewMode('city')}
              className="text-xs text-teal-200 hover:text-white bg-teal-400/15 hover:bg-teal-400/25 border border-teal-300/25 rounded-lg px-2.5 py-1 transition-colors"
            >
              View city
            </button>
          )}
          <button
            onClick={() => setFocusedId(null)}
            className="text-xs text-slate-300 hover:text-white bg-white/10 hover:bg-white/20 border border-white/15 rounded-lg px-2.5 py-1 transition-colors"
          >
            ← Back to globe
          </button>
        </div>
      ) : (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-500 tracking-wide pointer-events-none select-none">
          Click a city to zoom in
        </div>
      )}

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
