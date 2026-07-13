import type { Packet } from '../../types/network'
import { createTcb, type Tcb, type TcpCtx } from './tcb'
import { seqAdd } from './seq'
import { EPHEMERAL_BASE, EPHEMERAL_SPAN } from './tcp-const'

// A TCP endpoint lives on one host node (`home` or `server`). It owns that
// host's connection table, demultiplexes arriving segments to the right
// connection by 4-tuple, allocates ephemeral ports for active opens, and runs
// each connection's timers and sender.
//
// Milestone 1 (this file) is scaffolding: the endpoint can create connections
// and hold listeners, but the engine does not yet route segments to `deliver`
// or drive `tick`, so the simulation's behavior is unchanged. Milestone 2 wires
// those two methods into the tick loop and fills in the state machine.

// Connection table key: the local port plus the remote 2-tuple. (The local node
// is implied by the owning endpoint.)
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

  /** Passive open: accept connections addressed to `port`. */
  listen(port: number): void {
    this.listeners.add(port)
  }

  /**
   * Active open toward `remoteNode:remotePort`, with an application that wants to
   * send `bytes` bytes. Creates the TCB in SYN_SENT; the SYN itself is put on the
   * wire by the sender in `tick` (Milestone 2).
   */
  connect(remoteNode: string, remotePort: number, bytes: number): Tcb {
    const localPort = this.allocEphemeralPort()
    const tcb = createTcb({
      localNode: this.nodeId,
      localPort,
      remoteNode,
      remotePort,
      state: 'SYN_SENT',
    })
    // The SYN occupies one sequence number; application data begins after it.
    tcb.sndNxt = seqAdd(tcb.iss, 1)
    tcb.writeSeq = seqAdd(tcb.iss, 1)
    tcb.appToSend = bytes
    this.conns.set(connKey(localPort, remoteNode, remotePort), tcb)
    return tcb
  }

  /**
   * A segment arrived at this host. Milestone 2: demultiplex to a connection
   * (creating a passive TCB on a SYN to a LISTEN port, or replying RST when
   * there is no match) and run the state machine. Inert in Milestone 1.
   */
  deliver(_pkt: Packet, _ctx: TcpCtx): void {
    /* Milestone 2 */
  }

  /**
   * One engine tick for this endpoint. Milestone 2: fire due timers
   * (retransmit / delayed-ACK / persist / TIME_WAIT) and push new data allowed
   * by the congestion + flow-control window. Inert in Milestone 1.
   */
  tick(_ctx: TcpCtx): void {
    /* Milestone 2 */
  }

  private allocEphemeralPort(): number {
    const port = this.nextEphemeral++
    if (this.nextEphemeral >= EPHEMERAL_BASE + EPHEMERAL_SPAN) this.nextEphemeral = EPHEMERAL_BASE
    return port
  }
}
