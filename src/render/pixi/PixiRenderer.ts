import { Application, Container, Graphics, Sprite, Texture, TextureStyle } from 'pixi.js'
import type { Biome, GameEvent, Player, Prop, WeaponId } from '../../sim/types'
import { BARREL_LEN, PIVOT_X, PIVOT_Y, TANK_H, TANK_W, WEAPONS, WORLD_H, WORLD_W } from '../../sim/types'
import type { GameRenderer, RenderFrame, Viewport } from '../types'
import { BUBBLE_HOLD, BUBBLE_TIME, PropView, RECOIL_TIME, TankView } from './actors'
import type { Art } from './assets'
import { loadArt } from './assets'
import { DEBRIS_COLORS } from './fallback'
import type { ShotView } from './fx'
import { Extras } from './extras'
import { Fx } from './fx'
import { Raster, Rng } from './raster'
import { TerrainPainter } from './terrain'

const SCORCH_STYLES = new Set(['fire', 'bigfire', 'napalm', 'nuke'])
const NEAR_MISS = 40
const THREAT_MARGIN = 70
const TRAIL_STEP = 7 // px entre puntos de la estela
// QA: ?fxpeek=0.3 adelanta los efectos esos segundos al congelarse (para comparar capturas).
const FX_PEEK = Number(new URLSearchParams(location.search).get('fxpeek') ?? 0) || 0
// depuración: congela la imagen tras N s de vuelo del primer tiro (capturas de la estela)
const FLY_PEEK = Number(new URLSearchParams(location.search).get('flypeek') ?? 0) || 0
// QA: ?fxtest=nuke dibuja las explosiones de tiro con ese arma (radio y estilo) para capturas del modo demo.
const FX_TEST = ((): WeaponId | null => {
  const w = new URLSearchParams(location.search).get('fxtest')
  return w && w in WEAPONS ? (w as WeaponId) : null
})()

// QA: con ?fxtest o ?fxstats=1 muestra partículas activas (y el pico), fps y ms de efectos por frame.
const FX_STATS = FX_TEST !== null || new URLSearchParams(location.search).get('fxstats') === '1'

class FxStats {
  private el = document.createElement('div')
  private peak = 0
  private acc = 0
  private frames = 0
  private fps = 0
  private minFps = Infinity
  private ms = 0
  private maxMs = 0
  private t = 0

  constructor() {
    this.el.style.cssText = 'position:fixed;left:4px;top:40px;z-index:99;font:11px monospace;color:#fff;background:#000a;padding:2px 4px;pointer-events:none'
    document.body.appendChild(this.el)
  }

  sample(count: number, dt: number, ms: number, trails: string): void {
    this.t += dt
    this.peak = Math.max(this.peak, count)
    this.ms = ms
    if (this.t > 2) this.maxMs = Math.max(this.maxMs, ms)
    this.acc += dt
    this.frames++
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc
      if (this.t > 2) this.minFps = Math.min(this.minFps, this.fps)
      this.acc = 0
      this.frames = 0
    }
    const min = this.minFps === Infinity ? '-' : this.minFps.toFixed(0)
    this.el.textContent = `fx ${count} (máx ${this.peak}) · fps ${this.fps.toFixed(0)} (mín ${min}) · fx ${this.ms.toFixed(1)} ms (máx ${this.maxMs.toFixed(1)}) · estelas ${trails}`
  }
}

function canvasTexture(c: HTMLCanvasElement): Texture {
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  t.source.autoGenerateMipmaps = false
  return t
}

export class PixiRenderer implements GameRenderer {
  private app = new Application()
  private host: HTMLElement | null = null
  private art: Art | null = null
  private onFrame: ((dt: number) => void) | null = null

  private bg = new Container()
  private world = new Container()
  private propLayer = new Container()
  private tankLayer = new Container()
  private overlayLayer = new Container()
  private arrowLayer = new Container()
  private flashG = new Graphics()
  private glowG = new Graphics()

  private painter = new TerrainPainter(WORLD_W, WORLD_H)
  private backSprite = new Sprite()
  private frontSprite = new Sprite()
  private backTex: Texture | null = null
  private frontTex: Texture | null = null

  private fx = new Fx(WORLD_W, WORLD_H)
  private extras = new Extras(this.fx)
  private fxSprite = new Sprite()
  private lightSprite = new Sprite()
  private fxTex: Texture | null = null
  private lightTex: Texture | null = null
  private fxShown = false
  private lightShown = false

