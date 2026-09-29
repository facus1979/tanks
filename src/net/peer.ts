// Transporte 'peer': WebRTC con PeerJS (servidor de señalización público de PeerJS, STUN de Google).
// El anfitrión registra el id "tanks-" + código; cada cliente abre un DataConnection confiable
// y ordenado (JSON). Reintenta al conectar y, si el enlace se cae, reconecta solo durante RETRY_FOR.
import type { DataConnection, Peer as PeerT, PeerOptions } from 'peerjs'
import { BaseTransport, HOST_ID, PEER_PREFIX, RETRY_FOR, wait } from './base'
import type { NetMessage } from './types'
import { makeRoomCode } from './util'

// STUN alcanza entre redes "amables". Datos móviles y routers con NAT estricto necesitan TURN (un relay).
// Por defecto se usa el relay público de Open Relay; con VITE_TURN_URLS (separadas por coma),
// VITE_TURN_USER y VITE_TURN_PASS en el build se usa uno propio (p. ej. una cuenta gratis de Metered).
const env = import.meta.env as Record<string, string | undefined>
const TURN: RTCIceServer = env.VITE_TURN_URLS
  ? { urls: env.VITE_TURN_URLS.split(',').map((u) => u.trim()), username: env.VITE_TURN_USER, credential: env.VITE_TURN_PASS }
  : {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    }

const OPTIONS: Partial<PeerOptions> = {
  debug: 0,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      TURN,
    ],
  },
}
const CONNECT_TIMEOUT = 12000

let peerLib: Promise<typeof import('peerjs')> | null = null
const loadPeer = () => (peerLib ??= import('peerjs'))

export class PeerTransport extends BaseTransport {
  readonly kind = 'peer' as const
  private peer: PeerT | null = null
  private conns = new Map<string, DataConnection>()
  private hostPeerId = ''
  private retrying = false
  // Solo al irse de verdad: si la página queda en caché (celular que cambia de app) puede volver.
  private onHide = (e: PageTransitionEvent) => {
    if (!e.persisted) this.close()
  }

