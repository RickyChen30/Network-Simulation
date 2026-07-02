import { useMemo } from 'react'
import type { NetworkNode } from '../types/network'
import { NODE_COLORS } from '../config/topology'

interface ForwardingTablePanelProps {
  node: NetworkNode
  // The node's live forwarding table: destination id → next-hop neighbor id.
  table: Map<string, string> | null
  nodeMap: Map<string, NetworkNode>
}

// The focused city's forwarding table, grouped by next hop — so a stub city
// reads as one big "everything via my uplink" group (a default route), while
// backbone hubs show real fan-out across several neighbors.
export function ForwardingTablePanel({ node, table, nodeMap }: ForwardingTablePanelProps) {
  const label = (id: string) => nodeMap.get(id)?.label ?? id

  const groups = useMemo(() => {
    if (!table) return []
    const byHop = new Map<string, string[]>()
    for (const [destId, hopId] of table) {
      if (!byHop.has(hopId)) byHop.set(hopId, [])
      byHop.get(hopId)!.push(destId)
    }
    return [...byHop.entries()]
      .map(([hopId, destIds]) => ({
        hopId,
        destIds: destIds.sort((a, b) => label(a).localeCompare(label(b))),
      }))
      .sort((a, b) => b.destIds.length - a.destIds.length)
    // The table map is only replaced when routes reconverge (firewall/reset),
    // so this recomputes exactly when the routes change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, nodeMap])

  const routeCount = table?.size ?? 0

  return (
    <div className="bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl select-none pointer-events-auto flex flex-col min-h-0">
      <div className="p-4 pb-2.5">
        <p className="text-[11px] text-slate-400 uppercase tracking-[0.2em]">Forwarding Table</p>
        <p className="text-sm font-semibold text-white mt-0.5">
          {node.label}
          <span className="ml-2 text-[11px] font-mono font-normal text-teal-300/80">{node.ip}</span>
        </p>
        <p className="text-[11px] text-slate-500 mt-0.5">
          {routeCount} routes · {groups.length} next hop{groups.length === 1 ? '' : 's'} · rebuilt on
          reconvergence
        </p>
      </div>

      <div className="px-4 pb-4 overflow-y-auto">
        {groups.length === 0 && (
          <p className="text-xs text-rose-300/90">No routes — this node is unreachable (firewall?).</p>
        )}
        {groups.map(({ hopId, destIds }) => (
          <div key={hopId} className="mb-2.5 last:mb-0">
            <div className="flex items-baseline justify-between border-b border-white/10 pb-1 mb-1.5">
              <span className="text-xs text-white">
                <span className="text-slate-500">via</span>{' '}
                <span className="font-semibold">{label(hopId)}</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {destIds.length} dest{destIds.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {destIds.map(destId => {
                const dest = nodeMap.get(destId)
                return (
                  <span key={destId} className="flex items-center gap-1 text-[10px] text-slate-400 leading-tight">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: dest ? NODE_COLORS[dest.type] : '#64748b' }}
                    />
                    {label(destId)}
                  </span>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
