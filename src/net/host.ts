// Sala del anfitrión, sin UI ni Pixi. La sesión (área flujo) la crea y la conecta:
//
//   const room = new HostRoom(createTransport(kind), hooks, { name })
//   const code = await room.open()               // abre la sala; room.lobby tiene el estado
//   room.claim / release / setSlot / setOption   // lobby (lo que hace el anfitrión en la vista)
//                           // v5: siempre MAX_PLAYERS (8) casilleros, pero solo se ocupan los primeros
//                           // MAX_PLAYERS_BY_SIZE[size] (room.limit). Al achicar el mapa se compactan: ver fitSlots.
//   const { config, playerOfSlot } = room.start(seed)   // arma la partida; la sesión hace createMatch(config)
//   room.dispatch(cmd)      // TODO comando del anfitrión (su input, la IA, nextRound, setKind): valida con
//                           // hooks.apply, numera y reparte. 'aim' no entra al log: queda pendiente
//                           // y se mete antes del próximo comando de ese jugador (o con flushAim).
//   room.startTimer(id) / stopTimer()   // límite de turno de un humano remoto; al vencer dispara solo
//   room.close()
//
//
// v3 perfil (ver ./profile para las reglas de nombre y color):
//   room.setProfile({ name, crew, color })   // el del casillero del anfitrión (solo en el lobby)
//   room.setPersonality(slot, p | null)      // personalidad de un casillero de IA (null = la sortea la sim)
//   Los clientes mandan 'profile'; el anfitrión lo aplica a su casillero y lo refleja en el LobbyState.
//   El perfil del peer se recuerda: si cambia de casillero (claim) se lo lleva.
//   start() pone color y personality en cada SlotConfig del MatchConfig.
//
// v3 misil teledirigido (ver ./steer):
//   room.dispatch({ type: 'steer', ... })    // los del anfitrión (su humano o la IA), igual que cualquier comando
//   room.steerLive(playerId, x, y)           // posición en vivo del misil del anfitrión para los clientes
//   hooks.guided()                           // OBLIGATORIO con el teledirigido: state.guided de la sim del anfitrión
//   Con hooks.guided el room: rechaza 'steer' de quien no es el dueño del misil, completa con ceros si el
//   turno vence en 'guiding', si el dueño se desconecta o si el guiado se cuelga (GUIDE_SLACK).
//
// Los comandos de los clientes llegan por 'input': el room verifica que sean del jugador del
// casillero de ese peer y los pasa por hooks.apply (el mismo camino que dispatch).
// hooks.apply NO debe llamar a dispatch de forma síncrona (si lo hace, el comando se encola).
import { CREW_NAMES, CREWS, MAX_PLAYERS, MAX_PLAYERS_BY_SIZE, PERSONALITIES, STEER_TICK } from '../sim'
import type { Command, CrewId, MapSize, MatchConfig, Personality, PlayerKind } from '../sim'
import type { NetTransport } from './base'
import { assignColor, assignCrew, cleanName, isColor, isCrew } from './profile'
import { GUIDE_SLACK, STEER_REJECT, validDirs } from './steer'
import { NET_VERSION } from './types'
import type { LobbySlot, LobbyState, NetMessage } from './types'
import { compress } from './util'

// Lo que el room necesita del misil en vuelo (GameState.guided de la sim del anfitrión).
export interface GuidedInfo {
  ownerId: number
  t: number // segundos desde el disparo (en el apogeo: lo que tarda en verse el tramo balístico)
  guide: number // segundos de guiado que le quedan
}

export interface ProfileInput {
  name?: string
  crew?: CrewId
  color?: number
}

