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
    <div className="absolute top-4 left-4 w-60 bg-slate-950/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-2xl pointer-events-none select-none">
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`w-2 h-2 rounded-full ${stats.isPaused ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`}
        />
        <span className="text-[11px] font-semibold text-slate-200 uppercase tracking-[0.2em]">
          {stats.isPaused ? 'Paused' : 'Live Traffic'}
        </span>
      </div>

      <div>
        <StatRow label="Active Packets" value={stats.activePackets} color="text-cyan-300" />
        <StatRow label="Round-trips" value={stats.deliveredPackets} color="text-emerald-400" />
        <StatRow label="Dropped" value={stats.droppedPackets} color="text-rose-400" />
        <StatRow label="Avg RTT" value={`${stats.averageLatency} ms`} color="text-amber-300" />
        <StatRow
          label="Routing"
          value={modeLabel[stats.routingMode] ?? stats.routingMode}
          color="text-purple-300"
        />
      </div>
    </div>
  )
}
