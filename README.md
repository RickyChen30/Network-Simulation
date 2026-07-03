# 3D Global Internet Packet Simulator

A real-time 3D simulation of how the internet actually moves data around the
planet, rendered on an interactive globe. Real cities, internet exchange
points, hyperscale data centers and submarine-cable landing stations sit at
their true latitude/longitude, wired together by the terrestrial and subsea
backbone. Packets are glowing comets that ride great-circle "cable" arcs —
and underneath the visuals runs a real network stack: DNS resolution, per-hop
IP forwarding, TCP with slow start and congestion avoidance, router queues
with finite bandwidth, packet loss, and retransmission.

Built with TypeScript, React, Three.js, React Three Fiber, Drei, and
TailwindCSS. The simulation engine is pure TypeScript with **zero rendering
imports**, so everything described below can be verified headlessly
(`npm run test:engine`).

**Explore:** drag to spin the globe, scroll to zoom. **Click a city** to fly
down to a procedural night-time cityscape on the real coastline (with its own
local network of homes, neighborhood routers and an uplink). **Click a packet**
to ride along with it in a chase cam and open the deep packet inspector.

## Setup

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

> **Note:** the animation is driven by `requestAnimationFrame`, which browsers
> pause for background tabs. Keep the tab focused to see traffic flow.

## Controls

| Input  | Action                                                        |
|--------|---------------------------------------------------------------|
| SPACE  | Pause / resume the simulation                                 |
| R      | Reset all flows, packets and counters                         |
| A      | Toggle adaptive-routing mode flag (placeholder for now)       |
| D      | DDoS — flood one victim server with unpaced TCP connections   |
| F      | Toggle the data-center firewalls (routes reconverge live)     |
| C      | Cut / repair a submarine cable — BGP withdraws & re-converges |
| Esc    | Exit the packet ride / fly back out to the whole-globe view   |
| Click  | A city → fly in · a packet → ride along + inspect it          |
| Drag / Scroll | Spin the globe / zoom                                  |

---

## The network model

Every node sits at its real latitude/longitude. Traffic originates in user
cities, crosses continents over submarine cables, and terminates at servers
inside data centers:

```
User city → backbone IXP → submarine-cable landing → ocean crossing →
            IXP on another continent → data center → server
```

| Tier | Color | Real-world role |
|------|-------|-----------------|
| **User City** | amber | A metro generating requests (London, Mumbai, Sydney, …) |
| **Backbone / IXP** | purple | City core router / internet exchange (LINX, AMS-IX, DE-CIX, …) |
| **Cable Landing** | teal | Submarine-cable landing / transit hub (Marseille, Fujairah, LA, …) |
| **Data Center** | rose | Hyperscale facility — also acts as a firewall |
| **Server** | emerald | Application / CDN servers inside a data center |

~68 world cities are auto-wired to their nearest backbone hub, every node gets
an IP address, and links carry a one-way latency (ms) and a bandwidth rating
that drives both loss rates and queueing (below).

---

## The infrastructure, layer by layer

### 1. Flows, not lone packets

Every transmission is a **flow** — one logical conversation between a user
city and a server. A flow picks a protocol (60% TCP, 30% UDP, 10% ICMP), an
application port (TCP → 443/80, UDP → 53/443, ICMP → none), and an ephemeral
source port (49152+). Each packet on screen belongs to a flow and carries a
real segment type: `SYN`, `DATA-ACK`, `DNS-QUERY`, `RETX`, and so on. Packet
sizes are realistic too — handshake/ACK control packets are 40–60 B, ICMP
echoes 64 B, DNS answers 120–180 B, data segments 512–1500 B (MTU-ish).

### 2. DNS resolution

Before a city can open a connection it has to resolve the server's name.
Each city's uplink hub doubles as its ISP's recursive resolver, so a lookup
is a short `DNS-QUERY` / `DNS-RESPONSE` round-trip on the access link (UDP,
port 53) that must complete before the flow's first SYN. Answers are cached
per city with a 45-second TTL — repeat flows from the same city to the same
server skip the lookup, which you can watch in the "DNS Lookups" counter
(flows to port 53 are themselves DNS traffic and never trigger a lookup).

