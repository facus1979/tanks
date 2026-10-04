// v3 (render-armas): punto de entrada de los efectos de armas, ítems, peligros y carteles de bonos.
// PixiRenderer solo le pasa los eventos, le pregunta si una explosión es suya, le cede los proyectiles de las
// armas nuevas y lo actualiza una vez por frame. Las capas:
//   under  entre el terreno y los tanques (charcos, minas, grietas, bordes al rojo)
//   over   encima de los efectos (rayo, remolino, misil, burbuja, ancla, motas)
//   glow   aditiva, brillos baratos (texturas cacheadas en vez del buffer de luces)
//   signs  carteles de bonos (al nivel de los números de daño)
// QA: ?fxtest=<arma nueva> además arma los eventos que el tiro de prueba no trae (beam, quake, pull, hazard,
// guiado); ?fxtest=jetpack|teleport|anchor|deflector|bonus prueba los ítems y los carteles sobre el tiro del
// modo demo. ?fxpeek=<s> adelanta también estos efectos al congelarse.
import { Rectangle, Texture } from 'pixi.js'
import { muzzle, tankTilt } from '../../sim'
import type { GameEvent, Hazard, Player, WeaponId } from '../../sim/types'
import { WEAPONS } from '../../sim/types'
import type { RenderFrame } from '../types'
import type { Font } from './assets'
import { BonusSigns } from './bonus'
import type { Fx } from './fx'
import { HazardsView } from './hazards'
import { ItemsFx } from './items-fx'
import { Motes, PixelLayer } from './pixels'
import { V3_SHOTS, WeaponsFx } from './weapons-fx'

const QS = new URLSearchParams(location.search)
const FX_TEST = QS.get('fxtest')
const FX_PEEK = Number(QS.get('fxpeek') ?? 0) || 0

type Guided = NonNullable<RenderFrame['guided']>

export class ArmasFx {
  readonly under = new PixelLayer(900)
  readonly over = new PixelLayer(1400)
  readonly glow = new PixelLayer(160, 'add')
  readonly motes = new Motes(360)
  readonly signs = new BonusSigns(this.motes)
  readonly weapons: WeaponsFx
  readonly items: ItemsFx
  readonly hazards: HazardsView
  private wasFrozen = false
  private time = 0
  // QA: peligros falsos de ?fxtest=mine|acid y misil guiado falso de ?fxtest=guided
  private fakeHazards: Hazard[] = []
  private lastProj: { x: number; y: number }[] = []
  private testDone = false

  constructor(
    private fx: Fx,
    addCrater: (x: number, y: number, r: number) => void,
  ) {
    let terrain: RenderFrame['terrain'] | null = null
    this.terrainRef = (t) => (terrain = t)
    this.weapons = new WeaponsFx({ fx, motes: this.motes, terrain: () => terrain, addCrater })
    this.items = new ItemsFx(fx, this.motes)
    this.hazards = new HazardsView(fx, this.motes)
    this.hazards.onCorrode = (id, s) => this.weapons.corrodeTank(id, s)
    if (FX_TEST === 'anchor' || FX_TEST === 'deflector') this.items.force = FX_TEST
    void this.loadArt()
  }

  private terrainRef: (t: RenderFrame['terrain']) => void

