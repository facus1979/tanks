// Online: conecta HostRoom / ClientRoom (src/net) con la sesión. Sin vistas: main.ts muestra el
// lobby con lobbyModel() y el HUD con hudNet().
import { decodeState, encodeState, hashState } from '../sim'
import type { Command, MatchConfig, Personality } from '../sim/types'
import { ClientRoom, HostRoom, createTransport, roomLink } from '../net'
import type { LinkStatus, LobbyState, Role, TransportKind } from '../net'
import type { HudNet, LobbyModel } from '../ui/types'
import type { NetSeat, Session } from './session'
import { loadProfile, type Profile } from './profile'

// v3: lo que flujo espera de las salas de src/net (los implementa red). Se llaman solo si existen, así
// esto compila y anda igual con una sala que todavía no los tiene.
// - profile(p): manda el nombre, tripulante y color del casillero que ocupa este dispositivo (mensaje
//   'profile'); el anfitrión lo aplica a su propio casillero.
// - steerLive(playerId, x, y): manda la posición en vivo del misil que dirige este dispositivo (mensaje
//   'steerLive'; el anfitrión la reparte a los demás).
// - hooks.onSteerLive(playerId, x, y): llegó la posición en vivo del misil de otro.
// - setPersonality(slot, p): anfitrión, personalidad de una IA de la sala (null = al azar).
interface RoomV3 {
  profile?: (p: Profile) => void
  setPersonality?: (slot: number, personality: Personality | null) => void
  steerLive?: (playerId: number, x: number, y: number) => void
}

export interface OnlineEvents {
  lobby(): void // cambió el lobby o el estado de la conexión
  start(config: MatchConfig, seat: NetSeat, snapshotPending: boolean): void
  end(reason: string): void // el anfitrión cerró, se perdió la conexión o no se pudo abrir
  peer(joined: boolean): void // alguien se conectó / desconectó (sonido)
}

const AIM_EVERY = 1 / 15
const STEER_EVERY = 1 / 15 // v3: steerLive

export class Online {
  readonly role: Role
  code = ''
  status = 'CONECTANDO…'
  started = false
  private host: HostRoom | null = null
  private client: ClientRoom | null = null
  private link: LinkStatus = 'connecting'
  private turn: { playerId: number; left: number } | null = null
  private timerKey = ''
  private aimSent = ''
  private aimT = 0
  private connected = new Set<string>()
  private closed = false
  private debugSeq = -1
  private steerT = 0
  private profileSent = '' // v3: casillero y perfil ya mandados (no repetir)

  constructor(
    role: Role,
    kind: TransportKind,
    private session: Session,
    private events: OnlineEvents,
  ) {
    this.role = role
    const transport = createTransport(kind)
    if (role === 'host') {
      this.host = new HostRoom(
        transport,
        {
          apply: (c) => session.applyNet(c),
          hash: () => hashState(must(session.authState)),
          snapshot: () => encodeState(must(session.authState)),
          // v3: el room valida que el 'steer' venga del dueño del misil y completa con ceros si el turno
          // vence, el dueño se va o el guiado se cuelga (state.guided de la sim del anfitrión)
          guided: () => session.authState?.guided ?? null,
          onLobby: (lobby) => this.lobbyChanged(lobby),
          onPeerLeft: (p) => {
            if (p.playerId != null) session.hostCommand({ type: 'setKind', playerId: p.playerId, kind: 'ai' })
          },
          onPeerBack: (p) => {
            if (p.playerId != null) session.hostCommand({ type: 'setKind', playerId: p.playerId, kind: 'human' })
          },
          onAimLive: (id, angle, power) => session.remoteAim(id, angle, power),
          onTimer: (playerId, left) => (this.turn = { playerId, left }),
          ...steerHook(session),
        },
        { name: profileName() },
      )
    } else {
      this.client = new ClientRoom(
        transport,
        {
          onLobby: (lobby) => this.lobbyChanged(lobby),
          onStart: (config, info) => {
            this.started = true
            this.turn = null
            const seat: NetSeat = {
              mode: 'client',
              localIds: info.myPlayerId != null && info.mySlot != null ? [info.myPlayerId] : [],
              route: (c: Command) => this.client?.input(c),
            }
            this.events.start(config, seat, info.seq > 0)
          },
          apply: (c) => session.receive(c),
          hash: () => hashState(must(session.authState)),
          onSnapshot: (_seq, data) => session.loadSnapshot(decodeState(data)),
          onAimLive: (id, angle, power) => session.remoteAim(id, angle, power),
          onTimer: (playerId, left) => (this.turn = { playerId, left }),
          onStatus: (s) => {
            this.link = s
            if (s === 'retrying') this.status = 'RECONECTANDO…'
            else if (s === 'open') this.status = this.started ? '' : 'ELEGI UN CASILLERO'
            this.events.lobby()
          },
          // v2.3: el anfitrión rechaza algo (por ejemplo, el mapa se achicó y quedaste sin casillero):
          // se muestra en la sala, no solo en la consola
          onReject: (reason) => {
            console.warn('online:', reason)
            if (!this.started) {
              this.status = reason.toUpperCase()
              this.events.lobby()
            }
          },
          onDesync: (seq) => console.warn('online: desincronizado en', seq),
          onEnd: (reason) => this.finish(reason),
          ...steerHook(session),
        },
        { name: profileName() },
      )
    }
  }

