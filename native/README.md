# TCP — the C core

The **pure C port of the simulator's TCP stack** (`../src/engine/tcp/`). This is
the transport layer as freestanding C: the same source compiles to a **native**
object (verified here) and to a **WebAssembly** module that runs live TCP in the
browser, behind the exact seam the TypeScript stack already used.

## Why it ported cleanly

The TS stack was built as a *pure core* — no sockets, no threads, an **injected
clock** (every entry point takes `now`), all I/O behind a single `inject()`
callback, and payload as a **pure function of stream offset** (so no byte
buffers cross any boundary). That's exactly the shape a freestanding C / WASM
module needs, so the port is near‑mechanical, file for file:

| TypeScript      | C                          |
|-----------------|----------------------------|
| `seq.ts`        | serial‑number helpers      |
| `reasm.ts`      | `struct range` + coalesce  |
| `tcb.ts`        | `struct tcb` + `tcb_zero`  |
| `endpoint.ts`   | the state machine          |

`tcp_core.c` is **freestanding**: no libc, no `malloc`, no I/O. State lives in
fixed pools (`g_conns[128]`). That's what lets one source target both native and
WASM.

## The ABI

The core **imports one function** and **exports the `tcp_*` API**:

```c
/* host provides it (the C test defines it; in the browser it's a JS import): */
void host_emit(src_node, dst_node, src_port, dst_port,
               seq, ack, flags, window, payload_len, retx);

/* the core exports: */
void    tcp_init(void);
void    tcp_listen(node, port);
int32_t tcp_connect(cnode, snode, sport, bytes);   /* -> conn id */
void    tcp_tick(now);
void    tcp_deliver(now, dst, src, sport, dport, seq, ack, flags, window, plen);
int32_t tcp_reap(void);                            /* -> # completed */
/* + getters: tcp_state / tcp_cwnd / tcp_bytes_delivered / … (see tcp_core.h) */
```

Node ids and ports are **integers** (the JS glue interns string node ids to
indices). Because the core has no `malloc`, **no pointers cross the boundary** —
every argument is a scalar, so marshaling is trivial.

## Verify natively

```
make test
```

`tcp_test.c` plays the network's role: `host_emit` drops each segment into a tiny
in‑memory network (one‑way latency + optional random loss); the driver delivers
it later via `tcp_deliver`. It reproduces the TS stack's behaviour byte‑for‑byte:

```
basic transfer : 48 KB byte-exact, clean teardown
fast retransmit: 12 loss patterns @4% byte-exact, fast recovery exercised
flow control   : zero-window + persist, byte-exact
```

That covers the whole stack: handshake, sliding window, slow start / congestion
avoidance, Reno/NewReno fast retransmit, Go‑Back‑N RTO recovery, RTT/RTO
(Jacobson/Karels + Karn), reassembly, delayed ACKs, flow control, zero‑window
persist, and teardown.

## Build the WASM

```
make wasm     # -> tcp_core.wasm, copied into ../public/
```

`make wasm` uses a wasm‑capable clang + `wasm-ld` (e.g. from `brew install
llvm`; `brew install zig` also pulls a suitable toolchain). Edit the paths at
the top of the `Makefile` for your setup. The result is a lean, pure module with
`host_emit` left as an import from the JS `env`.

## How it plugs into the browser

`../src/engine/tcp/wasm-loader.ts` is the JS half. `WasmTcpStack.load()`
instantiates the module, turns the C's `host_emit` into an `OutSegment` the
engine injects, and exposes the interface the engine drives (`listen`,
`connect`, `tick`, `deliver`, `reap`, `getInfo`). At startup the app loads the
`.wasm`; if it's present, live TCP runs the C core, and the dashboard/engine
report the C backend. Without it, the app transparently falls back to the
identical TypeScript stack.

The C only replaces the **transport layer** — routing, queues, loss, BGP,
rendering and the inspector are untouched. And note: even running live, the C
speaks to the *simulated* network, not real sockets. (The same source also
compiles to a native binary that could run over real UDP — a separate target.)
