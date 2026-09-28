// Transporte 'local': BroadcastChannel entre pestañas del mismo navegador (pruebas sin red).
// Mismos eventos que el de PeerJS: 'join' al aceptar la conexión, 'leave' al cerrar o al caerse,
// y el cliente reintenta reconectar solo. El orden de un emisor a un receptor se conserva.
import { BaseTransport, HOST_ID, RETRY_FOR, wait } from './base'
import type { NetMessage } from './types'
import { makeRoomCode, randomId } from './util'

type Envelope =
  | { k: 'probe'; from: string } // ¿hay anfitrión en este canal?
  | { k: 'here'; to: string }
  | { k: 'connect'; from: string }
  | { k: 'accept'; to: string }
  | { k: 'msg'; from: string; to: string; msg: NetMessage }
  | { k: 'close'; from: string }

export class LocalTransport extends BaseTransport {
  readonly kind = 'local' as const
  private ch: BroadcastChannel | null = null
  private id = 'L' + randomId(6)
  private accepted: (() => void) | null = null
  private retrying = false
  private onHide = () => this.close()

  async host(code?: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = code ?? makeRoomCode()
      const ch = new BroadcastChannel('tanks-net-' + c)
      let taken = false
      ch.onmessage = (e) => {
        if ((e.data as Envelope).k === 'here') taken = true
      }
      ch.postMessage({ k: 'probe', from: this.id } satisfies Envelope)
      await wait(300)
      if (!taken) {
        this.role = 'host'
        this.id = HOST_ID
        this.open(ch)
        this.status('open')
        return c
      }
      ch.close()
      if (code) throw new Error('El código de sala ya está en uso')
    }
    throw new Error('No pude abrir la sala')
  }

  async join(code: string): Promise<void> {
    this.role = 'client'
    this.open(new BroadcastChannel('tanks-net-' + code))
    this.status('connecting')
    if (!(await this.connect(5000))) {
      this.close()
      throw new Error('Sala no encontrada')
    }
    this.status('open')
  }

  close(): void {
    if (this.closed) return
    this.post({ k: 'close', from: this.id })
    super.close()
    removeEventListener('pagehide', this.onHide)
    this.ch?.close()
    this.ch = null
  }

  protected sendRaw(peerId: string, msg: NetMessage): void {
    this.post({ k: 'msg', from: this.id, to: peerId, msg })
  }

  protected dropRaw(_peerId: string): void {}

  protected lost(peerId: string): void {
    if (this.role === 'client' && peerId === HOST_ID) void this.reconnect()
  }

  private open(ch: BroadcastChannel): void {
    this.ch = ch
    ch.onmessage = (e) => this.handle(e.data as Envelope)
    addEventListener('pagehide', this.onHide)
  }

  private post(env: Envelope): void {
    try {
      this.ch?.postMessage(env)
    } catch {}
  }

  // Manda 'connect' cada segundo hasta que el anfitrión acepte o se acabe el tiempo.
  private async connect(ms: number): Promise<boolean> {
    const end = performance.now() + ms
    const ok = new Promise<boolean>((resolve) => (this.accepted = () => resolve(true)))
    while (!this.closed && performance.now() < end) {
      this.post({ k: 'connect', from: this.id })
      const r = await Promise.race([ok, wait(1000).then(() => false)])
      if (r) return true
    }
    this.accepted = null
    return false
  }

  private async reconnect(): Promise<void> {
    if (this.retrying || this.closed) return
    this.retrying = true
    this.status('retrying')
    const ok = await this.connect(RETRY_FOR)
    this.retrying = false
    if (ok) this.status('open')
    else this.close()
  }

  private handle(env: Envelope): void {
    if (this.closed) return
    if (this.role === 'host') {
      if (env.k === 'probe') this.post({ k: 'here', to: env.from })
      else if (env.k === 'connect') {
        this.post({ k: 'accept', to: env.from })
        this.linkUp(env.from) // si ya estaba, linkUp emite leave + join
      } else if (env.k === 'msg' && env.to === HOST_ID) this.receive(env.from, env.msg)
      else if (env.k === 'close') this.linkDown(env.from)
      return
    }
    if (env.k === 'accept' && env.to === this.id) {
      const cb = this.accepted
      this.accepted = null
      if (cb) {
        this.linkUp(HOST_ID)
        cb()
      }
    } else if (env.k === 'msg' && env.from === HOST_ID && (env.to === this.id || env.to === 'all')) {
      this.receive(HOST_ID, env.msg)
    } else if (env.k === 'close' && env.from === HOST_ID) {
      this.linkDown(HOST_ID)
      this.close()
    }
  }
}
