// Headless verification of the simulation engine (pure TS, no React/Three).
// Drives the engine manually since there's no requestAnimationFrame in Node.
import { SimulationEngine } from '../src/engine/simulation'
import type { SimulationStats } from '../src/types/network'

const engine = new SimulationEngine()
let last: SimulationStats | null = null
engine.onStateChange = s => { last = s }

// Simulate ~12 seconds of wall-clock time at 60 fps.
const dt = 1 / 60
let realMs = 0
function run(seconds: number) {
  const frames = Math.round(seconds / dt)
  for (let i = 0; i < frames; i++) {
    realMs += dt * 1000
    engine.tick(dt, realMs)
  }
}

run(12)
console.log('--- Normal operation (shortest-path) ---')
console.log('active   :', last!.activePackets)
console.log('delivered:', last!.deliveredPackets, '(completed round-trips)')
console.log('dropped  :', last!.droppedPackets)
console.log('avg RTT  :', last!.averageLatency, 'ms')

// Sanity: at least some round-trips should have completed.
const okNormal = last!.deliveredPackets > 0 && last!.averageLatency > 0

// Inspect a sample packet's path to confirm realistic routing.
const sample = engine.packets.find(p => p.kind === 'request')
if (sample) console.log('sample request path:', sample.path.join(' -> '))

// Raise the firewall (block the data centers) and confirm traffic now drops.
const droppedBefore = last!.droppedPackets
engine.toggleFirewall()
run(4)
const droppedAfter = last!.droppedPackets
console.log('\n--- Firewall up (data centers blocked) ---')
console.log('dropped before:', droppedBefore, '-> after:', droppedAfter)
const okFirewall = droppedAfter > droppedBefore

// Reset should zero everything out.
engine.reset()
run(0)
const okReset = last!.deliveredPackets === 0 && last!.droppedPackets === 0

console.log('\n--- Results ---')
console.log('round-trips complete :', okNormal ? 'PASS' : 'FAIL')
console.log('firewall blocks      :', okFirewall ? 'PASS' : 'FAIL')
console.log('reset clears state   :', okReset ? 'PASS' : 'FAIL')

if (!okNormal || !okFirewall || !okReset) process.exit(1)
console.log('\nALL CHECKS PASSED')