### 3. Per-hop forwarding tables (how routing actually works)

Packets do **not** carry their route. Like real IP packets they know only
their destination, and every router makes an independent decision:

```
packet arrives at node → look destination up in this node's forwarding table
                       → hand it to the chosen neighbor → repeat
```

The tables are built the way a converged link-state protocol (OSPF / IS-IS)
would build them: one Dijkstra run per *destination* over the latency-weighted
graph fills in that destination's column of every router's table
(`routing.ts → buildForwardingTables`). Because links are symmetric, a node's
predecessor in the shortest-path tree rooted at D is exactly its next hop
toward D.

Consequences you can observe:

- A packet's route panel in the inspector fills in **hop by hop, like a live
  traceroute** — the tail shows `⋯ → destination` until each router decides.
- Toggling the firewall (`F`) makes the routers **reconverge**: routes through
  the blocked data centers vanish from every table. Packets already in flight
  get black-holed at the first router with no route — dropped mid-path, just
  like real convergence events.
- The TTL readout in the inspector decrements per actual router traversed.

### 4. Autonomous systems and BGP

Each **continent is an autonomous system** (a border city whose only uplink
crosses continents joins its provider hub's AS, like a single-homed customer).
Routing runs at two levels, the way the real internet does:

- **Inside an AS (IGP):** plain latency-weighted Dijkstra over the continent's
  own links fills the intra-AS part of every forwarding table.
- **Between ASes (BGP):** the submarine cables are eBGP sessions. Every AS
  originates its prefix and advertises routes carrying the full **AS_PATH**;
  a receiver rejects any path containing its own AS (loop prevention), keeps
  one candidate per neighbor, and runs the **decision process**: shortest
  AS_PATH wins, lowest next-hop AS breaks ties. External traffic leaves via
  the router's nearest egress toward the chosen next-hop AS (**hot potato**),
  and the selected routes are installed into the same forwarding tables the
  packets consult (RIB → FIB).

The dynamics are the realistic part. BGP updates are **messages with per-
session propagation delay, paced by an MRAI timer** — nothing converges
instantly (except the initial boot, which starts at steady state). Press `C`
to cut a submarine cable:

- If it was the **last cable between two ASes, the eBGP session drops** and
  both sides **withdraw** everything learned across it, then advertise their
  new (longer or vanished) best paths to their remaining neighbors.
- The change **ripples outward AS by AS over seconds** — the dashboard shows
  "Converging…" while updates are in flight. Distant ASes keep routing on
  stale paths meanwhile: packets get black-holed at routers with no route, or
  briefly loop between ASes until their **TTL (32 hops)** expires — and
  "path hunting" (an AS trying progressively longer stale routes before
  settling) emerges by itself.
- After convergence, traffic visibly reroutes — cut Europe–Africa and Lagos
  traffic swings around via Asia; cut Asia–Oceania and Sydney reaches
  Singapore the long way through North America. Press `C` again to repair the
  cable: the session re-establishes, full tables are re-exchanged (with the
  same delays), and the short paths return.

Click any city to see its AS's **BGP table** (best AS path per destination AS,
live convergence state) above its forwarding table; ride a packet and the
inspector shows the **AS Path** it actually crossed.

### 5. TCP — handshake, sliding window, congestion control

TCP flows run the full connection lifecycle:

```
SYN → SYN-ACK → ACK        (three-way handshake, stop-and-wait)
DATA ⇄ DATA-ACK …          (windowed transfer, 10–16 sequenced segments)
FIN → FIN-ACK              (teardown)
```

The data phase is governed by a **congestion window** (`cwnd`), exactly as in
classic TCP:

- **`cwnd` starts at 1 segment.** Every connection begins by probing the path
  with a single packet.
- **Slow start:** each ACK grows the window by 1 segment — which doubles it
  every RTT (1 → 2 → 4 → 8). On the globe this reads as growing *trains* of
  packets per round trip.
