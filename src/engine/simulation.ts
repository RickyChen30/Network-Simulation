import type { Packet, SimulationStats, RoutingMode } from '../types/network'
import { NetworkGraph } from './network'
import { findShortestPath, computePathLatency } from './routing'
import { createPacket, resetPacketCounter, stepPacket } from './packet'
import {
  PACKET_SPAWN_RATE,
  MAX_ACTIVE_PACKETS,
  PACKET_LINGER_MS,
  LATENCY_WINDOW,
} from '../config/constants'

// SimulationEngine drives the whole model. It is pure TypeScript with no React
// dependency, so it can be unit-tested in isolation. The renderer ticks it once
// per frame and reads its public state.
export class SimulationEngine {
  graph: NetworkGraph
  packets: Packet[]

  private _isPaused: boolean
  private _routingMode: RoutingMode
  private _isDDoS: boolean

  private _deliveredPackets: number   // completed round-trips
  private _droppedPackets: number
  private _recentRtts: number[]       // sliding window of round-trip times (ms)
  private _elapsedMs: number
  private _spawnAccumulator: number   // fractional packets owed since last spawn
  private _lingerTimers: Map<string, number>

  // Called each tick so React can re-render the dashboard / packet list
  onStateChange?: (stats: SimulationStats, packets: Packet[]) => void

  constructor() {
    this.graph = new NetworkGraph()
    this.packets = []
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    this._deliveredPackets = 0
    this._droppedPackets = 0
    this._recentRtts = []
    this._elapsedMs = 0
    this._spawnAccumulator = 0
    this._lingerTimers = new Map()
  }

  // Main tick — deltaSeconds is real frame time, realTimeMs is a running clock.
  tick(deltaSeconds: number, realTimeMs: number): void {
    if (this._isPaused) return

    this._elapsedMs += deltaSeconds * 1000

    this._spawnPackets(deltaSeconds)
    this._stepPackets(deltaSeconds, realTimeMs)
    this._pruneLingeredPackets(realTimeMs)

    this.onStateChange?.(this._buildStats(), this.packets)
  }

  // Build a fresh request packet from a random home to a random server.
  private _makeRequest(): Packet | null {
    const homes = this.graph.getHomeIds()
    const servers = this.graph.getServerIds()
    if (homes.length === 0 || servers.length === 0) return null

    const sourceId = homes[Math.floor(Math.random() * homes.length)]
    const destId = servers[Math.floor(Math.random() * servers.length)]

    const path = findShortestPath(
      sourceId,
      destId,
      this.graph.getActiveNodes(),
      this.graph.getActiveLinks(),
    )

    // No route (e.g. firewall blocking the data centers) → dropped packet.
    if (!path) {
      this._droppedPackets++
      return null
    }

    return createPacket('request', sourceId, destId, path, this.graph.links, this._elapsedMs)
  }

  // When a request arrives at a server, the server replies: a response packet
  // retraces the path back home. This models real request/response traffic.
  private _makeResponse(request: Packet): Packet {
    const reversedPath = [...request.path].reverse()
    return createPacket(
      'response',
      request.destinationId,
      request.sourceId,
      reversedPath,
      this.graph.links,
      this._elapsedMs,
    )
  }

  private _spawnPackets(deltaSeconds: number): void {
    const activeCount = this.packets.filter(p => p.status === 'in-flight').length
    if (activeCount >= MAX_ACTIVE_PACKETS) return

    // Accumulate fractional packets so the rate is frame-rate independent.
    // DDoS mode (placeholder) bursts traffic at 4x.
    const rate = this._isDDoS ? PACKET_SPAWN_RATE * 4 : PACKET_SPAWN_RATE
    this._spawnAccumulator += rate * deltaSeconds

    while (this._spawnAccumulator >= 1) {
      this._spawnAccumulator -= 1
      const req = this._makeRequest()
      if (req) this.packets.push(req)
    }
  }

  private _stepPackets(deltaSeconds: number, realTimeMs: number): void {
    const newResponses: Packet[] = []

    for (const packet of this.packets) {
      if (packet.status !== 'in-flight') continue

      const arrived = stepPacket(packet, deltaSeconds)
      if (!arrived) continue

      if (packet.kind === 'request') {
        // Request reached the server → fire the response back home.
        newResponses.push(this._makeResponse(packet))
        this._lingerTimers.set(packet.id, realTimeMs + PACKET_LINGER_MS)
      } else {
        // Response reached home → a full round-trip is complete.
        const rtt = computePathLatency(packet.path, this.graph.links) * 2
        this._recentRtts.push(rtt)
        if (this._recentRtts.length > LATENCY_WINDOW) this._recentRtts.shift()
        this._deliveredPackets++
        this._lingerTimers.set(packet.id, realTimeMs + PACKET_LINGER_MS)
      }
    }

    if (newResponses.length) this.packets.push(...newResponses)
  }

  private _pruneLingeredPackets(realTimeMs: number): void {
    this.packets = this.packets.filter(p => {
      if (p.status === 'in-flight') return true
      const removeAt = this._lingerTimers.get(p.id) ?? 0
      if (realTimeMs >= removeAt) {
        this._lingerTimers.delete(p.id)
        return false
      }
      return true
    })
  }

  private _buildStats(): SimulationStats {
    const avg =
      this._recentRtts.length > 0
        ? this._recentRtts.reduce((a, b) => a + b, 0) / this._recentRtts.length
        : 0

    return {
      activePackets: this.packets.filter(p => p.status === 'in-flight').length,
      deliveredPackets: this._deliveredPackets,
      droppedPackets: this._droppedPackets,
      averageLatency: Math.round(avg),
      routingMode: this._routingMode,
      isPaused: this._isPaused,
    }
  }

  // --- Controls ---

  togglePause(): void {
    this._isPaused = !this._isPaused
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleAdaptiveRouting(): void {
    this._routingMode = this._routingMode === 'adaptive' ? 'shortest-path' : 'adaptive'
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleDDoS(): void {
    this._isDDoS = !this._isDDoS
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  toggleFirewall(): void {
    this.graph.toggleFirewall()
  }

  reset(): void {
    this.graph.reset()
    this.packets = []
    this._deliveredPackets = 0
    this._droppedPackets = 0
    this._recentRtts = []
    this._elapsedMs = 0
    this._spawnAccumulator = 0
    this._lingerTimers.clear()
    this._isPaused = false
    this._routingMode = 'shortest-path'
    this._isDDoS = false
    resetPacketCounter()
    this.onStateChange?.(this._buildStats(), this.packets)
  }

  getPositionCache(): Map<string, [number, number, number]> {
    return this.graph.getPositionCache()
  }
}