  // host: abre la sala. client: se une a la del código.
  async open(code?: string): Promise<void> {
    try {
      if (this.host) {
        this.code = await this.host.open()
        this.status = 'ESPERANDO JUGADORES'
        this.debug()
      } else if (this.client && code) {
        this.code = code
        this.status = 'CONECTANDO…'
        this.events.lobby()
        await this.client.join(code)
        this.status = 'ELEGI UN CASILLERO'
        this.debug()
      }
      this.events.lobby()
    } catch (err) {
      this.finish(err instanceof Error ? err.message : 'No se pudo conectar')
    }
  }

  get lobby(): LobbyState | null {
    return this.host ? this.host.lobby : this.client?.lobby ?? null
  }

  get seq(): number {
    return this.host?.seq ?? this.client?.seq ?? 0
  }

  lobbyModel(): LobbyModel | null {
    const lobby = this.lobby
    if (!lobby) return null
    return {
      role: this.role,
      lobby,
      link: this.code ? roomLink(this.code) : '',
      mySlot: this.host ? this.host.mySlot : this.client?.mySlot ?? null,
      status: this.status,
      canStart: !!this.host?.canStart(),
    }
  }

  // ---------- lobby (lo que hace el jugador en la vista) ----------

  claim(slot: number): void {
    if (this.host) this.host.claim(slot)
    else this.client?.claim(slot)
  }

  release(): void {
    if (this.host) this.host.release()
    else this.client?.release()
  }

  setSlot(slot: number, kind: 'human' | 'ai' | 'off'): void {
    this.host?.setSlot(slot, kind)
  }

  setOption(key: 'rounds' | 'difficulty' | 'biome' | 'turnSeconds' | 'size', value: number | string): void {
    this.host?.setOption(key, value)
  }

  canStart(): boolean {
    return !!this.host?.canStart()
  }

  // host: arma la partida y la arranca en la sesión.
  start(): boolean {
    const host = this.host
    if (!host || !host.canStart() || this.started) return false
    let res
    try {
      res = host.start()
    } catch (err) {
      console.warn(err)
      return false
    }
    this.started = true
    this.turn = null
    const lobby = host.lobby
    const localIds: number[] = []
    lobby.slots.forEach((s, i) => {
      const id = res.playerOfSlot[i]
      if (s.owner === 'host' && s.kind === 'human' && id != null) localIds.push(id)
    })
    const seat: NetSeat = { mode: 'host', localIds, route: (c: Command) => host.dispatch(c) }
    this.events.start(res.config, seat, false)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.host?.close()
    this.client?.close()
    if (typeof window !== 'undefined') delete window.__tanksNet
  }

  // ---------- cada frame ----------

  update(dt: number): void {
    if (this.closed || !this.started) {
      this.debug()
      return
    }
    const s = this.session
    // timer de turno de los humanos remotos (lo corre la sala del anfitrión)
    if (this.host) {
      const rt = s.remoteTurn
      const key = rt?.key ?? ''
      if (key !== this.timerKey) {
        this.timerKey = key
        this.turn = null
        if (rt) this.host.startTimer(rt.playerId)
        else this.host.stopTimer()
      }
    }
    // cañón en vivo: el anfitrión reparte el del jugador de turno (su humano o la IA); el cliente, el suyo
    this.aimT -= dt
    const live = s.liveAim()
    const mine = this.host ? !s.remoteTurn : s.myTurn
    if (live && mine && this.aimT <= 0) {
      const key = `${live.playerId}:${live.angle.toFixed(1)}:${live.power.toFixed(1)}`
      if (key !== this.aimSent) {
        this.aimSent = key
        this.aimT = AIM_EVERY
        if (this.host) this.host.aim(live.playerId, live.angle, live.power)
        else this.client?.aimLive(live.playerId, live.angle, live.power)
      }
    }
    // v3: misil teledirigido en vivo (vista previa para los demás; las tandas van por el log)
    this.steerT -= dt
    const ls = s.liveSteer()
    if (ls && this.steerT <= 0) {
      this.steerT = STEER_EVERY
      this.room()?.steerLive?.(ls.playerId, ls.x, ls.y)
    }
    this.debug()
  }

