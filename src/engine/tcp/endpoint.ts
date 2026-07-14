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
  MAX_SEGS_PER_TICK,
  DELAYED_ACK_MS,
  DELAYED_ACK_SEGS,
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
  // Applied to passively-opened connections. Lower these on a server endpoint to
  // exercise flow control: a slow reader with a small buffer closes its window.
  defaultReadRate = Infinity
  defaultRcvBuf = RCV_BUF
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
    tcb.readRate = this.defaultReadRate
    tcb.rcvBuf = this.defaultRcvBuf
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
    const prevWnd = tcb.sndWnd
    tcb.sndWnd = pkt.window ?? tcb.sndWnd

    if (flags & F_ACK) this.processAck(tcb, ackNo, prevWnd, len > 0, ctx)
    if (tcb.sndWnd > 0) tcb.persistDeadline = 0 // the peer's window reopened

    // Complete the handshake.
    if (tcb.state === 'SYN_SENT') {
      if (flags & F_SYN && flags & F_ACK) {
        tcb.irs = seq
        tcb.rcvNxt = seqAdd(seq, 1)
        tcb.readSeq = tcb.rcvNxt
        tcb.state = 'ESTABLISHED'
        this.sendAckNow(tcb, ctx) // third leg of the handshake
      }
      return
    }
    if (tcb.state === 'SYN_RCVD' && seqGeq(tcb.sndUna, seqAdd(tcb.iss, 1))) {
      tcb.state = 'ESTABLISHED'
    }

    // Data + FIN. In-order data may be delay-ACKed; an out-of-order segment (a
    // gap) is ACKed immediately as a duplicate to drive the sender's fast
    // retransmit, and a FIN is always ACKed at once.
    let immediateAck = false
    let delayedAck = false
    if (len > 0) {
      if (this.recvData(tcb, seq, len)) delayedAck = true
      else immediateAck = true
      if (tcb.reasm.hasGaps()) immediateAck = true
    }
    if (flags & F_FIN) {
      if (seq === tcb.rcvNxt) this.recvFin(tcb, ctx)
      immediateAck = true
    }
    if (immediateAck) this.sendAckNow(tcb, ctx)
    else if (delayedAck) this.scheduleDelayedAck(tcb, ctx)

    this.checkFinAcked(tcb, ctx)
  }

  // Returns true if in-order data was delivered (advancing rcvNxt), false for a
  // pure duplicate or an out-of-order/over-window segment.
  private recvData(tcb: Tcb, seq: number, len: number): boolean {
    // Ignore anything wholly at or below what we've already delivered.
    if (seqLeq(seqAdd(seq, len), tcb.rcvNxt)) return false
    // Flow control: never buffer beyond the advertised window (readSeq + rcvBuf).
    const limit = seqAdd(tcb.readSeq, tcb.rcvBuf)
    if (seqGeq(seq, limit)) return false
    let end = seqAdd(seq, len)
    if (seqGt(end, limit)) end = limit
    const clamped = seqDiff(end, seq)
    if (clamped <= 0) return false

    tcb.reasm.insert(seq, clamped)
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
      return true
    }
    return false
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

  private processAck(tcb: Tcb, ackNo: number, prevWnd: number, hasData: boolean, ctx: TcpCtx): void {
    // Accept anything up to the highest byte ever sent (sndMax), not just the
    // current sndNxt: after a Go-Back-N rewind the receiver can cumulatively ACK
    // data it had buffered out of order, which lies beyond the rewound sndNxt.
    if (seqGt(ackNo, tcb.sndUna) && seqLeq(ackNo, tcb.sndMax)) {
      const oldUna = tcb.sndUna
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
      tcb.retxCount = 0

      if (tcb.inFastRecovery) {
        if (seqGeq(ackNo, tcb.recover)) {
          // Full ACK — recovery complete, deflate to the post-loss window.
          tcb.cwnd = tcb.ssthresh
          tcb.inFastRecovery = false
          tcb.dupAcks = 0
        } else {
          // Partial ACK (NewReno): the next hole surfaced — retransmit it and
          // deflate cwnd by the newly-acked amount (plus one segment).
          this.resendOldest(tcb, ctx)
          const acked = seqDiff(ackNo, oldUna)
          tcb.cwnd = Math.max(MSS, tcb.cwnd - acked + MSS)
        }
      } else {
        // Congestion window growth, one step per ACK.
        if (tcb.cwnd < tcb.ssthresh) tcb.cwnd += MSS // slow start
        else tcb.cwnd += Math.max(1, Math.floor((MSS * MSS) / tcb.cwnd)) // congestion avoidance
        tcb.dupAcks = 0
      }
      tcb.rtoDeadline = tcb.sndUna === tcb.sndNxt ? 0 : ctx.now + tcb.rto
    } else if (
      ackNo === tcb.sndUna &&
      !hasData &&
      tcb.sndWnd === prevWnd &&
      tcb.sndWnd > 0 &&
      seqGt(tcb.sndNxt, tcb.sndUna)
    ) {
      // A genuine duplicate ACK: no data, no window change, window open, and we
      // still have data outstanding.
      tcb.dupAcks++
      if (!tcb.inFastRecovery && tcb.dupAcks === 3) {
        // Fast retransmit + enter fast recovery (Reno/NewReno).
        tcb.ssthresh = Math.max(Math.floor(flightSize(tcb) / 2), 2 * MSS)
        tcb.recover = tcb.sndMax
        this.resendOldest(tcb, ctx)
        tcb.cwnd = tcb.ssthresh + 3 * MSS
        tcb.inFastRecovery = true
      } else if (tcb.inFastRecovery) {
        tcb.cwnd += MSS // inflate — each dup-ACK means a segment left the network
      }
    }
  }

  // Retransmit just the oldest unacknowledged segment (fast retransmit / NewReno
  // partial-ACK), without the Go-Back-N rewind an RTO does.
  private resendOldest(tcb: Tcb, ctx: TcpCtx): void {
    if (tcb.finSent && seqGeq(tcb.sndUna, tcb.finSeq)) {
      this.send(tcb, ctx, F_FIN | F_ACK, tcb.finSeq, 0)
    } else {
      const dataEnd = tcb.finRequested ? tcb.finSeq : tcb.writeSeq
      const len = Math.min(MSS, seqDiff(dataEnd, tcb.sndUna))
      if (len <= 0) return
      this.send(tcb, ctx, F_PSH | F_ACK, tcb.sndUna, len)
    }
    const seg = tcb.inflight.get(tcb.sndUna)
    if (seg) {
      seg.sentAt = ctx.now
      seg.retx++
    }
    tcb.rttRetx = true
    tcb.rtoDeadline = ctx.now + tcb.rto
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
      this.drainApp(tcb, ctx)
      this.serviceTimers(tcb, ctx)
      if (tcb.done) continue
      this.sendSegments(tcb, ctx)
    }
  }

  private serviceTimers(tcb: Tcb, ctx: TcpCtx): void {
    if (tcb.rtoDeadline && ctx.now >= tcb.rtoDeadline) this.onRto(tcb, ctx)
    if (tcb.ackPending && tcb.delAckDeadline && ctx.now >= tcb.delAckDeadline) {
      this.sendAckNow(tcb, ctx)
    }
    if (tcb.persistDeadline && ctx.now >= tcb.persistDeadline) this.sendProbe(tcb, ctx)
    if (tcb.state === 'TIME_WAIT' && tcb.timeWaitDeadline && ctx.now >= tcb.timeWaitDeadline) {
      tcb.state = 'CLOSED'
      tcb.done = true
    }
  }

  // Advance the receiving app's consumed pointer at its read rate, freeing
  // receive-buffer space. A slow reader keeps its window small or closed; when
  // the window reopens past a segment, send a proactive window update.
  private drainApp(tcb: Tcb, ctx: TcpCtx): void {
    if (tcb.readRate === Infinity) {
      tcb.readSeq = tcb.rcvNxt
      return
    }
    if (tcb.lastRead === 0) tcb.lastRead = ctx.now
    const dt = ctx.now - tcb.lastRead
    if (dt <= 0) return
    tcb.lastRead = ctx.now
    const freeBefore = this.recvWindow(tcb)
    const canRead = Math.floor((tcb.readRate * dt) / 1000)
    const buffered = seqDiff(tcb.rcvNxt, tcb.readSeq)
    const n = Math.min(canRead, buffered)
    if (n > 0) tcb.readSeq = seqAdd(tcb.readSeq, n)
    if (freeBefore < MSS && this.recvWindow(tcb) >= MSS && tcb.state !== 'CLOSED') {
      this.sendAckNow(tcb, ctx) // window-update: tell the sender it reopened
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
    tcb.inFastRecovery = false // a timeout supersedes fast recovery
    tcb.dupAcks = 0
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

    // Usable window respects BOTH congestion control (cwnd) and the peer's
    // advertised receive window (sndWnd) — flow control. If sndWnd is 0 nothing
    // is sent and the persist timer (below) takes over.
    const win = Math.min(tcb.cwnd, tcb.sndWnd)
    let sentThisTick = 0
    for (;;) {
      const flight = flightSize(tcb)
      if (flight >= win) break
      const can = win - flight
      const dataEnd = tcb.finRequested ? tcb.finSeq : tcb.writeSeq
      const avail = seqDiff(dataEnd, tcb.sndNxt)

      if (avail > 0) {
        if (sentThisTick >= MAX_SEGS_PER_TICK) break // pace: spread the window
        const len = Math.min(avail, MSS, can)
        if (len <= 0) break
        const end = seqAdd(tcb.sndNxt, len)
        const isNew = seqGeq(tcb.sndNxt, tcb.sndMax) // new territory vs a resend
        this.send(tcb, ctx, F_PSH | F_ACK, tcb.sndNxt, len)
        this.track(tcb, tcb.sndNxt, end, ctx.now, isNew)
        tcb.sndNxt = end
        if (isNew) tcb.sndMax = end
        this.armRto(tcb, ctx.now)
        sentThisTick++
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

    // Zero-window persist: the peer's window is shut but we still have data (or a
    // FIN) to send and nothing is in flight to elicit an ACK. Arm the probe timer.
    const end = tcb.finRequested ? tcb.finSeq : tcb.writeSeq
    const haveMore = seqGt(end, tcb.sndNxt) || (tcb.finRequested && !tcb.finSent)
    if (tcb.sndWnd === 0 && haveMore && flightSize(tcb) === 0 && !tcb.persistDeadline) {
      tcb.persistBackoff = Math.max(RTO_MIN, tcb.rto)
      tcb.persistDeadline = ctx.now + tcb.persistBackoff
    }
  }

  // Zero-window probe: send one byte (or the FIN) beyond sndNxt to force the
  // receiver to re-advertise its window, then back off and re-arm.
  private sendProbe(tcb: Tcb, ctx: TcpCtx): void {
    const dataEnd = tcb.finRequested ? tcb.finSeq : tcb.writeSeq
    if (seqGt(dataEnd, tcb.sndNxt)) {
      const end = seqAdd(tcb.sndNxt, 1)
      const isNew = seqGeq(tcb.sndNxt, tcb.sndMax)
      this.send(tcb, ctx, F_PSH | F_ACK, tcb.sndNxt, 1)
      this.track(tcb, tcb.sndNxt, end, ctx.now, isNew)
      tcb.sndNxt = end
      if (isNew) tcb.sndMax = end
      this.armRto(tcb, ctx.now)
    }
    tcb.persistBackoff = Math.min(RTO_MAX, tcb.persistBackoff * 2)
    tcb.persistDeadline = ctx.now + tcb.persistBackoff
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
    // Any segment we send carries our current ACK, so a pending delayed ACK is
    // satisfied (piggybacked).
    if (flags & F_ACK) {
      tcb.ackPending = false
      tcb.unackedSegs = 0
      tcb.delAckDeadline = 0
    }
  }

  private sendAckNow(tcb: Tcb, ctx: TcpCtx): void {
    this.send(tcb, ctx, F_ACK, tcb.sndNxt, 0)
  }

  // Hold the ACK briefly (delayed ACK) unless a second unacked segment has piled
  // up, in which case ACK immediately.
  private scheduleDelayedAck(tcb: Tcb, ctx: TcpCtx): void {
    tcb.unackedSegs++
    if (tcb.unackedSegs >= DELAYED_ACK_SEGS) {
      this.sendAckNow(tcb, ctx)
      return
    }
    tcb.ackPending = true
    if (!tcb.delAckDeadline) tcb.delAckDeadline = ctx.now + DELAYED_ACK_MS
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
    return Math.max(0, Math.min(65535, tcb.rcvBuf - buffered))
  }

  private allocEphemeralPort(): number {
    const port = this.nextEphemeral++
    if (this.nextEphemeral >= EPHEMERAL_BASE + EPHEMERAL_SPAN) this.nextEphemeral = EPHEMERAL_BASE
    return port
  }
}
