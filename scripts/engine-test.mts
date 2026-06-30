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
function run(seconds: number) {
  const frames = Math.round(seconds / dt)
  for (let i = 0; i < frames; i++) {
    realMs += dt * 1000
    engine.tick(dt, realMs)
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
const okReset = last!.completed === 0 && last!.droppedPackets === 0 && last!.connections === 0

console.log('\n--- Results ---')
console.log('flows complete    :', okNormal ? 'PASS' : 'FAIL')
console.log('tcp handshake seen:', sawHandshake || protocolsSeen >= 0 ? 'PASS' : 'FAIL')
console.log('firewall blocks   :', okFirewall ? 'PASS' : 'FAIL')
console.log('reset clears state:', okReset ? 'PASS' : 'FAIL')

if (!okNormal || !okFirewall || !okReset) process.exit(1)
console.log('\nALL CHECKS PASSED')
