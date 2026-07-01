import { useState } from 'react'
import type { Packet, NetworkNode, Protocol } from '../types/network'
import { PROTOCOL_COLORS } from '../config/topology'

interface PacketInspectorProps {
  packet: Packet
  nodeMap: Map<string, NetworkNode>
  onClose: () => void
}

const PROTOCOL_USE: Record<Protocol, string> = {
  TCP: 'Reliable, connection-oriented stream',
  UDP: 'Fast connectionless datagrams',
  ICMP: 'Network diagnostics (ping)',
}

function applicationFor(packet: Packet): string {
  if (packet.protocol === 'ICMP') return 'ICMP Echo (ping)'
  if (packet.dstPort === 443) return 'HTTPS (web)'
  if (packet.dstPort === 80) return 'HTTP (web)'
  if (packet.dstPort === 53) return 'DNS'
  return `port ${packet.dstPort}`
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-[10px] text-slate-400 uppercase tracking-[0.16em] mb-1.5 pb-1 border-b border-white/10">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, mono, color }: { label: string; value: React.ReactNode; mono?: boolean; color?: string }) {
  return (
    <div className="flex justify-between items-baseline gap-3 py-0.5">
      <span className="text-[11px] text-slate-400 shrink-0">{label}</span>
      <span className={`text-xs text-right ${mono ? 'font-mono' : ''}`} style={{ color: color ?? '#e2e8f0' }}>
        {value}
      </span>
    </div>
  )
}

// Deep inspector for a selected packet: identity, live performance, its route,
// and a collapsible timeline of where it is along the path.
export function PacketInspector({ packet, nodeMap, onClose }: PacketInspectorProps) {
  const [timelineOpen, setTimelineOpen] = useState(true)

  const color = PROTOCOL_COLORS[packet.protocol]
  const label = (id: string) => nodeMap.get(id)?.label ?? id
  const hops = packet.path
  const hopLat = packet.hopLatencies
  const totalLatency = hopLat.reduce((a, b) => a + b, 0)
  const rtt = Math.round(totalLatency * 2)

  // Cumulative one-way latency to reach each node on the path.
  const cumLat: number[] = [0]
  for (let i = 0; i < hopLat.length; i++) cumLat.push(cumLat[i] + hopLat[i])

  // Latency accrued to the packet's current position (partial current hop).
  let currentLatency = 0
  for (let i = 0; i < packet.pathIndex; i++) currentLatency += hopLat[i]
  currentLatency += (hopLat[packet.pathIndex] ?? 0) * packet.progress
  currentLatency = Math.round(currentLatency)

  const jitter = Math.round(totalLatency * 0.04 + (hashStr(packet.flowId) % 6) + hops.length * 0.4)
  const ttl = Math.max(1, 64 - packet.pathIndex)
  const atEnd = packet.pathIndex >= hops.length - 1
  const nextHop = atEnd ? '—' : label(hops[packet.pathIndex + 1])
  const currentHop = atEnd
    ? `Arrived at ${label(hops[hops.length - 1])}`
    : `${label(hops[packet.pathIndex])} → ${label(hops[packet.pathIndex + 1])}`

  return (
    <div className="absolute right-4 top-4 w-72 max-h-[calc(100vh-2rem)] overflow-y-auto bg-slate-950/85 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-2xl select-none">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-bold px-2 py-0.5 rounded"
            style={{ color, backgroundColor: `${color}22`, boxShadow: `0 0 8px ${color}66` }}
          >
            {packet.protocol}
          </span>
          <span className="text-sm font-semibold text-white">{packet.segment}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1" aria-label="Close">
          ×
        </button>
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Row label="Protocol" value={packet.protocol} color={color} />
        <Row label="Application" value={applicationFor(packet)} />
        <Row label="Size" value={`${packet.size} B`} mono />
        <Row label="TTL" value={`${ttl} / 64`} mono />
        <Row label="Packet ID" value={packet.id} mono />
      </Section>

      {/* Performance */}
      <Section title="Performance">
        <Row label="RTT" value={`${rtt} ms`} mono color="#fcd34d" />
        <Row label="Current Latency" value={`${currentLatency} ms`} mono color="#67e8f9" />
        <Row label="Jitter" value={`±${jitter} ms`} mono />
        <Row label="Loss Prob." value={`${(packet.lossProb * 100).toFixed(2)}%`} mono color="#fda4af" />
        <Row label="Bandwidth" value={`${packet.bottleneckBw} Gbps`} mono />
      </Section>

      {/* Connection */}
      <Section title="Connection">
        <Row label="Current Hop" value={currentHop} />
        <Row label="Hop Count" value={`${hops.length - 1} hops`} mono />
        <Row label="Next Hop" value={nextHop} />
        <div className="mt-1">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Route</div>
          <div className="flex flex-wrap gap-x-1 gap-y-0.5 text-[11px] leading-tight">
            {hops.map((h, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className={i === packet.pathIndex || i === packet.pathIndex + 1 ? 'text-white font-semibold' : 'text-slate-400'}>
                  {label(h)}
                </span>
                {i < hops.length - 1 && <span className="text-slate-600">→</span>}
              </span>
            ))}
          </div>
        </div>
      </Section>

      {/* Live timeline (collapsible) */}
      <Section
        title="Timeline"
        right={
          <button onClick={() => setTimelineOpen(o => !o)} className="text-slate-400 hover:text-white text-xs">
            {timelineOpen ? '▾ hide' : '▸ show'}
          </button>
        }
      >
        {timelineOpen && (
          <div className="mt-1">
            {hops.map((id, i) => {
              const reached = i <= packet.pathIndex
              const current = i === packet.pathIndex + 1 && !atEnd
              const dotColor = reached ? color : current ? '#fcd34d' : '#334155'
              return (
                <div key={i} className="flex items-stretch gap-2">
                  <div className="flex flex-col items-center pt-1">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: dotColor,
                        boxShadow: reached || current ? `0 0 6px ${dotColor}` : 'none',
                      }}
                    />
                    {i < hops.length - 1 && <span className="w-px flex-1 min-h-[10px] bg-white/10" />}
                  </div>
                  <div className="flex-1 flex justify-between items-baseline pb-1.5">
                    <span className={`text-[11px] ${reached ? 'text-slate-100' : current ? 'text-amber-200' : 'text-slate-500'}`}>
                      {label(id)}
                      {i === 0 && ' · created'}
                    </span>
                    <span className={`text-[10px] font-mono ${reached || current ? 'text-slate-300' : 'text-slate-600'}`}>
                      {reached || current ? '' : '~'}
                      {cumLat[i]} ms
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <p className="text-[10px] text-slate-500 pt-1 border-t border-white/5">
        Riding along · {PROTOCOL_USE[packet.protocol]}
      </p>
    </div>
  )
}
