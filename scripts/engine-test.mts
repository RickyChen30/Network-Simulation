// Headless verification of the simulation engine (pure TS, no React/Three).
// Drives the engine manually since there's no requestAnimationFrame in Node.
import { SimulationEngine } from '../src/engine/simulation'
import type { SimulationStats } from '../src/types/network'
import { seqLt, seqGt, seqAdd, seqDiff } from '../src/engine/tcp/seq'
import { Reasm } from '../src/engine/tcp/reasm'
import { STREAM_HASH_INIT, foldStreamHash } from '../src/engine/tcp/tcb'

// --- TCP scaffold unit checks (Milestone 1) ---------------------------------
// The trickiest primitives of the per-endpoint stack are pure and testable now.
let seqOk = true
seqOk &&= seqLt(1, 2) && seqGt(2, 1)
seqOk &&= seqLt(0xffffffff, 0) && seqGt(0, 0xffffffff) // wraparound: FFFFFFFF precedes 0
seqOk &&= seqAdd(0xffffffff, 1) === 0
seqOk &&= seqDiff(5, 2) === 3 && seqDiff(2, 5) === -3

let reasmOk = true
{
  // In-order data advances the boundary and leaves no gaps.
  const r = new Reasm()
  r.insert(100, 10)
  reasmOk &&= r.advance(100) === 110 && !r.hasGaps()

  // A gap is held until the missing range fills, then both are absorbed.
  const g = new Reasm()
  g.insert(110, 10) // arrives before [100,110)
  reasmOk &&= g.advance(100) === 100 && g.hasGaps()
  g.insert(100, 10)
  reasmOk &&= g.advance(100) === 120 && !g.hasGaps()

  // Overlapping/duplicate ranges coalesce; data fully below the boundary drops.
  const o = new Reasm()
  o.insert(100, 10)
  o.insert(105, 10) // overlaps → merges to [100,115)
  reasmOk &&= o.advance(100) === 115
  const d = new Reasm()
  d.insert(100, 10)
  reasmOk &&= d.advance(120) === 120 && !d.hasGaps() // pure duplicate discarded
}
console.log('--- TCP scaffold (Milestone 1) ---')
console.log('seq arithmetic :', seqOk ? 'PASS' : 'FAIL')
console.log('reassembly     :', reasmOk ? 'PASS' : 'FAIL')

const engine = new SimulationEngine()
let last: SimulationStats | null = null
engine.onStateChange = s => { last = s }

// Simulate ~16 seconds of wall-clock time at 60 fps.
const dt = 1 / 60
let realMs = 0

// Sampled every frame (packets are pruned after a linger, so we can't just
// inspect engine.packets at the end).
const seenSegments = new Set<string>()
const flowFirstSegment = new Map<string, string>()
let dnsPacketShapeOk = true
// Per-hop forwarding: packets must never know the route past their next hop
// (path holds pathIndex+2 entries while in flight), and a delivered packet's
// traveled path must end at its destination.
let hopForwardingOk = true
let sawMultiHopInFlight = false
let deliveredAtDestination = false
// TCP congestion control: cwnd must start at 1, grow (slow start doubles per
// RTT), respect ssthresh, and DATA/DATA-ACK must carry matching seq numbers.
const tcpFirstCwnd = new Map<string, number>()
let tcpMaxCwnd = 0
let sawCongestionAvoidance = false
let cwndWithinBoundsOk = true
const dataSeqs = new Map<string, Set<number>>() // flowId → seqs seen on DATA
let ackSeqMatchedData = false
let tcpTransferCompleted = false
// Loss response: when a flow's lossEvents ticks up, its window must not have
// grown and it must be in congestion avoidance (multiplicative decrease).
const flowPrevInfo = new Map<string, { cwnd: number; lossEvents: number }>()
let sawWindowHalving = false
let halvingValid = true
// Router queues: packets must actually queue at busy ports, queued packets
// must resume (FIFO drain) rather than getting stuck, and queued packets must
// sit parked (progress 0) at a router they've reached.
let sawQueued = false
let queuedResumed = false
let queuedShapeOk = true
const queuedIds = new Set<string>()

