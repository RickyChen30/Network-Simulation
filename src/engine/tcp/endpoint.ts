import type { Packet } from '../../types/network'
import {
  createTcb,
  flightSize,
  foldStreamHash,
  type Tcb,
  type TcpCtx,
} from './tcb'
import { seqAdd, seqDiff, seqGt, seqGeq, seqLt, seqLeq } from './seq'
import {
  MSS,
  RCV_BUF,
  RTO_MIN,
  RTO_MAX,
  RTT_ALPHA,
  RTT_BETA,
  RTO_K,
  MSL_MS,
  MAX_RETX,
  EPHEMERAL_BASE,
  EPHEMERAL_SPAN,
  F_SYN,
  F_ACK,
  F_FIN,
  F_RST,
  F_PSH,
} from './tcp-const'

// A TCP endpoint on one host node. It owns the host's connection table,
// demultiplexes arriving segments to the right connection by 4-tuple, runs each
// connection's timers and sender, and hands segments to the network via TcpCtx.
//
// Milestone 2: a full connection works end-to-end — three-way handshake,
// windowed data with slow-start / congestion-avoidance growth, cumulative ACKs
// and reassembly, timeout retransmission (fixed RTO with exponential backoff),
// and graceful FIN teardown (active + passive close). RTT-estimated RTO,
// delayed/duplicate-ACK fast retransmit, and zero-window persist are Milestone 3.

export function connKey(localPort: number, remoteNode: string, remotePort: number): string {
  return `${localPort}:${remoteNode}:${remotePort}`
}

export class TcpEndpoint {
  readonly nodeId: string
  readonly conns = new Map<string, Tcb>()
  readonly listeners = new Set<number>()
  private nextEphemeral = EPHEMERAL_BASE

  constructor(nodeId: string) {
    this.nodeId = nodeId
  }

  listen(port: number): void {
    this.listeners.add(port)
  }

  /** Active open toward `remoteNode:remotePort`; the app will send `bytes` then close. */
  connect(remoteNode: string, remotePort: number, bytes: number): Tcb {
    const localPort = this.allocEphemeralPort()
    const tcb = createTcb({
      localNode: this.nodeId,
      localPort,
      remoteNode,
      remotePort,
      state: 'SYN_SENT',
    })
    // Stream layout: [iss] = SYN, [iss+1 .. iss+1+bytes) = data, [iss+1+bytes] = FIN.
    tcb.writeSeq = seqAdd(tcb.iss, 1 + bytes)
    tcb.finRequested = true
    tcb.finSeq = seqAdd(tcb.iss, 1 + bytes)
    tcb.appToSend = bytes
    this.conns.set(connKey(localPort, remoteNode, remotePort), tcb)
    return tcb
  }

  // ---- inbound ------------------------------------------------------------

  deliver(pkt: Packet, ctx: TcpCtx): void {
    const flags = pkt.tcpFlags ?? 0
    const remoteNode = pkt.sourceId
    const remotePort = pkt.srcPort
    const localPort = pkt.dstPort
    const key = connKey(localPort, remoteNode, remotePort)
    let tcb = this.conns.get(key)

    if (!tcb) {
      // Passive open: a SYN to a listening port creates a connection.
      if (flags & F_SYN && !(flags & F_ACK) && this.listeners.has(localPort)) {
        tcb = this.passiveOpen(pkt, ctx)
        this.conns.set(key, tcb)
      }
      // No match and not a new SYN → drop (RST generation is Milestone 5).
      return
    }
    this.onSegment(tcb, pkt, ctx)
  }

  private passiveOpen(pkt: Packet, ctx: TcpCtx): Tcb {
    const tcb = createTcb({
      localNode: this.nodeId,
      localPort: pkt.dstPort,
      remoteNode: pkt.sourceId,
      remotePort: pkt.srcPort,
      state: 'SYN_RCVD',
    })
    tcb.irs = pkt.seq ?? 0
    tcb.rcvNxt = seqAdd(tcb.irs, 1) // the SYN occupies one sequence number
    tcb.readSeq = tcb.rcvNxt
    tcb.sndWnd = pkt.window ?? MSS
    // Reply SYN|ACK; it occupies iss and is retransmitted by the RTO if lost.
    this.send(tcb, ctx, F_SYN | F_ACK, tcb.iss, 0)
    tcb.sndNxt = seqAdd(tcb.iss, 1)
    tcb.sndMax = tcb.sndNxt
    tcb.synSent = true
    this.track(tcb, tcb.iss, seqAdd(tcb.iss, 1), ctx.now, true)
    this.armRto(tcb, ctx.now)
    return tcb
  }

