// Sesión local: aplica comandos a la sim, reproduce los tiros en el tiempo y maneja a las IAs.
import { PATH_DT, applyCommand, chooseShot, createMatch, fly } from '../sim'
import type { ShotPlan } from '../sim'
import type {
  Biome,
  Command,
  Difficulty,
  Flight,
  GameEvent,
  GameState,
  ItemId,
  MatchConfig,
  Player,
  Prop,
  ShopId,
  StepResult,
  Terrain,
  Vec2,
  WeaponId,
} from '../sim/types'
import { FUEL_PER_TURN, ITEM_ORDER, SHOP, SUDDEN_DEATH_CALM, WEAPONS } from '../sim/types'
import { VIEW_W, type Camera, type RenderFrame } from '../render/types'
import type { HudModel, HudSide } from '../ui/hud'
import type { BannerModel, HudExtras, HudNet, MinimapModel, ScoreModel, ShopModel } from '../ui/types'
import { AiClient } from './ai-client'
import { CameraController, shotZoom } from './camera'
import { pickDemoShot, seededRandom } from './demo'

export interface DemoOptions {
  freeze: boolean
  weapon?: WeaponId // QA: arma del tiro fijo de P1 (&weapon=)
}

// local: todo en este dispositivo. host: corre la sim y la IA, y loguea cada comando aceptado.
// client: réplica; aplica el log del anfitrión y manda su input como pedido.
export type SessionMode = 'local' | 'host' | 'client'

export interface NetSeat {
  mode: SessionMode
  localIds: number[] // jugadores que se controlan desde este dispositivo
  // host: HostRoom.dispatch (valida con applyNet, numera y reparte); client: ClientRoom.input
  route: (command: Command) => boolean | void
}

interface Inbound {
  command: Command
  result: StepResult | null // client: ya aplicado sobre la réplica lógica; se muestra en orden
}

const TURN_COMMANDS = new Set<Command['type']>(['aim', 'selectWeapon', 'move', 'fire', 'useItem'])

interface TimedEvent {
  t: number
  event: GameEvent
}

// Un disparo en reproducción: el estado final ya está resuelto; esto es presentación.
interface Playback {
  t: number
  end: number
  before: GameState
  after: GameState
  flights: { flight: Flight; start: number; dur: number; done: boolean }[]
  timeline: TimedEvent[]
  next: number
  firstImpact: number
  shooterId: number
  weapon: WeaponId
  players: Player[]
  props: Prop[]
  terrain: Terrain // grilla que se ve: arranca en before y suma los cambios de cada evento
  reveal: Map<GameEvent, Int32Array> // pixels que cambia cada impact/burn
  pending: number // pixels todavía sin mostrar
  finisher: GameEvent | null // la muerte que cierra la ronda: arranca la cámara lenta
  flightsEnd: number // fin del último vuelo
  zoom: number // zoom de la cámara durante el vuelo (shotZoom)
  // v2: punto donde se asienta la cámara al terminar los vuelos (último impacto o fin del último vuelo)
  settle: Vec2 | null
  // v2 muerte súbita: lava y tiros sin daño que muestra el tiro mientras se reproduce. Arrancan como
  // estaban antes del disparo y cambian cuando llegan los eventos lava y calm en su t.
  lava: number | null
  calmLeft: number
}

interface AiDrive {
  playerId: number
  token: number
  plan: ShotPlan | null // null mientras el worker piensa
  from: { angle: number; power: number }
  t: number
  think: number
  dur: number
  hold: number
  move: number // pixels con signo que faltan recorrer antes de apuntar (ShotPlan.move)
  moveAcc: number
}

const SETTLE = 0.9
const MOVE_SPEED = 36
const SLOW_SCALE = 0.3
const SLOW_TIME = 1.2
const LATE = new Set<GameEvent['type']>(['turn', 'wind', 'gameover', 'roundover', 'round', 'shop'])
// Anticipación de la cámara sobre el proyectil (segundos de vuelo hacia adelante).
const LOOKAHEAD = 0.35
// v2 muerte súbita. La lava sube (o aparece desde el fondo) en LAVA_ANIM segundos, con un respiro de
// LAVA_GAP después de la última explosión del tiro; el daño de lava sin t llega LAVA_HIT después de que
// empieza a subir, y el turno siguiente arranca LAVA_TAIL después de que termina de subir.
const LAVA_ANIM = 0.8
const LAVA_GAP = 0.3
const LAVA_HIT = 0.5
const LAVA_TAIL = 0.4

export class Session {
  state: GameState | null = null
  config: MatchConfig | null = null
  // true: la IA calcula en el hilo principal (avance rápido de QA, sin esperar al worker)
  syncAi = false
  private playback: Playback | null = null
  private fx: GameEvent[] = []
  private ai: AiDrive | null = null
  private aiClient: AiClient | null = null
  private aiToken = 0
  private aim: { playerId: number; angle: number; power: number } | null = null
  private message = ''
  private messageT = 0
  private terrainVersion = 0
  private matchId = 0
  private moveAcc = 0
  private shots: { playerId: number; weapon: WeaponId }[] = []
  private lastShooter: number | null = null
  private lastImpact: Vec2 | null = null
  private demo: (DemoOptions & { shotDone: boolean; seed: number }) | null = null
  private frozen = false
  private random: () => number = Math.random
  private phaseT = 0
  private movedT = 0
  private slow = 0
  private scale = 1
  private lastHumanId: number | null = null // último humano que tuvo el turno (hot-seat)
  private tracerCache: { key: string; path: Vec2[] } | null = null
  // v2: cámara y minimapa
  private cam = new CameraController()
  private camKey = '' // turno que sigue la cámara; si cambia, vuelve al tanque
  private lastImpacts = new Map<number, Vec2>() // último impacto de cada jugador en la ronda
  // v2 muerte súbita: subida de la lava en curso (presentación) y avisos para el audio
  private lavaAnim: { from: number; to: number; t: number } | null = null
  private suddenDeathSaid = false // ya se avisó en esta ronda que empezó la muerte súbita
  private suddenDeathNews = false // se avisó y main.ts todavía no lo levantó (sonido y vibración)
  private melts: Vec2[] = [] // proyectiles derretidos en la lava desde la última llamada a pullMelts
  // online
  private mode: SessionMode = 'local'
  private localIds = new Set<number>()
  private route: NetSeat['route'] | null = null
  private inbox: Inbound[] = []
  private logic: GameState | null = null // client: réplica con todo el log aplicado (adelante de lo que se ve)
  private accepted = false
  private awaitFire = 0 // client: segundos esperando que el anfitrión confirme el tiro
  private sentReady = new Set<number>()
  private sentNext = false
  netHud: HudNet | null = null

  get netMode(): SessionMode {
    return this.mode
  }

  // Estado autoritativo: client, la réplica con todo el log; si no, con un tiro en
  // reproducción, el de después del tiro.
  get authState(): GameState | null {
    if (this.mode === 'client') return this.logic
    return this.playback ? this.playback.after : this.state
  }

