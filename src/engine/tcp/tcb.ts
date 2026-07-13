import type { NetworkLink, Segment } from '../../types/network'
import { Reasm } from './reasm'
import { randomIsn } from './seq'
import {
  INIT_CWND,
  INIT_SSTHRESH,
  RTO_INIT,
  F_SYN,
  F_ACK,
  F_FIN,
  F_RST,
  F_PSH,
} from './tcp-const'

// The TCP finite state machine (RFC 793).
export type TcpState =
  | 'CLOSED'
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSING'
  | 'TIME_WAIT'
  | 'CLOSE_WAIT'
  | 'LAST_ACK'

// One segment an endpoint wants to put on the wire. The engine turns this into
// a Packet (routing it hop-by-hop through the simulated network) — the endpoint
// never touches the network directly.
export interface OutSegment {
  srcNode: string
  dstNode: string
  srcPort: number
  dstPort: number
  seq: number
  ackNo: number
  flags: number // F_SYN | F_ACK | ...
  window: number // advertised receive window (bytes)
  payloadLen: number // application bytes carried (0 for pure control/ACK)
}

// The seam between an endpoint and the engine (kept as an interface so the TCB
// and endpoint stay engine-free and unit-testable). Milestone 1 defines it;
// Milestone 2 wires the engine to provide it.
export interface TcpCtx {
  now: number
  nextHop(from: string, to: string): string | null
  route(from: string, to: string): string[] | null
  inject(seg: OutSegment): void
  links: NetworkLink[]
}

// The Transmission Control Block: everything TCP tracks for one connection.
export interface Tcb {
  // Identity (4-tuple; the local node is the owning endpoint).
  localNode: string
  localPort: number
  remoteNode: string
  remotePort: number

  state: TcpState

  // Send sequence space.
  iss: number
  sndUna: number // oldest unacknowledged byte
  sndNxt: number // next byte to send
  writeSeq: number // next byte the app will hand to TCP (end of send buffer)
  sndWnd: number // peer's advertised window (flow control limit)

  // Receive sequence space.
  irs: number
  rcvNxt: number // next in-order byte expected
  readSeq: number // next byte the app will consume (<= rcvNxt)
  reasm: Reasm

  // Congestion control (Reno, in bytes).
  cwnd: number
  ssthresh: number
  dupAcks: number
  inFastRecovery: boolean
  recover: number // snd_nxt snapshot at loss (NewReno recovery point)

  // RTT estimation / RTO (Jacobson–Karels, Karn).
  srtt: number
  rttvar: number
  rto: number
  rttTiming: boolean
  rttSeq: number
  rttStart: number
  rttRetx: boolean

  // Timer deadlines (absolute sim-ms; 0 = disarmed).
  rtoDeadline: number
  delAckDeadline: number
  timeWaitDeadline: number
  persistDeadline: number

  // Retransmit queue: seq → bookkeeping for a sent-but-unacked segment.
  inflight: Map<number, { end: number; sentAt: number; retx: number }>

  // Application intent.
  appToSend: number // bytes the app still wants TCP to deliver
  finRequested: boolean
  finSeq: number
  retxCount: number

  // Verification: bytes actually delivered in order to the receiving app.
  bytesDelivered: number

  done: boolean
}

export interface CreateTcbArgs {
  localNode: string
  localPort: number
  remoteNode: string
  remotePort: number
  state: TcpState
}

// Build a fresh TCB with a random ISS and the standard initial control values.
export function createTcb(a: CreateTcbArgs): Tcb {
  const iss = randomIsn()
  return {
    localNode: a.localNode,
    localPort: a.localPort,
    remoteNode: a.remoteNode,
    remotePort: a.remotePort,
    state: a.state,

    iss,
    sndUna: iss,
    sndNxt: iss,
    writeSeq: iss,
    sndWnd: INIT_CWND, // provisional until the peer advertises its window

    irs: 0,
    rcvNxt: 0,
    readSeq: 0,
    reasm: new Reasm(),

    cwnd: INIT_CWND,
    ssthresh: INIT_SSTHRESH,
    dupAcks: 0,
    inFastRecovery: false,
    recover: iss,

    srtt: 0,
    rttvar: 0,
    rto: RTO_INIT,
    rttTiming: false,
    rttSeq: 0,
    rttStart: 0,
    rttRetx: false,

    rtoDeadline: 0,
    delAckDeadline: 0,
    timeWaitDeadline: 0,
    persistDeadline: 0,

    inflight: new Map(),

    appToSend: 0,
    finRequested: false,
    finSeq: 0,
    retxCount: 0,

    bytesDelivered: 0,

    done: false,
  }
}

// The bytes still buffered but unsent: [sndNxt, writeSeq).
export function sendableBytes(tcb: Tcb): number {
  return (tcb.writeSeq - tcb.sndNxt) | 0
}

// Bytes in flight (sent, not yet acked): [sndUna, sndNxt).
export function flightSize(tcb: Tcb): number {
  return (tcb.sndNxt - tcb.sndUna) | 0
}

// Map a flag combination to the Segment label the renderer/inspector show.
export function flagsToLabel(flags: number, hasData: boolean, retx: boolean): Segment {
  if (retx) return 'RETX'
  if (flags & F_RST) return 'RST'
  if (flags & F_SYN) return flags & F_ACK ? 'SYN-ACK' : 'SYN'
  if (flags & F_FIN) return flags & F_ACK ? 'FIN-ACK' : 'FIN'
  if (hasData || flags & F_PSH) return 'DATA'
  if (flags & F_ACK) return 'DATA-ACK'
  return 'DATA-ACK'
}