export interface HostHooks {
  apply(command: Command): boolean // applyCommand sobre la sim del anfitrión; true si lo aceptó
  hash(): number // hash del estado actual (después del último comando aplicado)
  snapshot(): string | Uint8Array // estado completo (encodeState), síncrono: se toma en el seq actual
  onLobby?(lobby: LobbyState): void // cambió el lobby (también durante la partida: conectado sí/no)
  onPeerLeft?(p: RoomPeerEvent): void // un humano remoto se fue: la sesión despacha setKind 'ai'
  onPeerBack?(p: RoomPeerEvent): void // volvió con su token (ya tiene snapshot): setKind 'human'
  onAimLive?(playerId: number, angle: number, power: number): void // vista previa de un remoto
  onTimer?(playerId: number, left: number): void
  guided?(): GuidedInfo | null // v3: state.guided de la sim del anfitrión (null fuera de 'guiding')
  onSteerLive?(playerId: number, x: number, y: number): void // v3: misil de un remoto en vivo (vista previa)
}

export interface RoomPeerEvent {
  peerId: string
  name: string
  slot: number
  playerId: number | null // null si la partida no empezó
}

export interface RoomPeerInfo {
  peerId: string
  name: string
  slot: number | null
  connected: boolean
  ping: number | null
}

const ROUNDS = [1, 3, 5, 10]
const SIZE_NAMES: Record<MapSize, string> = { small: 'Chico', medium: 'Mediano', large: 'Grande' }
const BIOMES_OK = ['forest', 'jungle', 'industrial', 'snow', 'random', 'rotate']

interface PeerRec {
  token: string
  name: string
  peerId: string | null // último peerId; conectado si byPeer lo tiene
  crew?: CrewId // v3: perfil elegido (se lo lleva al cambiar de casillero)
  color?: number
}

export class HostRoom {
  seq = 0
  started = false
  config: MatchConfig | null = null
  private state: LobbyState
  private byToken = new Map<string, PeerRec>()
  private byPeer = new Map<string, PeerRec>()
  private snapQueue = new Map<string, NetMessage[]>() // peers esperando su snapshot
  private pendingAim = new Map<number, { angle: number; power: number }>()
  private playerOfSlot: (number | null)[] = new Array(MAX_PLAYERS).fill(null)
  private applying = false
  private queue: Command[] = []
  private timer = 0
  private timerPlayer: number | null = null
  private readonly hashEvery: number
  // v3 guiado de un remoto: hasta cuándo se le espera (performance.now()) antes de completar con ceros
  private guideWatch: { playerId: number; timer: number } | null = null
  private completing = false
  private hostProfile: { crew?: CrewId; color?: number } = {} // v3: perfil del anfitrión (viaja con su casillero)

  constructor(
    private transport: NetTransport,
    private hooks: HostHooks,
    opts: { name: string; hashEvery?: number },
  ) {
    this.hashEvery = opts.hashEvery ?? 8
    const slots: LobbySlot[] = CREWS.map((crew, i) => ({
      kind: i < 2 ? 'human' : 'off',
      name: i === 0 ? cleanName(opts.name) || CREW_NAMES[crew] : '',
      crew,
      color: i, // v3: los 8 casilleros llevan siempre una permutación de los 8 colores (ver ./profile)
      owner: i === 0 ? 'host' : null,
      connected: i === 0,
    }))
    this.state = { code: '', slots, rounds: 3, difficulty: 'normal', biome: 'random', turnSeconds: 30, size: 'medium' }
    transport.onPeer((id, s) => (s === 'join' ? undefined : this.peerLeft(id)))
    transport.onMessage((from, msg) => this.message(from, msg))
  }

  get lobby(): LobbyState {
    return structuredClone(this.state)
  }

  get code(): string {
    return this.state.code
  }

  async open(code?: string): Promise<string> {
    this.state.code = await this.transport.host(code)
    this.lobbyChanged()
    return this.state.code
  }

  // ---------- lobby ----------

  get mySlot(): number | null {
    const i = this.state.slots.findIndex((s) => s.owner === 'host')
    return i < 0 ? null : i
  }

