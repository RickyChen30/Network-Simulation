# Per-node TCP endpoints — implementation plan

Turn GlobeNet's *simulated* flow-TCP into a **real TCP stack that runs on each
host node**, over the existing simulated network. Host nodes (`home`, `server`)
become transport-layer endpoints; routers keep forwarding at L3. The network you
already built — per-hop forwarding, finite-bandwidth router queues, tail drops,
link loss, BGP — becomes the genuine IP layer underneath.

"Real" here means a spec-faithful TCP implementation (byte-sequence space,
handshake, RTT-estimated RTO, Reno congestion control, flow control, reassembly,
teardown, Internet checksum) that provably delivers a byte stream intact under
loss/reordering. It is **not** the OS kernel's TCP and does not interoperate with
real hosts — that's not achievable in a browser and isn't the goal.

---

## 1. Layering & file layout

```
engine/
  tcp/
    tcb.ts          # the Transmission Control Block (one per connection) + state machine
    endpoint.ts     # TcpEndpoint: per-host connection table, demux, ports, app driver
    seq.ts          # 32-bit serial-number arithmetic (seqLt/seqLeq/seqGt, add)
    reasm.ts        # receive reassembly buffer (in-order + out-of-order ranges)
    tcp-const.ts    # MSS, ISS, RTO bounds, MSL, initial cwnd/ssthresh, buffer sizes
  simulation.ts     # owns endpoints, drives their tick, dispatches delivered packets
  packet.ts         # Packet gains TCP segment fields (ackNo, flags, window, payloadLen)
  network.ts        # unchanged — getNextHop/getRoute are the "IP" the endpoints use
  queues.ts         # unchanged — the link layer
```

Routers (`core-router`/`gateway`/`datacenter`) get **no** endpoint — they only
forward, exactly as today. Only `home` and `server` nodes get a `TcpEndpoint`.

Keep everything in `engine/` (framework-free, unit-testable), same as the rest.

---

## 2. Data model

### 2.1 Segment fields on `Packet` (packet.ts / types/network.ts)

`Packet` already carries `seq`. Add the rest of a TCP header as optional fields
so UDP/ICMP/DNS packets are unaffected:

```ts
// on Packet
ackNo?: number       // cumulative ack (next byte expected)
tcpFlags?: number    // SYN|ACK|FIN|RST|PSH bitmask
window?: number      // advertised receive window (bytes) — flow control
payloadLen?: number  // bytes of application data this segment carries
checksum?: number    // Internet checksum over pseudo-header + segment
corrupt?: boolean    // set by the optional bit-error impairment (see §9)
```

`segment: Segment` stays for the label/color the renderer already uses
(`SYN`, `DATA`, `DATA-ACK` → derive from `tcpFlags`).

### 2.2 TCB — one per connection (tcb.ts)

```ts
interface Tcb {
  // identity (4-tuple; localNode is the owning endpoint)
  localPort: number
  remoteNode: string
  remotePort: number

  state: 'CLOSED'|'LISTEN'|'SYN_SENT'|'SYN_RCVD'|'ESTABLISHED'
       | 'FIN_WAIT_1'|'FIN_WAIT_2'|'CLOSING'|'TIME_WAIT'|'CLOSE_WAIT'|'LAST_ACK'

  // send sequence space
  iss: number; sndUna: number; sndNxt: number; writeSeq: number
  sndWnd: number            // peer's advertised window (flow control)
  // send buffer is modelled as byte COUNTS + a deterministic generator (see §7),
  // so no real byte arrays are stored; retransmission re-reads [sndUna, sndNxt).

  // receive sequence space
  irs: number; rcvNxt: number; readSeq: number
  reasm: Reasm              // out-of-order ranges (reasm.ts)

  // congestion control (Reno, in BYTES)
  cwnd: number; ssthresh: number
  dupAcks: number; inFastRecovery: boolean; recover: number

  // RTT / RTO (Jacobson–Karels)
  srtt: number; rttvar: number; rto: number
  rttTiming: boolean; rttSeq: number; rttStart: number; rttRetx: boolean

  // timers (absolute sim-ms deadlines; 0 = disarmed)
  rtoDeadline: number; delAckDeadline: number
  timeWaitDeadline: number; persistDeadline: number

  // app intent
  appToSend: number         // bytes the app still wants to hand to TCP
  finRequested: boolean; finSeq: number
  retxCount: number
  done: boolean
}
```

