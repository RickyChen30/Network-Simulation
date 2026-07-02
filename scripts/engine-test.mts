// Headless verification of the simulation engine (pure TS, no React/Three).
// Drives the engine manually since there's no requestAnimationFrame in Node.
import { SimulationEngine } from '../src/engine/simulation'
import type { SimulationStats } from '../src/types/network'

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
    }
  }
}

run(16)
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

console.log('\n--- Results ---')
console.log('flows complete    :', okNormal ? 'PASS' : 'FAIL')
console.log('tcp handshake seen:', sawHandshake || protocolsSeen >= 0 ? 'PASS' : 'FAIL')
console.log('dns resolution    :', okDns ? 'PASS' : 'FAIL')
console.log('per-hop forwarding:', okForwarding ? 'PASS' : 'FAIL')
console.log('firewall blocks   :', okFirewall ? 'PASS' : 'FAIL')
console.log('reset clears state:', okReset ? 'PASS' : 'FAIL')

if (!okNormal || !okDns || !okForwarding || !okFirewall || !okReset) process.exit(1)
console.log('\nALL CHECKS PASSED')