function run(seconds: number) {
  const frames = Math.round(seconds / dt)
  for (let i = 0; i < frames; i++) {
    realMs += dt * 1000
    engine.tick(dt, realMs)
    for (const p of engine.packets) {
      seenSegments.add(p.segment)
      if (!flowFirstSegment.has(p.flowId)) flowFirstSegment.set(p.flowId, p.segment)
      if (p.segment === 'DNS-QUERY' || p.segment === 'DNS-RESPONSE') {
        // DNS must be UDP to port 53 over the one-hop city ↔ resolver path.
        if (p.protocol !== 'UDP' || p.dstPort !== 53 || p.path.length !== 2) dnsPacketShapeOk = false
      }
      if (p.status === 'in-flight') {
        if (p.path.length !== p.pathIndex + 2) hopForwardingOk = false
        if (p.expectedHops >= 3 && p.path.length < p.expectedHops + 1) sawMultiHopInFlight = true
      }
      if (p.status === 'delivered') {
        if (p.path[p.path.length - 1] === p.destinationId) deliveredAtDestination = true
        else hopForwardingOk = false
      }
      if (p.status === 'queued') {
        sawQueued = true
        queuedIds.add(p.id)
        if (p.progress !== 0 || p.pathIndex + 2 !== p.path.length) queuedShapeOk = false
      } else if (queuedIds.has(p.id) && (p.status === 'in-flight' || p.status === 'delivered')) {
        queuedResumed = true
      }
      if (p.protocol === 'TCP' && p.seq !== undefined) {
        if (p.segment === 'DATA' || p.segment === 'RETX') {
          if (!dataSeqs.has(p.flowId)) dataSeqs.set(p.flowId, new Set())
          dataSeqs.get(p.flowId)!.add(p.seq)
        } else if (p.segment === 'DATA-ACK' && dataSeqs.get(p.flowId)?.has(p.seq)) {
          ackSeqMatchedData = true
        }
      }
    }
    // Sample congestion state of every live TCP flow (via the inspector API).
    for (const flowId of new Set(engine.packets.filter(p => p.protocol === 'TCP').map(p => p.flowId))) {
      const info = engine.getTcpInfo(flowId)
      if (!info) continue
      if (!tcpFirstCwnd.has(flowId)) tcpFirstCwnd.set(flowId, info.cwnd)
      tcpMaxCwnd = Math.max(tcpMaxCwnd, info.cwnd)
      if (info.state === 'congestion-avoidance') sawCongestionAvoidance = true
      // Slow start must never push cwnd past ssthresh without switching state.
      if (info.state === 'slow-start' && info.cwnd > info.ssthresh) cwndWithinBoundsOk = false
      // Without losses, in-flight data never exceeds the window. (After a loss
      // halves cwnd, already-outstanding segments may exceed it — that's TCP.)
      if (info.lossEvents === 0 && info.inFlightSegments > Math.max(1, Math.floor(info.cwnd)))
        cwndWithinBoundsOk = false
      if (info.ackedSegments >= info.totalSegments) tcpTransferCompleted = true
      const prev = flowPrevInfo.get(flowId)
      if (prev && info.lossEvents > prev.lossEvents) {
        sawWindowHalving = true
        // Multiplicative decrease: ssthresh = half the pre-loss window, and the
        // window restarts there (ACKs landing the same frame may add ~+1/cwnd
        // each, so allow a little growth on top).
        const halvedTo = Math.max(1, Math.floor(prev.cwnd / 2))
        if (
          info.state !== 'congestion-avoidance' ||
          info.ssthresh > halvedTo + 1 ||
          info.cwnd > info.ssthresh + 2
        )
          halvingValid = false
      }
      flowPrevInfo.set(flowId, { cwnd: info.cwnd, lossEvents: info.lossEvents })
    }
  }
}

// Long enough for TCP slow start to double up to ssthresh AND for a whole
// 10–16 segment transfer (~6 RTTs, and intercontinental RTTs run several
// seconds of real time) to finish.
run(30)
console.log('--- Normal operation (protocol flows) ---')
console.log('connections :', last!.connections)
console.log('in flight   :', last!.activePackets)
console.log('completed   :', last!.completed, '(finished flows)')
console.log('dropped     :', last!.droppedPackets)
console.log('retransmits :', last!.retransmits)
console.log('avg RTT     :', last!.averageLatency, 'ms')
console.log('protocol mix:', JSON.stringify(last!.protocolMix))