### 2.3 TcpEndpoint — one per host node (endpoint.ts)

```ts
class TcpEndpoint {
  nodeId: string
  conns: Map<string, Tcb>        // key = `${localPort}:${remoteNode}:${remotePort}`
  listeners: Set<number>          // ports in LISTEN (servers: 80, 443)
  nextEphemeral = 49152

  connect(remoteNode, remotePort, bytes): Tcb   // active open, app wants to send `bytes`
  listen(port): void
  deliver(pkt: Packet, ctx: TcpCtx): void        // a segment arrived here → demux + process
  tick(ctx: TcpCtx): void                         // run timers + send within window
}
```

`TcpCtx` is the injected seam to the engine (keeps the TCB testable, no engine import):

```ts
interface TcpCtx {
  now: number
  nextHop(from, to): string | null       // graph.getNextHop
  route(from, to): string[] | null        // graph.getRoute (for expectedHops)
  inject(seg: OutSegment): void           // hand a segment to the network
  links: NetworkLink[]
}
```

---

## 3. Segment ↔ Packet mapping

Endpoints never touch the wire directly; they call `ctx.inject(seg)`. The engine
turns that into a `Packet` with the **existing** machinery so forwarding, queues,
and loss are unchanged:

```
inject(seg):
  firstHop = ctx.nextHop(seg.srcNode, seg.dstNode)
  if firstHop == null: drop (no route) — sender's RTO will retry
  pkt = createPacket({
    sourceId: seg.srcNode, destinationId: seg.dstNode,
    firstHopId: firstHop, expectedHops: route length,
    srcPort, dstPort, seq, ackNo, tcpFlags, window, payloadLen,
    segment: labelFromFlags(seg.tcpFlags),   // for the renderer
    checksum: computeChecksum(seg),
    ...
  })
  engine.packets.push(pkt); scheduler.send(pkt, srcNode, firstHop, now)
```

This is exactly what `_emit` does today — factor its body into a shared
`engine._injectSegment(...)` that both the old UDP/ICMP flows and the new
endpoints call.

---

## 4. Delivery dispatch (the central refactor)

Today `_stepPackets` calls `_onDelivered`, which contains flow-coupled TCP logic.
Change delivery to hand the packet to the **destination node's endpoint**:

```
_stepPackets: on stepPacket(...) === 'delivered':
   if pkt is a TCP segment and endpoints.has(pkt.destinationId):
       endpoints.get(pkt.destinationId).deliver(pkt, ctx)
   else:
       _onDelivered(pkt, now)   // legacy path for UDP/ICMP/DNS
```

The receiver-side ACK logic that currently lives in `_onDelivered` **moves into
`TcpEndpoint.deliver` / the TCB**. ACKs become real packets sourced at the
destination node and forwarded back per-hop (forwarding tables are bidirectional,
so return traffic already works — no `revPath` needed).

---

## 5. The TCP algorithms (tcb.ts)

Implement the classic mechanisms; each is small in a single-threaded tick model:

- **Seq arithmetic** (`seq.ts`): `seqLt/Leq/Gt/Geq` via `(a-b)|0 < 0` on 32-bit,
  `seqAdd`. SYN and FIN each consume one sequence number.
- **Handshake:** active open → `SYN_SENT`; passive (SYN hits a `LISTEN` port) →
  create TCB in `SYN_RCVD`, reply `SYN|ACK`; final ACK → `ESTABLISHED`.
- **Send window:** `usable = min(cwnd, sndWnd) - (sndNxt - sndUna)`; emit up to
  MSS-sized `DATA` segments from `[sndNxt, writeSeq)` while usable > 0. Stagger
  by `TCP_DATA_STAGGER_MS` (0 under DDoS) so trains stay visible.