  // host: humano remoto que tiene el turno (para el timer de la sala), con una clave por turno.
  get remoteTurn(): { key: string; playerId: number } | null {
    const s = this.state
    if (this.mode !== 'host' || !s || s.phase !== 'aiming' || this.playback) return null
    const p = s.players[s.current]
    if (!p || !p.alive || !this.controlledByHuman(p) || this.isLocal(p)) return null
    return { key: `${this.matchId}:${s.turn}:${p.id}`, playerId: p.id }
  }

  // Online: te toca a vos (humano de este dispositivo) y podés jugar.
  get myTurn(): boolean {
    return this.mode !== 'local' && this.inputEnabled
  }

  // client: pidió la próxima ronda y espera que el anfitrión la confirme.
  get awaitingHost(): boolean {
    return this.sentNext && this.state?.phase === 'roundover'
  }

  get busy(): boolean {
    return this.playback !== null
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  // Si el tanque avanzó hace instantes (para el sonido del motor).
  get moving(): boolean {
    return this.movedT > 0
  }

  get isDemo(): boolean {
    return this.demo !== null
  }

  // Segundos desde que la partida salió de 'aiming' (fin de ronda o de partida); 0 si se juega.
  get finishedFor(): number {
    return this.phaseT
  }

  // Factor de tiempo del último update (cámara lenta en el golpe que cierra la ronda).
  get timeScale(): number {
    return this.scale
  }

  get inputEnabled(): boolean {
    const s = this.state
    if (!s || s.phase !== 'aiming' || this.playback || this.frozen) return false
    const p = s.players[s.current]
    if (this.mode === 'client' && (this.awaitFire > 0 || this.inbox.length > 0)) return false
    return !!p && this.controlledHere(p) && !this.bannerFor()
  }

  start(config: MatchConfig, demo?: DemoOptions, seat?: NetSeat): void {
    this.mode = demo ? 'local' : seat?.mode ?? 'local'
    this.localIds = new Set(seat?.localIds ?? [])
    this.route = seat?.route ?? null
    this.inbox = []
    this.awaitFire = 0
    this.sentReady.clear()
    this.sentNext = false
    const seed = config.seed ?? ((Math.random() * 0xffffffff) >>> 0)
    const slots = config.slots.slice(0, 4)
    this.config = { ...config, slots, rounds: Math.max(1, Math.round(config.rounds || 1)), seed }
    this.state = createMatch(this.config)
    this.logic = this.mode === 'client' ? this.state : null
    this.playback = null
    this.fx = []
    this.ai = null
    this.aiToken++
    this.aim = null
    this.message = ''
    this.messageT = 0
    this.terrainVersion++
    this.matchId++
    this.moveAcc = 0
    this.shots = []
    this.lastShooter = null
    this.lastImpact = null
    this.frozen = false
    this.phaseT = 0
    this.movedT = 0
    this.slow = 0
    this.scale = 1
    this.lastHumanId = null
    this.tracerCache = null
    this.resetLava()
    this.resetCamera()
    this.demo = demo ? { ...demo, shotDone: false, seed } : null
    this.random = demo ? seededRandom(seed ^ 0x5bd1e995) : Math.random
    if (!demo?.freeze && !this.aiClient && this.mode !== 'client') this.aiClient = new AiClient()
  }

  // QA (?play=...&calm=N): arranca la ronda con N tiros sin daño ya contados, para probar la muerte
  // súbita rápido. Solo en partidas locales, antes del primer tiro.
  qaCalm(calm: number): void {
    const s = this.state
    if (!s || this.mode !== 'local' || this.playback) return
    this.state = { ...s, calm: Math.max(0, Math.round(calm)) }
  }

  // ---------- online ----------

  // host: HostRoom.hooks.apply. Todo comando del log pasa por acá (el del anfitrión y el de los
  // peers, ya verificado por la sala). true si la sim lo aceptó.
  applyNet(command: Command): boolean {
    const s = this.state
    if (this.mode !== 'host' || !s || this.playback) return false
    if (TURN_COMMANDS.has(command.type)) {
      const id = (command as { playerId: number }).playerId
      if (s.phase !== 'aiming' || s.players[s.current]?.id !== id) return false
    }
    this.accepted = false
    return this.dispatch(command) || this.accepted
  }

  // host: comando propio que espera a que termine el tiro en curso (setKind de un peer caído).
  hostCommand(command: Command): void {
    if (this.mode !== 'host') return
    this.inbox.push({ command, result: null })
  }

  // client: ClientRoom.hooks.apply. Se aplica ya sobre la réplica lógica (para el hash) y se
  // muestra en orden cuando termina el tiro en reproducción.
  receive(command: Command): void {
    if (this.mode !== 'client' || !this.logic) return
    let result: StepResult
    try {
      result = applyCommand(this.logic, command)
    } catch (err) {
      console.error(err)
      result = { state: this.logic, events: [] }
    }
    this.logic = result.state
    this.inbox.push({ command, result })
  }

  // client: estado completo del anfitrión (desincronización o reconexión).
  loadSnapshot(state: GameState): void {
    const round = this.state?.round
    this.state = state
    this.logic = state
    this.playback = null
    this.inbox = []
    this.awaitFire = 0
    this.aim = null
    this.terrainVersion++
    this.lavaAnim = null
    if (round !== state.round) this.newRound()
    // ya empezada (reconexión): no se vuelve a avisar
    if (state.lava != null) this.suddenDeathSaid = true
  }

  // Cañón de otro jugador en vivo (aimLive): solo visual, no toca el estado.
  remoteAim(playerId: number, angle: number, power: number): void {
    const s = this.state
    if (!s || this.playback || s.phase !== 'aiming') return
    const p = s.players[s.current]
    if (!p || p.id !== playerId || this.controlledHere(p)) return
    this.aim = { playerId, angle: clamp(angle, 0, 180), power: clamp(power, 0, 100) }
  }

  // Apuntado en vivo del jugador de turno (para mandar como aimLive), o null.
  liveAim(): { playerId: number; angle: number; power: number } | null {
    const s = this.state
    if (!s || this.playback || s.phase !== 'aiming') return null
    const p = s.players[s.current]
    if (!p || !p.alive) return null
    if (this.aim && this.aim.playerId === p.id) return { ...this.aim }
    return { playerId: p.id, angle: p.angle, power: p.power }
  }

  // Jugador que controla este dispositivo (humano, no IA).
  isLocal(p: Player): boolean {
    if (p.kind !== 'human') return false
    return this.mode === 'local' || this.localIds.has(p.id)
  }

  // QA (?autotest=1): apunta a un valor fijo y dispara.
  fireWith(angle: number, power: number): void {
    if (!this.inputEnabled || !this.state) return
    const aim = this.currentAim()
    if (aim) {
      aim.angle = clamp(angle, 0, 180)
      aim.power = clamp(power, 0, 100)
    }
    this.fire()
  }

  // Apuntado absoluto (arrastre táctil). Igual que nudge, se manda a la sim al disparar.
  aimTo(angle: number, power: number): void {
    if (!this.inputEnabled || !this.state) return
    const aim = this.currentAim()
    if (!aim) return
    aim.angle = clamp(Math.round(angle), 0, 180)
    aim.power = clamp(Math.round(power), 0, 100)
  }

  // Ajuste continuo del ángulo y la potencia del humano (con Shift o el paso táctil corto, fino y con
  // decimales). Se manda a la sim al disparar, redondeado a un decimal.
  nudge(dAngle: number, dPower: number): void {
    if (!this.inputEnabled || !this.state || (dAngle === 0 && dPower === 0)) return
    const aim = this.currentAim()
    if (!aim) return
    aim.angle = clamp(aim.angle + dAngle, 0, 180)
    aim.power = clamp(aim.power + dPower, 0, 100)
  }

  move(dir: -1 | 1, dt: number): void {
    if (!this.inputEnabled || !this.state) return
    this.moveAcc += MOVE_SPEED * dt
    let steps = Math.min(3, Math.floor(this.moveAcc))
    this.moveAcc -= steps
    const p = this.state.players[this.state.current]
    while (steps-- > 0) {
      if (this.mode === 'client' && (p.fuel ?? 0) <= 0) break
      if (!this.act({ type: 'move', playerId: p.id, dir })) break
      this.movedT = 0.12
    }
  }

  stopMove(): void {
    this.moveAcc = 0
  }

  select(weapon: WeaponId): void {
    if (!this.inputEnabled || !this.state) return
    const p = this.state.players[this.state.current]
    if ((p.ammo[weapon] ?? 0) <= 0) {
      this.flash('Sin municion')
      return
    }
    this.act({ type: 'selectWeapon', playerId: p.id, weapon })
  }

  // Arma anterior/siguiente con munición (gamepad).
  cycleWeapon(dir: -1 | 1, order: WeaponId[]): void {
    if (!this.inputEnabled || !this.state) return
    const p = this.state.players[this.state.current]
    const at = Math.max(0, order.indexOf(p.weapon))
    for (let i = 1; i <= order.length; i++) {
      const w = order[(at + dir * i + order.length * 2) % order.length]
      if ((p.ammo[w] ?? 0) > 0) {
        if (w !== p.weapon) this.act({ type: 'selectWeapon', playerId: p.id, weapon: w })
        return
      }
    }
  }

  fire(): void {
    if (!this.inputEnabled || !this.state) return
    this.commitAimAndFire(this.state.players[this.state.current].id)
  }

  // Q/F/R/T: escudo, combustible, reparación, trazador. Devuelve true si se aplicó.
  useItem(item: ItemId): boolean {
    if (!this.inputEnabled || !this.state) return false
    const p = this.state.players[this.state.current]
    if ((p.items?.[item] ?? 0) <= 0) {
      this.flash(`Sin ${ITEM_NAMES[item]}`)
      return false
    }
    const ok = this.act({ type: 'useItem', playerId: p.id, item })
    if (!ok) this.flash('No se puede')
    return ok
  }

  // Primer ítem usable del inventario (botón B del gamepad).
  firstUsableItem(): ItemId | null {
    const s = this.state
    if (!s) return null
    const p = s.players[s.current]
    for (const id of USABLE) {
      if ((p?.items?.[id] ?? 0) <= 0) continue
      if (id === 'shield' && p.shield > 0) continue
      if (id === 'tracer' && p.tracer) continue
      return id
    }
    return null
  }

  // ---------- rondas, tienda, hot-seat ----------

  nextRound(): void {
    const s = this.state
    if (!s || s.phase !== 'roundover') return
    // client: la próxima ronda la decide el anfitrión
    if (this.mode === 'client') {
      this.sentNext = true
      return
    }
    this.act({ type: 'nextRound' })
    this.skipEmptyShop()
  }

  // Humanos que todavía no terminaron de comprar, en orden de jugador.
  shopQueue(): Player[] {
    const s = this.state
    if (!s || s.phase !== 'shop') return []
    return s.players.filter((p) => this.isLocal(p) && !p.ready && !this.sentReady.has(p.id))
  }

  shopModel(playerId: number): ShopModel | null {
    const s = this.state
    const p = s?.players.find((q) => q.id === playerId)
    if (!s || !p) return null
    return {
      playerId: p.id,
      name: p.name,
      color: p.color,
      crew: p.crew,
      money: p.money,
      round: Math.min(s.rounds, s.round + 1),
      rounds: s.rounds,
      rows: SHOP.map((e) => {
        const owned = ownedOf(p, e.id)
        return {
          id: e.id,
          kind: e.kind,
          name: e.name,
          price: e.price,
          qty: e.qty,
          owned,
          max: e.max,
          canBuy: p.money >= e.price && owned + e.qty <= e.max,
          canSell: owned > 0,
        }
      }),
    }
  }

  buy(playerId: number, id: ShopId): boolean {
    if (this.mode === 'client' && !this.shopModel(playerId)?.rows.find((r) => r.id === id)?.canBuy) return false
    return this.act({ type: 'buy', playerId, id })
  }

  sell(playerId: number, id: ShopId): boolean {
    if (this.mode === 'client' && !this.shopModel(playerId)?.rows.find((r) => r.id === id)?.canSell) return false
    return this.act({ type: 'sell', playerId, id })
  }

  ready(playerId: number): void {
    if (this.mode === 'client') {
      this.sentReady.add(playerId)
      this.act({ type: 'ready', playerId })
      return
    }
    this.act({ type: 'ready', playerId })
    this.skipEmptyShop()
  }

  scoreModel(): ScoreModel | null {
    const s = this.state
    if (!s) return null
    return {
      round: s.round,
      rounds: s.rounds,
      roundWinnerId: s.roundWinnerId ?? null,
      final: s.phase === 'gameover',
      winnerId: s.winnerId,
      rows: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        crew: p.crew,
        alive: p.alive,
        roundsWon: p.roundsWon ?? 0,
        kills: p.kills ?? 0,
        earned: s.earnings?.[p.id] ?? 0,
        money: p.money ?? 0,
      })),
    }
  }

  // Hot-seat: el humano que tiene que ver el cartel antes de jugar, o null.
  bannerFor(): Player | null {
    const s = this.state
    if (!s || s.phase !== 'aiming' || this.playback || this.demo) return null
    const p = s.players[s.current]
    if (!p || !p.alive || !this.isLocal(p) || p.id === this.lastHumanId) return null
    // solo entre humanos del mismo dispositivo
    if (s.players.filter((q) => this.isLocal(q) && q.alive).length < 2) {
      this.lastHumanId = p.id
      return null
    }
    return p
  }

  bannerModel(): BannerModel | null {
    const p = this.bannerFor()
    const s = this.state
    if (!p || !s) return null
    return { name: p.name, color: p.color, crew: p.crew, round: s.round, rounds: s.rounds }
  }

  ackBanner(): void {
    const p = this.bannerFor()
    if (p) this.lastHumanId = p.id
  }

  update(dt: number): void {
    this.step(dt)
    if (!this.frozen) this.updateCamera(dt)
  }

  private step(dt: number): void {
    this.scale = 1
    if (!this.state || this.frozen) return
    if (this.movedT > 0) this.movedT -= dt
    if (this.messageT > 0) {
      this.messageT -= dt
      if (this.messageT <= 0) this.message = ''
    }
    if (this.slow > 0) {
      this.scale = SLOW_SCALE
      this.slow = Math.max(0, this.slow - dt)
    }
    if (this.awaitFire > 0) this.awaitFire = Math.max(0, this.awaitFire - dt)
    if (this.lavaAnim) {
      this.lavaAnim.t += dt * this.scale
      if (this.lavaAnim.t >= LAVA_ANIM) this.lavaAnim = null
    }
    if (this.playback) {
      this.advance(dt * this.scale)
      return
    }
    this.drain()
    if (this.playback) return
    if (this.state.phase !== 'aiming') {
      this.phaseT += dt
      // demo: la partida entre IAs sigue sola (tienda de IAs incluida)
      if (this.demo && this.state.phase === 'roundover' && this.phaseT > 1.5) this.nextRound()
      return
    }
    this.phaseT = 0
    if (this.mode === 'client') return
    this.driveAi(dt)
  }

  pullFx(): GameEvent[] {
    const events = this.fx
    this.fx = []
    return events
  }

  // Proyectiles que se derritieron en la lava desde la última llamada (chisporroteo).
  pullMelts(): Vec2[] {
    const melts = this.melts
    this.melts = []
    return melts
  }

  // true una vez por ronda, cuando empieza la muerte súbita (aviso sonoro y vibración).
  pullSuddenDeath(): boolean {
    const news = this.suddenDeathNews
    this.suddenDeathNews = false
    return news
  }

  // Disparos que salieron desde la última llamada (para el audio).
  pullShots(): { playerId: number; weapon: WeaponId }[] {
    const shots = this.shots
    this.shots = []
    return shots
  }

  frame(): RenderFrame | null {
    const s = this.state
    if (!s) return null
    const pb = this.playback
    const biome: Biome = s.biome ?? 'forest'
    if (pb) {
      return {
        biome,
        terrain: pb.terrain,
        terrainVersion: this.terrainVersion,
        matchId: this.matchId,
        props: pb.props,
        players: pb.players,
        current: pb.before.current,
        wind: pb.before.wind,
        projectiles: this.projectiles(pb),
        shooterId: pb.shooterId,
        weapon: pb.weapon,
        freeze: this.frozen,
        aimPreview: null,
        camera: this.cam.camera,
        lava: this.lavaView(),
      }
    }
    return {
      biome,
      terrain: s.terrain,
      terrainVersion: this.terrainVersion,
      matchId: this.matchId,
      props: s.props ?? [],
      players: this.playersWithAim(s),
      current: s.current,
      wind: s.wind,
      projectiles: [],
      shooterId: null,
      weapon: null,
      freeze: this.frozen,
      aimPreview: this.tracerPath(s),
      camera: this.cam.camera,
      lava: this.lavaView(),
    }
  }

  // ---------- muerte súbita (v2) ----------

  // y de la superficie de la lava que se ve: subiendo suave tras el evento lava; con un tiro en
  // reproducción, la del tiro (la de antes hasta que llega el evento); si no, la del estado.
  private lavaView(): number | null {
    const a = this.lavaAnim
    if (a) {
      const k = clamp(a.t / LAVA_ANIM, 0, 1)
      const e = k * k * (3 - 2 * k) // arranca y se asienta suave
      return a.from + (a.to - a.from) * e
    }
    if (this.playback) return this.playback.lava
    return this.state?.lava ?? null
  }

  private resetLava(): void {
    this.lavaAnim = null
    this.suddenDeathSaid = false
    this.suddenDeathNews = false
    this.melts = []
  }

  // Eventos de la muerte súbita, en su momento (playback) o al aplicarse (fuera de un tiro).
  private noteEvent(event: GameEvent, pb: Playback | null): void {
    if (event.type === 'lava') {
      const shown = this.lavaView()
      const h = (pb ? pb.terrain : this.state?.terrain)?.h ?? 450
      // sin lava todavía: aparece subiendo desde el fondo del mapa
      const from = shown ?? event.from ?? h
      this.lavaAnim = from !== event.to ? { from, to: event.to, t: 0 } : null
      if (pb) {
        pb.lava = event.to
        pb.calmLeft = Math.max(0, event.warn)
      }
      if (event.from == null) this.announceSuddenDeath()
    } else if (event.type === 'calm') {
      if (pb) pb.calmLeft = Math.max(0, event.left)
      if (event.left <= 0) this.announceSuddenDeath()
    }
  }

  private announceSuddenDeath(): void {
    if (this.suddenDeathSaid || this.demo?.freeze) return
    this.suddenDeathSaid = true
    this.suddenDeathNews = true
  }

  // HudExtras.suddenDeath: tiros sin daño que faltan y si la lava ya sube.
  private suddenDeathModel(s: GameState): HudExtras['suddenDeath'] {
    const pb = this.playback
    const calmLeft = pb ? pb.calmLeft : Math.max(0, SUDDEN_DEATH_CALM - (s.calm ?? 0))
    return { active: this.lavaView() !== null, calmLeft }
  }

  // ---------- cámara (v2) ----------

  get camera(): Camera {
    return this.cam.camera
  }

  // Hay cámara móvil: el mapa es más ancho que la pantalla.
  get scrolls(): boolean {
    return !this.cam.fixed
  }

  // Se puede panear: mapa más ancho que la pantalla y sin tiro en vuelo.
  get canPan(): boolean {
    return !!this.state && !this.playback && !this.frozen && !this.cam.fixed
  }

  // Paneo a mano en px de mundo (Z / X, borde, arrastre, stick derecho, dos dedos).
  panBy(dx: number): void {
    if (this.canPan) this.cam.pan(dx)
  }

  // Minimapa: centra la cámara en x (smooth: con viaje; si no, salta, para el arrastre).
  panTo(x: number, smooth: boolean): void {
    if (this.canPan) this.cam.centerOn(x, smooth)
  }

  // C, doble toque en el minimapa o botón de recentrar: vuelve al tanque del turno.
  recenter(): void {
    if (!this.playback) this.cam.recenter()
  }

  private updateCamera(dt: number): void {
    const s = this.state
    if (!s) return
    const pb = this.playback
    const t = pb ? pb.terrain : s.terrain
    if (this.cam.world.w !== t.w || this.cam.world.h !== t.h) this.resetCamera()
    if (pb) {
      const now = this.projectiles(pb)
      if (now.length) {
        // el grupo de proyectiles (racimo) y dónde van a estar en un rato: la cámara mira adelante
        const ahead = this.projectiles(pb, pb.t + LOOKAHEAD, true)
        let x0 = Infinity
        let x1 = -Infinity
        let y0 = Infinity
        let y1 = -Infinity
        for (const p of [...now, ...ahead]) {
          x0 = Math.min(x0, p.x)
          x1 = Math.max(x1, p.x)
          y0 = Math.min(y0, p.y)
          y1 = Math.max(y1, p.y)
        }
        this.cam.followShot((x0 + x1) / 2, (y0 + y1) / 2, pb.zoom)
      } else if (pb.t < pb.flightsEnd) {
        this.cam.holdShot(pb.zoom)
      } else {
        // se queda donde terminó el tiro (también mientras sube la lava y quema a los de cerca)
        const at = pb.settle ?? pb.players.find((p) => p.id === pb.shooterId) ?? null
        if (at) this.cam.settleAt(at.x, at.y)
        else this.cam.holdShot(1)
      }
    } else if (s.phase === 'aiming') {
      const key = `${this.matchId}:${s.turn}:${s.current}`
      if (key !== this.camKey) {
        // turno nuevo: la cámara vuelve al tanque aunque el anterior haya paneado
        this.camKey = key
        if (this.cam.mode === 'manual') this.cam.mode = 'tank'
      }
      const p = s.players[s.current]
      if (p) this.cam.followTank(p.x, p.y)
    } else if (this.cam.mode === 'shot') {
      this.cam.holdShot(1)
    }
    this.cam.update(dt)
  }

  private minimap(players: Player[], currentIndex: number, terrain: Terrain): MinimapModel | null {
    if (terrain.w <= VIEW_W) return null
    const pb = this.playback
    const lastImpacts: MinimapModel['lastImpacts'] = []
    for (const [playerId, at] of this.lastImpacts) {
      const p = players.find((q) => q.id === playerId)
      if (p) lastImpacts.push({ playerId, x: at.x, y: at.y, color: p.color })
    }
    return {
      terrain,
      terrainVersion: this.terrainVersion,
      view: this.cam.view(),
      tanks: players.map((p, i) => ({ id: p.id, x: p.x, y: p.y, color: p.color, alive: p.alive, current: i === currentIndex })),
      projectiles: pb ? this.projectiles(pb) : [],
      lastImpacts,
      lava: this.lavaView(),
    }
  }

  hud(): HudModel | null {
    const s = this.state
    if (!s) return null
    const pb = this.playback
    const players = pb ? pb.players : this.playersWithAim(s)
    const currentIndex = pb ? pb.before.current : s.current
    const current = players[currentIndex]
    const human = this.focusHuman(players, current) ?? players[0] ?? null
    let rival: Player | undefined
    if (current && human && current.id !== human.id) rival = current
    // en el tiro del humano, el rival más cerca del impacto
    if (!rival && this.lastImpact && current?.id === human?.id && this.lastShooter === human?.id) {
      const hit = this.lastImpact
      let best = Infinity
      for (const p of players) {
        if (p.id === human?.id) continue
        const d = Math.hypot(p.x - hit.x, p.y - hit.y)
        if (d < best) {
          best = d
          rival = p
        }
      }
    }
    if (!rival && this.lastShooter != null && this.lastShooter !== human?.id) {
      rival = players.find((p) => p.id === this.lastShooter)
    }
    if (!rival) rival = players.find((p) => p.id !== human?.id && p.alive) ?? players.find((p) => p.id !== human?.id)
    const demoP1 = this.demo ? players[0]?.id : null
    const side = (p: Player | undefined | null): HudSide | null =>
      p
        ? {
            name: p.name,
            tag: `P${p.id + 1}`,
            color: p.color,
            crew: p.crew,
            hp: Math.round(p.hp),
            alive: p.alive,
            active: !!current && p.id === current.id,
            you: !!human && p.id === human.id && (this.mode === 'local' ? human.kind === 'human' || p.id === demoP1 : this.isLocal(human)),
          }
        : null
    // el resto de los tanques, en orden de jugador, con placa compacta
    const others: HudSide[] = []
    for (const p of players) {
      if (p.id === human?.id || p.id === rival?.id) continue
      const o = side(p)
      if (o) others.push(o)
    }
    // La munición sale del estado final para que el tiro ya se vea descontado.
    const ammoOwner = pb ? pb.after.players.find((p) => p.id === current?.id) : current
    const weapon = current?.weapon ?? 'normal'
    const ammoAll = {} as Record<WeaponId, number>
    for (const id of Object.keys(WEAPONS) as WeaponId[]) ammoAll[id] = ammoOwner?.ammo?.[id] ?? 0
    // extras: plata e inventario del humano en foco (el del estado, ya descontado)
    const focus = (pb ? pb.after : s).players.find((p) => p.id === human?.id)
    const items = {} as Record<ItemId, number>
    for (const id of ITEM_ORDER) items[id] = focus?.items?.[id] ?? 0
    const shieldOwner = pb ? pb.players.find((p) => p.id === current?.id) : current
    return {
      human: side(human),
      rival: side(rival),
      others,
      angle: current?.angle ?? 0,
      power: current?.power ?? 0,
      weapon,
      ammo: ammoOwner?.ammo?.[weapon] ?? 0,
      wind: pb ? pb.before.wind : s.wind,
      status: this.status(s, current),
      showAim: !!current && !pb,
      ammoAll,
      fuel: current ? Math.max(0, current.fuel ?? 0) / FUEL_PER_TURN : 0,
      showBar: !!current && this.controlledHere(current) && s.phase === 'aiming',
      // el demo congelado se compara contra capturas previas: sin extras
      extras: this.demo?.freeze ? undefined : {
        round: s.round ?? 1,
        rounds: s.rounds ?? 1,
        money: focus?.money ?? 0,
        items,
        shield: Math.max(0, shieldOwner?.shield ?? 0),
        tracer: !!ammoOwner?.tracer,
        net: this.netHud,
        minimap: this.minimap(players, currentIndex, pb ? pb.terrain : s.terrain),
        suddenDeath: this.suddenDeathModel(s),
      },
    }
  }

  resultText(): string {
    const s = this.state
    if (!s || s.winnerId == null) return 'Empate'
    const winner = s.players.find((p) => p.id === s.winnerId)
    if (!winner) return 'Empate'
    const humans = s.players.filter((p) => p.kind === 'human').length
    const alone = this.mode === 'local' ? humans === 1 : s.players.filter((p) => this.isLocal(p)).length === 1
    return this.controlledHere(winner) && alone ? 'Ganaste' : `Gano ${winner.name}`
  }

  winner(): Player | null {
    const s = this.state
    if (!s || s.winnerId == null) return null
    return s.players.find((p) => p.id === s.winnerId) ?? null
  }

  // ---------- interno ----------

  private status(s: GameState, current: Player | undefined): string {
    if (this.message) return this.message
    if (s.phase === 'gameover' && !this.playback) return this.resultText()
    if (s.phase !== 'aiming' && !this.playback) return 'Fin de ronda'
    if (this.playback || !current) return ''
    if (this.controlledHere(current)) {
      return s.players.filter((p) => this.isLocal(p)).length > 1 ? `Turno de ${current.name}` : 'Tu turno'
    }
    if (this.controlledByHuman(current)) return `Turno de ${current.name}`
    return `${current.name} apunta`
  }

  // Humano en foco para el HUD: el de turno, o el último que jugó, o el primero.
  private focusHuman(players: Player[], current: Player | undefined): Player | undefined {
    if (current && this.isLocal(current) && !this.demo) return current
    if (this.lastHumanId != null) {
      const p = players.find((q) => q.id === this.lastHumanId)
      if (p) return p
    }
    return players.find((p) => this.isLocal(p)) ?? players.find((p) => p.kind === 'human')
  }

  // Humano (en cualquier dispositivo): no lo maneja la IA.
  private controlledByHuman(p: Player): boolean {
    if (p.kind !== 'human') return false
    return !this.demo
  }

  // Humano de este dispositivo: el input local lo mueve.
  private controlledHere(p: Player): boolean {
    return this.controlledByHuman(p) && this.isLocal(p)
  }

  private flash(text: string): void {
    this.message = text
    this.messageT = 1.1
  }

  private skipEmptyShop(): void {
    // sin humanos en la tienda (todas IAs): la ronda arranca sola
    const s = this.state
    if (this.mode === 'client' || !s || s.phase !== 'shop' || s.players.some((p) => p.kind === 'human' && !p.ready)) return
    const any = s.players[0]
    if (any) this.act({ type: 'ready', playerId: any.id })
  }

  private tracerPath(s: GameState): Vec2[] | null {
    if (s.phase !== 'aiming') return null
    const p = s.players[s.current]
    if (!p || !p.tracer || !this.controlledHere(p) || this.bannerFor()) return null
    const aim = this.aim && this.aim.playerId === p.id ? this.aim : p
    const angle = quantize(aim.angle)
    const power = quantize(aim.power)
    const key = `${this.matchId}:${s.turn}:${p.x}:${p.y}:${angle}:${power}:${s.wind}:${this.terrainVersion}`
    if (this.tracerCache?.key === key) return this.tracerCache.path
    let path: Vec2[] = []
    try {
      path = fly({ terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: s.wind }).path
    } catch (err) {
      console.error(err)
    }
    this.tracerCache = { key, path }
    return path
  }

  private currentAim(): { playerId: number; angle: number; power: number } | null {
    const s = this.state
    if (!s) return null
    const p = s.players[s.current]
    if (!p) return null
    if (!this.aim || this.aim.playerId !== p.id) this.aim = { playerId: p.id, angle: p.angle, power: p.power }
    return this.aim
  }

  private playersWithAim(s: GameState): Player[] {
    const p = s.players[s.current]
    if (!p || !this.aim || this.aim.playerId !== p.id) return s.players
    if (p.angle === this.aim.angle && p.power === this.aim.power) return s.players
    const players = s.players.slice()
    players[s.current] = { ...p, angle: this.aim.angle, power: this.aim.power }
    return players
  }

  private commitAimAndFire(playerId: number, exact = false): void {
    const s = this.state
    if (!s) return
    const p = s.players[s.current]
    if (!p || p.id !== playerId) return
    const aim = this.currentAim()
    if (aim) {
      const angle = exact ? aim.angle : quantize(aim.angle)
      const power = exact ? aim.power : quantize(aim.power)
      if (angle !== p.angle || power !== p.power || this.mode !== 'local') this.act({ type: 'aim', playerId, angle, power })
    }
    this.act({ type: 'fire', playerId })
    if (this.mode === 'client') this.awaitFire = 4
  }

  // Comando pedido desde este dispositivo (input, IA, timer). En línea va por la sala: el
  // anfitrión lo numera y lo aplica con applyNet; el cliente lo manda como pedido.
  private act(command: Command): boolean {
    if (this.mode === 'local' || !this.route) return this.dispatch(command)
    if (this.mode === 'client' && (!this.state || this.playback)) return false
    return this.route(command) !== false
  }

  // Muestra lo que llegó por la red (client) o lo diferido (host), en orden, sin pisar un tiro.
  private drain(): void {
    while (this.inbox.length && !this.playback && this.state) {
      const item = this.inbox.shift()!
      const c = item.command
      if (this.mode !== 'client') {
        this.act(c)
        continue
      }
      const s = this.state
      const ok = this.dispatch(c, item.result ?? undefined)
      if (c.type === 'move' && ok) this.movedT = 0.12
      if (c.type === 'aim' && this.aim?.playerId === c.playerId) {
        const p = s.players.find((q) => q.id === c.playerId)
        if (!p || !this.isLocal(p)) this.aim = null
      }
      if (c.type === 'fire' || c.type === 'setKind') this.awaitFire = 0
    }
  }

  // Devuelve false si la sim rechazó o no implementa el comando. pre: resultado ya calculado (client).
  private dispatch(command: Command, pre?: StepResult): boolean {
    const s = this.state
    if (!s || this.playback) return false
    let result
    try {
      result = pre ?? applyCommand(s, command)
    } catch (err) {
      if (command.type !== 'move') console.error(err)
      return false
    }
    this.accepted = result.state !== s || result.events.length > 0
    if (command.type === 'fire') {
      this.aim = null
      this.ai = null
      this.startPlayback(s, result.state, result.events, result.flights ?? [], command.playerId)
      return true
    }
    const changed = result.state !== s
    this.state = result.state
    if (result.events.length) this.fx.push(...result.events)
    for (const e of result.events) this.noteEvent(e, null)
    if (result.events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    if (command.type === 'move' && changed && result.state.terrain !== s.terrain) this.terrainVersion++
    if (result.events.some((e) => e.type === 'round') || (s.phase !== 'aiming' && result.state.phase === 'aiming')) this.newRound()
    return changed
  }

  // Mapa nuevo: el renderer limpia cráteres y restos con el matchId nuevo.
  private newRound(): void {
    this.terrainVersion++
    this.matchId++
    this.aim = null
    this.ai = null
    this.aiToken++
    this.lastShooter = null
    this.lastImpact = null
    this.lastHumanId = null
    this.phaseT = 0
    this.slow = 0
    this.tracerCache = null
    this.sentReady.clear()
    this.sentNext = false
    this.resetLava()
    this.resetCamera()
  }

  // Mapa nuevo: la cámara salta al tanque del turno y se borran las marcas de impacto del minimapa.
  private resetCamera(): void {
    const s = this.state
    this.lastImpacts.clear()
    this.camKey = ''
    if (!s) return
    const p = s.players[s.current]
    this.cam.reset(s.terrain.w, s.terrain.h, p ? { x: p.x, y: p.y } : null)
  }

  private startPlayback(before: GameState, after: GameState, events: GameEvent[], flights: Flight[], shooterId: number): void {
    if (events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    const timed = flights.map((flight) => ({
      flight,
      start: flight.startT ?? 0,
      dur: Math.max(0, (flight.path.length - 1) * PATH_DT),
      done: false,
    }))
    const flightsEnd = timed.reduce((m, f) => Math.max(m, f.start + f.dur), 0)
    let lastT = 0
    let firstImpact = Infinity
    let bigBlast = false
    // v2 muerte súbita: calm, lava y lo que viene después de la lava (o el daño de lava) sin t propio
    // se ubican al final del tiro, cuando ya se asentaron las explosiones (ver abajo).
    const deferred: TimedEvent[] = []
    let lavaPhase = false
    const timeline: TimedEvent[] = events.map((event) => {
      if (event.type === 'impact') {
        lastT = Number.isFinite(event.t) ? event.t : flightsEnd
        firstImpact = Math.min(firstImpact, lastT)
        if (event.blast === 'nuke' || event.blast === 'bigfire') bigBlast = true
      }
      if (LATE.has(event.type)) return { t: Infinity, event }
      const own = ownT(event)
      if (event.type === 'lava' || (event.type === 'damage' && event.cause === 'lava')) lavaPhase = true
      if (own == null && (lavaPhase || event.type === 'calm') && event.type !== 'impact') {
        const item = { t: NaN, event }
        deferred.push(item)
        return item
      }
      return { t: own ?? lastT, event }
    })
    // Base de la lava: después de los vuelos y de todo lo que ya tiene su momento.
    let base = flightsEnd
    for (const e of timeline) if (Number.isFinite(e.t)) base = Math.max(base, e.t)
    const lavaEvent = events.find((e) => e.type === 'lava')
    const hasLava = !!lavaEvent || deferred.some((d) => d.event.type === 'damage')
    const lavaT = (lavaEvent && ownT(lavaEvent)) ?? base + LAVA_GAP
    for (const d of deferred) {
      if (d.event.type === 'lava') d.t = lavaT
      else if (d.event.type === 'calm') d.t = hasLava ? lavaT : base
      else d.t = lavaT + LAVA_HIT
    }
    timeline.sort((a, b) => a.t - b.t)
    if (!Number.isFinite(firstImpact)) firstImpact = flightsEnd
    const eventsEnd = timeline.reduce((m, e) => (Number.isFinite(e.t) ? Math.max(m, e.t) : m), 0)
    const hasShot = flights.length > 0 || timeline.some((e) => e.event.type === 'impact')
    const settle = hasShot ? SETTLE + (bigBlast ? 0.5 : 0) : 0
    // con lava, el turno siguiente espera a que termine de subir
    const lavaEnd = hasLava ? lavaT + LAVA_ANIM + LAVA_TAIL : 0
    const weapon = before.players.find((p) => p.id === shooterId)?.weapon ?? 'normal'
    const { terrain, reveal, pending } = splitTerrain(before.terrain, after.terrain, timeline)
    // la ronda termina con este tiro: la última muerte va en cámara lenta
    let finisher: GameEvent | null = null
    if (after.phase !== 'aiming' && !this.demo?.freeze) {
      for (const e of timeline) if (e.event.type === 'death' && Number.isFinite(e.t)) finisher = e.event
    }
    this.playback = {
      t: 0,
      end: Math.max(Math.max(flightsEnd, eventsEnd) + settle, lavaEnd),
      before,
      after,
      flights: timed,
      timeline,
      next: 0,
      firstImpact,
      shooterId,
      weapon,
      players: before.players.map((p) => ({ ...p })),
      props: (before.props ?? []).map((p) => ({ ...p })),
      terrain,
      reveal,
      pending,
      finisher,
      flightsEnd,
      zoom: shotZoom(
        flights.map((f) => f.path),
        before.terrain.h,
      ),
      settle: null,
      lava: before.lava ?? null,
      calmLeft: Math.max(0, SUDDEN_DEATH_CALM - (before.calm ?? 0)),
    }
    if (hasShot) {
      this.shots.push({ playerId: shooterId, weapon })
      this.lastShooter = shooterId
    }
    this.advance(0)
  }

  private advance(dt: number): void {
    const pb = this.playback
    if (!pb) return
    pb.t += dt
    this.landFlights(pb)
    while (pb.next < pb.timeline.length && pb.timeline[pb.next].t <= pb.t) {
      this.deliver(pb, pb.timeline[pb.next].event)
      pb.next++
    }
    if (this.demo?.freeze && this.demo.shotDone && pb.t >= pb.firstImpact + 0.35) {
      this.frozen = true
      return
    }
    if (pb.t < pb.end) return
    while (pb.next < pb.timeline.length) {
      this.deliver(pb, pb.timeline[pb.next].event)
      pb.next++
    }
    if (pb.pending > 0) this.terrainVersion++
    this.state = pb.after
    this.playback = null
    this.phaseT = 0
    // al terminar el tiro, la cámara va al tanque del turno siguiente
    this.cam.mode = 'tank'
  }

  // Vuelos que terminaron: la cámara se asienta en su punto final si no hubo impacto, y los que se
  // derritieron en la lava (sin explosión ni evento impact) chisporrotean.
  private landFlights(pb: Playback): void {
    for (const f of pb.flights) {
      if (f.done || pb.t < f.start + f.dur) continue
      f.done = true
      const path = f.flight.path
      const end: Vec2 | null = path.length ? path[path.length - 1] : null
      if (f.flight.impact.kind === 'lava') {
        const at = { x: f.flight.impact.x, y: f.flight.impact.y }
        this.melts.push(at)
        pb.settle = at
        this.lastImpacts.set(pb.shooterId, at)
      } else if (!pb.settle && end) {
        pb.settle = { x: end.x, y: end.y }
      }
    }
  }

  private deliver(pb: Playback, event: GameEvent): void {
    this.fx.push(event)
    this.noteEvent(event, pb)
    if (event === pb.finisher) this.slow = SLOW_TIME
    const pixels = pb.reveal.get(event)
    if (pixels && pixels.length) {
      const { front, back } = pb.after.terrain
      for (const i of pixels) {
        pb.terrain.front[i] = front[i]
        pb.terrain.back[i] = back[i]
      }
      pb.pending -= pixels.length
      this.terrainVersion++
    }
    switch (event.type) {
      case 'impact':
        this.lastImpact = { x: event.x, y: event.y }
        pb.settle = this.lastImpact
        if (event.source !== 'barrel') this.lastImpacts.set(pb.shooterId, { x: event.x, y: event.y })
        break
      case 'damage': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) p.hp = event.hp
        break
      }
      case 'shield': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) p.shield = event.left
        break
      }
      case 'death': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) {
          p.alive = false
          p.hp = 0
        }
        break
      }
      case 'fall': {
        const p = pb.players.find((q) => q.id === event.playerId)
        const final = pb.after.players.find((q) => q.id === event.playerId)
        if (p) {
          p.y = event.to
          if (final) p.x = final.x
        }
        break
      }
      case 'prop': {
        const prop = pb.props.find((q) => q.id === event.propId)
        const final = pb.after.props?.find((q) => q.id === event.propId)
        if (prop) {
          prop.alive = !event.destroyed
          if (final) {
            prop.x = final.x
            prop.y = final.y
          }
        }
        break
      }
      default:
        break
    }
  }

  // Proyectiles en vuelo en el tiempo t del tiro. hold: los que siguen en vuelo ahora pero terminan antes
  // de t quedan en su punto final (la anticipación de la cámara mira hasta dónde llega el vuelo).
  private projectiles(pb: Playback, t = pb.t, hold = false): Vec2[] {
    const out: Vec2[] = []
    for (const f of pb.flights) {
      const local = t - f.start
      if (f.flight.path.length === 0 || local < 0) continue
      if (local > f.dur) {
        if (hold && pb.t - f.start <= f.dur) out.push(f.flight.path[f.flight.path.length - 1])
        continue
      }
      out.push(samplePath(f.flight.path, local))
    }
    return out
  }

  private driveAi(dt: number): void {
    const s = this.state
    if (!s || s.phase !== 'aiming') return
    const actor = s.players[s.current]
    if (!actor || !actor.alive || this.controlledByHuman(actor)) {
      this.ai = null
      return
    }
    if (!this.ai || this.ai.playerId !== actor.id) {
      const scripted = !!this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id
      const token = ++this.aiToken
      this.ai = {
        playerId: actor.id,
        token,
        plan: null,
        from: { angle: actor.angle, power: actor.power },
        t: 0,
        think: scripted ? 0.15 : 0.45,
        dur: 0.45,
        hold: scripted ? 0.1 : 0.3,
        move: 0,
        moveAcc: 0,
      }
      const client = this.aiClient
      if (scripted || this.demo?.freeze || this.syncAi || !client || !client.available) {
        this.setPlan(this.ai, this.plan(s, actor))
      } else {
        const seed = (this.random() * 0x100000000) >>> 0
        const difficulty: Difficulty = this.config?.difficulty ?? 'normal'
        client
          .choose(s, difficulty, seed)
          .catch((err) => {
            console.error(err)
            return fallbackPlan(actor)
          })
          .then((plan) => {
            const ai = this.ai
            if (!ai || ai.token !== token || this.state !== s) return
            this.setPlan(ai, plan)
          })
      }
    }
    const ai = this.ai
    if (!ai.plan) {
      // pensando en el worker: el cañón tantea alrededor de donde estaba
      ai.t += dt
      const aim = this.currentAim()
      if (aim) {
        const k = Math.min(1, ai.t / 0.4)
        aim.angle = clamp(ai.from.angle + Math.sin(ai.t * 2.3) * 5 * k, 0, 180)
        aim.power = clamp(ai.from.power + Math.sin(ai.t * 1.7 + 1) * 4 * k, 0, 100)
      }
      return
    }
    if (ai.move !== 0) {
      ai.moveAcc += MOVE_SPEED * dt
      let steps = Math.min(3, Math.floor(ai.moveAcc))
      ai.moveAcc -= steps
      const dir: -1 | 1 = ai.move > 0 ? 1 : -1
      while (steps-- > 0 && ai.move !== 0) {
        if (!this.act({ type: 'move', playerId: actor.id, dir })) {
          ai.move = 0
          break
        }
        ai.move -= dir
        this.movedT = 0.12
      }
      return
    }
    ai.t += dt
    const k = clamp((ai.t - ai.think) / ai.dur, 0, 1)
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const aim = this.currentAim()
    if (aim) {
      aim.angle = ai.from.angle + (ai.plan.angle - ai.from.angle) * e
      aim.power = ai.from.power + (ai.plan.power - ai.from.power) * e
    }
    if (ai.t >= ai.think + ai.dur + ai.hold) {
      if (aim) {
        aim.angle = ai.plan.angle
        aim.power = ai.plan.power
      }
      if (this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id) this.demo.shotDone = true
      this.commitAimAndFire(actor.id, true)
    }
  }

  // Con el plan en la mano: arma, recorrido y duración del apuntado. Si el worker tardó más
  // que el "pensar" de siempre, el apuntado arranca ya desde donde quedó el cañón.
  private setPlan(ai: AiDrive, plan: ShotPlan): void {
    const s = this.state
    const actor = s?.players.find((p) => p.id === ai.playerId)
    if (!s || !actor) return
    const aim = this.currentAim()
    ai.from = aim ? { angle: aim.angle, power: aim.power } : { angle: actor.angle, power: actor.power }
    const turn = Math.abs(plan.angle - ai.from.angle) / 180 + Math.abs(plan.power - ai.from.power) / 200
    ai.plan = plan
    ai.dur = clamp(0.45 + turn * 1.1, 0.45, 1.3)
    ai.think = Math.max(0, ai.think - ai.t)
    ai.t = 0
    ai.move = Math.round(plan.move ?? 0)
    ai.moveAcc = 0
    if (plan.weapon !== actor.weapon) this.act({ type: 'selectWeapon', playerId: actor.id, weapon: plan.weapon })
  }

  private plan(s: GameState, actor: Player): ShotPlan {
    const difficulty: Difficulty = this.config?.difficulty ?? 'normal'
    try {
      if (this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id) {
        return pickDemoShot(s, this.demo.seed, this.demo.weapon)
      }
      return chooseShot(s, difficulty, this.random)
    } catch (err) {
      console.error(err)
      return fallbackPlan(actor)
    }
  }
}