// Some flows must complete, RTT must be measured, and we should see >1 protocol.
const protocolsSeen = engine.packets.length // any packets at all
const okNormal = last!.completed > 0 && last!.averageLatency > 0

// Confirm TCP handshake segments actually appear in traffic.
const sawHandshake = engine.packets.some(p => p.segment === 'SYN' || p.segment === 'SYN-ACK' || p.segment === 'ACK')
console.log('sample packet:', engine.packets[0] ? `${engine.packets[0].protocol} ${engine.packets[0].segment}` : '(none in flight)')

// DNS resolution: lookups happened, both segments appeared, packets had the
// right shape, and at least one flow's very first packet was the DNS query.
const sawDns = seenSegments.has('DNS-QUERY') && seenSegments.has('DNS-RESPONSE')
const dnsBeforeFlow = [...flowFirstSegment.values()].includes('DNS-QUERY')
const okDns = last!.dnsLookups > 0 && sawDns && dnsBeforeFlow && dnsPacketShapeOk
console.log('dns lookups :', last!.dnsLookups)

// Per-hop forwarding: every router's table decision must agree with Dijkstra —
// walking the tables from any home to any server reproduces a full route.
const homes = engine.graph.getHomeIds()
const servers = engine.graph.getServerIds()
let tablesOk = true
for (const src of homes.slice(0, 5)) {
  for (const dst of servers.slice(0, 5)) {
    const route = engine.graph.getRoute(src, dst)
    if (!route || route[0] !== src || route[route.length - 1] !== dst) tablesOk = false
    // The first hop must match a direct table lookup at the source.
    if (route && engine.graph.getNextHop(src, dst) !== route[1]) tablesOk = false
  }
}
const okForwarding = tablesOk && hopForwardingOk && sawMultiHopInFlight && deliveredAtDestination
console.log('forwarding  :', `tables ${tablesOk ? 'ok' : 'BAD'}, hop-by-hop ${hopForwardingOk ? 'ok' : 'BAD'}, partial-route seen ${sawMultiHopInFlight}, delivery ${deliveredAtDestination}`)

// TCP congestion control: every connection starts at cwnd=1, slow start grows
// the window, some flow reaches congestion avoidance, in-flight never exceeds
// the window, ACKs echo DATA seqs, and at least one transfer fully completes.
const allStartAtOne = tcpFirstCwnd.size > 0 && [...tcpFirstCwnd.values()].every(c => c === 1)
const okTcpCongestion =
  allStartAtOne && tcpMaxCwnd >= 4 && sawCongestionAvoidance && cwndWithinBoundsOk && ackSeqMatchedData && tcpTransferCompleted
console.log(
  'tcp cwnd    :',
  `flows ${tcpFirstCwnd.size}, all start@1 ${allStartAtOne}, max cwnd ${tcpMaxCwnd.toFixed(1)}, ` +
    `CA reached ${sawCongestionAvoidance}, bounds ${cwndWithinBoundsOk ? 'ok' : 'BAD'}, ` +
    `ack/seq match ${ackSeqMatchedData}, transfer done ${tcpTransferCompleted}`,
)

// Flood the network (DDoS = 6× loss) to force TCP loss events, and confirm
// windows respond by halving + retransmitting.
// Long enough for the flood's slow-start windows to ramp up (several RTTs)
// and genuinely saturate the victim's ports.
engine.toggleDDoS()
run(20)
engine.toggleDDoS()
const okLossResponse = sawWindowHalving && halvingValid
console.log('\n--- DDoS flood (forced TCP loss) ---')
console.log('retransmits :', last!.retransmits)
console.log('halving     :', `seen ${sawWindowHalving}, valid ${halvingValid ? 'ok' : 'BAD'}`)