- **Congestion avoidance:** once `cwnd` reaches the slow-start threshold
  (`ssthresh`, initially 8), growth switches to additive increase —
  `cwnd += 1/cwnd` per ACK, roughly +1 segment per RTT.
- **Loss → multiplicative decrease:** an unacked segment that times out
  (1.1 s with nothing left in flight) is treated as congestion:
  `ssthresh = cwnd / 2`, `cwnd = ssthresh` — the window **halves** — and the
  lost segment is **retransmitted** (visible as a `RETX` packet). One loss
  burst halves the window once, not once per lost segment. After halving,
  the sender simply stops sending until in-flight data drains below the
  smaller window.
- **Give-up:** five failed retransmissions of the same segment reset the
  connection, like a real RST after repeated RTOs.

Every DATA segment carries a sequence number; the receiver ACKs each arrival
and duplicate ACKs (from spurious retransmits) are ignored. Ride along any
TCP packet and the inspector shows the sender's live congestion state: the
current **window**, **threshold**, **state** (slow start vs congestion
avoidance), in-flight vs window, delivery progress, loss events, and a window
bar with the `ssthresh` tick — you can watch it double, cross the threshold,
and get halved.

UDP, by contrast, just streams datagrams (no handshake, no ACKs, no recovery),
and ICMP does echo/reply ping rounds — the classic reliability trade-off,
side by side.

### 6. Router queues and bandwidth limits

Links aren't infinitely fast. Every directed link is a **router output port**
that transmits one packet at a time; transmission takes
`LINK_SERVICE_FACTOR / bandwidth` seconds, so a slim 120-unit city uplink
serializes a packet every ~230 ms while an 800-unit data-center link does one
every ~35 ms.

A packet arriving while the port is busy parks in that port's **FIFO queue**
(it visibly dims and waits at the router; the inspector reads "Queued at …").
When the queue already holds 8 packets, newcomers are **tail-dropped** — the
congestion signal TCP reacts to. Sending hosts contend for their own uplink
like everyone else, so even the first hop can buffer or drop.

This is where the transport and network layers meet: bursts from slow-start
doubling pile into the bottleneck queue, the queue overflows, the drop times
out at the sender, and the window halves. Congestion control emerges from the
queues instead of being scripted.

### 7. Packet loss

Two independent loss mechanisms:

- **Random transmission loss**, per link quality, compounded along the path:
  backbone/subsea fiber ~0.03% per link, regional ~0.08%, last-mile ~0.3% —
  a typical intercontinental path totals a fraction of a percent, which is
  why you'll occasionally see a lone red flash and a retransmission even on a
  calm network.
- **Congestion loss** — the queue tail drops above. Deterministic, load-driven,
  and the dominant source of drops under DDoS.

### 8. DDoS — emergent congestion collapse

Pressing `D` doesn't multiply a loss dial — it launches an actual flood:

- All new flows converge on **one randomly chosen victim server**.
- Flow spawn rate jumps 6×, with doubled connection and packet caps.
- Attack senders **don't pace themselves** — they blast full congestion
  windows instead of spacing sends out.

The victim's ingress ports genuinely saturate: queues spike to capacity, tail
drops cascade (watch "Queue Drops"), retransmissions climb, and every sender's
window collapses — congestion collapse as an emergent property, not a
hard-coded effect. Legitimate cross-traffic sharing those links suffers
collateral queueing delay and loss.

### 9. Firewalls

`F` toggles the data centers off. The forwarding tables reconverge without
them, so new flows fail instantly at the source ("no route") and in-flight
packets die at the first router that can no longer forward them. TCP flows
mid-transfer keep retransmitting into the void until they hit the retry cap
and reset.

---

## Riding a packet

Click any packet to follow it in a chase cam. The **inspector** panel shows:

- **Identity** — protocol, segment, application (HTTPS/HTTP/DNS by port),
  size in bytes, TTL (decrements per router), packet ID.
- **Performance** — RTT, latency accrued to its current position, jitter,
  the path's loss probability, and the bottleneck bandwidth seen so far.