  private onSegment(tcb: Tcb, pkt: Packet, ctx: TcpCtx): void {
    const flags = pkt.tcpFlags ?? 0
    const seq = pkt.seq ?? 0
    const ackNo = pkt.ackNo ?? 0
    const len = pkt.payloadLen ?? 0

    if (flags & F_RST) {
      tcb.done = true
      return
    }
    tcb.sndWnd = pkt.window ?? tcb.sndWnd

    if (flags & F_ACK) this.processAck(tcb, ackNo, ctx)

    // Complete the handshake.
    if (tcb.state === 'SYN_SENT') {
      if (flags & F_SYN && flags & F_ACK) {
        tcb.irs = seq
        tcb.rcvNxt = seqAdd(seq, 1)
        tcb.readSeq = tcb.rcvNxt
        tcb.state = 'ESTABLISHED'
        this.sendAck(tcb, ctx) // third leg of the handshake
      }
      return
    }
    if (tcb.state === 'SYN_RCVD' && seqGeq(tcb.sndUna, seqAdd(tcb.iss, 1))) {
      tcb.state = 'ESTABLISHED'
    }

    // Data + FIN.
    let ackNeeded = false
    if (len > 0) {
      this.recvData(tcb, seq, len)
      ackNeeded = true
    }
    if (flags & F_FIN) {
      if (seq === tcb.rcvNxt) this.recvFin(tcb, ctx)
      ackNeeded = true // ACK the FIN, or dup-ACK to prompt retransmit on a gap
    }
    if (ackNeeded) this.sendAck(tcb, ctx)

    this.checkFinAcked(tcb, ctx)
  }

  private recvData(tcb: Tcb, seq: number, len: number): void {
    // Ignore anything wholly at or below what we've already delivered.
    if (seqLeq(seqAdd(seq, len), tcb.rcvNxt)) return
    tcb.reasm.insert(seq, len)
    const before = tcb.rcvNxt
    const after = tcb.reasm.advance(before)
    if (seqGt(after, before)) {
      const delivered = seqDiff(after, before)
      const dataStart = seqAdd(tcb.irs, 1) // first data byte is index 0
      const startIdx = seqDiff(before, dataStart)
      for (let k = 0; k < delivered; k++) {
        tcb.deliverHash = foldStreamHash(tcb.deliverHash, startIdx + k)
      }
      tcb.bytesDelivered += delivered
      tcb.rcvNxt = after
      tcb.readSeq = after // the app consumes immediately in this model
    }
  }

  private recvFin(tcb: Tcb, ctx: TcpCtx): void {
    tcb.rcvNxt = seqAdd(tcb.rcvNxt, 1) // the FIN occupies one sequence number
    switch (tcb.state) {
      case 'ESTABLISHED':
        // Passive close: our app has nothing more to send, so close in turn.
        tcb.state = 'CLOSE_WAIT'
        tcb.finRequested = true
        tcb.finSeq = tcb.sndNxt
        break
      case 'FIN_WAIT_1':
        tcb.state = 'CLOSING'
        break
      case 'FIN_WAIT_2':
        tcb.state = 'TIME_WAIT'
        tcb.timeWaitDeadline = ctx.now + 2 * MSL_MS
        break
    }
  }