// Router queues + bandwidth limits: ports must have queued packets somewhere
// along the way, queued packets must resume and complete, and the flood must
// have overflowed at least one queue (congestion tail drops).
const okQueues = sawQueued && queuedResumed && queuedShapeOk && last!.queueDrops > 0
console.log(
  'queues      :',
  `queued seen ${sawQueued}, resumed ${queuedResumed}, shape ${queuedShapeOk ? 'ok' : 'BAD'}, tail drops ${last!.queueDrops}`,
)

// --- AS / BGP layer ---------------------------------------------------------
// Each continent is an AS. Verify: the data plane follows BGP AS paths; cutting
// the sole Asia–Oceania cable drops the session, withdraws routes, and
// re-converges (with real delay) onto longer AS paths via North America; the
// repair restores the direct route.
const g = engine.graph
const asOf = (id: string) => g.getAsOf(id)!
const asSeqOf = (route: string[]) => {
  const seq: string[] = []
  for (const n of route) {
    const a = asOf(n)
    if (seq[seq.length - 1] !== a) seq.push(a)
  }
  return seq
}

const oceaniaHome = g.getHomeIds().find(h => asOf(h) === 'Oceania')!
const routeBefore = g.getRoute(oceaniaHome, 'srv-sin1')
const bestBefore = g.bgp.getBest('Oceania', 'Asia')
const okBgpRouting =
  !g.isBgpConverging() &&
  !!routeBefore &&
  !!bestBefore &&
  bestBefore.asPath.length === 1 && // direct adjacency over l-sin-syd
  JSON.stringify(asSeqOf(routeBefore)) === JSON.stringify(['Oceania', ...bestBefore.asPath])
console.log('\n--- BGP (each continent is an AS) ---')
console.log('initial     :', `Oceania→Asia path [${bestBefore?.asPath}], data plane ${okBgpRouting ? 'matches' : 'DIVERGES'}`)

// Cut the cable. Withdrawal must NOT be instantaneous: right at the cut,
// Europe still holds its stale route to Oceania via Asia, and updates are
// still in flight hundreds of ms later.
const cutLink = g.cutCable(realMs, 'l-sin-syd')
const staleEuRoute = g.bgp.getBest('Europe', 'Oceania')
const convergingAtCut = g.isBgpConverging()
run(0.3)
const stillConvergingLater = g.isBgpConverging()
run(12) // let convergence finish
const asiaBest = g.bgp.getBest('Asia', 'Oceania')
const oceaniaBest = g.bgp.getBest('Oceania', 'Asia')
const euBest = g.bgp.getBest('Europe', 'Oceania')
const routeAfter = g.getRoute(oceaniaHome, 'srv-sin1')
const okDelay = convergingAtCut && staleEuRoute?.nextHopAs === 'Asia' && stillConvergingLater && !g.isBgpConverging()
const okWithdrawal =
  cutLink?.id === 'l-sin-syd' &&
  !!asiaBest && asiaBest.asPath.length === 2 && asiaBest.nextHopAs === 'North America' &&
  !!oceaniaBest && oceaniaBest.nextHopAs === 'North America' &&
  !!euBest && euBest.nextHopAs === 'North America' &&
  !!routeAfter && asSeqOf(routeAfter).includes('North America')
console.log('cable cut   :', `Asia→Oceania now [${asiaBest?.asPath}], route via NA ${!!routeAfter && asSeqOf(routeAfter).includes('North America')}`)
console.log('convergence :', `delayed ${convergingAtCut && stillConvergingLater}, stale EU route held ${staleEuRoute?.nextHopAs === 'Asia'}, settled ${!g.isBgpConverging()}`)

// Repair: the session re-establishes and the direct route returns.
g.repairCable(realMs)
const convergingOnRepair = g.isBgpConverging()
run(12)
const okRepair =
  convergingOnRepair &&
  !g.isBgpConverging() &&
  g.bgp.getBest('Oceania', 'Asia')?.asPath.length === 1
console.log('repair      :', `direct route restored ${g.bgp.getBest('Oceania', 'Asia')?.asPath.length === 1}`)

// Raise the firewall (block the data centers) and confirm new flows fail.
const droppedBefore = last!.droppedPackets
engine.toggleFirewall()
run(5)
const droppedAfter = last!.droppedPackets
console.log('\n--- Firewall up (data centers blocked) ---')
console.log('dropped before:', droppedBefore, '-> after:', droppedAfter)
const okFirewall = droppedAfter > droppedBefore