  private lamps = new Raster(WORLD_W, WORLD_H)
  private lampSprite = new Sprite()
  private lampTex: Texture | null = null
  private lampKey = ''

  private tanks = new Map<number, TankView>()
  private props = new Map<number, PropView>()
  private arrows: Sprite[] = []

  private biome: Biome | null = null
  private version = -1
  private matchId = -1
  private time = 0
  private rng = new Rng(7)
  private players: Player[] = []
  private lastShooter: number | null = null
  private near = new Set<number>()
  private hitThisShot = new Set<number>()
  private impactSeen = false
  private trailLast: { x: number; y: number; acc: number; dx: number; dy: number; ground: number; spin: number }[] = []
  private shotCount = 0
  private shots: ShotView[] = []
  private flyT = 0
  private flyHeld = false
  private shakeX = 0
  private shakeY = 0
  private wasFrozen = false
  private stats: FxStats | null = FX_STATS ? new FxStats() : null
  private blocked = (x: number, y: number, w: number, h: number): boolean => this.fx.blocks(x, y, w, h)

  async mount(host: HTMLElement): Promise<void> {
    this.host = host
    TextureStyle.defaultOptions.scaleMode = 'nearest'
    await this.app.init({
      width: WORLD_W,
      height: WORLD_H,
      background: 0x14121c,
      antialias: false,
      resolution: 1,
      autoDensity: false,
      roundPixels: true,
      preference: 'webgl',
    })
    this.app.canvas.style.imageRendering = 'pixelated'
    host.appendChild(this.app.canvas)
    this.art = await loadArt()

    this.backTex = canvasTexture(this.painter.back.canvas)
    this.frontTex = canvasTexture(this.painter.front.canvas)
    this.fxTex = canvasTexture(this.fx.fx.canvas)
    this.lightTex = canvasTexture(this.fx.light.canvas)
    this.lampTex = canvasTexture(this.lamps.canvas)
    this.backSprite.texture = this.backTex
    this.frontSprite.texture = this.frontTex
    this.fxSprite.texture = this.fxTex
    this.lightSprite.texture = this.lightTex
    this.lampSprite.texture = this.lampTex
    this.lightSprite.blendMode = 'add'
    this.lampSprite.blendMode = 'add'
    this.fxSprite.visible = false
    this.lightSprite.visible = false
    this.lampSprite.visible = false

    this.flashG.rect(0, 0, WORLD_W, WORLD_H).fill(0xffffff)
    this.flashG.alpha = 0
    this.glowG.rect(0, 0, WORLD_W, WORLD_H).fill(0xffffff)
    this.glowG.blendMode = 'add'
    this.glowG.alpha = 0
    this.world.addChild(
      this.backSprite,
      this.propLayer,
      this.lampSprite,
      this.frontSprite,
      this.tankLayer,
      this.lightSprite,
      this.fxSprite,
      this.extras.layer,
      this.overlayLayer,
    )
    this.app.stage.addChild(this.bg, this.world, this.glowG, this.arrowLayer, this.flashG, this.extras.curtain)
    this.fx.wreckPos = (id) => {
      const p = this.players.find((q) => q.id === id)
      return p && !p.alive ? { x: Math.round(p.x), y: Math.round(p.y) } : null
    }
    this.app.ticker.add((ticker) => {
      this.onFrame?.(Math.min(0.05, ticker.deltaMS / 1000))
    })
  }

  setLoop(loop: (dt: number) => void): void {
    this.onFrame = loop
  }

  resize(): Viewport {
    const ww = window.innerWidth
    const wh = window.innerHeight
    const sx = ww / WORLD_W
    const sy = wh / WORLD_H
    const fit = Math.min(sx, sy)
    const byWidth = sx <= sy
    const avail = byWidth ? ww : wh
    const logical = byWidth ? WORLD_W : WORLD_H
    const k = Math.floor(fit)
    const scale = k >= 1 && k * logical >= 0.85 * avail ? k : fit
    const w = Math.round(WORLD_W * scale)
    const h = Math.round(WORLD_H * scale)
    const x = Math.floor((ww - w) / 2)
    const y = Math.floor((wh - h) / 2)
    if (this.host) {
      this.host.style.left = `${x}px`
      this.host.style.top = `${y}px`
    }
    this.app.canvas.style.width = `${w}px`
    this.app.canvas.style.height = `${h}px`
    return { x, y, w, h, scale }
  }