  private processAck(tcb: Tcb, ackNo: number, ctx: TcpCtx): void {
    // Accept anything up to the highest byte ever sent (sndMax), not just the
    // current sndNxt: after a Go-Back-N rewind the receiver can cumulatively ACK
    // data it had buffered out of order, which lies beyond the rewound sndNxt.
    if (seqGt(ackNo, tcb.sndUna) && seqLeq(ackNo, tcb.sndMax)) {
      // RTT sample (Jacobson/Karels) — but never off a retransmitted segment
      // (Karn's algorithm), since we can't tell which copy the ACK answers.
      if (tcb.rttTiming && !tcb.rttRetx && seqGt(ackNo, tcb.rttSeq)) {
        const r = ctx.now - tcb.rttStart
        if (tcb.srtt === 0) {
          tcb.srtt = r
          tcb.rttvar = r / 2
        } else {
          tcb.rttvar = (1 - RTT_BETA) * tcb.rttvar + RTT_BETA * Math.abs(tcb.srtt - r)
          tcb.srtt = (1 - RTT_ALPHA) * tcb.srtt + RTT_ALPHA * r
        }
        tcb.rto = Math.min(RTO_MAX, Math.max(RTO_MIN, tcb.srtt + RTO_K * tcb.rttvar))
        tcb.rttTiming = false
      }
      tcb.sndUna = ackNo
      // Don't retransmit data the receiver just acknowledged past the rewind.
      if (seqLt(tcb.sndNxt, tcb.sndUna)) tcb.sndNxt = tcb.sndUna
      for (const [start, seg] of tcb.inflight) {
        if (seqLeq(seg.end, ackNo)) tcb.inflight.delete(start)
      }
      // Congestion window growth, one step per ACK.
      if (tcb.cwnd < tcb.ssthresh) tcb.cwnd += MSS // slow start
      else tcb.cwnd += Math.max(1, Math.floor((MSS * MSS) / tcb.cwnd)) // congestion avoidance
      tcb.dupAcks = 0
      tcb.retxCount = 0
      tcb.rtoDeadline = tcb.sndUna === tcb.sndNxt ? 0 : ctx.now + tcb.rto
    } else if (ackNo === tcb.sndUna) {
      tcb.dupAcks++ // Milestone 3: 3 dup-ACKs → fast retransmit
    }
  }

  private checkFinAcked(tcb: Tcb, ctx: TcpCtx): void {
    if (!tcb.finSent) return
    if (!seqGeq(tcb.sndUna, seqAdd(tcb.finSeq, 1))) return
    switch (tcb.state) {
      case 'FIN_WAIT_1':
        tcb.state = 'FIN_WAIT_2'
        break
      case 'CLOSING':
        tcb.state = 'TIME_WAIT'
        tcb.timeWaitDeadline = ctx.now + 2 * MSL_MS
        break
      case 'LAST_ACK':
        tcb.state = 'CLOSED'
        tcb.done = true
        break
    }
  }

  // ---- per-tick timers + sender ------------------------------------------

  tick(ctx: TcpCtx): void {
    for (const tcb of this.conns.values()) {
      if (tcb.done) continue
      this.serviceTimers(tcb, ctx)
      if (tcb.done) continue
      this.sendSegments(tcb, ctx)
    }
  }

  private serviceTimers(tcb: Tcb, ctx: TcpCtx): void {
    if (tcb.rtoDeadline && ctx.now >= tcb.rtoDeadline) this.onRto(tcb, ctx)
    if (tcb.state === 'TIME_WAIT' && tcb.timeWaitDeadline && ctx.now >= tcb.timeWaitDeadline) {
      tcb.state = 'CLOSED'
      tcb.done = true
    }
  }

  private onRto(tcb: Tcb, ctx: TcpCtx): void {
    const now = ctx.now
    if (seqGeq(tcb.sndUna, tcb.sndNxt)) {
      tcb.rtoDeadline = 0 // nothing outstanding
      return
    }
    tcb.retxCount++
    if (tcb.retxCount > MAX_RETX) {
      tcb.done = true // give up after too many retries
      return
    }
    // Multiplicative decrease (a timeout is the strongest congestion signal).
    tcb.ssthresh = Math.max(Math.floor(flightSize(tcb) / 2), 2 * MSS)
    tcb.cwnd = MSS
    tcb.rttTiming = false // let a fresh (clean) RTT sample restart once recovered
    tcb.rto = Math.min(tcb.rto * 2, RTO_MAX) // exponential backoff
    tcb.rtoDeadline = now + tcb.rto

    if (tcb.sndUna === tcb.iss) {
      // The handshake SYN / SYN-ACK is still unacked — resend it directly
      // (sendSegments only originates the SYN, it doesn't retransmit it).
      const flags = tcb.state === 'SYN_RCVD' ? F_SYN | F_ACK : F_SYN
      this.send(tcb, ctx, flags, tcb.iss, 0)
      const seg = tcb.inflight.get(tcb.iss)
      if (seg) {
        seg.sentAt = now
        seg.retx++
      }
      return
    }
    // Data / FIN phase — Go-Back-N: rewind and let sendSegments resend everything
    // from the oldest unacked byte (slow-start clocked). Robust to the burst
    // losses a full-window send causes when it overruns a shallow router queue.
    tcb.inflight.clear()
    tcb.sndNxt = tcb.sndUna
    if (tcb.finSent) tcb.finSent = false // the FIN will be resent after the data
  }

