import type { Packet, NetworkNode, Protocol, Segment } from '../types/network'
import { PROTOCOL_COLORS } from '../config/topology'

interface PacketInspectorProps {
  packet: Packet
  nodeMap: Map<string, NetworkNode>
  onClose: () => void
}

// What each protocol is generally for.
const PROTOCOL_USE: Record<Protocol, string> = {
  TCP: 'Reliable, connection-oriented stream (web, APIs, files)',
  UDP: 'Fast connectionless datagrams (DNS, video, games)',
  ICMP: 'Network diagnostics (ping / traceroute)',
}

// Well-known destination ports → service.
function serviceFor(packet: Packet): string {
  if (packet.protocol === 'ICMP') return 'Echo (ping)'
  const p = packet.dstPort
  if (p === 443) return 'HTTPS'
  if (p === 80) return 'HTTP'
  if (p === 53) return 'DNS'
  return `port ${p}`
}

// Plain-English meaning of each segment.
const SEGMENT_MEANING: Record<Segment, string> = {
  SYN: 'Open connection (handshake 1/3)',
  'SYN-ACK': 'Accept + acknowledge (handshake 2/3)',
  ACK: 'Acknowledge (handshake 3/3)',
  DATA: 'Payload data',
  'DATA-ACK': 'Acknowledge received data',
  FIN: 'Close connection',
  'FIN-ACK': 'Acknowledge close',
  RETX: 'Retransmission (recovering a lost segment)',
  DATAGRAM: 'Datagram (fire-and-forget)',
  ECHO: 'Echo request (ping out)',
  REPLY: 'Echo reply (ping back)',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline gap-3 py-1 border-b border-white/5 last:border-0">
      <span className="text-[10px] text-slate-400 uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-xs text-slate-100 text-right">{children}</span>
    </div>
  )
}

// A live panel describing the selected packet: protocol, what it's doing, its
// source/destination (with IPs & ports) and the full route it takes.
export function PacketInspector({ packet, nodeMap, onClose }: PacketInspectorProps) {
  const color = PROTOCOL_COLORS[packet.protocol]
  const src = nodeMap.get(packet.sourceId)
  const dst = nodeMap.get(packet.destinationId)
  const hops = packet.path.map(id => nodeMap.get(id)?.label ?? id)

  return (
    <div className="absolute right-4 top-1/2 -translate-y-1/2 w-72 bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-2xl select-none">
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
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white text-lg leading-none px-1"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <p className="text-[11px] text-slate-300 mb-3 leading-snug">{SEGMENT_MEANING[packet.segment]}</p>

      <div className="mb-3">
        <Row label="Service">{serviceFor(packet)}</Row>
        <Row label="Kind">{packet.control ? 'Control' : 'Data'}</Row>
        <Row label="Status">
          <span className={packet.status === 'dropped' ? 'text-rose-400' : 'text-emerald-300'}>
            {packet.status}
          </span>
        </Row>
      </div>

      <div className="mb-3">
        <Row label="Source">
          <span className="font-medium">{src?.label ?? packet.sourceId}</span>
          <br />
          <span className="font-mono text-[10px] text-teal-300/80">
            {src?.ip}:{packet.srcPort}
          </span>
        </Row>
        <Row label="Dest">
          <span className="font-medium">{dst?.label ?? packet.destinationId}</span>
          <br />
          <span className="font-mono text-[10px] text-teal-300/80">
            {dst?.ip}:{packet.dstPort}
          </span>
        </Row>
      </div>

      <div>
        <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1.5">
          Route ({hops.length} hops)
        </p>
        <div className="flex flex-wrap gap-x-1 gap-y-0.5 text-[11px] leading-tight">
          {hops.map((h, i) => (
            <span key={i} className="flex items-center gap-1">
              <span
                className={
                  i === packet.pathIndex || i === packet.pathIndex + 1
                    ? 'text-white font-semibold'
                    : 'text-slate-400'
                }
              >
                {h}
              </span>
              {i < hops.length - 1 && <span className="text-slate-600">→</span>}
            </span>
          ))}
        </div>
      </div>

      <p className="text-[10px] text-slate-500 mt-3 pt-2 border-t border-white/5">
        Camera is riding along · {PROTOCOL_USE[packet.protocol]}
      </p>
    </div>
  )
}