  render(frame: RenderFrame, events: GameEvent[], dt: number): void {
    const art = this.art
    if (!art) return
    if (FLY_PEEK > 0) {
      if (this.flyHeld) return
      if (frame.projectiles.length) this.flyT += dt
      if (this.flyT >= FLY_PEEK) this.flyHeld = true
    }
    this.players = frame.players

    if (frame.matchId !== this.matchId || frame.terrainVersion < this.version) {
      if (this.matchId !== -1) this.reset()
      this.matchId = frame.matchId
    }
    if (frame.biome !== this.biome) this.setBiome(art, frame.biome)
    this.fx.setTerrain(frame.terrain)
    this.fx.wind = frame.wind

    const anim = frame.freeze ? 0 : dt
    for (const ev of events) this.onEvent(ev, frame)
    if (frame.freeze && !this.wasFrozen && FX_PEEK > 0) {
      for (let i = 0; i < Math.round(FX_PEEK * 60); i++) {
        this.fx.update(1 / 60, frame.wind)
        this.fx.decay(1 / 60)
      }
    }
    this.wasFrozen = frame.freeze

    const changed = frame.terrainVersion !== this.version
    this.version = frame.terrainVersion
    const pal = art.palette[frame.biome] ?? art.palette.forest
    if (this.painter.update(frame.terrain, art, pal, changed)) {
      this.backTex?.source.update()
      this.frontTex?.source.update()
    }

    this.trackShot(frame, anim)

    const stopped = this.fx.hitStop > 0
    const t0 = this.stats ? performance.now() : 0
    this.fx.update(anim, frame.wind)
    const step = stopped ? 0 : anim
    this.time += step
    if (anim > 0) this.fx.decay(anim)

    this.fx.draw(this.shotViews(frame))
    this.stats?.sample(this.fx.count, dt, performance.now() - t0, this.fx.trails)

    this.syncTanks(art, frame, step)
    this.extras.update(art, frame, step, this.time, (id) => this.tanks.get(id)?.dropOff ?? 0)
    this.syncProps(art, frame.props, frame.wind)
    this.syncLamps(frame.props)
    this.upload()
    this.syncArrows(art, frame)

    if (anim > 0) {
      const s = this.fx.shake
      if (s > 0.3) {
        this.shakeX = Math.round((this.rng.next() - 0.5) * 2 * s)
        this.shakeY = Math.round((this.rng.next() - 0.5) * 2 * s)
      } else {
        this.shakeX = 0
        this.shakeY = 0
      }
    }
    this.world.x = this.shakeX
    this.world.y = this.shakeY
    const n = this.bg.children.length
    this.bg.children.forEach((c, i) => {
      const f = i === 0 || n < 2 ? 0 : 0.15 + (0.55 * i) / (n - 1)
      c.x = Math.round(this.shakeX * f)
      c.y = Math.round(this.shakeY * f)
    })
    this.flashG.tint = this.fx.flashColor
    this.flashG.alpha = Math.min(0.95, this.fx.flash)
    this.glowG.tint = this.fx.glowColor
    this.glowG.alpha = 0.42 * this.fx.glow * this.fx.glow
  }

  private reset(): void {
    this.painter.reset()
    this.fx.reset()
    this.extras.reset()
    for (const v of this.tanks.values()) v.destroy()
    this.tanks.clear()
    for (const v of this.props.values()) v.destroy()
    this.props.clear()
    this.lampKey = ''
    this.lastShooter = null
    this.near.clear()
    this.hitThisShot.clear()
    this.impactSeen = false
    this.version = -1
    this.extras.startTransition()
  }

  private setBiome(art: Art, biome: Biome): void {
    this.biome = biome
    for (const c of this.bg.removeChildren()) c.destroy()
    const def = art.backgrounds[biome] ?? art.backgrounds.forest
    for (const t of def.layers) this.bg.addChild(new Sprite(t))
    this.app.renderer.background.color = def.fog
    this.fx.fog = def.fog
    this.painter.markDirty({ x0: 0, y0: 0, x1: WORLD_W, y1: WORLD_H })
  }

