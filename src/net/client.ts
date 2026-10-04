// Sala del cliente, sin UI ni Pixi. La sesión (área flujo) la crea y la conecta:
//
//   const room = new ClientRoom(createTransport(kind), hooks, { name })
//   await room.join(code)                 // conecta y manda hello con el token de reconexión
//   room.claim(slot) / room.release()     // lobby
//   hooks.onStart(config, info)           // info.seq === 0: createMatch(config); si no, esperar onSnapshot
//   hooks.apply(cmd)                      // log del anfitrión, en orden y sin huecos
//   room.input(cmd)                       // pedido al anfitrión (vuelve por hooks.apply si lo acepta)
//   room.aimLive(id, angle, power)        // vista previa (limitada a ~15/s); input(fire) la vacía antes
//   room.profile({ name, crew, color })   // v3: perfil del casillero (solo en el lobby; se reenvía solo al
//                                         // reconectar). El anfitrión lo sanea y puede cambiar el color
//                                         // (ver ./profile): el que vale es el del lobby.
//
// v3 misil teledirigido, con predicción del que dispara (ver ./steer):
//   room.steer(id, dir)                   // un tick de STEER_TICK s (-1, 0, 1); sale en tandas de STEER_BATCH
//   room.steerBatch(id, dirs)             // o la tanda armada por el flujo (input({ type: 'steer' }) es lo mismo)
//   room.flushSteer()                     // manda lo que quede (al terminar el guiado local)
//   room.pendingSteers()                  // tandas propias todavía sin confirmar por el log, en orden
//   room.steerVersion                     // cambia cada vez que cambia pendingSteers() (para cachear)
//   room.steerLive(id, x, y)              // posición del misil predicho para los demás (hasta ~20/s)
//   room.steerStats()                     // latencia medida (envío → vuelve en el log) y correcciones
//   hooks.onSteerCorrect(reason)          // falló la predicción: el anfitrión rechazó o metió otra cosa
//                                         // ('reject' | 'mismatch' | 'snapshot'); pendingSteers() ya quedó vacío
//   hooks.onSteerLive(id, x, y)           // misil de otro jugador en vivo (vista previa, antes que el log)
// Predicción: estado mostrado = réplica (log confirmado) + pendingSteers() aplicados encima con
// applyCommand. Cuando la tanda vuelve en el log y coincide, sale de pendingSteers() en el mismo paso en
// que hooks.apply la aplica a la réplica: el estado mostrado no cambia (nada que corregir). Si no coincide
// (el anfitrión la rechazó, completó con ceros o hubo snapshot), pendingSteers() se vacía y el estado
// mostrado vuelve a ser el del log: la corrección es recalcular, no deshacer.
// Requisito de la sim (área sim-armas): aplicar 'steer' [a] y después [b] tiene que dar lo mismo que
// [a, b] (la tanda que todavía se está llenando se predice sola).
//
// Si falta un seq o el hash no coincide pide un snapshot y, hasta que llegue, guarda los comandos.
// Si se corta, el transporte reconecta solo; al volver repite el hello y recibe start + snapshot.
import type { Command, CrewId, MatchConfig } from '../sim'
import { HOST_ID } from './base'
import type { LinkStatus, NetTransport } from './base'
import { STEER_BATCH, STEER_FLUSH_MS, STEER_LIVE_MS, STEER_REJECT, sameSteer } from './steer'
import type { SteerCommand, SteerDir } from './steer'
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
  onSteerCorrect?(reason: 'reject' | 'mismatch' | 'snapshot'): void // v3: falló la predicción del guiado
  onSteerLive?(playerId: number, x: number, y: number): void // v3: misil de otro jugador en vivo
}