  // Mina y misil pintados por el arte (props.mine, props.missile del manifiesto), si ya están.
  private async loadArt(): Promise<void> {
    try {
      const res = await fetch('assets/manifest.json')
      if (!res.ok) return
      const m = (await res.json()) as { props?: { mine?: { file: string; cell: { w: number; h: number }; frames: number }; missile?: string } }
      const load = (file: string): Promise<Texture | null> =>
        new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            if (!img.naturalWidth) return resolve(null)
            const t = Texture.from(img)
            t.source.scaleMode = 'nearest'
            resolve(t)
          }
          img.onerror = () => resolve(null)
          img.src = 'assets/' + file
        })
      const mine = m.props?.mine
      if (mine?.file) {
        const t = await load(mine.file)
        if (t) {
          const frame = (i: number): Texture => new Texture({ source: t.source, frame: new Rectangle(i * mine.cell.w, 0, mine.cell.w, mine.cell.h) })
          this.hazards.setMineArt(frame(0), frame(Math.min(1, mine.frames - 1)))
        }
      }
      if (m.props?.missile) this.weapons.missileTex = await load(m.props.missile)
    } catch {
      // sin manifiesto o sin esos campos: quedan los respaldos procedurales
    }
  }

  set font(f: Font | null) {
    this.signs.font = f
  }

  reset(): void {
    this.weapons.reset()
    this.items.reset()
    this.hazards.reset()
    this.motes.clear()
    this.signs.clear()
    this.fakeHazards = []
    this.testDone = false
    this.under.clear()
    this.over.clear()
    this.glow.clear()
  }

  // ¿El proyectil de esta arma lo dibuja este módulo? (el renderer no se lo pasa a Fx.draw)
  ownsShot(weapon: WeaponId | null): boolean {
    return weapon !== null && V3_SHOTS.has(weapon)
  }

  // Explosión de un BlastStyle de v3. true = ya la dibujó.
  blast(ev: Extract<GameEvent, { type: 'impact' }>, dirX: number, dirY: number, frame: RenderFrame): boolean {
    return this.weapons.blast(ev.blast, ev.x, ev.y, ev.radius, ev.debris, dirX, dirY, frame.players)
  }

  onEvent(ev: GameEvent, frame: RenderFrame): void {
    const players = frame.players
    switch (ev.type) {
      case 'beam': {
        const shooter = players.find((p) => p.id === frame.shooterId)
        this.weapons.beam(ev.x0, ev.y0, ev.x1, ev.y1, shooter?.color ?? null)
        break
      }
      case 'quake':
        this.weapons.quake(ev.x, ev.y, ev.radius, false)
        break
      case 'pull':
        this.weapons.vortex(ev.x, ev.y, ev.radius, ev.duration)
        break
      case 'hazard':
        this.hazards.onEvent(ev, players)
        break
      case 'deflect':
        this.items.deflect(ev.x, ev.y, players.find((p) => p.id === ev.playerId))
        break
      case 'jetpack':
        this.items.jetpack(ev.playerId, ev.path)
        break
      case 'teleport':
        this.items.teleport(ev.from, ev.to)
        break
      case 'bonus':
        this.signs.spawn(
          players.find((p) => p.id === ev.playerId),
          ev.kind,
          ev.amount,
          ev.x,
          ev.y,
        )
        break
      case 'slide':
        // el agujero negro y el terremoto arrastran tanques: terrones y polvo al arrancar
        if ((ev.cause === 'pull' || ev.cause === 'quake') && ev.path.length > 1) this.fx.dust(ev.path[0].x, ev.path[0].y, 8, 28)
        break
      case 'impact':
        if (FX_TEST && ev.source !== 'barrel' && !this.testDone) this.fxTest(ev, frame)
        break
    }
  }

  // ?fxtest: arma los eventos de v3 que el tiro del modo demo no trae, en el lugar del impacto.
  private fxTest(ev: Extract<GameEvent, { type: 'impact' }>, frame: RenderFrame): void {
    const shooter = frame.players.find((p) => p.id === frame.shooterId) ?? frame.players[frame.current]
    const w = FX_TEST && FX_TEST in WEAPONS ? WEAPONS[FX_TEST as WeaponId] : null
    let id = 1000
    const hz = (kind: Hazard['kind'], radius: number): Hazard => ({ id: id++, kind, ownerId: shooter?.id ?? 0, x: ev.x, y: ev.y, radius, turns: 2 })
    switch (FX_TEST) {
      case 'laser':
        if (shooter) {
          const m = muzzle(shooter.x, shooter.y, shooter.angle, tankTilt(frame.terrain, shooter.x, shooter.y))
          this.onEvent({ type: 'beam', x0: m.x, y0: m.y, x1: ev.x, y1: ev.y, t: 0 }, frame)
        }
        break
      case 'quake':
        this.onEvent({ type: 'quake', x: ev.x, y: ev.y, radius: w?.quake ?? 70, t: 0 }, frame)
        break
      case 'blackhole':
        this.onEvent({ type: 'pull', x: ev.x, y: ev.y, radius: w?.pull ?? 80, t: 0, duration: 1.2 }, frame)
        break
      case 'mine': {
        // una mina al lado del impacto (queda puesta) y otra que se activa
        const h = hz('mine', 18)
        h.x += 40
        this.fakeHazards.push(h)
        this.onEvent({ type: 'hazard', action: 'place', hazard: h }, frame)
        break
      }
      case 'acid': {
        const h = hz('acid', w?.radius ?? 18)
        this.fakeHazards.push(h)
        this.onEvent({ type: 'hazard', action: 'place', hazard: h }, frame)
        break
      }
      case 'jetpack':
        if (shooter) {
          const path = []
          const dir = shooter.x < frame.terrain.w / 2 ? 1 : -1
          for (let i = 0; i <= 40; i++) {
            const u = i / 40
            path.push({ x: shooter.x + dir * 110 * u, y: shooter.y - 70 * 4 * u * (1 - u) })
          }
          this.onEvent({ type: 'jetpack', playerId: shooter.id, path }, frame)
        }
        break
      case 'teleport':
        if (shooter) this.onEvent({ type: 'teleport', playerId: shooter.id, from: { x: shooter.x, y: shooter.y }, to: { x: ev.x, y: ev.y } }, frame)
        break
      case 'deflector':
        if (shooter) this.onEvent({ type: 'deflect', playerId: shooter.id, x: shooter.x + 10, y: shooter.y - 22, t: 0 }, frame)
        break
      case 'bonus':
        if (shooter) {
          this.onEvent({ type: 'bonus', playerId: shooter.id, kind: 'loot', amount: 250, x: ev.x, y: ev.y - 10 }, frame)
          this.onEvent({ type: 'bonus', playerId: shooter.id, kind: 'longshot', amount: 150, x: ev.x, y: ev.y - 10 }, frame)
          this.onEvent({ type: 'bonus', playerId: shooter.id, kind: 'double', amount: 300, x: ev.x + 4, y: ev.y - 10 }, frame)
        }
        break
    }
    this.testDone = true
  }

  // Misil guiado falso para ?fxtest=guided: en la bajada del tiro de prueba.
  private fakeGuided(frame: RenderFrame): Guided | null {
    const p = frame.projectiles[0]
    const last = this.lastProj[0]
    this.lastProj = frame.projectiles.map((q) => ({ x: q.x, y: q.y }))
    if (!p || !last || p.y <= last.y) return null
    return { x: p.x, y: p.y, vx: (p.x - last.x) * 60, vy: (p.y - last.y) * 60, guide: 1 }
  }

  update(frame: RenderFrame, step: number, weapon: WeaponId | null, view: { x0: number; x1: number }): void {
    this.terrainRef(frame.terrain)
    const players = frame.players
    let guided = frame.guided ?? null
    if (FX_TEST === 'guided' && !guided) guided = this.fakeGuided(frame)
    const hazards = this.fakeHazards.length ? (frame.hazards ?? []).concat(this.fakeHazards) : frame.hazards
    // ?fxpeek: al congelarse, adelanta también estos efectos
    if (frame.freeze && !this.wasFrozen && FX_PEEK > 0) {
      for (let i = 0; i < Math.round(FX_PEEK * 60); i++) this.tick(frame, players, 1 / 60, hazards, view)
    }
    this.wasFrozen = frame.freeze
    this.tick(frame, players, step, hazards, view)

    this.under.begin()
    this.over.begin()
    this.glow.begin()
    this.hazards.draw(this.under, this.glow, players)
    this.weapons.draw(this.under, this.over, this.glow, players)
    this.items.draw(this.over, this.glow, players)
    this.weapons.shots(this.over, this.glow, frame.projectiles, weapon, guided, step)
    this.motes.draw(this.over)
    this.under.end()
    this.over.end()
    this.glow.end()
  }

  private tick(frame: RenderFrame, players: Player[], dt: number, hazards: Hazard[] | undefined, view: { x0: number; x1: number }): void {
    this.time += dt
    this.weapons.update(players, dt)
    this.items.update(players, dt)
    this.hazards.update(hazards, frame.terrain, frame.terrainVersion, dt, view)
    this.motes.update(dt)
    this.signs.update(dt)
  }
}