- **Congestion Control** (TCP) — live cwnd / ssthresh / state, in-flight vs
  window, delivered segments, loss events, and the window bar.
- **Connection** — current hop (or "Queued at …"), destination, hops taken
  so far vs expected, and the route as discovered hop by hop.
- **Timeline** — every node the packet has visited with cumulative one-way
  latency, plus a pending entry for the destination until the route is known.

---

## Architecture

The engine/renderer split is the core design rule: `src/engine/` is pure
TypeScript with no React or Three.js imports. Rendering reads engine state
every frame and never mutates it.

```
src/
  engine/                 # pure simulation logic (no rendering)
    simulation.ts         # flows: DNS, TCP/UDP/ICMP state machines, cwnd,
                          #   retransmits, DDoS, stats
    network.ts            # node/link graph, AS membership, IGP+BGP → FIB, cable cuts
    routing.ts            # Dijkstra + per-destination forwarding-table builder
    bgp.ts                # eBGP between continent-ASes: AS_PATH selection,
                          #   withdrawals, delayed update propagation (MRAI)
    packet.ts             # per-hop packet lifecycle: forward, queue, drop, arc position
    queues.ts             # router output ports: bandwidth service rate + FIFO queues
  rendering/              # React Three Fiber scene
    NetworkScene.tsx      # scene root, camera state machine, chase cam, ticks engine
    Globe.tsx             # textured Earth, graticule, atmosphere
    CityDetail.tsx        # land-masked procedural cityscape + local network
    NodeMesh.tsx          # glowing city markers with label LOD
    LinkMesh.tsx          # great-circle cable arcs with animated dashes
    PacketMesh.tsx        # comet-trailed packets (dim while queued), clickable
  ui/
    Dashboard.tsx         # live telemetry incl. queued packets & queue drops
    PacketInspector.tsx   # the deep packet panel described above
    Legend.tsx, Controls.tsx
  types/network.ts        # shared data model (Packet, stats, TcpCongestionInfo…)
  config/
    globe.ts              # lat/long → sphere + great-circle arc math
    topology.ts           # ~30 backbone nodes + ~68 cities, IPs, links
    constants.ts          # tuning: timing, queue capacity, service factor, camera
  App.tsx                 # HUD state, keyboard, inspector wiring
scripts/
  engine-test.mts         # headless engine verification
public/
  earth-*.jpg/png         # NASA blue-marble day/night/topology textures (offline)
```

## Verifying the engine

```bash
npm run test:engine
```

Drives ~55 seconds of simulated traffic through three phases — normal
operation, a DDoS flood, and a firewall raise — and asserts, among others:

- flows complete and RTTs are measured; DNS resolves before connections open
- forwarding tables agree with Dijkstra; packets never know more than their
  next hop; delivered packets end exactly at their destination
- every TCP connection starts at `cwnd = 1`, slow start grows the window,
  congestion avoidance is reached, ACKs echo DATA sequence numbers, and
  transfers complete
- loss events halve the window (`ssthresh = cwnd/2`) and land in
  congestion avoidance
- packets queue at busy ports, resume FIFO, and the flood produces real
  tail drops
- the firewall blocks traffic; reset clears all state

## Extending

| Idea | Where to start |
|------|----------------|
| Fast retransmit / dup-ACK detection | `simulation.ts` `_onDelivered()` — count duplicate ACKs, skip the RTO |
| Adaptive routing under load | `routing.ts` — weight edges by live queue depth, rebuild tables periodically |
| Active queue management (RED/CoDel) | `queues.ts` — probabilistic early drops as queues grow |
| Per-link load coloring | `LinkMesh.tsx` — tint arcs by port utilization |
| New cities / nodes | `topology.ts` — add to `WORLD_CITIES` (lat/long, auto-wired) or `NODE_DEFS` for infrastructure |
| Day/night terminator | `Globe.tsx` — shader masking night lights by sun angle |

The Earth textures are NASA imagery (via the
[three-globe](https://github.com/vasturiano/three-globe) example assets)
served locally from `public/`, so the app works offline.