const USABLE: ItemId[] = ['shield', 'repair', 'fuel', 'tracer']
const ITEM_NAMES: Record<ItemId, string> = {
  shield: 'escudo',
  parachute: 'paracaidas',
  fuel: 'combustible',
  repair: 'reparacion',
  tracer: 'trazador',
}

function ownedOf(p: Player, id: ShopId): number {
  if (id in WEAPONS) return p.ammo?.[id as WeaponId] ?? 0
  return p.items?.[id as ItemId] ?? 0
}

function fallbackPlan(actor: Player): ShotPlan {
  return { angle: actor.angle, power: Math.max(40, actor.power), weapon: 'normal' }
}

const BURN_REACH = 8

// Reparte los pixels que cambian entre before y after entre los impact/burn del tiro, para que
// cada cráter aparezca en el momento de su evento. Cada pixel va al primer evento (en el tiempo)
// que lo alcanza; si ninguno, al más cercano.
function splitTerrain(
  before: Terrain,
  after: Terrain,
  timeline: TimedEvent[],
): { terrain: Terrain; reveal: Map<GameEvent, Int32Array>; pending: number } {
  const reveal = new Map<GameEvent, Int32Array>()
  if (after === before || after.w !== before.w || after.h !== before.h) {
    return { terrain: after, reveal, pending: 0 }
  }
  const sources = timeline
    .map((e) => e.event)
    .filter((e): e is Extract<GameEvent, { type: 'impact' | 'burn' }> => e.type === 'impact' || e.type === 'burn')
  const { w, h } = before
  const changed: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (before.front[i] !== after.front[i] || before.back[i] !== after.back[i]) changed.push(i)
  }
  if (sources.length === 0 || changed.length === 0) return { terrain: after, reveal, pending: 0 }
  const reach = (e: (typeof sources)[number], x: number, y: number): number => {
    if (e.type === 'impact') {
      const r = Math.max(4, e.radius)
      // la excavadora cava un túnel largo: se lo da a su impacto aunque quede lejos
      return Math.hypot(x - e.x, y - e.y) / (e.blast === 'dig' ? r * 10 : r)
    }
    const dx = x < e.x ? e.x - x : x > e.x + e.w ? x - e.x - e.w : 0
    return Math.hypot(dx, y - e.y) / BURN_REACH
  }
  const buckets: number[][] = sources.map(() => [])
  for (const i of changed) {
    const x = i % w
    const y = (i - x) / w
    let pick = -1
    let best = Infinity
    let bestAt = 0
    for (let k = 0; k < sources.length; k++) {
      const d = reach(sources[k], x, y)
      if (d <= 1.15) {
        pick = k
        break
      }
      if (d < best) {
        best = d
        bestAt = k
      }
    }
    buckets[pick >= 0 ? pick : bestAt].push(i)
  }
  sources.forEach((e, k) => reveal.set(e, Int32Array.from(buckets[k])))
  const terrain: Terrain = { ...before, front: before.front.slice(), back: before.back.slice() }
  return { terrain, reveal, pending: changed.length }
}

function samplePath(path: Vec2[], t: number): Vec2 {
  if (path.length === 1) return path[0]
  const u = t / PATH_DT
  const i = Math.min(path.length - 2, Math.floor(u))
  const f = Math.min(1, u - i)
  return {
    x: path[i].x + (path[i + 1].x - path[i].x) * f,
    y: path[i].y + (path[i + 1].y - path[i].y) * f,
  }
}

// t propio de un evento (los que lo traen opcional); el de impact se maneja aparte.
function ownT(event: GameEvent): number | null {
  if (event.type === 'impact') return null
  const t = (event as { t?: unknown }).t
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

// Un decimal: el ajuste fino (Shift, paso táctil) mueve de a 0,2 y eso tiene que llegar a la sim.
function quantize(v: number): number {
  return Math.round(v * 10) / 10
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
