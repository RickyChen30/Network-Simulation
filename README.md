# 3D Internet Packet Simulator

An interactive 3D model of how the internet actually moves data around the
Earth. Real cities, internet exchanges, submarine‑cable landings and hyperscale
data centres sit at their true latitude/longitude on a globe; packets ride
great‑circle "cable" arcs between them. Underneath the visuals runs a real
network stack — per‑hop IP forwarding, BGP between continents, finite‑bandwidth
router queues, and a **byte‑accurate TCP** implementation.

<!-- screenshot: the whole globe with live packet traffic -->


https://github.com/user-attachments/assets/d7fc5500-dd5f-41e6-b3b3-e2913c3c721e




Built with TypeScript, React, Three.js (React Three Fiber) and Tailwind, plus a
C core for TCP. The simulation engine is framework‑free and headless‑testable.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

> The animation is driven by `requestAnimationFrame`, which browsers pause for
> background tabs. Keep the tab focused to see traffic flow.

Optional — build the C TCP core to WebAssembly so live TCP runs the C stack
(needs a wasm‑capable clang; the app falls back to the TypeScript stack without
it, see [The C / WASM hybrid](#the-c--wasm-hybrid)):

```bash
cd native && make wasm     # builds tcp_core.wasm and copies it into public/
```

## Controls

| Input | Action |
|-------|--------|
| Click a city | fly in to its cityscape + show its routing tables |
| Click a packet | ride along with it and open the inspector |
| `Space` | pause / resume · `R` reset |
| `D` | DDoS — SYN‑flood one victim server |
| `F` | toggle the data‑centre firewalls |
| `C` | cut / repair a submarine cable (BGP re‑converges) |
| `Esc` | leave the packet ride / fly back out |
| Drag / Scroll | orbit / zoom |

---

## The network model

Every node sits at its real location. Traffic originates in **user cities**,
crosses continents over **submarine cables**, and terminates at **servers**
inside data centres.

| Tier | Role |
|------|------|
| **User city** | a metro generating requests (London, Mumbai, São Paulo, …) |
| **Backbone / IXP** | a city core router / internet exchange (LINX, DE‑CIX, …) |
| **Cable landing** | a submarine‑cable landing or transit hub |
| **Data centre** | a hyperscale facility (also acts as a firewall) |
| **Server** | an application/CDN host inside a data centre |

~68 cities are auto‑wired to their nearest backbone hub. Every node has an IP;
every link has a one‑way latency (ms) and a bandwidth rating that together drive
routing cost, loss, and queueing.

---

## How it works, layer by layer

The stack mirrors the real internet from the wire up.

### 1 · Autonomous systems and BGP

Each **continent is an autonomous system (AS)**. Routing runs at two levels:

- **Inside an AS (IGP):** shortest‑path (Dijkstra, latency‑weighted) fills each
  router's forwarding table.
- **Between ASes (BGP):** submarine cables are eBGP sessions. Each AS originates
  its prefix and advertises routes carrying the full **AS_PATH**; receivers
  reject paths containing themselves (loop prevention) and pick a best route
  (shortest AS_PATH, lowest next‑hop AS as tie‑break). External traffic leaves
  via the nearest egress toward the chosen next‑hop AS (**hot potato**).

The realism is in the *dynamics*: BGP updates are messages with per‑session
propagation delay, so a change ripples outward AS by AS. Press **`C`** to cut a
cable — the eBGP session drops, routes are **withdrawn**, distant ASes route on
stale paths for seconds (packets black‑hole or briefly loop until their TTL
expires), then everything settles on a longer detour. Cut Asia↔Oceania and
Sydney reaches Singapore the long way via North America; repair it and the short
path returns.

<!-- screenshot: a cut cable (red arc) mid re-convergence, dashboard showing "Converging…" -->

https://github.com/user-attachments/assets/889c769b-3d56-4ca0-ae92-a2564ee4b60d



### 2 · Per‑hop forwarding

Packets **don't carry their route**. Like real IP, each router looks the
destination up in *its own* forwarding table and picks the next hop; a packet's
path is discovered hop by hop, like a live traceroute. Tables are built the way
a converged link‑state protocol (OSPF/IS‑IS) would build them — one Dijkstra per
destination — and **re‑converge** whenever the topology changes (a cable cut, a
firewall raised). Click any city to see its live forwarding table and its AS's
BGP table.

<!-- screenshot: city view with the forwarding-table / BGP panel open -->

https://github.com/user-attachments/assets/24d5227f-5350-4214-8fd2-b47a53a829f7



### 3 · Router queues and bandwidth

Links aren't infinitely fast. Every directed link is a router **output port**
that transmits one packet at a time at a rate set by its bandwidth. A packet
arriving at a busy port waits in an 8‑deep **FIFO queue**; when the queue is
full, newcomers are **tail‑dropped**. This is where congestion becomes real —
bursts overrun the queue, drops happen, and TCP backs off.

### 4 · Packet loss

Two independent sources:

- **Random per‑link loss**, by link quality (backbone ~0.03%, last‑mile ~0.3%),
  compounded along the path.
- **Congestion loss** — the queue tail‑drops above, the dominant source under
  load.

### 5 · TCP — the real thing

Every TCP connection runs a genuine, spec‑faithful stack (implemented in C, see
below), not a scripted handshake:

- **Three‑way handshake** → **windowed data** → **FIN teardown**.
- **Congestion control:** slow start (window doubles per RTT), congestion
  avoidance, **fast retransmit + NewReno** fast recovery on triple‑duplicate
  ACKs, and multiplicative decrease on timeout.
- **Reliability:** cumulative ACKs, out‑of‑order **reassembly**, Go‑Back‑N
  timeout recovery, retransmission.
- **RTT/RTO:** Jacobson/Karels estimation with Karn's algorithm.
- **Flow control:** an advertised receive window; a stalled receiver closes the
  window and the sender **persist‑probes** until it reopens.

Payload is a deterministic function of stream offset, so the receiver verifies
every byte it delivers — the transfer is provably **byte‑exact** even under loss
and reordering.

### 6 · DNS, UDP, ICMP

Alongside TCP, the simulator runs **UDP** datagram bursts, **ICMP** echo/reply
pings, and **DNS** lookups (a short UDP :53 round‑trip to the city's resolver
before a connection). These stay on a lightweight flow model; TCP is the only
protocol that runs the full stack.

### 7 · Attacks and faults

- **`D` — DDoS:** a SYN flood converges on one victim server; its ingress queues
  saturate, drops cascade, and every sender's window collapses — congestion
  collapse as an emergent property.
- **`F` — Firewall:** data centres go dark; routes re‑converge without them and
  in‑flight packets die at the first router that can no longer forward them.

---

## Riding a packet

Click any packet to follow it in a chase cam and open the **inspector**:
protocol, size, TTL, application (HTTPS/DNS/…); live RTT, jitter, loss
probability, bottleneck bandwidth; for TCP, the sender's live **congestion
window / threshold / state**; the **AS path** it crossed; and a hop‑by‑hop route
and timeline.

<!-- screenshot: the packet inspector while riding a TCP packet -->
![Riding a packet](screenshots/inspector.png)

---

## The C / WASM hybrid

TCP is the one layer with a second life as C. The stack under `src/engine/tcp/`
was written as a **pure core** — no sockets, no threads, an injected clock, all
I/O behind a single callback — which made it portable almost verbatim to C
(`native/tcp_core.c`). That C is **freestanding** (no libc, no `malloc`, fixed
pools), so one source compiles two ways:

- a **native** binary, verified by `native/tcp_test.c` (`make test`), and
- a **WebAssembly** module the browser loads to run live TCP (`make wasm`).

The seam is tiny: the C core *imports* one function (`host_emit`, to put a
segment on the wire) and *exports* the `tcp_*` API. Because there's no `malloc`,
no pointers cross the JS↔WASM boundary — every argument is a scalar. When the
`.wasm` is present the globe runs the C stack; otherwise it transparently falls
back to the identical TypeScript implementation. Details in
[`native/README.md`](native/README.md).

---

## Architecture

The core rule: `src/engine/` is pure TypeScript with no React/Three imports, so
the whole simulation is unit‑testable without a browser. Rendering reads engine
state each frame and never mutates it.

```
src/
  engine/            pure simulation (no rendering)
    simulation.ts      main loop: spawn, forward, step, stats
    network.ts         node/link graph, AS membership, IGP+BGP → forwarding tables
    routing.ts         Dijkstra + per-destination forwarding-table builder
    bgp.ts             eBGP: AS_PATH selection, withdrawals, delayed convergence
    packet.ts          per-hop packet lifecycle (forward / queue / drop)
    queues.ts          router output ports: bandwidth + FIFO queues
    tcp/               the TCP stack (TS) — mirrored by the C core
  rendering/         React Three Fiber scene (globe, arcs, instanced packets, cameras)
  ui/                HUD: dashboard, packet inspector, routing panels, legend
  config/            globe math, topology (nodes/cities/links), tuning constants
native/              the C TCP core + native test + WASM build
scripts/
  engine-test.mts    headless verification of the whole engine
```

Packets render in **three instanced draw calls** regardless of count, and engine
state is pushed to React at ~8 Hz — so thousands of simultaneous packets stay
smooth.

---

## Verification

```bash
npm run test:engine        # headless engine checks (routing, BGP, queues, TCP, …)
cd native && make test     # the C TCP core, natively
```

`engine-test.mts` drives the simulation through normal traffic, a DDoS flood, a
cable cut/repair and a firewall raise, asserting ~18 invariants: forwarding
matches Dijkstra, BGP withdraws and re‑converges, queues fill and overflow, TCP
transfers arrive byte‑exact (including under 4% forced loss and with fast
retransmit / flow control), and — when the wasm is built — that the live globe's
TCP connections complete through the **C core**.
