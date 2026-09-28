// Sesión local: aplica comandos a la sim, reproduce los tiros en el tiempo y maneja a las IAs.
import { PATH_DT, applyCommand, chooseShot, createMatch } from '../sim'
import type { ShotPlan } from '../sim'
import type {
  Biome,
  Command,
  Difficulty,
  Flight,
  GameEvent,
  GameState,
  MatchConfig,
  Player,
  Prop,
  Terrain,
  Vec2,
  WeaponId,
} from '../sim/types'
import { FUEL_PER_TURN, WEAPONS } from '../sim/types'
import type { RenderFrame } from '../render/types'
import type { HudModel, HudSide } from '../ui/hud'
import { pickDemoShot, seededRandom } from './demo'

export interface DemoOptions {
  freeze: boolean
  weapon?: WeaponId // QA: arma del tiro fijo de P1 (&weapon=)
}

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
  flights: { flight: Flight; start: number; dur: number }[]
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
}

interface AiDrive {
  playerId: number
  plan: ShotPlan
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
const LATE = new Set<GameEvent['type']>(['turn', 'wind', 'gameover'])

export class Session {
  state: GameState | null = null
  config: MatchConfig | null = null
  private playback: Playback | null = null
  private fx: GameEvent[] = []
  private ai: AiDrive | null = null
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
  private gameoverT = 0
  private movedT = 0

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

  // Segundos desde que terminó la partida (0 si sigue).
  get finishedFor(): number {
    return this.gameoverT
  }

  get inputEnabled(): boolean {
    const s = this.state
    if (!s || s.phase !== 'aiming' || this.playback || this.frozen) return false
    const p = s.players[s.current]
    return !!p && this.controlledByHuman(p)
  }

  start(config: MatchConfig, demo?: DemoOptions): void {
    const seed = config.seed ?? ((Math.random() * 0xffffffff) >>> 0)
    this.config = { ...config, bots: Math.max(1, Math.min(3, config.bots)), seed }
    this.state = createMatch(this.config)
    this.playback = null
    this.fx = []
    this.ai = null
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
    this.gameoverT = 0
    this.movedT = 0
    this.demo = demo ? { ...demo, shotDone: false, seed } : null
    this.random = demo ? seededRandom(seed ^ 0x5bd1e995) : Math.random
  }

  // Ajuste continuo del ángulo y la potencia del humano. Se manda a la sim al disparar.
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
      if (!this.dispatch({ type: 'move', playerId: p.id, dir })) break
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
    this.dispatch({ type: 'selectWeapon', playerId: p.id, weapon })
  }

  fire(): void {
    if (!this.inputEnabled || !this.state) return
    this.commitAimAndFire(this.state.players[this.state.current].id)
  }

  update(dt: number): void {
    if (!this.state || this.frozen) return
    if (this.movedT > 0) this.movedT -= dt
    if (this.messageT > 0) {
      this.messageT -= dt
      if (this.messageT <= 0) this.message = ''
    }
    if (this.playback) {
      this.advance(dt)
      return
    }
    if (this.state.phase === 'gameover') {
      this.gameoverT += dt
      return
    }
    this.driveAi(dt)
  }

