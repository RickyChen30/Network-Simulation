import type { NodeType } from '../types/network'
import { NODE_COLORS, NODE_TIER_LABELS } from '../config/topology'

// Explains the network hierarchy so viewers can read the topology.
// Only the tiers actually used in the global topology are listed.
const TIER_ORDER: NodeType[] = [
  'home',
  'core-router',
  'gateway',
]

export function Legend() {
  return (
    <div className="absolute top-4 right-4 w-52 bg-slate-950/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-2xl pointer-events-none select-none">
      <p className="text-[11px] text-slate-400 uppercase tracking-[0.2em] mb-3">Network Tiers</p>
      <div className="space-y-2">
        {TIER_ORDER.map(type => (
          <div key={type} className="flex items-center gap-2.5">
            <span
              className="w-3 h-3 rounded-sm shrink-0"
              style={{ backgroundColor: NODE_COLORS[type], boxShadow: `0 0 8px ${NODE_COLORS[type]}` }}
            />
            <span className="text-xs text-slate-300">{NODE_TIER_LABELS[type]}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
        <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-1">Protocols</p>
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: '#38bdf8', boxShadow: '0 0 8px #38bdf8' }} />
          <span className="text-xs text-slate-300">TCP (handshake + ACKs)</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: '#c084fc', boxShadow: '0 0 8px #c084fc' }} />
          <span className="text-xs text-slate-300">UDP (datagrams)</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: '#34d399', boxShadow: '0 0 8px #34d399' }} />
          <span className="text-xs text-slate-300">ICMP (ping)</span>
        </div>
      </div>
    </div>
  )
}