  // Casilleros que se pueden ocupar con el tamaño de mapa elegido (Chico 4, Mediano 6, Grande 8).
  get limit(): number {
    return MAX_PLAYERS_BY_SIZE[this.state.size ?? 'small'] ?? MAX_PLAYERS
  }

  claim(slot: number): boolean {
    return this.claimFor('host', slot, this.state.slots[this.mySlot ?? 0]?.name ?? '')
  }

  release(): void {
    this.releaseFor('host')
  }

  setSlot(slot: number, kind: PlayerKind | 'off'): void {
    const s = this.state.slots[slot]
    if (!s || this.started) return
    if (slot >= this.limit && kind !== 'off') return // por encima del límite del mapa solo 'off'
    if (s.owner === 'host' && kind !== 'human') return // el anfitrión suelta su casillero con release()
    if (s.owner && s.owner !== 'host' && kind !== 'human') s.owner = null
    s.kind = kind
    if (kind !== 'ai') delete s.personality // v3: la personalidad es solo de IA
    if (kind === 'ai') s.name = CREW_NAMES[s.crew]
    if (kind === 'off' || (kind === 'human' && !s.owner)) s.name = ''
    s.connected = s.owner === 'host' || (!!s.owner && this.byPeer.has(s.owner))
    this.lobbyChanged()
  }

  setOption(key: 'rounds' | 'difficulty' | 'biome' | 'turnSeconds' | 'size', value: number | string): void {
    if (this.started) return
    const st = this.state
    if (key === 'rounds' && ROUNDS.includes(Number(value))) st.rounds = Number(value)
    else if (key === 'difficulty' && (value === 'easy' || value === 'normal' || value === 'hard')) st.difficulty = value
    else if (key === 'biome' && BIOMES_OK.includes(String(value)))
      st.biome = value as LobbyState['biome']
    else if (key === 'turnSeconds' && Number(value) >= 0) st.turnSeconds = Math.round(Number(value))
    else if (key === 'size' && (value === 'small' || value === 'medium' || value === 'large')) {
      st.size = value
      const dropped = this.fitSlots()
      this.lobbyChanged()
      const n = MAX_PLAYERS_BY_SIZE[value]
      const reason = `El mapa ${SIZE_NAMES[value]} admite ${n} jugadores: quedaste sin casillero (podés tomar uno si se libera)`
      for (const p of dropped) this.transport.send(p, { t: 'reject', reason })
      return
    } else return
    this.lobbyChanged()
  }

  // v3: perfil del casillero del anfitrión (nombre, tripulante, color). Solo en el lobby.
  // Devuelve el color que le quedó (puede no ser el pedido: ver ./profile), o null si no aplica.
  setProfile(p: ProfileInput): number | null {
    const slot = this.mySlot
    if (this.started || slot === null) return null
    if (isCrew(p.crew)) this.hostProfile.crew = p.crew
    if (isColor(p.color)) this.hostProfile.color = p.color
    const color = this.applyProfile(slot, p, 'host')
    this.lobbyChanged()
    return color
  }

  // v3: personalidad de un casillero de IA (null = que la sortee la sim con la seed). Solo en el lobby.
  setPersonality(slot: number, p: Personality | null): void {
    const s = this.state.slots[slot]
    if (!s || this.started || s.kind !== 'ai') return
    if (p === null) delete s.personality
    else if (PERSONALITIES.includes(p)) s.personality = p
    else return
    this.lobbyChanged()
  }

  // Al menos 2 casilleros ocupados y todos los humanos con dueño conectado.
  canStart(): boolean {
    const used = this.state.slots.filter((s, i) => s.kind !== 'off' && i < this.limit)
    return used.length >= 2 && used.every((s) => s.kind === 'ai' || (s.owner !== null && s.connected))
  }

