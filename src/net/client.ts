// Sala del cliente, sin UI ni Pixi. La sesión (área flujo) la crea y la conecta:
//
//   const room = new ClientRoom(createTransport(kind), hooks, { name })
//   await room.join(code)                 // conecta y manda hello con el token de reconexión
//   room.claim(slot) / room.release()     // lobby
//   hooks.onStart(config, info)           // info.seq === 0: createMatch(config); si no, esperar onSnapshot
//   hooks.apply(cmd)                      // log del anfitrión, en orden y sin huecos
//   room.input(cmd)                       // pedido al anfitrión (vuelve por hooks.apply si lo acepta)
//   room.aimLive(id, angle, power)        // vista previa (limitada a ~15/s); input(fire) la vacía antes
//
// Si falta un seq o el hash no coincide pide un snapshot y, hasta que llegue, guarda los comandos.
// Si se corta, el transporte reconecta solo; al volver repite el hello y recibe start + snapshot.
import type { Command, MatchConfig } from '../sim'
import { HOST_ID } from './base'
import type { LinkStatus, NetTransport } from './base'
import { NET_VERSION } from './types'
import type { LobbyState, NetMessage } from './types'
import { decompress, reconnectToken } from './util'

export interface ClientHooks {
  onLobby?(lobby: LobbyState, mySlot: number | null): void
  onStart(config: MatchConfig, info: { mySlot: number | null; myPlayerId: number | null; seq: number }): void
  apply(command: Command): void // applyCommand sobre la réplica
  hash(): number // hash de la réplica
  onSnapshot(seq: number, data: Uint8Array): void // decodeState(data) reemplaza la réplica
  onAimLive?(playerId: number, angle: number, power: number): void
  onTimer?(playerId: number, left: number): void
  onStatus?(status: LinkStatus): void // 'retrying' → "RECONECTANDO…"
  onReject?(reason: string): void
  onDesync?(seq: number): void // aviso (el room ya pidió el snapshot)
  onEnd?(reason: string): void // bye del anfitrión o conexión perdida del todo
}

const AIM_EVERY = 66 // ms

export class ClientRoom {
  seq = 0
  started = false
  peerId: string | null = null
  lobby: LobbyState | null = null
  config: MatchConfig | null = null
  private waitingSnap = false
  private buffer = new Map<number, Command>()
  private pendingHash: { seq: number; hash: number } | null = null
  private aimTimer = 0
  private aimLast = 0
  private aimNext: NetMessage | null = null
  private ended = false
  private readonly name: string

  constructor(
    private transport: NetTransport,
    private hooks: ClientHooks,
    opts: { name: string },
  ) {
    this.name = opts.name
    transport.onMessage((_from, msg) => this.message(msg))
    transport.onPeer((id, s) => {
      if (id === HOST_ID && s === 'join') this.hello() // también al reconectar
    })
    transport.onStatus((s) => {
      hooks.onStatus?.(s)
      if (s === 'closed') this.end('Se perdió la conexión con el anfitrión')
    })
  }

  async join(code: string): Promise<void> {
    await this.transport.join(code)
  }

  get mySlot(): number | null {
    if (!this.lobby || !this.peerId) return null
    const i = this.lobby.slots.findIndex((s) => s.owner === this.peerId)
    return i < 0 ? null : i
  }

  // Id del jugador en la partida (casilleros ocupados, en orden).
  get myPlayerId(): number | null {
    const slot = this.mySlot
    if (slot === null || !this.lobby) return null
    let id = 0
    for (let i = 0; i < slot; i++) if (this.lobby.slots[i].kind !== 'off') id++
    return id
  }

  get ping(): number | null {
    return this.transport.rtt(HOST_ID)
  }

  claim(slot: number): void {
    this.transport.send(HOST_ID, { t: 'claim', slot })
  }

  release(): void {
    this.transport.send(HOST_ID, { t: 'release' })
  }

  input(command: Command): void {
    if (command.type === 'aim') return this.aimLive(command.playerId, command.angle, command.power)
    this.flushAim()
    this.transport.send(HOST_ID, { t: 'input', command })
  }

  aimLive(playerId: number, angle: number, power: number): void {
    this.aimNext = { t: 'aimLive', playerId, angle, power }
    const since = performance.now() - this.aimLast
    if (since >= AIM_EVERY) this.flushAim()
    else if (!this.aimTimer) this.aimTimer = window.setTimeout(() => this.flushAim(), AIM_EVERY - since)
  }