  private onEvent(ev: GameEvent, frame: RenderFrame): void {
    if (ev.type === 'round') {
      // mapa nuevo: los restos y cráteres de la ronda anterior no pasan
      this.reset()
      return
    }
    if (this.art) this.extras.onEvent(ev, frame, this.art)
    if (FX_TEST && ev.type === 'impact' && ev.source !== 'barrel') {
      const w = WEAPONS[FX_TEST]
      ev = { ...ev, blast: w.blast, radius: w.radius }
    }
    switch (ev.type) {
      case 'impact':
        if (ev.y > WORLD_H + 30 || ev.x < -60 || ev.x > WORLD_W + 60) return
        {
          // la excavadora cava en la dirección en que venía el proyectil más cercano
          let dir = { dx: 0, dy: 1 }
          let best = Infinity
          for (const t of this.trailLast) {
            const d = Math.hypot(t.x - ev.x, t.y - ev.y)
            if (d < best) {
              best = d
              dir = t
            }
          }
          this.fx.explosion(ev.blast, ev.x, ev.y, ev.radius, ev.debris, dir.dx, dir.dy)
        }
        if (SCORCH_STYLES.has(ev.blast)) this.painter.addCrater(ev.x, ev.y, ev.radius)
        this.impactSeen = true
        // el tanque más amenazado grita '!', los otros cercanos se preguntan '?'
        {
          const reach = ev.radius + THREAT_MARGIN
          const close = frame.players
            .filter((p) => p.alive)
            .map((p) => ({ p, d: Math.hypot(p.x - ev.x, p.y - TANK_H / 2 - ev.y) }))
            .filter((q) => q.d < reach)
            .sort((a, b) => a.d - b.d)
          close.forEach((q, i) => {
            const v = this.view(q.p.id)
            if (i === 0) v.alert = BUBBLE_TIME
            else v.ask = BUBBLE_TIME
          })
        }
        break
      case 'damage':
        this.hitThisShot.add(ev.playerId)
        this.view(ev.playerId).alert = BUBBLE_TIME
        break
      case 'death': {
        const p = frame.players.find((q) => q.id === ev.playerId)
        if (p) this.fx.explosion('fire', p.x, p.y - 6, 12, { 8: 30 })
        this.fx.wreck(ev.playerId)
        break
      }
      case 'fall': {
        const p = frame.players.find((q) => q.id === ev.playerId)
        if (ev.parachute) this.view(ev.playerId).startChute(ev.from - ev.to)
        else if (p) this.fx.dust(p.x, ev.to, 12, TANK_W)
        break
      }
      case 'prop':
        if (ev.destroyed) {
          const cols = ev.kind === 'barrel' ? [0xd0362c, 0x8e1e1a, 0x8a8a84] : DEBRIS_COLORS[4].concat(DEBRIS_COLORS[5])
          const prop = frame.props.find((q) => q.id === ev.propId)
          this.fx.splinters(ev.x + (prop ? prop.w / 2 : 0), ev.y + (prop ? prop.h / 2 : 0), cols, 14)
        }
        break
      case 'burn':
        this.fx.burn(ev.x, ev.y, ev.w)
        this.painter.addCrater(ev.x + ev.w / 2, ev.y, Math.max(3, ev.w / 2))
        break
    }
  }

  // La rodadora se reconoce enseguida; otro proyectil tiene que ir pegado al piso varios frames.
  private rolling(frame: RenderFrame, ground: number): boolean {
    const w = FX_TEST ?? frame.weapon ?? frame.players.find((q) => q.id === frame.shooterId)?.weapon
    return ground >= (w === 'roller' ? 2 : 8)
  }

  // Primera fila sólida a 0..6 px bajo el punto, o -1.
  private floorBelow(frame: RenderFrame, x: number, y: number): number {
    const t = frame.terrain
    const xi = Math.round(x)
    if (xi < 0 || xi >= t.w) return -1
    for (let yy = Math.max(0, Math.round(y) - 1); yy <= Math.round(y) + 6 && yy < t.h; yy++) if (t.front[yy * t.w + xi] !== 0) return yy
    return -1
  }