  peers(): RoomPeerInfo[] {
    return [...this.byToken.values()].map((p) => {
      const connected = p.peerId !== null && this.byPeer.get(p.peerId) === p
      return {
        peerId: p.peerId ?? '',
        name: p.name,
        slot: this.slotOfToken(p),
        connected,
        ping: connected ? this.transport.rtt(p.peerId!) : null,
      }
    })
  }

  // ---------- partida ----------

  start(seed?: number): { config: MatchConfig; slotOfPeer: Record<string, number>; playerOfSlot: (number | null)[] } {
    if (!this.canStart()) throw new Error('Faltan jugadores')
    const st = this.state
    const used = st.slots.map((s, i) => ({ s, i })).filter(({ s, i }) => s.kind !== 'off' && i < this.limit)
    this.playerOfSlot = new Array(MAX_PLAYERS).fill(null)
    used.forEach(({ i }, id) => (this.playerOfSlot[i] = id))
    this.config = {
      // v3: color (único: la sala mantiene la permutación) y personalidad (solo IA; sin ella, la sortea la sim)
      slots: used.map(({ s, i }) => ({
        kind: s.kind as PlayerKind,
        name: s.name || CREW_NAMES[s.crew],
        crew: s.crew,
        color: s.color ?? i,
        ...(s.kind === 'ai' && s.personality ? { personality: s.personality } : {}),
      })),
      rounds: st.rounds,
      difficulty: st.difficulty,
      biome: st.biome,
      size: st.size,
      seed: seed ?? crypto.getRandomValues(new Uint32Array(1))[0],
    }
    this.started = true
    this.seq = 0
    this.lobbyChanged()
    const slotOfPeer = this.slotOfPeer()
    this.broadcast({ t: 'start', config: this.config, seq: 0, slotOfPeer })
    return { config: this.config, slotOfPeer, playerOfSlot: [...this.playerOfSlot] }
  }

  playerOf(slot: number): number | null {
    return this.playerOfSlot[slot] ?? null
  }

  slotOf(playerId: number): number | null {
    const i = this.playerOfSlot.indexOf(playerId)
    return i < 0 ? null : i
  }

  // true si el comando entró al log (o, para 'aim', si quedó pendiente).
  dispatch(command: Command): boolean {
    if (!this.started) return false
    if (command.type === 'aim') {
      this.aim(command.playerId, command.angle, command.power)
      return true
    }
    if ('playerId' in command) this.flushAim(command.playerId)
    return this.commit(command)
  }

  // Aim del anfitrión o de un remoto: vista previa para todos; entra al log recién antes del próximo comando.
  aim(playerId: number, angle: number, power: number, except?: string): void {
    this.pendingAim.set(playerId, { angle, power })
    const msg: NetMessage = { t: 'aimLive', playerId, angle, power }
    for (const p of this.byPeer.keys()) if (p !== except) this.sendTo(p, msg)
    if (except) this.hooks.onAimLive?.(playerId, angle, power)
  }

  // Mete el último aim pendiente del jugador (llamar también al cerrar su turno).
  flushAim(playerId: number): void {
    const a = this.pendingAim.get(playerId)
    if (!a) return
    this.pendingAim.delete(playerId)
    this.commit({ type: 'aim', playerId, angle: a.angle, power: a.power })
  }

  // v3: posición en vivo del misil teledirigido que dirige el anfitrión (su humano o la IA). Vista previa:
  // no entra al log. El flujo la llama a ~20/s mientras dura el guiado.
  steerLive(playerId: number, x: number, y: number, except?: string): void {
    const msg: NetMessage = { t: 'steerLive', playerId, x, y }
    for (const p of this.byPeer.keys()) if (p !== except) this.sendTo(p, msg)
  }

