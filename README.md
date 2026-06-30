# 3D Global Internet Packet Simulator

A real-time 3D visualization of how internet traffic flows around the **whole
world**, rendered on an interactive globe. Real cities, internet exchange points,
hyperscale data centers and submarine-cable landing stations are placed at their
true latitude/longitude, connected by the terrestrial and subsea backbone. Built
with TypeScript, React, Three.js, React Three Fiber, Drei, and TailwindCSS.

Packets are glowing comets that ride great-circle "cable" arcs over the planet,
take the shortest path to their destination server, and trigger a response that
retraces the route home. A request to a nearby data center returns in tens of
milliseconds; one that has to cross an ocean takes much longer.

**Navigate the globe:** drag to spin it, scroll to zoom; it also auto-rotates
gently on its own. **Click any city** to fly down to it and reveal a detailed
night-time cityscape on the surface; press `Esc` or "Back to globe" to fly out.

## Setup

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

> **Note:** the packet animation is driven by `requestAnimationFrame`, which
> browsers pause when the tab is in the background. Keep the tab focused to see
> traffic flow.

## Controls

| Key    | Action                                                |
|--------|-------------------------------------------------------|
| SPACE  | Pause / resume the simulation                         |
| R      | Reset all packets and counters                        |
| A      | Toggle adaptive routing (placeholder for now)         |
| D      | DDoS burst — floods the network at 4× traffic         |
| F      | Toggle the data-center firewalls (blocks their servers) |
| Esc    | Fly back out to the whole-globe view                  |
| Click  | Click a city to fly in and reveal its cityscape       |
| Drag   | Spin the globe                                        |
| Scroll | Zoom in / out                                         |

## How the network is modeled

Every node sits at its **real latitude/longitude** on the globe. Traffic flows
from a user city, across continents over submarine cables (via landing stations),
into a data center, and back:

```
  User city → regional IXP → submarine cable landing → ocean crossing →
              IXP on another continent → data center → server  (then response home)

  e.g. Sydney → Singapore → Mumbai → Marseille → Frankfurt DC → eu-web
       Sao Paulo → Miami → New York → Ashburn DC → us-east-web
```

Cities span North & South America, Europe, Africa, the Middle East, Asia and
Oceania (New York, San Jose, London, Amsterdam, Frankfurt, Marseille, Lagos,
Johannesburg, Mumbai, Singapore, Hong Kong, Tokyo, Sydney, São Paulo, …).

| Tier                 | Real-world role                                          |
|----------------------|---------------------------------------------------------|
| **User City** (amber) | A metro generating requests (London, Mumbai, Sydney, …) |
| **Backbone / IXP** (purple) | City router / internet exchange (LINX, AMS-IX, DE-CIX, …) |
| **Cable Landing** (teal) | Submarine-cable landing / transit hub (Marseille, Fujairah, …) |
| **Data Center** (rose) | Hyperscale facility + firewall (Ashburn, Frankfurt, Singapore, Tokyo) |
| **Server** (green)   | Application / CDN servers inside a data center           |

**Networking ideas demonstrated:**

- **Geographic shortest-path routing** — every packet runs Dijkstra over the live
  graph weighted by link latency, so it naturally picks the lowest-latency
  intercontinental route.
- **Distance = latency** — a request to a nearby data center resolves quickly; one
  that crosses an ocean racks up tens to hundreds of milliseconds round-trip.
- **Great-circle arcs** — links and packets follow lifted great-circle paths over
  the sphere, the way real cables span the planet.
- **Request / response** — when a request reaches a server, the server replies and
  the response retraces the path home, updating the RTT readout.
- **Firewalls** — pressing `F` deactivates the data centers; with the servers
  behind them unreachable, those requests are dropped.

## Architecture

Simulation logic is **pure TypeScript with no React or Three.js imports**, so it
can run and be tested headlessly (see `npm run test:engine`). Rendering reads
engine state each frame but never mutates it.

```
src/
  engine/                 # pure simulation logic (no rendering)
    simulation.ts         # main loop: spawn, step, round-trips, stats
    network.ts            # the node/link graph + firewall state
    routing.ts            # Dijkstra shortest-path (latency-weighted)
    packet.ts             # packet lifecycle, segment timing, interpolation
  rendering/              # React Three Fiber scene
    NetworkScene.tsx      # scene root: lights, bloom, environment, ticks engine
    Globe.tsx             # textured Earth, lat/long graticule, atmosphere glow
    CityDetail.tsx        # procedural cityscape shown when a city is focused
    NodeMesh.tsx          # glowing, clickable city marker + camera-facing label
    LinkMesh.tsx          # great-circle cable arcs with animated data-flow dashes
    PacketMesh.tsx        # comet-trailed packet spheres riding the arcs
  ui/                     # HTML/Tailwind HUD overlays
    Dashboard.tsx         # live telemetry
    Legend.tsx            # tier + packet-type key
    Controls.tsx          # keyboard legend
  types/network.ts        # shared TypeScript model
  config/
    globe.ts              # lat/long → sphere projection + great-circle arc math
    topology.ts           # global nodes (real lat/long) and backbone links
    constants.ts          # tuning (spawn rate, sizes, camera)
  App.tsx                 # canvas + keyboard handling
  main.tsx
public/
  earth-day.jpg           # NASA "blue marble" land/ocean texture
  earth-night.jpg         # night-lights map (emissive city glow)
  earth-bump.png          # topology / terrain bump map
scripts/
  engine-test.mts         # headless engine verification
```

The Earth uses NASA imagery (via the [three-globe](https://github.com/vasturiano/three-globe)
example assets) served locally from `public/`, so it works offline.

## Verifying the engine

Because the engine is decoupled from rendering, you can validate the simulation
without a browser:

```bash
npm run test:engine
```

This drives ~12 seconds of simulated traffic and checks that round-trips
complete, that raising the firewall drops packets, and that reset clears state.

## Extending

| Feature                  | Where to start                                          |
|--------------------------|---------------------------------------------------------|
| Real adaptive routing    | `routing.ts` — weight edges by live packet load         |
| Congestion / packet loss | `simulation.ts` `_stepPackets()` — drop on overloaded links |
| Real DDoS attacker node  | `simulation.ts` `toggleDDoS()` — target one server/link |
| New cities / nodes       | add entries to `NODE_DEFS` in `topology.ts` (lat/long)  |
| New node tiers           | `types/network.ts` → `topology.ts` (colors) → `NodeMesh.tsx` |
| Day/night terminator     | `Globe.tsx` — custom shader to mask night lights by sun angle |
| Per-link load coloring   | `LinkMesh.tsx` — tint by packets currently on the link  |