  // v3: manda el perfil del jugador de este dispositivo para su casillero (al ocuparlo o al cambiarlo).
  sendProfile(p: Profile | null = loadProfile(), force = false): void {
    const slot = this.host ? this.host.mySlot : this.client?.mySlot ?? null
    if (!p || slot == null || this.started) return
    const key = `${slot}:${p.name}:${p.crew}:${p.color}`
    if (!force && key === this.profileSent) return
    const room = this.room()
    if (!room?.profile) return
    this.profileSent = key
    try {
      room.profile(p)
    } catch (err) {
      console.warn('online: no se pudo mandar el perfil', err)
    }
  }

  // v3: el anfitrión elige la personalidad de una IA de la sala (null = al azar).
  setPersonality(slot: number, personality: Personality | null): void {
    if (!this.host) return
    const room = this.room()
    if (room?.setPersonality) room.setPersonality(slot, personality)
    else console.warn('online: la sala todavía no sabe elegir la personalidad de la IA')
  }

  private room(): RoomV3 | null {
    return ((this.host ?? this.client) as unknown as RoomV3 | null) ?? null
  }

  hudNet(): HudNet {
    const s = this.session.state
    let peers: HudNet['peers'] = []
    if (this.host) {
      peers = this.host.peers().filter((p) => p.slot !== null).map((p) => ({ name: p.name, connected: p.connected, ping: p.ping }))
    } else if (this.lobby) {
      const me = this.client?.mySlot
      peers = this.lobby.slots
        .filter((q, i) => q.kind === 'human' && q.owner !== null && i !== me)
        .map((q) => ({ name: q.name, connected: q.connected, ping: q.owner === 'host' ? this.client?.ping ?? null : null }))
    }
    let waiting: string | null = null
    if (this.link === 'retrying') waiting = 'RECONECTANDO…'
    else if (s && s.phase === 'aiming') {
      const p = s.players[s.current]
      if (p && p.alive && p.kind === 'human' && !this.session.isLocal(p) && !this.session.busy) waiting = `ESPERANDO A ${p.name.toUpperCase()}…`
    } else if (s && s.phase === 'shop' && this.session.shopQueue().length === 0) {
      const names = s.players.filter((p) => p.kind === 'human' && !p.ready && !this.session.isLocal(p)).map((p) => p.name.toUpperCase())
      if (names.length) waiting = `ESPERANDO A ${names.join(', ')}…`
    } else if (s && this.session.awaitingHost) waiting = 'ESPERANDO AL ANFITRION…'
    const current = s && s.phase === 'aiming' ? s.players[s.current] : null
    const turnLeft = this.turn && current && this.turn.playerId === current.id && !this.session.busy ? Math.max(0, this.turn.left) : null
    return { role: this.role, code: this.code, peers, turnLeft, waiting }
  }

  // ---------- interno ----------

  private lobbyChanged(_lobby: LobbyState): void {
    // sonido de conexión / desconexión de los humanos remotos
    const lobby = this.lobby
    if (lobby) {
      const now = new Set<string>()
      for (const q of lobby.slots) if (q.owner && q.connected) now.add(q.owner)
      const myId = this.host ? 'host' : this.client?.peerId
      for (const id of now) if (!this.connected.has(id) && id !== myId && this.connected.size > 0) this.events.peer(true)
      for (const id of this.connected) if (!now.has(id) && id !== myId) this.events.peer(false)
      this.connected = now
    }
    if (this.host && !this.started) this.status = this.host.canStart() ? 'LISTO PARA EMPEZAR' : 'ESPERANDO JUGADORES'
    // v3: con casillero propio, el perfil guardado viaja a la sala
    this.sendProfile()
    this.debug()
    this.events.lobby()
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.close()
    this.events.end(reason)
  }

  private debug(): void {
    if (typeof window === 'undefined' || this.closed) return
    const seq = this.seq
    const phase = this.started ? this.session.authState?.phase ?? 'lobby' : 'lobby'
    const prev = window.__tanksNet
    if (prev && seq === this.debugSeq && prev.phase === phase && prev.code === this.code) return
    this.debugSeq = seq
    const state = this.started ? this.session.authState : null
    window.__tanksNet = {
      role: this.role,
      code: this.code,
      seq,
      hash: state ? hashState(state) : 0,
      phase,
      players: state?.players.length,
      size: state?.size,
    }
  }
}

// v3: nombre del perfil guardado para el hello de la sala ('' = el de siempre).
function profileName(): string {
  return loadProfile()?.name ?? ''
}

// v3: hook de steerLive para las salas (si la sala no lo conoce, lo ignora).
function steerHook(session: Session): object {
  return { onSteerLive: (playerId: number, x: number, y: number) => session.remoteSteer(playerId, x, y) }
}

function must<T>(v: T | null): T {
  if (v == null) throw new Error('Sin partida')
  return v
}
