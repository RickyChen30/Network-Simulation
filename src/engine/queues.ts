import type { Packet, NetworkLink } from '../types/network'
import { LINK_SERVICE_FACTOR, ROUTER_QUEUE_CAPACITY } from '../config/constants'

// Router output ports: every directed link can transmit one packet at a time,
// at a rate set by its bandwidth. A packet arriving while the port is busy
// waits in that port's FIFO queue; when the queue is full it is tail-dropped.
// This is where congestion becomes real — under load (DDoS), queues build up
// and overflow, and TCP senders see the drops and halve their windows.

export type TransmitResult = 'sent' | 'queued' | 'dropped'

interface Port {
  serviceMs: number // transmission time per packet on this link
  nextFreeAt: number // sim time (ms) when the port finishes its current packet
  queue: Packet[] // packets waiting for the port (FIFO)
}

export class LinkScheduler {
  private _ports: Map<string, Port>

  constructor(links: NetworkLink[]) {
    this._ports = new Map()
    this.rebuild(links)
  }

  // (Re)create ports for the topology, emptying all queues.
  rebuild(links: NetworkLink[]): void {
    this._ports = new Map()
    for (const link of links) {
      const serviceMs = (LINK_SERVICE_FACTOR / link.bandwidth) * 1000
      for (const key of [
        `${link.sourceId}>${link.targetId}`,
        `${link.targetId}>${link.sourceId}`,
      ]) {
        this._ports.set(key, { serviceMs, nextFreeAt: 0, queue: [] })
      }
    }
  }

  // A packet at `fromId` wants to cross the link to `toId`: transmit right away
  // if the port is idle, park it in the queue if busy, tail-drop if full.
  send(packet: Packet, fromId: string, toId: string, nowMs: number): TransmitResult {
    const port = this._ports.get(`${fromId}>${toId}`)
    if (!port) return 'sent' // unknown link — never stall a packet on bookkeeping

    if (port.queue.length === 0 && port.nextFreeAt <= nowMs) {
      port.nextFreeAt = nowMs + port.serviceMs
      return 'sent'
    }
    if (port.queue.length >= ROUTER_QUEUE_CAPACITY) return 'dropped'
    port.queue.push(packet)
    return 'queued'
  }

  // Release queued packets whose transmission slot has arrived. Returns the
  // packets freed this call so the engine can put them back in flight.
  drain(nowMs: number): Packet[] {
    const released: Packet[] = []
    for (const port of this._ports.values()) {
      while (port.queue.length > 0 && port.nextFreeAt <= nowMs) {
        released.push(port.queue.shift()!)
        port.nextFreeAt = nowMs + port.serviceMs
      }
    }
    return released
  }
}