  close(): void {
    this.ended = true
    clearTimeout(this.aimTimer)
    this.transport.close()
  }

  private flushAim(): void {
    clearTimeout(this.aimTimer)
    this.aimTimer = 0
    if (!this.aimNext) return
    this.transport.send(HOST_ID, this.aimNext)
    this.aimNext = null
    this.aimLast = performance.now()
  }

  private hello(): void {
    this.transport.send(HOST_ID, { t: 'hello', version: NET_VERSION, name: this.name, token: reconnectToken() })
  }

  private message(msg: NetMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.peerId = msg.peerId
        this.lobby = msg.lobby
        this.hooks.onLobby?.(msg.lobby, this.mySlot)
        return
      case 'lobby':
        this.lobby = msg.lobby
        this.hooks.onLobby?.(msg.lobby, this.mySlot)
        return
      case 'start':
        return this.start(msg.config, msg.seq, msg.slotOfPeer)
      case 'cmd':
        return this.cmd(msg.seq, msg.command)
      case 'hash':
        if (msg.seq === this.seq && !this.waitingSnap) this.checkHash(msg.seq, msg.hash)
        else if (msg.seq > this.seq) this.pendingHash = { seq: msg.seq, hash: msg.hash }
        return
      case 'snapshot':
        if (msg.data) void this.snapshot(msg.seq, msg.data)
        return
      case 'aimLive':
        this.hooks.onAimLive?.(msg.playerId, msg.angle, msg.power)
        return
      case 'timer':
        this.hooks.onTimer?.(msg.playerId, msg.left)
        return
      case 'reject':
        this.hooks.onReject?.(msg.reason)
        return
      case 'bye':
        this.end(msg.reason)
        this.transport.close()
        return
    }
  }

  private start(config: MatchConfig, seq: number, slotOfPeer: Record<string, number>): void {
    this.config = config
    this.buffer.clear()
    this.pendingHash = null
    if (seq > 0 || this.started) this.waitingSnap = true // el anfitrión manda el snapshot enseguida
    this.seq = seq
    if (this.started) return
    this.started = true
    const mySlot = this.peerId && this.peerId in slotOfPeer ? slotOfPeer[this.peerId] : this.mySlot
    this.hooks.onStart(config, { mySlot, myPlayerId: this.myPlayerId, seq })
  }

  private cmd(seq: number, command: Command): void {
    if (!this.started || seq <= this.seq) return
    if (this.waitingSnap || seq > this.seq + 1) {
      this.buffer.set(seq, command)
      if (!this.waitingSnap) this.requestSnapshot()
      return
    }
    this.applyOne(seq, command)
  }

  private applyOne(seq: number, command: Command): void {
    this.hooks.apply(command)
    this.seq = seq
    if (this.pendingHash?.seq === seq) {
      const h = this.pendingHash
      this.pendingHash = null
      this.checkHash(h.seq, h.hash)
    }
  }

  private checkHash(seq: number, hash: number): void {
    if (this.hooks.hash() === hash) return
    this.hooks.onDesync?.(seq)
    this.requestSnapshot()
  }

  private requestSnapshot(): void {
    if (this.waitingSnap) return
    this.waitingSnap = true
    this.transport.send(HOST_ID, { t: 'snapshot', seq: this.seq, data: '' })
  }

  private async snapshot(seq: number, data: string): Promise<void> {
    let bytes: Uint8Array
    try {
      bytes = await decompress(data)
    } catch {
      this.waitingSnap = false
      return this.requestSnapshot()
    }
    this.hooks.onSnapshot(seq, bytes)
    this.seq = seq
    this.waitingSnap = false
    if (this.pendingHash && this.pendingHash.seq <= seq) this.pendingHash = null
    for (const s of [...this.buffer.keys()].sort((a, b) => a - b)) {
      const c = this.buffer.get(s)!
      this.buffer.delete(s)
      if (s <= this.seq) continue
      if (s !== this.seq + 1) {
        this.buffer.set(s, c)
        return this.requestSnapshot()
      }
      this.applyOne(s, c)
    }
  }

  private end(reason: string): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.aimTimer)
    this.hooks.onEnd?.(reason)
  }
}