  private shotViews(frame: RenderFrame): ShotView[] {
    const out = this.shots
    out.length = 0
    const shooter = frame.players.find((q) => q.id === frame.shooterId)
    const weapon = FX_TEST ?? frame.weapon ?? shooter?.weapon
    const n = frame.projectiles.length
    frame.projectiles.forEach((p, i) => {
      if (p.y < -4) return
      const st = this.trailLast.length === n ? this.trailLast[i] : undefined
      if (st && this.rolling(frame, st.ground)) {
        const floor = this.floorBelow(frame, p.x, p.y)
        out.push({ x: p.x, y: (floor >= 0 ? floor : p.y) - 4, kind: 'roll', spin: st.spin })
      } else if (weapon === 'nuke') out.push({ x: p.x, y: p.y, kind: 'nuke' })
      else if (weapon === 'cluster' && n > 1) out.push({ x: p.x, y: p.y, kind: 'bomblet' })
      else out.push({ x: p.x, y: p.y, kind: 'shell' })
    })
    return out
  }

  private view(id: number): TankView {
    let v = this.tanks.get(id)
    if (!v) {
      v = new TankView()
      this.tanks.set(id, v)
      this.tankLayer.addChild(v.root)
      this.overlayLayer.addChild(v.overlay)
    }
    return v
  }

  // Retroceso, humo del cañón, estela y "?" por tiro que pasa cerca.
  private trackShot(frame: RenderFrame, anim: number): void {
    const shooter = frame.shooterId
    if (shooter !== null && shooter !== this.lastShooter) {
      const p = frame.players.find((q) => q.id === shooter)
      if (p) {
        this.view(p.id).recoil = RECOIL_TIME
        const facing = p.angle > 90 ? -1 : 1
        const px = Math.round(p.x) + facing * PIVOT_X
        const py = Math.round(p.y) - PIVOT_Y
        const rad = (p.angle * Math.PI) / 180
        const dx = Math.cos(rad)
        const dy = -Math.sin(rad)
        this.fx.muzzle(px + dx * (BARREL_LEN + 1), py + dy * (BARREL_LEN + 1), dx, dy)
      }
      this.near.clear()
      this.hitThisShot.clear()
      this.impactSeen = false
    }
    this.lastShooter = shooter

    const proj = frame.projectiles
    for (const pr of proj) {
      for (const p of frame.players) {
        if (!p.alive || p.id === shooter) continue
        if (Math.hypot(pr.x - p.x, pr.y - (p.y - 12)) < NEAR_MISS) this.near.add(p.id)
      }
    }
    // estela por distancia recorrida (no por frame): arco punteado parejo aunque baje el framerate
    if (anim > 0 && proj.length) {
      if (proj.length > this.shotCount && proj.length > 1) {
        // racimo: se abre en el apogeo
        const cx = proj.reduce((a, p) => a + p.x, 0) / proj.length
        const cy = proj.reduce((a, p) => a + p.y, 0) / proj.length
        if (cy > -10) this.fx.pop(cx, cy)
      }
      if (this.trailLast.length !== proj.length) this.trailLast = proj.map((p) => ({ x: p.x, y: p.y, acc: 0, dx: 0, dy: 1, ground: 0, spin: 0 }))
      proj.forEach((pr, i) => {
        const last = this.trailLast[i]
        const dx = pr.x - last.x
        const dy = pr.y - last.y
        const d = Math.hypot(dx, dy)
        // rodadora: pegada al piso y avanzando de costado, deja polvo en vez de estela
        const floor = this.floorBelow(frame, pr.x, pr.y)
        const touching = floor >= 0 && d < 60
        const was = this.rolling(frame, last.ground)
        if (touching && (was || Math.abs(dx) >= Math.abs(dy) * 0.6)) last.ground = Math.min(8, last.ground + 1)
        else last.ground = was && !touching ? Math.max(0, last.ground - 3) : 0
        if (this.rolling(frame, last.ground)) {
          last.spin += dx / 3.5
          last.acc += d
          while (last.acc >= 3) {
            last.acc -= 3
            this.fx.rollDust(pr.x, floor - 4, Math.sign(dx) || 1)
          }
          last.x = pr.x
          last.y = pr.y
          last.dx = d > 0.01 ? dx / d : last.dx
          last.dy = d > 0.01 ? dy / d : last.dy
          return
        }
        if (d > 0.01 && d <= 60) {
          last.dx = dx / d
          last.dy = dy / d
        }
        if (d > 60) last.acc = 0
        else {
          let s = TRAIL_STEP - last.acc
          for (; s <= d; s += TRAIL_STEP) {
            const y = last.y + (dy * s) / d
            if (y > -20) this.fx.trailPoint(last.x + (dx * s) / d, y)
          }
          last.acc = d - (s - TRAIL_STEP)
        }
        last.x = pr.x
        last.y = pr.y
      })
    } else if (!proj.length) this.trailLast = []
    if (anim > 0 || !proj.length) this.shotCount = proj.length
    if (proj.length === 0 && this.impactSeen) {
      for (const id of this.near) if (!this.hitThisShot.has(id)) this.view(id).ask = BUBBLE_TIME
      this.near.clear()
      this.hitThisShot.clear()
      this.impactSeen = false
    }
  }