  // v3: completa el guiado del misil de playerId con 'steer' de ceros hasta que cae (turno vencido, dueño
  // caído o guiado colgado). Sin hooks.guided no hace nada (la sim no tiene teledirigido o el flujo no lo
  // conectó). Corta si la sim rechaza los ceros, para no quedar en un bucle.
  completeGuide(playerId: number): void {
    const g = this.hooks.guided
    if (!g || this.completing) return
    this.completing = true
    try {
      for (let i = 0; i < 64; i++) {
        const now = g()
        if (!now || now.ownerId !== playerId) break
        const ticks = Math.max(1, Math.min(64, Math.ceil(now.guide / STEER_TICK - 1e-6)))
        if (!this.dispatch({ type: 'steer', playerId, dirs: new Array(ticks).fill(0) })) break
      }
    } finally {
      this.completing = false
    }
    this.watchGuide()
  }

  // Cuenta regresiva del turno de un humano remoto conectado. Al llegar a 0 dispara en su nombre.
  startTimer(playerId: number): void {
    this.stopTimer()
    const slot = this.slotOf(playerId)
    const s = slot === null ? null : this.state.slots[slot]
    if (!s || this.state.turnSeconds <= 0 || !s.owner || s.owner === 'host' || !s.connected) return
    let left = this.state.turnSeconds
    this.timerPlayer = playerId
    const tick = () => {
      this.broadcast({ t: 'timer', playerId, left })
      this.hooks.onTimer?.(playerId, left)
      if (left <= 0) {
        this.stopTimer()
        const g = this.hooks.guided?.()
        // v3: si venció con el misil en el aire, se completa el guiado; si no, dispara en su nombre (y si
        // ese tiro es un teledirigido, el turno ya está vencido: se completa enseguida)
        if (!g || g.ownerId !== playerId) this.dispatch({ type: 'fire', playerId })
        this.completeGuide(playerId)
      }
      left--
    }
    tick()
    this.timer = window.setInterval(tick, 1000)
  }

  stopTimer(): void {
    clearInterval(this.timer)
    this.timer = 0
    this.timerPlayer = null
  }

  get timerFor(): number | null {
    return this.timerPlayer
  }

  close(reason = 'El anfitrión cerró la sala'): void {
    this.stopTimer()
    this.stopGuideWatch()
    this.transport.send('all', { t: 'bye', reason })
    setTimeout(() => this.transport.close(), 300) // que el bye alcance a salir
  }

  // ---------- internos ----------

  private commit(command: Command): boolean {
    if (this.applying) {
      this.queue.push(command)
      return false
    }
    this.applying = true
    let ok = false
    try {
      ok = this.hooks.apply(command)
    } finally {
      this.applying = false
    }
    if (ok) {
      this.seq++
      this.broadcast({ t: 'cmd', seq: this.seq, command })
      if (this.seq % this.hashEvery === 0) this.broadcast({ t: 'hash', seq: this.seq, hash: this.hooks.hash() })
    }
    while (this.queue.length) {
      const next = this.queue.shift()!
      if (next.type === 'aim') this.aim(next.playerId, next.angle, next.power)
      else this.commit(next)
    }
    if (ok) this.watchGuide()
    return ok
  }

  // v3: con un misil de un humano remoto en 'guiding', se le da el tramo balístico (guided.t), el guiado
  // que le queda y GUIDE_SLACK de margen; si para entonces sigue en el aire, se completa con ceros.
  // El plazo se fija al entrar en 'guiding' (no se renueva con cada tanda).
  private watchGuide(): void {
    const g = this.hooks.guided?.()
    if (!g) return this.stopGuideWatch()
    if (this.guideWatch?.playerId === g.ownerId) return
    this.stopGuideWatch()
    const slot = this.slotOf(g.ownerId)
    const s = slot === null ? null : this.state.slots[slot]
    if (!s || s.kind !== 'human' || !s.owner || s.owner === 'host') return // anfitrión o IA: los maneja el flujo
    const playerId = g.ownerId
    if (!s.connected) return this.completeGuide(playerId) // se fue: no hay a quién esperar
    const ms = (g.t + g.guide + GUIDE_SLACK) * 1000
    this.guideWatch = { playerId, timer: window.setTimeout(() => this.completeGuide(playerId), ms) }
  }

