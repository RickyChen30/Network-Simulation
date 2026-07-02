import type { SimulationStats } from '../types/network'

interface DashboardProps {
  stats: SimulationStats
}

interface StatRowProps {
  label: string
  value: string | number
  color?: string
}

function StatRow({ label, value, color = 'text-white' }: StatRowProps) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-white/5 last:border-0">
      <span className="text-[11px] text-slate-400 uppercase tracking-wider">{label}</span>
      <span className={`text-sm font-mono font-semibold ${color}`}>{value}</span>
    </div>
  )
}

// Live telemetry HUD.
export function Dashboard({ stats }: DashboardProps) {
  const modeLabel: Record<string, string> = {
    'shortest-path': 'Shortest Path',
    adaptive: 'Adaptive (beta)',
    ddos: 'DDoS',
  }

  return (
    <div className="bg-slate-950/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-2xl pointer-events-none select-none shrink-0">
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`w-2 h-2 rounded-full ${stats.isPaused ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`}
        />
        <span className="text-[11px] font-semibold text-slate-200 uppercase tracking-[0.2em]">
          {stats.isPaused ? 'Paused' : 'Live Traffic'}
        </span>
      </div>

      <div>
        <StatRow label="Connections" value={stats.connections} color="text-cyan-300" />
        <StatRow label="In Flight" value={stats.activePackets} color="text-sky-300" />
        <StatRow label="Completed" value={stats.completed} color="text-emerald-400" />
        <StatRow label="Queued" value={stats.queuedPackets} color="text-yellow-300" />
        <StatRow label="Dropped" value={stats.droppedPackets} color="text-rose-400" />
        <StatRow label="Queue Drops" value={stats.queueDrops} color="text-rose-300" />
        <StatRow label="Retransmits" value={stats.retransmits} color="text-orange-300" />
        <StatRow label="DNS Lookups" value={stats.dnsLookups} color="text-violet-300" />
        <StatRow label="Avg RTT" value={`${stats.averageLatency} ms`} color="text-amber-300" />
        <StatRow
          label="Routing"
          value={modeLabel[stats.routingMode] ?? stats.routingMode}
          color="text-purple-300"
        />
      </div>

      {/* Live protocol mix */}
      <div className="mt-3 pt-3 border-t border-white/5">
        <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-2">Protocols in flight</p>
        <div className="flex gap-1.5">
          <ProtoChip label="TCP" value={stats.protocolMix.TCP} color="#38bdf8" />
          <ProtoChip label="UDP" value={stats.protocolMix.UDP} color="#c084fc" />
          <ProtoChip label="ICMP" value={stats.protocolMix.ICMP} color="#34d399" />
        </div>
      </div>
    </div>
  )
}

function ProtoChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex-1 rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 text-center">
      <div className="text-[10px] font-semibold tracking-wide" style={{ color }}>
        {label}
      </div>
      <div className="text-sm font-mono font-semibold text-white">{value}</div>
    </div>
  )
}