- **Receive + cumulative ACK:** in-order data advances `rcvNxt`; out-of-order goes
  to `reasm` and triggers an **immediate dup-ACK** (enables fast retransmit).
  In-order data schedules a **delayed ACK** (≤2 segments or 40 ms).
- **RTT/RTO (Jacobson–Karels):** sample one segment per window; on ack,
  `rttvar = .75·rttvar + .25·|srtt−R|; srtt = .875·srtt + .125·R;
  rto = clamp(srtt + 4·rttvar, 200ms, 60s)`. **Karn:** don't sample retransmits;
  double RTO on timeout (exponential backoff).
- **Congestion control (Reno, bytes):** slow start `cwnd += MSS` per ACK until
  `cwnd ≥ ssthresh`; congestion avoidance `cwnd += MSS·MSS/cwnd`. On timeout:
  `ssthresh = max(flight/2, 2·MSS); cwnd = MSS`. On 3 dup-ACKs: fast retransmit
  + fast recovery (`ssthresh = flight/2; cwnd = ssthresh + 3·MSS`), exit on the
  recovery ack.
- **Flow control:** receiver advertises `window = rcvBufFree`; sender clamps to it;
  zero window → **persist timer** sends 1-byte probes.
- **Teardown:** app close → `finRequested`, FIN after all data acked; standard
  `FIN_WAIT_1/2 → TIME_WAIT (2·MSL)` active close and `CLOSE_WAIT → LAST_ACK`
  passive close. Keep MSL short (~500 ms) so demos finish.
- **RST:** segment to a port with no listener/connection → send RST; on RST,
  drop the connection.

---

## 6. Timers in the tick model

No wall clock, no threads — every timer is an absolute **sim-ms deadline** checked
in `TcpEndpoint.tick(ctx)`:

```
tick(ctx):
  for tcb in conns:
    if tcb.rtoDeadline && now >= deadline:   onRto(tcb)      // retransmit sndUna, back off
    if tcb.delAckDeadline && now >= deadline: sendAck(tcb)
    if tcb.persistDeadline && now >= deadline: sendProbe(tcb)
    if tcb.state==TIME_WAIT && now>=deadline:  tcb.done=true
    sendWithinWindow(tcb)                      // push new data the window allows
```

Because deadlines are sim-time, pausing or rate-scaling the simulation scales the
TCP timers automatically — a property the C-stack design could never have.

---

## 7. Application driver (verifiable byte streams)

To *prove* reliability without storing megabytes, make payload a **pure function
of absolute stream offset**: `byte(i) = (i * 2654435761) >>> 24 & 0xff`. Then:

- The sender never stores bytes; retransmitting `[a,b)` just re-emits lengths.
- The receiver, on delivering in-order bytes `[readSeq, rcvNxt)`, recomputes the
  expected pattern and asserts equality → **byte-exact delivery check** for free.
- A `Packet` carries only `payloadLen` (+ checksum), not real bytes — cheap.

App model: replace the current flow spawner with an **app request** — pick a
`home` endpoint, a `server` endpoint + port (80/443), and a transfer size
(e.g. 8–64 KB); call `endpoint.connect(server, port, bytes)`. Optionally the
server replies with a response size (full-duplex) to exercise both buffers.

---

## 8. Checksum

Reuse the real Internet checksum (RFC 1071) over a pseudo-header built from the
two nodes' **already-assigned IPs** (topology gives every node an `ip`) + the TCP
segment. Compute on inject, verify on deliver.

Caveat: GlobeNet loss **drops** packets; it never flips bits, so the checksum
always passes and is ceremonial — until §9.

---

## 9. Optional: bit-error impairment (makes the checksum matter)