// v3: latencia del guiado medida en el cliente que dirige (para QA y el panel de red).
export interface SteerStats {
  confirmed: number // tandas confirmadas por el log
  corrected: number // veces que falló la predicción
  lastMs: number | null // ida y vuelta de la última tanda (envío → vuelve en el log)
  avgMs: number | null
  maxMs: number | null
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
  private myProfile: { name: string; crew: CrewId; color: number } | null = null
  // v3 guiado: tandas mandadas sin confirmar (con la hora de envío) y la que se está llenando
  private sent: { command: SteerCommand; at: number }[] = []
  private filling: SteerCommand | null = null
  private steerTimer = 0
  private liveLast = 0
  private liveTimer = 0
  private liveNext: NetMessage | null = null
  private stats = { confirmed: 0, corrected: 0, last: null as number | null, sum: 0, max: null as number | null }
  steerVersion = 0

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
    if (command.type === 'steer') return this.steerBatch(command.playerId, command.dirs)
    this.flushAim()
    this.transport.send(HOST_ID, { t: 'input', command })
  }

  // v3: perfil del casillero que ocupa (o del próximo que tome). Solo en el lobby. El flujo lo llama con
  // un objeto ({ name, crew, color }); también acepta los tres argumentos sueltos.
  profile(p: { name: string; crew: CrewId; color: number } | string, crewArg?: CrewId, colorArg?: number): void {
    const { name, crew, color } = typeof p === 'string' ? { name: p, crew: crewArg as CrewId, color: colorArg as number } : p
    this.myProfile = { name, crew, color }
    if (!this.started) this.transport.send(HOST_ID, { t: 'profile', name, crew, color })
  }

  // ---------- v3 misil teledirigido ----------

  // Un tick de guiado. Entra a la predicción al instante; sale al anfitrión en tandas de STEER_BATCH.
  steer(playerId: number, dir: SteerDir): void {
    if (this.filling && this.filling.playerId !== playerId) this.flushSteer()
    if (!this.filling) this.filling = { type: 'steer', playerId, dirs: [] }
    this.filling.dirs.push(dir)
    this.steerVersion++
    if (this.filling.dirs.length >= STEER_BATCH) this.flushSteer()
    else if (!this.steerTimer) this.steerTimer = window.setTimeout(() => this.flushSteer(), STEER_FLUSH_MS)
  }

  // Una tanda armada por el flujo: sale ya (y entra a la predicción).
  steerBatch(playerId: number, dirs: SteerDir[]): void {
    if (!dirs.length) return
    this.flushSteer()
    this.sendSteer({ type: 'steer', playerId, dirs: [...dirs] })
  }

  flushSteer(): void {
    clearTimeout(this.steerTimer)
    this.steerTimer = 0
    const c = this.filling
    this.filling = null
    if (c && c.dirs.length) this.sendSteer(c)
  }

  // Tandas propias sin confirmar, en orden (la que se está llenando al final).
  pendingSteers(): SteerCommand[] {
    const out = this.sent.map((s) => s.command)
    if (this.filling && this.filling.dirs.length) out.push(this.filling)
    return out
  }

  steerStats(): SteerStats {
    const s = this.stats
    return { confirmed: s.confirmed, corrected: s.corrected, lastMs: s.last, avgMs: s.confirmed ? s.sum / s.confirmed : null, maxMs: s.max }
  }

  // Posición del misil predicho, para que los demás lo vean antes que el log. Hasta ~20/s.
  steerLive(playerId: number, x: number, y: number): void {
    this.liveNext = { t: 'steerLive', playerId, x, y }
    const since = performance.now() - this.liveLast
    if (since >= STEER_LIVE_MS) this.flushLive()
    else if (!this.liveTimer) this.liveTimer = window.setTimeout(() => this.flushLive(), STEER_LIVE_MS - since)
  }

  aimLive(playerId: number, angle: number, power: number): void {
    this.aimNext = { t: 'aimLive', playerId, angle, power }
    const since = performance.now() - this.aimLast
    if (since >= AIM_EVERY) this.flushAim()
    else if (!this.aimTimer) this.aimTimer = window.setTimeout(() => this.flushAim(), AIM_EVERY - since)
  }

  close(): void {
    this.ended = true
    this.clearTimers()
    this.transport.close()
  }

  private clearTimers(): void {
    clearTimeout(this.aimTimer)
    clearTimeout(this.steerTimer)
    clearTimeout(this.liveTimer)
  }

  private sendSteer(command: SteerCommand): void {
    this.flushAim()
    this.sent.push({ command, at: performance.now() })
    this.steerVersion++
    this.transport.send(HOST_ID, { t: 'input', command })
  }

  private flushLive(): void {
    clearTimeout(this.liveTimer)
    this.liveTimer = 0
    if (!this.liveNext) return
    this.transport.send(HOST_ID, this.liveNext)
    this.liveNext = null
    this.liveLast = performance.now()
  }

  // Un 'steer' del log: si es la próxima tanda propia, se confirma; si es de un jugador con tandas
  // propias pendientes y no coincide (reordenada, ceros del anfitrión), la predicción falló.
  private matchSteer(command: Command): void {
    if (command.type !== 'steer') return
    const head = this.sent[0]
    if (head && sameSteer(head.command, command)) {
      this.sent.shift()
      const ms = performance.now() - head.at
      const s = this.stats
      s.confirmed++
      s.last = ms
      s.sum += ms
      s.max = Math.max(s.max ?? 0, ms)
      this.steerVersion++
      return
    }
    const mine = (head && head.command.playerId === command.playerId) || this.filling?.playerId === command.playerId
    if (mine) this.dropSteers('mismatch')
  }

  private dropSteers(reason: 'reject' | 'mismatch' | 'snapshot'): void {
    if (!this.sent.length && !this.filling) return
    this.sent = []
    this.filling = null
    clearTimeout(this.steerTimer)
    this.steerTimer = 0
    this.stats.corrected++
    this.steerVersion++
    this.hooks.onSteerCorrect?.(reason)
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
        // v3: el perfil elegido antes de entrar (o antes de reconectar) se manda ahora
        if (this.myProfile && !this.started) {
          const p = this.myProfile
          this.transport.send(HOST_ID, { t: 'profile', name: p.name, crew: p.crew, color: p.color })
        }
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
        // v3: un 'steer' rechazado no es un error para mostrar: corrige la predicción
        if (msg.reason === STEER_REJECT) return this.dropSteers('reject')
        this.hooks.onReject?.(msg.reason)
        return
      case 'steerLive':
        this.hooks.onSteerLive?.(msg.playerId, msg.x, msg.y)
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
    this.matchSteer(command) // la tanda sale de la predicción y entra a la réplica en el mismo paso
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
    this.dropSteers('snapshot') // la réplica se reemplaza: lo pendiente puede estar ya adentro o no
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
    this.clearTimers()
    this.hooks.onEnd?.(reason)
  }
}