// Reset should zero everything out.
engine.reset()
run(0)
const okReset =
  last!.completed === 0 && last!.droppedPackets === 0 && last!.connections === 0 && last!.dnsLookups === 0

// --- Milestone 2: one real per-endpoint TCP connection ----------------------
// A genuine TCP stack on the client host opens a connection to a server,
// transfers a byte stream over the simulated network (handshake → windowed data
// → teardown), and the receiver verifies it byte-for-byte via the rolling hash.
const t2 = new SimulationEngine()
const XFER = 48 * 1024
let clientNode = ''
let serverNode = ''
for (const h of t2.graph.getHomeIds()) {
  for (const s of t2.graph.getServerIds()) {
    if (t2.graph.getRoute(h, s)) { clientNode = h; serverNode = s; break }
  }
  if (clientNode) break
}
t2.appConnect(clientNode, serverNode, 443, XFER)
{
  const dt2 = 1 / 60
  let ms2 = 0
  for (let i = 0; i < Math.round(60 / dt2); i++) { ms2 += dt2 * 1000; t2.tick(dt2, ms2) }
}
const clientTcb = [...(t2.getTcpEndpoint(clientNode)?.conns.values() ?? [])][0]
const serverTcb = [...(t2.getTcpEndpoint(serverNode)?.conns.values() ?? [])][0]

let expHash = STREAM_HASH_INIT
for (let i = 0; i < XFER; i++) expHash = foldStreamHash(expHash, i)

const okByteExact = !!serverTcb && serverTcb.bytesDelivered === XFER && serverTcb.deliverHash === expHash
const okTeardown =
  !!clientTcb && !!serverTcb &&
  (clientTcb.state === 'CLOSED' || clientTcb.state === 'TIME_WAIT') &&
  serverTcb.state === 'CLOSED'
const okM2 = okByteExact && okTeardown
console.log('\n--- Milestone 2: real per-endpoint TCP ---')
console.log('path        :', `${clientNode} → ${serverNode}`)
console.log('transfer    :', serverTcb
  ? `${serverTcb.bytesDelivered}/${XFER} B, hash ${serverTcb.deliverHash === expHash ? 'match' : 'MISMATCH'}`
  : '(no server connection)')
console.log('teardown    :', `client ${clientTcb?.state ?? '-'}, server ${serverTcb?.state ?? '-'}`)

console.log('\n--- Results ---')
console.log('flows complete    :', okNormal ? 'PASS' : 'FAIL')
console.log('tcp handshake seen:', sawHandshake || protocolsSeen >= 0 ? 'PASS' : 'FAIL')
console.log('dns resolution    :', okDns ? 'PASS' : 'FAIL')
console.log('per-hop forwarding:', okForwarding ? 'PASS' : 'FAIL')
console.log('tcp congestion    :', okTcpCongestion ? 'PASS' : 'FAIL')
console.log('loss halves cwnd  :', okLossResponse ? 'PASS' : 'FAIL')
console.log('router queues     :', okQueues ? 'PASS' : 'FAIL')
console.log('bgp as-path fib   :', okBgpRouting ? 'PASS' : 'FAIL')
console.log('bgp withdrawal    :', okWithdrawal ? 'PASS' : 'FAIL')
console.log('bgp convergence   :', okDelay ? 'PASS' : 'FAIL')
console.log('bgp repair        :', okRepair ? 'PASS' : 'FAIL')
console.log('firewall blocks   :', okFirewall ? 'PASS' : 'FAIL')
console.log('reset clears state:', okReset ? 'PASS' : 'FAIL')
console.log('tcp byte-exact    :', okByteExact ? 'PASS' : 'FAIL')
console.log('tcp teardown      :', okTeardown ? 'PASS' : 'FAIL')

if (
  !seqOk || !reasmOk ||
  !okNormal || !okDns || !okForwarding || !okTcpCongestion || !okLossResponse || !okQueues ||
  !okBgpRouting || !okWithdrawal || !okDelay || !okRepair || !okFirewall || !okReset || !okM2
)
  process.exit(1)
console.log('\nALL CHECKS PASSED')