Add a per-link bit-error rate. On a "corrupted" event, set `pkt.corrupt = true`.
On deliver, if `corrupt`, the recomputed checksum ≠ carried checksum → **drop
before it reaches the TCB** (silent loss, sender's RTO recovers). This is the only
thing that makes the checksum functional, and it demonstrates why TCP needs one.

---

## 10. Engine tick integration (order)

```
tick(dt, now):
  graph.tick(now)                 // BGP (unchanged)
  spawnAppRequests(now)           // was _spawnFlows: now opens TCP connections
  for ep in endpoints: ep.tick(ctx)   // timers + send within window → inject segments
  _processFlows(now)              // legacy UDP/ICMP/DNS only
  _drainQueues(now)
  _stepPackets(dt, now)           // delivery → ep.deliver(pkt) for TCP, else _onDelivered
  prune...
  statsPush (throttled)
```

---

## 11. UI changes (read the real TCB)

- `engine.getTcpInfo(flowId)` → `getTcpInfo(connKey)` returns the live TCB view:
  state, `sndUna/sndNxt/rcvNxt`, cwnd/ssthresh (bytes), rwnd, inflight, srtt, rto,
  dupAcks, retransmits.
- **PacketInspector** "Congestion Control" section gains: TCP state, rwnd vs cwnd,
  SRTT/RTO, sequence/ack numbers of the ridden segment.
- **Dashboard**: add "TCP conns", keep retransmits (now real), add "fast retx".
- Renderer unchanged — segments are still `Packet`s; derive the label/color from
  `tcpFlags`.

---

## 12. Migration path (keep everything green)

1. **Scaffold, no behavior change.** Add `Packet` TCP fields, `seq.ts`, `tcb.ts`,
   `endpoint.ts`, `TcpCtx`, and `_injectSegment` (factored from `_emit`). Endpoints
   exist but nothing routes to them yet.
2. **One connection end-to-end.** Wire delivery dispatch (§4). Get a single active
   open → handshake → windowed data → teardown delivering byte-exact over the real
   network with real seq/ack, timeout-only retransmit. Fixed RTO first.
3. **Full mechanisms.** RTT/RTO, flow control, delayed ACK, fast retransmit/recovery,
   persist. Verify each in `engine-test.mts`.
4. **Cut over the spawner.** Replace TCP branch of `_createFlow`/`buildSteps`/
   `_tickTransfer`/`_onDelivered` with app requests → endpoints. Delete the old
   `TcpTransfer`. Leave UDP/ICMP/DNS on the flow model.
5. **UI + checksum + bit-errors + tests.**

Each step keeps `npm run test:engine` passing.

---

## 13. Testing (engine-test.mts additions)

- **Byte-exact under loss:** transfer N KB with elevated link loss; assert the
  receiver's in-order verification never fails and delivers exactly N bytes.
- **Sequence correctness:** `rcvNxt` only advances over contiguous bytes; OOO
  segments buffered in `reasm`, gaps filled on retransmit.
- **Handshake/teardown:** state reaches `ESTABLISHED`, then both closes reach
  `CLOSED`/`TIME_WAIT`.
- **Flow control:** shrink receiver buffer; assert sender never has more than
  `rwnd` outstanding; zero-window persist probes recover.
- **Fast retransmit:** drop one middle segment; assert 3 dup-ACKs → retransmit
  before the RTO would fire.
- **RTO/backoff:** blackhole a connection; assert exponential backoff then reset
  after max retries.
- Keep all existing BGP/queue/forwarding checks green.

---

## 14. Risks & tricky bits

- **Reassembly + seq wraparound** — the fiddliest code; isolate in `reasm.ts` +
  `seq.ts` with their own unit checks.
- **Reordering during BGP convergence** — a route change mid-connection can deliver
  segments out of order; good (exercises reasm), but watch for TTL-drop loops
  (already bounded by `TTL_MAX_HOPS`).
- **Packet volume** — real ACKs (both directions) + dup-ACKs roughly double packet
  count. The instanced renderer and O(1) alive-index already handle this; watch
  `MAX_ACTIVE_PACKETS`.
- **Determinism** — keep all timing on the injected sim clock; keep `Math.random`
  usage centralized so headless runs stay reproducible.
- **TIME_WAIT accumulation** — cap/expire promptly so idle TCBs don't pile up.

---

## 15. Effort

Milestones 1–2 are the spine (a real connection over the real network); 3 is the
bulk of the algorithm work; 4 is the risk-bearing cutover; 5 is polish. Sizeable
but self-contained, all in `engine/`, and it raises the whole project's fidelity:
the inspector would then be reading an actual TCP control block, and "reliable
delivery" would be a property you can assert rather than assert-by-construction.