  private syncTanks(art: Art, frame: RenderFrame, dt: number): void {
    const seen = new Set<number>()
    const currentId = frame.players[frame.current]?.id
    for (const p of frame.players) {
      seen.add(p.id)
      const v = this.view(p.id)
      v.recoil = Math.max(0, v.recoil - dt)
      // un globo tapado por la explosión no gasta su tiempo hasta que se despeja
      const hold = v.held && v.heldFor < BUBBLE_HOLD
      v.heldFor = v.held ? v.heldFor + dt : 0
      if (!hold) {
        v.alert = Math.max(0, v.alert - dt)
        v.ask = Math.max(0, v.ask - dt)
      }
      v.overlay.visible = true
      v.stepChute(dt, p.alive)
      if (v.landed) {
        v.landed = false
        this.fx.dust(p.x, p.y, 8, TANK_W)
      }
      v.update(art, p, p.id === currentId, this.time, frame.wind, this.blocked, frame.terrain)
      // polvo de las orugas: una bocanada cada pocos pixels, desde la cola del tanque
      if (v.moved !== 0 && dt > 0) {
        v.dustAcc += Math.abs(v.moved)
        const dir = Math.sign(v.moved)
        for (; v.dustAcc >= 3; v.dustAcc -= 3) this.fx.treadDust(p.x - dir * (TANK_W / 2 - 2), p.y, -dir)
      }
      if (!p.alive) this.fx.wreck(p.id)
    }
    for (const [id, v] of this.tanks) {
      if (!seen.has(id)) {
        v.root.visible = false
        v.overlay.visible = false
      }
    }
  }

  private syncProps(art: Art, props: Prop[], wind: number): void {
    const seen = new Set<number>()
    for (const p of props) {
      seen.add(p.id)
      let v = this.props.get(p.id)
      if (!v) {
        v = new PropView(p)
        this.props.set(p.id, v)
        this.propLayer.addChild(v.root)
      }
      v.update(art, p, this.time, wind)
    }
    for (const [id, v] of this.props) {
      if (!seen.has(id)) {
        v.destroy()
        this.props.delete(id)
      }
    }
  }

  // Luz fija de los focos: solo se repinta si cambian.
  private syncLamps(props: Prop[]): void {
    const lamps = props.filter((p) => p.kind === 'lamp' && p.alive)
    const key = lamps.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')
    if (key === this.lampKey) return
    this.lampKey = key
    this.lamps.clear()
    for (const p of lamps) this.lamps.light(p.x + p.w / 2, p.y + p.h + 2, 34, 0xffb04a, 0.55)
    this.lamps.flush()
    this.lampTex?.source.update()
    this.lampSprite.visible = lamps.length > 0
  }

  private upload(): void {
    const fx = this.fx.fx
    if (fx.dirty || this.fxShown) {
      fx.flush()
      this.fxTex?.source.update()
    }
    this.fxShown = fx.dirty
    this.fxSprite.visible = fx.dirty
    const light = this.fx.light
    if (light.dirty || this.lightShown) {
      light.flush()
      this.lightTex?.source.update()
    }
    this.lightShown = light.dirty
    this.lightSprite.visible = light.dirty
  }

  private syncArrows(art: Art, frame: RenderFrame): void {
    const off = frame.projectiles.filter((p) => p.y < 0 && p.x > -20 && p.x < WORLD_W + 20)
    while (this.arrows.length < off.length) {
      const s = new Sprite(art.arrow)
      this.arrows.push(s)
      this.arrowLayer.addChild(s)
    }
    this.arrows.forEach((s, i) => {
      const p = off[i]
      s.visible = !!p
      if (!p) return
      const w = s.texture.width
      s.x = Math.max(2, Math.min(WORLD_W - w - 2, Math.round(p.x - w / 2)))
      s.y = 2 + (Math.floor(this.time * 6) % 2)
    })
  }
}