  async host(code?: string): Promise<string> {
    const { Peer } = await loadPeer()
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = code ?? makeRoomCode()
      const peer = new Peer(PEER_PREFIX + c, OPTIONS)
      try {
        await opened(peer)
      } catch (err) {
        peer.destroy()
        if (errType(err) === 'unavailable-id' && !code) continue
        throw new Error(errType(err) === 'unavailable-id' ? 'El código de sala ya está en uso' : describe(err))
      }
      this.role = 'host'
      this.peer = peer
      peer.on('connection', (conn) => this.accept(conn))
      peer.on('disconnected', () => {
        if (!this.closed && !peer.destroyed) peer.reconnect() // se cayó la señalización; los enlaces siguen
      })
      addEventListener('pagehide', this.onHide)
      this.status('open')
      return c
    }
    throw new Error('No pude abrir la sala')
  }

  async join(code: string): Promise<void> {
    this.role = 'client'
    this.hostPeerId = PEER_PREFIX + code
    this.status('connecting')
    addEventListener('pagehide', this.onHide)
    let last: unknown = null
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      try {
        await this.dial()
        this.status('open')
        return
      } catch (err) {
        last = err
        if (errType(err) === 'peer-unavailable') break
        await wait(1500)
      }
    }
    this.close()
    throw new Error(errType(last) === 'peer-unavailable' ? 'Sala no encontrada' : describe(last))
  }

  close(): void {
    if (this.closed) return
    super.close()
    removeEventListener('pagehide', this.onHide)
    for (const c of this.conns.values()) c.close()
    this.conns.clear()
    this.peer?.destroy()
    this.peer = null
  }

  protected sendRaw(peerId: string, msg: NetMessage): void {
    const conn = this.conns.get(peerId)
    if (!conn?.open) return
    try {
      void conn.send(msg)
    } catch {}
  }

  protected dropRaw(peerId: string): void {
    const conn = this.conns.get(peerId)
    this.conns.delete(peerId)
    conn?.close()
  }

  protected lost(peerId: string): void {
    if (this.role === 'client' && peerId === HOST_ID) void this.reconnect()
  }

  // Anfitrión: un cliente nuevo (o el mismo que vuelve con otro DataConnection).
  private accept(conn: DataConnection): void {
    conn.on('open', () => {
      if (this.closed) return conn.close()
      const old = this.conns.get(conn.peer)
      this.conns.set(conn.peer, conn)
      if (old && old !== conn) old.close()
      this.linkUp(conn.peer)
    })
    conn.on('data', (data) => {
      if (this.conns.get(conn.peer) === conn) this.receive(conn.peer, data as NetMessage)
    })
    const gone = () => {
      if (this.conns.get(conn.peer) !== conn) return
      this.conns.delete(conn.peer)
      this.linkDown(conn.peer)
    }
    conn.on('close', gone)
    conn.on('error', gone)
  }

  // Cliente: abre (o reabre) el Peer propio y el DataConnection al anfitrión.
  private async dial(): Promise<void> {
    const { Peer } = await loadPeer()
    if (!this.peer || this.peer.destroyed) {
      this.peer?.destroy()
      this.peer = new Peer(OPTIONS)
      await opened(this.peer)
    } else if (this.peer.disconnected) {
      this.peer.reconnect()
      await opened(this.peer)
    }
    const peer = this.peer
    const conn = peer.connect(this.hostPeerId, { reliable: true, serialization: 'json' })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        conn.close()
        reject(new Error('El anfitrión no responde'))
      }, CONNECT_TIMEOUT)
      const onErr = (err: unknown) => {
        cleanup()
        conn.close()
        reject(err)
      }
      const cleanup = () => {
        clearTimeout(timer)
        peer.off('error', onErr)
      }
      peer.on('error', onErr) // 'peer-unavailable' llega por el Peer, no por la conexión
      conn.on('open', () => {
        cleanup()
        resolve()
      })
      conn.on('error', onErr)
    })
    if (this.closed) return conn.close()
    const old = this.conns.get(HOST_ID)
    this.conns.set(HOST_ID, conn)
    old?.close()
    conn.on('data', (data) => {
      if (this.conns.get(HOST_ID) === conn) this.receive(HOST_ID, data as NetMessage)
    })
    const gone = () => {
      if (this.conns.get(HOST_ID) !== conn) return
      this.conns.delete(HOST_ID)
      this.linkDown(HOST_ID)
      this.lost(HOST_ID)
    }
    conn.on('close', gone)
    conn.on('error', gone)
    this.linkUp(HOST_ID)
  }

  private async reconnect(): Promise<void> {
    if (this.retrying || this.closed) return
    this.retrying = true
    this.status('retrying')
    const end = performance.now() + RETRY_FOR
    while (!this.closed && performance.now() < end) {
      try {
        await this.dial()
        this.retrying = false
        this.status('open')
        return
      } catch {
        await wait(2000)
      }
    }
    this.retrying = false
    this.close()
  }
}

function opened(peer: PeerT): Promise<void> {
  if (peer.open) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Sin respuesta del servidor de señalización')), CONNECT_TIMEOUT)
    const onOpen = () => done(null)
    const onErr = (err: unknown) => done(err)
    const done = (err: unknown) => {
      clearTimeout(timer)
      peer.off('open', onOpen)
      peer.off('error', onErr)
      if (err) reject(err)
      else resolve()
    }
    peer.on('open', onOpen)
    peer.on('error', onErr)
  })
}

function errType(err: unknown): string {
  return (err as { type?: string } | null)?.type ?? ''
}

function describe(err: unknown): string {
  const t = errType(err)
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Sin conexión con el servidor de salas'
  if (t === 'browser-incompatible') return 'Este navegador no soporta WebRTC'
  return err instanceof Error ? err.message : 'Error de conexión'
}
