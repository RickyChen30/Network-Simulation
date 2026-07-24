# GlobeNet TCP — C core (the hybrid)

This is the **pure C port of GlobeNet's TCP stack** (`src/engine/tcp/`). It's the
"systems-programming" half of the hybrid: the transport-layer logic lives in C,
everything else (network graph, forwarding, queues, BGP, rendering, UI) stays
TypeScript. The same C source compiles two ways:

- a **native** object, verified here by `tcp_test.c` (`make test`), and
- a **WebAssembly** module that drops in behind GlobeNet's existing `TcpCtx`
  seam and drives the live globe (`make wasm`).

## Why this was portable at all

The TS stack was already built as a *pure core*: no sockets, no threads, an
**injected clock** (every entry point takes `now`), all I/O behind a single
`inject()` callback, and payload as a **pure function of stream offset** (so no
byte buffers cross any boundary). That's exactly the shape a freestanding C /
WASM module needs — the port is a near-mechanical translation, file for file:

| TypeScript            | C                         |
|-----------------------|---------------------------|
| `seq.ts`              | serial-number helpers     |
| `reasm.ts`            | `struct range` + coalesce |
| `tcb.ts`              | `struct tcb` + `tcb_zero` |
| `endpoint.ts`         | the state machine         |

`tcp_core.c` is **freestanding** — no libc, no `malloc`, no I/O. State lives in
fixed pools (`g_conns[128]`). That's what lets it target both native and WASM.

## The ABI (the seam, made concrete)

The core **imports one function** and **exports the `tcp_*` API**:

```c
/* host provides (JS "env" import / the C test defines it): */
void host_emit(src_node, dst_node, src_port, dst_port,
               seq, ack, flags, window, payload_len, retx);

/* core exports: */
void    tcp_init(void);
void    tcp_listen(node, port);
int32_t tcp_connect(cnode, snode, sport, bytes);   /* -> conn id */
void    tcp_tick(now);
void    tcp_deliver(now, dst, src, sport, dport, seq, ack, flags, window, plen);
int32_t tcp_reap(void);                            /* -> # completed */
/* + getters: tcp_state/cwnd/srtt/bytes_delivered/... (see tcp_core.h) */
```

Node ids and ports are **integers**; the JS glue interns GlobeNet's string node
ids to indices. Because the core has no `malloc`, **no pointers cross the
boundary** — every argument is a scalar, so marshaling is trivial.

## Verification (native — runs here)

```
make test
```

`tcp_test.c` plays GlobeNet's role: `host_emit` drops each segment into a tiny
network (one-way latency + optional random loss); the driver delivers it later
via `tcp_deliver`. It mirrors the Milestone 2/3 checks and currently passes:

```
basic transfer : PASS  (48 KB byte-exact, clean teardown)
fast retransmit: PASS  (12 loss patterns @4% byte-exact, fast recovery seen)
flow control   : PASS  (zero-window + persist, byte-exact)
```

So the C core reproduces the TS stack's verified behaviour byte-for-byte:
three-way handshake, sliding window, slow start / congestion avoidance,
Reno/NewReno fast retransmit, Go-Back-N RTO recovery, RTT/RTO (Jacobson/Karels
+ Karn), reassembly, delayed ACKs, flow control, zero-window persist, teardown.

## Building the WASM (needs a toolchain not installed here)

This machine has no wasm-capable compiler (no Emscripten, no wasi-sdk, and Apple
clang has no wasm backend), so the `.wasm` isn't built here. Once you install
one:

```
# freestanding clang (wasi-sdk, or `brew install llvm`):
make wasm            # -> tcp_core.wasm  (a lean, pure module, host_emit imported)
cp tcp_core.wasm ../public/
```

## Wiring it into GlobeNet (the last step)

`src/engine/tcp/wasm-loader.ts` is the JS half, ready to activate:

```ts
const wasm = await WasmTcpStack.load('/tcp_core.wasm', seg => engine.injectTcp(seg))
```

`WasmTcpStack` exposes the interface `simulation.ts` drives — `listen`,
`connect`, `tick`, `deliver`, `reap`, `activeConns`, `getInfo(flowId)`. The
integration swaps the per-node `TcpEndpoint`/`Tcb` usage in `simulation.ts` for
this single stack object:

1. Preload the module before the engine is constructed (WASM instantiation is
   async; the engine tick loop is sync).
2. Replace `_endpoints` + inline reap/RTT logic with the `WasmTcpStack`:
   - `_startTcpApp` → `wasm.connect(...)`
   - `_tickEndpoints` → `wasm.tick(now)` then `wasm.reap()` for completions
   - `_stepPackets` delivery dispatch → `wasm.deliver(now, …)`
   - `getTcpInfo` → `wasm.getInfo(flowId)`
3. `host_emit` → `_injectTcpSegment` (already the exact `OutSegment` shape).

Everything else — routing, queues, loss, BGP, the instanced renderer, the
inspector — is unchanged. The C core only replaces the transport layer, behind
the seam that already existed.