  pullFx(): GameEvent[] {
    const events = this.fx
    this.fx = []
    return events
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
    const biome: Biome = s.biome ?? this.config?.biome ?? 'forest'
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
    }
  }

  hud(): HudModel | null {
    const s = this.state
    if (!s) return null
    const pb = this.playback
    const players = pb ? pb.players : this.playersWithAim(s)
    const currentIndex = pb ? pb.before.current : s.current
    const current = players[currentIndex]
    const human = players.find((p) => p.kind === 'human') ?? players[0] ?? null
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
            you: !!human && p.id === human.id && human.kind === 'human',
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
      showBar: !!current && this.controlledByHuman(current) && s.phase === 'aiming',
    }
  }

  resultText(): string {
    const s = this.state
    if (!s || s.winnerId == null) return 'Empate'
    const winner = s.players.find((p) => p.id === s.winnerId)
    if (!winner) return 'Empate'
    return this.controlledByHuman(winner) || winner.kind === 'human' ? 'Ganaste' : `Gano ${winner.name}`
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
    if (this.playback || !current) return ''
    if (this.controlledByHuman(current)) return 'Tu turno'
    return `${current.name} apunta`
  }

  private controlledByHuman(p: Player): boolean {
    if (p.kind !== 'human') return false
    return !this.demo
  }

  private flash(text: string): void {
    this.message = text
    this.messageT = 1.1
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
      const angle = exact ? aim.angle : Math.round(aim.angle)
      const power = exact ? aim.power : Math.round(aim.power)
      if (angle !== p.angle || power !== p.power) this.dispatch({ type: 'aim', playerId, angle, power })
    }
    this.dispatch({ type: 'fire', playerId })
  }

  // Devuelve false si la sim rechazó o no implementa el comando.
  private dispatch(command: Command): boolean {
    const s = this.state
    if (!s || this.playback) return false
    let result
    try {
      result = applyCommand(s, command)
    } catch (err) {
      if (command.type !== 'move') console.error(err)
      return false
    }
    if (command.type === 'fire') {
      this.aim = null
      this.ai = null
      this.startPlayback(s, result.state, result.events, result.flights ?? [], command.playerId)
      return true
    }
    const changed = result.state !== s
    this.state = result.state
    if (result.events.length) this.fx.push(...result.events)
    if (result.events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    if (command.type === 'move' && changed && result.state.terrain !== s.terrain) this.terrainVersion++
    return changed
  }

  private startPlayback(before: GameState, after: GameState, events: GameEvent[], flights: Flight[], shooterId: number): void {
    if (events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    const timed = flights.map((flight) => ({
      flight,
      start: flight.startT ?? 0,
      dur: Math.max(0, (flight.path.length - 1) * PATH_DT),
    }))
    const flightsEnd = timed.reduce((m, f) => Math.max(m, f.start + f.dur), 0)
    let lastT = 0
    let firstImpact = Infinity
    let bigBlast = false
    const timeline: TimedEvent[] = events.map((event) => {
      if (event.type === 'impact') {
        lastT = Number.isFinite(event.t) ? event.t : flightsEnd
        firstImpact = Math.min(firstImpact, lastT)
        if (event.blast === 'nuke' || event.blast === 'bigfire') bigBlast = true
      }
      if (LATE.has(event.type)) return { t: Infinity, event }
      const own = event.type !== 'impact' && 't' in event && typeof event.t === 'number' ? event.t : null
      return { t: own ?? lastT, event }
    })
    timeline.sort((a, b) => a.t - b.t)
    if (!Number.isFinite(firstImpact)) firstImpact = flightsEnd
    const eventsEnd = timeline.reduce((m, e) => (Number.isFinite(e.t) ? Math.max(m, e.t) : m), 0)
    const hasShot = flights.length > 0 || timeline.some((e) => e.event.type === 'impact')
    const settle = hasShot ? SETTLE + (bigBlast ? 0.5 : 0) : 0
    const weapon = before.players.find((p) => p.id === shooterId)?.weapon ?? 'normal'
    const { terrain, reveal, pending } = splitTerrain(before.terrain, after.terrain, timeline)
    this.playback = {
      t: 0,
      end: Math.max(flightsEnd, eventsEnd) + settle,
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
  }

  private deliver(pb: Playback, event: GameEvent): void {
    this.fx.push(event)
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
        break
      case 'damage': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) p.hp = event.hp
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

  private projectiles(pb: Playback): Vec2[] {
    const out: Vec2[] = []
    for (const f of pb.flights) {
      const local = pb.t - f.start
      if (local < 0 || local > f.dur || f.flight.path.length === 0) continue
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
      const plan = this.plan(s, actor)
      if (!plan) return
      const turn = Math.abs(plan.angle - actor.angle) / 180 + Math.abs(plan.power - actor.power) / 200
      const scripted = this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id
      this.ai = {
        playerId: actor.id,
        plan,
        from: { angle: actor.angle, power: actor.power },
        t: 0,
        think: scripted ? 0.15 : 0.45,
        dur: clamp(0.45 + turn * 1.1, 0.45, 1.3),
        hold: scripted ? 0.1 : 0.3,
        move: Math.round(plan.move ?? 0),
        moveAcc: 0,
      }
      if (plan.weapon !== actor.weapon) this.dispatch({ type: 'selectWeapon', playerId: actor.id, weapon: plan.weapon })
    }
    const ai = this.ai
    if (ai.move !== 0) {
      ai.moveAcc += MOVE_SPEED * dt
      let steps = Math.min(3, Math.floor(ai.moveAcc))
      ai.moveAcc -= steps
      const dir: -1 | 1 = ai.move > 0 ? 1 : -1
      while (steps-- > 0 && ai.move !== 0) {
        if (!this.dispatch({ type: 'move', playerId: actor.id, dir })) {
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

  private plan(s: GameState, actor: Player): ShotPlan | null {
    const difficulty: Difficulty = this.config?.difficulty ?? 'normal'
    try {
      if (this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id) {
        return pickDemoShot(s, this.demo.seed, this.demo.weapon)
      }
      return chooseShot(s, difficulty, this.random)
    } catch (err) {
      console.error(err)
      return { angle: actor.angle, power: Math.max(40, actor.power), weapon: 'normal' } as ShotPlan
    }
  }
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
