// Parte común de los transportes: enlaces por peer, ping/pong y detección de caída.
// ping/pong no llegan a onMessage: los consume el transporte y deja el RTT en rtt().
import type { NetMessage, Transport, TransportKind } from './types'

// Estado del enlace del cliente con el anfitrión (el anfitrión siempre está 'open' tras host()).
export type LinkStatus = 'connecting' | 'open' | 'retrying' | 'closed'

// Lo que devuelve createTransport: el Transport del contrato más RTT y estado de conexión.
export interface NetTransport extends Transport {
  rtt(peerId: string): number | null // ms; en el cliente, peerId = HOST_ID
  onStatus(cb: (status: LinkStatus) => void): void
}

export const HOST_ID = 'host' // peerId con el que el cliente ve al anfitrión
export const PEER_PREFIX = 'tanks-'
const PING_EVERY = 2000
const DROP_AFTER = 9000 // sin tráfico durante este tiempo → el peer se cayó
export const RETRY_FOR = 30000 // el cliente reintenta reconectar durante este tiempo

interface Link {
  lastSeen: number
  lastPing: number
  rtt: number | null
}

export abstract class BaseTransport implements NetTransport {
  abstract readonly kind: TransportKind
  protected role: 'host' | 'client' | null = null
  protected closed = false
  private links = new Map<string, Link>()
  private msgCbs: ((from: string, msg: NetMessage) => void)[] = []
  private peerCbs: ((peerId: string, state: 'join' | 'leave') => void)[] = []
  private statusCbs: ((status: LinkStatus) => void)[] = []
  private beat = 0

  abstract host(code?: string): Promise<string>
  abstract join(code: string): Promise<void>
  protected abstract sendRaw(peerId: string, msg: NetMessage): void
  protected abstract dropRaw(peerId: string): void // cierra el enlace de bajo nivel sin avisar
  protected lost(_peerId: string): void {} // caída detectada (el cliente reintenta)

  send(to: string | 'all', msg: NetMessage): void {
    if (this.closed) return
    if (this.role === 'client') return this.sendRaw(HOST_ID, msg)
    if (to === 'all') for (const id of this.links.keys()) this.sendRaw(id, msg)
    else if (this.links.has(to)) this.sendRaw(to, msg)
  }

  onMessage(cb: (from: string, msg: NetMessage) => void): void {
    this.msgCbs.push(cb)
  }

  onPeer(cb: (peerId: string, state: 'join' | 'leave') => void): void {
    this.peerCbs.push(cb)
  }

  onStatus(cb: (status: LinkStatus) => void): void {
    this.statusCbs.push(cb)
  }

  rtt(peerId: string): number | null {
    return this.links.get(peerId)?.rtt ?? null
  }

  close(): void {
    this.closed = true
    clearInterval(this.beat)
    this.links.clear()
    this.status('closed')
  }

  protected status(s: LinkStatus): void {
    for (const cb of this.statusCbs) cb(s)
  }

  protected linked(peerId: string): boolean {
    return this.links.has(peerId)
  }

  protected linkUp(peerId: string): void {
    if (this.closed) return
    if (this.links.has(peerId)) this.linkDown(peerId)
    const now = performance.now()
    this.links.set(peerId, { lastSeen: now, lastPing: 0, rtt: null })
    if (!this.beat) this.beat = window.setInterval(() => this.heartbeat(), 1000)
    for (const cb of this.peerCbs) cb(peerId, 'join')
  }

  protected linkDown(peerId: string): void {
    if (!this.links.delete(peerId)) return
    for (const cb of this.peerCbs) cb(peerId, 'leave')
  }

  protected receive(peerId: string, msg: NetMessage): void {
    const link = this.links.get(peerId)
    if (!link || this.closed) return
    link.lastSeen = performance.now()
    if (msg.t === 'ping') return this.sendRaw(peerId, { t: 'pong', at: msg.at })
    if (msg.t === 'pong') {
      link.rtt = Math.round(performance.now() - msg.at)
      return
    }
    for (const cb of this.msgCbs) cb(peerId, msg)
  }

  private heartbeat(): void {
    const now = performance.now()
    for (const [id, link] of [...this.links]) {
      if (now - link.lastSeen > DROP_AFTER) {
        this.dropRaw(id)
        this.linkDown(id)
        this.lost(id)
      } else if (now - link.lastPing >= PING_EVERY) {
        link.lastPing = now
        this.sendRaw(id, { t: 'ping', at: now })
      }
    }
  }
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