  private sendSegments(tcb: Tcb, ctx: TcpCtx): void {
    // Send the initial SYN once we're in SYN_SENT.
    if (tcb.state === 'SYN_SENT' && !tcb.synSent) {
      this.send(tcb, ctx, F_SYN, tcb.iss, 0)
      tcb.sndNxt = seqAdd(tcb.iss, 1)
      tcb.sndMax = tcb.sndNxt
      tcb.synSent = true
      this.track(tcb, tcb.iss, seqAdd(tcb.iss, 1), ctx.now, true)
      this.armRto(tcb, ctx.now)
      return
    }
    if (
      tcb.state !== 'ESTABLISHED' &&
      tcb.state !== 'FIN_WAIT_1' &&
      tcb.state !== 'CLOSE_WAIT' &&
      tcb.state !== 'LAST_ACK'
    ) {
      return
    }

    const win = Math.max(MSS, Math.min(tcb.cwnd, tcb.sndWnd))
    for (;;) {
      const flight = flightSize(tcb)
      if (flight >= win) break
      const can = win - flight
      const dataEnd = tcb.finRequested ? tcb.finSeq : tcb.writeSeq
      const avail = seqDiff(dataEnd, tcb.sndNxt)

      if (avail > 0) {
        const len = Math.min(avail, MSS, can)
        if (len <= 0) break
        const end = seqAdd(tcb.sndNxt, len)
        const isNew = seqGeq(tcb.sndNxt, tcb.sndMax) // new territory vs a resend
        this.send(tcb, ctx, F_PSH | F_ACK, tcb.sndNxt, len)
        this.track(tcb, tcb.sndNxt, end, ctx.now, isNew)
        tcb.sndNxt = end
        if (isNew) tcb.sndMax = end
        this.armRto(tcb, ctx.now)
        continue
      }

      // All data sent — send the FIN if the app has closed.
      if (tcb.finRequested && !tcb.finSent && tcb.sndNxt === tcb.finSeq && can >= 1) {
        const finEnd = seqAdd(tcb.finSeq, 1)
        const isNew = seqGeq(tcb.finSeq, tcb.sndMax)
        this.send(tcb, ctx, F_FIN | F_ACK, tcb.finSeq, 0)
        this.track(tcb, tcb.finSeq, finEnd, ctx.now, isNew)
        tcb.sndNxt = finEnd
        if (isNew) tcb.sndMax = finEnd
        tcb.finSent = true
        this.armRto(tcb, ctx.now)
        if (tcb.state === 'ESTABLISHED') tcb.state = 'FIN_WAIT_1'
        else if (tcb.state === 'CLOSE_WAIT') tcb.state = 'LAST_ACK'
      }
      break
    }
  }

  // ---- helpers ------------------------------------------------------------

  private send(tcb: Tcb, ctx: TcpCtx, flags: number, seq: number, payloadLen: number): void {
    ctx.inject({
      srcNode: tcb.localNode,
      dstNode: tcb.remoteNode,
      srcPort: tcb.localPort,
      dstPort: tcb.remotePort,
      seq,
      ackNo: tcb.rcvNxt,
      flags,
      window: this.recvWindow(tcb),
      payloadLen,
    })
  }

  private sendAck(tcb: Tcb, ctx: TcpCtx): void {
    this.send(tcb, ctx, F_ACK, tcb.sndNxt, 0)
  }

  private track(tcb: Tcb, start: number, end: number, now: number, isNew: boolean): void {
    tcb.inflight.set(start, { end, sentAt: now, retx: 0 })
    // Time one *new* segment at a time for the RTT estimator. Resent segments
    // are never timed (Karn's algorithm).
    if (isNew && !tcb.rttTiming) {
      tcb.rttTiming = true
      tcb.rttSeq = start
      tcb.rttStart = now
      tcb.rttRetx = false
    }
  }

  private armRto(tcb: Tcb, now: number): void {
    if (tcb.rtoDeadline === 0) tcb.rtoDeadline = now + tcb.rto
  }

  private recvWindow(tcb: Tcb): number {
    const buffered = (tcb.rcvNxt - tcb.readSeq) | 0
    return Math.min(65535, RCV_BUF - buffered)
  }

  private allocEphemeralPort(): number {
    const port = this.nextEphemeral++
    if (this.nextEphemeral >= EPHEMERAL_BASE + EPHEMERAL_SPAN) this.nextEphemeral = EPHEMERAL_BASE
    return port
  }
}
