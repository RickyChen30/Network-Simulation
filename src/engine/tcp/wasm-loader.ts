// wasm-loader.ts — load the C TCP core (native/tcp_core.c → tcp_core.wasm) and
// present it behind the same seam the TS stack uses. This is the JS half of the
// hybrid: the C core owns all TCP state; this adapter marshals GlobeNet's string
// node-ids to the integer ids the core uses, and turns the core's host_emit
// callback into an OutSegment the engine injects.
//
// STATUS: ready to activate once `native/tcp_core.wasm` is built (see
// native/Makefile — needs a wasm-capable clang/emcc, which isn't installed in
// this environment). Nothing imports this module yet, so the default TS stack is
// unaffected. To switch GlobeNet onto the C core, see native/README.md.

import type { OutSegment } from './tcb'
import type { TcpCongestionInfo } from '../../types/network'
import { MSS } from './tcp-const'

// The functions the freestanding module exports (clang --export-all keeps the C
// names verbatim; an emcc build prefixes them with '_').
interface CoreExports {
  memory: WebAssembly.Memory
  tcp_init(): void
  tcp_listen(node: number, port: number): void
  tcp_connect(cnode: number, snode: number, sport: number, bytes: number): number
  tcp_tick(now: number): void
  tcp_deliver(now: number, dst: number, src: number, sport: number, dport: number,
              seq: number, ack: number, flags: number, window: number, plen: number): void
  tcp_reap(): number
  tcp_find(lnode: number, lport: number, rnode: number, rport: number): number
  tcp_active_conns(): number
  tcp_state(cid: number): number
  tcp_done(cid: number): number
  tcp_cwnd(cid: number): number
  tcp_ssthresh(cid: number): number
  tcp_srtt(cid: number): number
  tcp_snd_wnd(cid: number): number
  tcp_loss_events(cid: number): number
  tcp_bytes_delivered(cid: number): number
  tcp_flight(cid: number): number
  tcp_app_to_send(cid: number): number
  tcp_local_port(cid: number): number
  tcp_set_default_rcv_buf(bytes: number): void
  tcp_set_default_read_rate(rate: number): void
}

const TS_STATE = [
  'CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED',
  'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSING', 'TIME_WAIT', 'CLOSE_WAIT', 'LAST_ACK',
] as const

export class WasmTcpStack {
  private x: CoreExports
  private toId: string[] = [] // int index → node id
  private toIdx = new Map<string, number>() // node id → int index

  private constructor(x: CoreExports) {
    this.x = x
    x.tcp_init()
  }

  // Build the WASM import object; `inject` is the engine's _injectTcpSegment,
  // wrapped to take an OutSegment. `getStack` returns the (post-construction)
  // stack so host_emit can map integer node ids back to strings.
  private static env(inject: (seg: OutSegment) => void, getStack: () => WasmTcpStack) {
    return {
      env: {
        host_emit(src: number, dst: number, sport: number, dport: number, seq: number,
                  ack: number, flags: number, window: number, plen: number, retx: number) {
          inject({
            srcNode: getStack().name(src),
            dstNode: getStack().name(dst),
            srcPort: sport,
            dstPort: dport,
            seq: seq >>> 0,
            ackNo: ack >>> 0,
            flags,
            window,
            payloadLen: plen,
            retx: retx !== 0,
          })
        },
      },
    }
  }

  // Browser: stream + instantiate from a URL.
  static async load(wasmUrl: string, inject: (seg: OutSegment) => void): Promise<WasmTcpStack> {
    let stack!: WasmTcpStack
    const res = await WebAssembly.instantiateStreaming(fetch(wasmUrl), WasmTcpStack.env(inject, () => stack))
    stack = new WasmTcpStack(res.instance.exports as unknown as CoreExports)
    return stack
  }

  // Node / tests: instantiate from raw bytes.
  static async fromBytes(bytes: BufferSource, inject: (seg: OutSegment) => void): Promise<WasmTcpStack> {
    let stack!: WasmTcpStack
    const res = await WebAssembly.instantiate(bytes, WasmTcpStack.env(inject, () => stack))
    stack = new WasmTcpStack(res.instance.exports as unknown as CoreExports)
    return stack
  }

  // --- node-id interning (string ↔ int) ---
  idx(nodeId: string): number {
    let i = this.toIdx.get(nodeId)
    if (i === undefined) {
      i = this.toId.length
      this.toId.push(nodeId)
      this.toIdx.set(nodeId, i)
    }
    return i
  }
  private name(i: number): string {
    return this.toId[i] ?? `?${i}`
  }

  // --- the interface simulation.ts drives ---
  listen(nodeId: string, port: number): void {
    this.x.tcp_listen(this.idx(nodeId), port)
  }
  connect(cNode: string, sNode: string, port: number, bytes: number): number {
    return this.x.tcp_connect(this.idx(cNode), this.idx(sNode), port, bytes)
  }
  deliver(now: number, dstNode: string, srcNode: string, srcPort: number, dstPort: number,
          seq: number, ackNo: number, flags: number, window: number, payloadLen: number): void {
    this.x.tcp_deliver(now, this.idx(dstNode), this.idx(srcNode), srcPort, dstPort,
                       seq | 0, ackNo | 0, flags, window, payloadLen)
  }
  tick(now: number): void { this.x.tcp_tick(now) }
  reap(): number { return this.x.tcp_reap() }
  activeConns(): number { return this.x.tcp_active_conns() }
  setDefaultRcvBuf(bytes: number): void { this.x.tcp_set_default_rcv_buf(bytes) }
  setDefaultReadRate(rate: number): void { this.x.tcp_set_default_read_rate(rate) }

  // Congestion snapshot for the inspector, from a `tcp:src:port>dst:port` flow id.
  getInfo(flowId: string): TcpCongestionInfo | null {
    const m = /^tcp:(.+):(\d+)>(.+):(\d+)$/.exec(flowId)
    if (!m) return null
    const [, a, aPort, b, bPort] = m
    let cid = this.x.tcp_find(this.idx(a), +aPort, this.idx(b), +bPort)
    if (cid < 0) cid = this.x.tcp_find(this.idx(b), +bPort, this.idx(a), +aPort)
    if (cid < 0) return null
    const cwnd = this.x.tcp_cwnd(cid)
    const ssthresh = this.x.tcp_ssthresh(cid)
    return {
      cwnd: Math.max(1, Math.round(cwnd / MSS)),
      ssthresh: Math.round(ssthresh / MSS),
      state: cwnd < ssthresh ? 'slow-start' : 'congestion-avoidance',
      inFlightSegments: Math.round(this.x.tcp_flight(cid) / MSS),
      ackedSegments: Math.max(0, Math.round((this.x.tcp_bytes_delivered(cid)) / MSS)),
      totalSegments: Math.max(1, Math.round(this.x.tcp_app_to_send(cid) / MSS)),
      lossEvents: this.x.tcp_loss_events(cid),
    }
  }

  stateOf(cid: number): (typeof TS_STATE)[number] { return TS_STATE[this.x.tcp_state(cid)] ?? 'CLOSED' }
  isDone(cid: number): boolean { return this.x.tcp_done(cid) !== 0 }
}
