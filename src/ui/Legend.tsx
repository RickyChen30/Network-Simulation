import type { NodeType } from '../types/network'
import { NODE_COLORS, NODE_TIER_LABELS } from '../config/topology'

// Explains the network hierarchy so viewers can read the topology.
// Only the tiers actually used in the global topology are listed.
const TIER_ORDER: NodeType[] = [
  'home',
  'core-router',
  'gateway',
  'datacenter',
  'server',
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
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: '#67e8f9', boxShadow: '0 0 8px #67e8f9' }} />
          <span className="text-xs text-slate-300">Request packet</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: '#fde047', boxShadow: '0 0 8px #fde047' }} />
          <span className="text-xs text-slate-300">Response packet</span>
        </div>
      </div>
    </div>
  )
}