  private stopGuideWatch(): void {
    if (this.guideWatch) clearTimeout(this.guideWatch.timer)
    this.guideWatch = null
  }

  private message(from: string, msg: NetMessage): void {
    if (msg.t === 'hello') return this.hello(from, msg.version, msg.name, msg.token)
    const rec = this.byPeer.get(from)
    if (!rec) return
    switch (msg.t) {
      case 'claim':
        if (!this.started) this.claimFor(from, msg.slot, rec.name)
        return
      case 'release':
        if (!this.started) this.releaseFor(from)
        return
      case 'input':
        return this.input(from, msg.command)
      case 'aimLive':
        if (this.started && this.playerOfPeer(from) === msg.playerId) this.aim(msg.playerId, msg.angle, msg.power, from)
        return
      case 'profile': // v3: solo en el lobby y solo para el casillero que ocupa
        if (!this.started) this.profileFrom(from, rec, msg)
        return
      case 'steerLive': {
        // v3: vista previa del misil; solo del dueño del misil en vuelo (si el flujo conectó hooks.guided)
        const pid = this.playerOfPeer(from)
        if (!this.started || pid === null || pid !== msg.playerId || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return
        const g = this.hooks.guided?.()
        if (g && g.ownerId !== pid) return
        this.steerLive(pid, msg.x, msg.y, from)
        this.hooks.onSteerLive?.(pid, msg.x, msg.y)
        return
      }
      case 'snapshot': // pedido del cliente (data vacío): se desincronizó o le falta un seq
        if (this.started) this.sendSnapshot(from)
        return
    }
  }

  private hello(from: string, version: number, name: string, token: string): void {
    if (version !== NET_VERSION) {
      this.transport.send(from, { t: 'reject', reason: 'Versión distinta del juego: recargá la página' })
      this.transport.send(from, { t: 'bye', reason: 'Versión distinta' })
      return
    }
    let rec = this.byToken.get(token)
    if (!rec && this.started) {
      this.transport.send(from, { t: 'reject', reason: 'La partida ya empezó' })
      this.transport.send(from, { t: 'bye', reason: 'La partida ya empezó' })
      return
    }
    if (!rec) {
      rec = { token, name: cleanName(name) || 'Jugador', peerId: null }
      this.byToken.set(token, rec)
    }
    // el casillero que tenía (por su peerId viejo) pasa al nuevo
    let slot = this.slotOfToken(rec)
    if (rec.peerId && rec.peerId !== from) this.byPeer.delete(rec.peerId)
    rec.peerId = from
    this.byPeer.set(from, rec)
    if (slot !== null) {
      const s = this.state.slots[slot]
      s.owner = from
      s.connected = true
    } else if (!this.started) {
      const free = this.state.slots.findIndex((s, i) => s.kind === 'human' && s.owner === null && i < this.limit)
      if (free >= 0) this.claimFor(from, free, rec.name, false)
      slot = free >= 0 ? free : null
    }
    this.transport.send(from, { t: 'welcome', peerId: from, lobby: this.state })
    this.lobbyChanged()
    if (!this.started || !this.config) return
    this.transport.send(from, { t: 'start', config: this.config, seq: this.seq, slotOfPeer: this.slotOfPeer() })
    this.sendSnapshot(from)
    if (slot !== null) this.hooks.onPeerBack?.({ peerId: from, name: rec.name, slot, playerId: this.playerOf(slot) })
  }

  private input(from: string, command: Command): void {
    const pid = this.playerOfPeer(from)
    if (!this.started || pid === null || !('playerId' in command) || command.playerId !== pid || command.type === 'setKind') {
      this.transport.send(from, { t: 'reject', reason: 'Comando inválido' })
      return
    }
    if (command.type === 'aim') return this.aim(pid, command.angle, command.power, from)
    if (command.type === 'steer') {
      // v3: solo el dueño del misil en vuelo, tandas bien formadas, y la sim decide (phase 'guiding')
      const g = this.hooks.guided?.()
      const ok = validDirs(command.dirs) && (!this.hooks.guided || g?.ownerId === pid)
      if (!ok || !this.dispatch({ type: 'steer', playerId: pid, dirs: command.dirs })) this.transport.send(from, { t: 'reject', reason: STEER_REJECT })
      return
    }
    if (!this.dispatch(command)) this.transport.send(from, { t: 'reject', reason: 'Comando rechazado' })
    else if (this.timerPlayer === pid && command.type === 'fire') this.stopTimer()
  }

  private peerLeft(peerId: string): void {
    const rec = this.byPeer.get(peerId)
    this.byPeer.delete(peerId)
    this.snapQueue.delete(peerId)
    if (!rec) return
    const slot = this.state.slots.findIndex((s) => s.owner === peerId)
    // rec.peerId queda como "último peerId" para que slotOfToken lo encuentre al volver
    if (slot >= 0) this.state.slots[slot].connected = false
    this.lobbyChanged()
    if (slot < 0) return
    const playerId = this.playerOf(slot)
    if (this.started && playerId !== null) {
      this.pendingAim.delete(playerId)
      if (this.timerPlayer === playerId) this.stopTimer()
      // v3: se fue con el misil en el aire: se completa el guiado antes de que la sesión lo pase a IA
      if (this.hooks.guided?.()?.ownerId === playerId) this.completeGuide(playerId)
    }
    this.hooks.onPeerLeft?.({ peerId, name: rec.name, slot, playerId: this.started ? playerId : null })
  }

  private claimFor(owner: string, slot: number, name: string, notify = true): boolean {
    const s = this.state.slots[slot]
    if (!s || this.started || slot >= this.limit || s.kind !== 'human' || (s.owner !== null && s.owner !== owner)) return false
    this.releaseFor(owner, false)
    s.owner = owner
    s.name = name
    s.connected = true
    // v3: el perfil que eligió el peer viaja con él al casillero nuevo
    const prof = owner === 'host' ? this.hostProfile : this.byPeer.get(owner)
    if (prof && (prof.crew || prof.color !== undefined)) this.applyProfile(slot, { crew: prof.crew, color: prof.color }, owner)
    if (notify) this.lobbyChanged()
    return true
  }

  // v3: 'profile' de un cliente. Se recuerda en su registro (para el próximo casillero que tome) y se
  // aplica al que ocupa ahora, si tiene uno.
  private profileFrom(from: string, rec: PeerRec, msg: Extract<NetMessage, { t: 'profile' }>): void {
    const name = cleanName(msg.name)
    if (name) rec.name = name
    if (isCrew(msg.crew)) rec.crew = msg.crew
    if (isColor(msg.color)) rec.color = msg.color
    const slot = this.state.slots.findIndex((s) => s.owner === from)
    if (slot >= 0) this.applyProfile(slot, { name, crew: rec.crew, color: rec.color }, from)
    this.lobbyChanged()
  }

  // Aplica nombre, tripulante y color a un casillero humano de ese dueño. Devuelve el color que le quedó.
  private applyProfile(slot: number, p: ProfileInput, owner: string): number | null {
    const s = this.state.slots[slot]
    if (!s || s.owner !== owner || s.kind !== 'human') return null
    const name = p.name === undefined ? '' : cleanName(p.name)
    if (name) s.name = name
    if (isCrew(p.crew)) assignCrew(this.state.slots, slot, p.crew) // v3: único, como el color
    if (isColor(p.color)) assignColor(this.state.slots, slot, p.color)
    return s.color ?? slot
  }

  // v2.3: al achicar el mapa se COMPACTA conservando la configuración (la misma regla que el menú
  // local, área vistas):
  // 1. Si todos los ocupados (kind !== 'off') ya están por debajo del límite nuevo, no se toca nada
  //    (los huecos que eligió el anfitrión quedan como están).
  // 2. Si no, los ocupados se corren hacia arriba en su orden, sin huecos, y cada uno se lleva TODO lo
  //    suyo: humano/IA, nombre, tripulante, dueño y conectado. Los 'off' van detrás en su orden, así
  //    los tripulantes siguen siendo una permutación de los 8.
  // 3. Los que siguen sin entrar (índice ≥ límite) se descartan desde el final: quedan 'off', sin
  //    dueño ni nombre, y conservan su tripulante. Excepción online: el casillero del anfitrión nunca
  //    se descarta; si caería afuera, toma el último lugar de adentro y se descarta el que estaba ahí.
  // 4. Un humano remoto que se queda sin casillero sigue conectado en la sala como espectador (si la
  //    partida arranca así, la mira sin jugar) y puede reclamar un casillero que se libere. Se le
  //    avisa con un 'reject' explicando por qué.
  // Devuelve los peers que quedaron sin casillero (para el aviso).
  private fitSlots(): string[] {
    const lim = this.limit
    const slots = this.state.slots
    if (slots.every((s, i) => i < lim || s.kind === 'off')) return []
    const used = slots.filter((s) => s.kind !== 'off')
    const order = [...used, ...slots.filter((s) => s.kind === 'off')]
    const host = order.findIndex((s) => s.owner === 'host')
    if (host >= lim) order.splice(lim - 1, 0, ...order.splice(host, 1)) // el anfitrión entra último
    const dropped: string[] = []
    order.forEach((s, i) => {
      if (i < lim || s.kind === 'off') return
      if (s.owner && s.owner !== 'host') dropped.push(s.owner)
      s.kind = 'off'
      s.owner = null
      s.name = ''
      s.connected = false
    })
    this.state.slots = order
    return dropped
  }

  private releaseFor(owner: string, notify = true): void {
    for (const s of this.state.slots) {
      if (s.owner !== owner) continue
      s.owner = null
      s.name = ''
      s.connected = false
    }
    if (notify) this.lobbyChanged()
  }

  private slotOfToken(rec: PeerRec): number | null {
    if (!rec.peerId) return null
    const i = this.state.slots.findIndex((s) => s.owner === rec.peerId)
    return i < 0 ? null : i
  }

  private playerOfPeer(peerId: string): number | null {
    const slot = this.state.slots.findIndex((s) => s.owner === peerId)
    return slot < 0 ? null : this.playerOf(slot)
  }

  private slotOfPeer(): Record<string, number> {
    const out: Record<string, number> = {}
    this.state.slots.forEach((s, i) => {
      if (s.owner && s.kind !== 'off') out[s.owner] = i
    })
    return out
  }

  private lobbyChanged(): void {
    this.broadcast({ t: 'lobby', lobby: this.state })
    this.hooks.onLobby?.(this.lobby)
  }

  private broadcast(msg: NetMessage): void {
    for (const p of this.byPeer.keys()) this.sendTo(p, msg)
  }

  // Respeta la cola de quien espera un snapshot: lo que sale después del snapshot va después.
  private sendTo(peerId: string, msg: NetMessage): void {
    const q = this.snapQueue.get(peerId)
    if (q) q.push(msg)
    else this.transport.send(peerId, msg)
  }

  private sendSnapshot(peerId: string): void {
    if (this.snapQueue.has(peerId)) return
    const seq = this.seq
    const raw = this.hooks.snapshot()
    const queue: NetMessage[] = []
    this.snapQueue.set(peerId, queue)
    compress(raw).then(
      (data) => {
        if (this.snapQueue.get(peerId) !== queue) return
        this.snapQueue.delete(peerId)
        this.transport.send(peerId, { t: 'snapshot', seq, data })
        for (const m of queue) this.transport.send(peerId, m)
      },
      () => this.snapQueue.delete(peerId),
    )
  }
}
