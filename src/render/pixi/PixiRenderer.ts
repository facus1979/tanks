import { Application, Container, Graphics, Sprite, Texture, TextureStyle } from 'pixi.js'
import type { Biome, GameEvent, Player, Prop, Vec2, WeaponId } from '../../sim/types'
import { PATH_DT, muzzle, tankTilt } from '../../sim'
import { TANK_H, TANK_W, WEAPONS } from '../../sim/types'
import type { Terrain } from '../../sim/types'
import type { GameRenderer, RenderFrame, Viewport } from '../types'
import { VIEW_H, VIEW_W } from '../types'
import { AbyssFalls } from './abyss'
import { ArmasFx } from './armas'
import { CollapseView } from './collapse'
import type { Part } from './abyss'
import { BUBBLE_HOLD, BUBBLE_TIME, PropView, RECOIL_TIME, TankView } from './actors'
import type { Art } from './assets'
import { loadArt } from './assets'
import { DEBRIS_COLORS } from './fallback'
import type { ShotView } from './fx'
import { Extras } from './extras'
import { Fx } from './fx'
import { LavaView } from './lava'
import { LiquidView, solidCell } from './liquids'
import { LootKit, LootProp, isLootKind } from './loot'
import { SnowView } from './snow'
import { DMG_BIG, DMG_COLOR, DMG_LAVA, DMG_SHIELD, DamageNumbers } from './numbers'
import { Raster, Rng } from './raster'
import { installRasterUpload } from './gpu'
import { QualityGovernor } from './quality'
import { CHUNK_W, TerrainPainter } from './terrain'
import type { Rect } from './terrain'

const SCORCH_STYLES = new Set(['fire', 'bigfire', 'napalm', 'nuke', 'spark', 'laser', 'acid']) // v3: rebotadora, mina, láser y ácido también chamuscan
const NEAR_MISS = 40
const THREAT_MARGIN = 70
const TRAIL_STEP = 7 // px entre puntos de la estela
// Buffers de efectos y luces: la pantalla más un margen (el origen se redondea a múltiplos de 4 con zoom 1).
const BUF_W = VIEW_W + 8
const BUF_H = VIEW_H + 8
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
// Margen (px de mundo) alrededor de la vista para pintar trozos de terreno: cubre el sacudón.
const CULL_MARGIN = 48
// Parallax: el cielo casi quieto; las capas siguientes de 0,15 a 0,7 de la velocidad del terreno.
const SKY_PARALLAX = 0.04
// v2.3: segundos que el "!" de RenderFrame.alerts sigue a la vista después de que el id sale de la lista
const ALERT_LINGER = 0.3
const LAMP_R = 34
const LAMP_TEX = 72 // lado de la textura de luz de un foco (radio 34 más el corrimiento de la trama)
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
  private warmG = new Graphics() // v2: tinte cálido de toda la pantalla con la lava alta
  private lava = new LavaView()
  // v4: superficie animada del agua y la lava material, resplandor de los pozos y efectos de entrada
  private liquids = new LiquidView()
  private numbers = new DamageNumbers()
  // v3: tanques que se perdieron en el abismo (los dibuja AbyssFalls mientras caen)
  private lost = new Set<number>()
  private lastAlive = new Map<number, { x: number; y: number }>()

  private painter: TerrainPainter | null = null
  private backLayer = new Container()
  private frontLayer = new Container()
  private backChunks: Sprite[] = []
  private frontChunks: Sprite[] = []
  private liquidLayer = new Container() // v4: cuerpo de los líquidos, encima de los tanques
  private liquidChunks: Sprite[] = []
  // v4: flujo en curso (evento 'flow'): rectángulo que tocan sus parches y segundos que le quedan
  private flowRect: Rect | null = null
  private flowLeft = 0
  private flowNew = false // el frame en que llega el evento el diff es completo (puede haber otros cambios)
  // v2.4: derrumbes en curso (evento 'collapse'): polvo de los bordes, piedritas y nube al asentarse
  private collapse = new CollapseView()
  // v3 nieve: nevada, niebla fría, brillos del hielo, aliento y patinazos; y el botín y los objetivos pagos
  private snow = new SnowView()
  private loot = new LootKit()

  private fx = new Fx(BUF_W, BUF_H)
  private extras = new Extras(this.fx)
  // v3: lo que cae al abismo (tanques, tripulantes, utilería)
  private abyss = new AbyssFalls(this.fx, () => this.painter?.pits ?? null)
  // v3 (render-armas): armas e ítems nuevos, minas y charcos, carteles de bonos (ver armas.ts)
  private armas = new ArmasFx(this.fx, (x, y, r) => this.painter?.addCrater(x, y, r))
  private fxSprite = new Sprite()
  private quality = new QualityGovernor()

  private lampLayer = new Container()
  private lampTex = new Map<string, Texture>()
  private lampKey = ''

  private bgLayers: { tex: Texture; wrap: boolean; holder: Container; tiles: Sprite[] }[] = []
  // Cámara aplicada en el último frame, sin sacudón: el origen del mundo cae en (camX, camY) de la pantalla lógica.
  private camX = 0
  private camY = 0
  private camZ = 1

  private tanks = new Map<number, TankView>()
  private props = new Map<number, PropView | LootProp>()
  private arrows: Sprite[] = []

  private biome: Biome | null = null
  private version = -1
  private matchId = -1
  private time = 0
  private rng = new Rng(7)
  private players: Player[] = []
  private lastShooter: number | null = null
  private near = new Set<number>()
  private alerted = new Set<number>() // v2.3: ids que estaban en RenderFrame.alerts el frame anterior
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
  private lastTerrain: Terrain | null = null
  private stats: FxStats | null = FX_STATS ? new FxStats() : null
  private blocked = (x: number, y: number, w: number, h: number): boolean => this.fx.blocks(x, y, w, h)

  async mount(host: HTMLElement): Promise<void> {
    this.host = host
    TextureStyle.defaultOptions.scaleMode = 'nearest'
    await this.app.init({
      width: VIEW_W,
      height: VIEW_H,
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
    await this.loot.load()
    this.loot.dust = (x, y, n, w) => {
      if (this.painter && this.lastTerrain && this.snow.landing(this.lastTerrain, x, y, n)) return
      this.fx.dust(x, y, n, w)
    }

    installRasterUpload(this.app.renderer)
    // v3: fx se sube directo desde sus bytes y las luces son sprites aditivos (fx.light.root)
    this.fxSprite.texture = this.fx.fxTexture
    this.fxSprite.visible = false

    this.flashG.rect(0, 0, VIEW_W, VIEW_H).fill(0xffffff)
    this.flashG.alpha = 0
    this.glowG.rect(0, 0, VIEW_W, VIEW_H).fill(0xffffff)
    this.glowG.blendMode = 'add'
    this.glowG.alpha = 0
    this.warmG.rect(0, 0, VIEW_W, VIEW_H).fill(0xff6a20)
    this.warmG.alpha = 0
    this.warmG.visible = false
    this.world.addChild(
      this.snow.mist,
      this.backLayer,
      this.propLayer,
      this.lampLayer,
      this.abyss.layer,
      this.frontLayer,
      this.snow.surface,
      this.armas.under.root,
      this.tankLayer,
      this.liquidLayer,
      this.liquids.layer,
      this.liquids.glowLayer,
      this.lava.glowLayer,
      this.lava.layer,
      this.fx.light.root,
      this.fxSprite,
      this.armas.glow.root,
      this.armas.over.root,
      this.extras.layer,
      this.loot.overlay,
      this.numbers.root,
      this.armas.signs.root,
      this.overlayLayer,
    )
    this.app.stage.addChild(this.bg, this.snow.behind, this.world, this.snow.ahead, this.warmG, this.glowG, this.arrowLayer, this.flashG, this.extras.curtain)
    this.fx.wreckPos = (id) => {
      const p = this.players.find((q) => q.id === id)
      return p && !p.alive && !this.lost.has(id) ? { x: Math.round(p.x), y: Math.round(p.y) } : null
    }
    this.extras.isLost = (id) => this.lost.has(id)
    this.extras.darkAt = (x, y) => (this.painter ? this.painter.pits.dark(x, y, this.painter.h) : 0)
    this.app.ticker.add((ticker) => {
      this.onFrame?.(Math.min(0.05, ticker.deltaMS / 1000))
    })
  }

  setLoop(loop: (dt: number) => void): void {
    this.onFrame = loop
  }

  // Ventana → pantalla lógica → mundo, con la cámara del último frame (sin sacudón).
  screenToWorld(clientX: number, clientY: number): Vec2 {
    const r = this.app.canvas.getBoundingClientRect()
    const lx = ((clientX - r.left) / (r.width || 1)) * VIEW_W
    const ly = ((clientY - r.top) / (r.height || 1)) * VIEW_H
    return { x: (lx - this.camX) / this.camZ, y: (ly - this.camY) / this.camZ }
  }

  resize(): Viewport {
    const ww = window.innerWidth
    const wh = window.innerHeight
    const sx = ww / VIEW_W
    const sy = wh / VIEW_H
    const fit = Math.min(sx, sy)
    const byWidth = sx <= sy
    const avail = byWidth ? ww : wh
    const logical = byWidth ? VIEW_W : VIEW_H
    const k = Math.floor(fit)
    const scale = k >= 1 && k * logical >= 0.85 * avail ? k : fit
    const w = Math.round(VIEW_W * scale)
    const h = Math.round(VIEW_H * scale)
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
    this.lastTerrain = frame.terrain

    if (frame.matchId !== this.matchId || frame.terrainVersion < this.version) {
      if (this.matchId !== -1) this.reset()
      this.matchId = frame.matchId
    }
    const painter = this.ensurePainter(frame.terrain)
    if (frame.biome !== this.biome) this.setBiome(art, frame.biome)
    painter.fog = this.fx.fog
    this.applyCamera(frame)
    this.fx.setTerrain(frame.terrain)
    this.liquids.setTerrain(frame.terrain)
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
    {
      const x0 = -this.camX / this.camZ - CULL_MARGIN
      const x1 = x0 + VIEW_W / this.camZ + 2 * CULL_MARGIN
      if (this.flowLeft > 0) {
        this.flowLeft -= dt
        if (this.flowLeft <= 0) this.flowRect = null
      }
      const list = painter.update(frame.terrain, art, pal, changed, x0, x1, this.flowNew ? null : this.flowRect)
      this.flowNew = false
      // v2.4: el derrumbe mira lo que cambió en su zona (antes del update de fx: las partículas nuevas ya se mueven)
      this.collapse.update(this.fx, frame.terrain, changed, frame.freeze || this.fx.hitStop > 0 ? 0 : dt, (x, y) => this.liquids.plunge(this.fx, x, y))
      for (const i of list) {
        if (painter.bfFlushed[i]) {
          this.backChunks[i].texture.source.update()
          this.frontChunks[i].texture.source.update()
        }
        if (painter.liqFlushed[i]) this.liquidChunks[i].texture.source.update()
      }
    }

    this.trackShot(frame, anim)

    // v3: calidad automática de efectos (quality.ts; ?quality=low|high la fija)
    this.fx.quality = this.quality.sample()
    const stopped = this.fx.hitStop > 0
    const t0 = this.stats ? performance.now() : 0
    this.fx.update(anim, frame.wind)
    const step = stopped ? 0 : anim
    this.time += step
    if (anim > 0) this.fx.decay(anim)

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
    this.placeWorld()
    this.updateLava(frame, step, events)
    this.updateLiquids(frame, step, events)
    {
      // v3: nieve (nevada, niebla, brillos, partículas) sobre la vista con sacudón
      const z = this.camZ
      const wx = this.camX + this.shakeX
      const wy = this.camY + this.shakeY
      const x0 = -wx / z
      const y0 = -wy / z
      this.snow.update(frame.terrain, frame.players, changed, step, frame.wind, wx, wy, x0, x0 + VIEW_W / z, y0, y0 + VIEW_H / z, art.crewInBody)
    }

    this.fx.draw(this.shotViews(frame))
    this.stats?.sample(this.fx.count, dt, performance.now() - t0, `${this.fx.trails} · calidad ${this.quality.level}`)

    this.abyss.update(frame.terrain, step)
    this.syncTanks(art, frame, step)
    this.extras.update(art, frame, step, this.time, (id) => this.tanks.get(id)?.dropOff ?? 0)
    this.numbers.font = art.font
    this.numbers.update(step)
    this.loot.dt = step
    this.loot.time = this.time
    this.loot.viewTop = this.viewTop
    this.loot.biome = frame.biome
    this.loot.terrain = frame.terrain
    {
      const z = this.camZ
      const vx0 = -(this.camX + this.shakeX) / z
      this.armas.font = art.font
      this.armas.update(frame, step, this.shotWeapon(frame), { x0: vx0, x1: vx0 + VIEW_W / z })
    }
    this.syncProps(art, frame.props, frame.wind)
    this.loot.endFrame()
    this.syncLamps(frame.props)
    this.upload()
    this.syncArrows(art, frame)
    this.placeBackground(frame.terrain)
    this.flashG.tint = this.fx.flashColor
    this.flashG.alpha = Math.min(0.95, this.fx.flash)
    this.glowG.tint = this.fx.glowColor
    this.glowG.alpha = 0.42 * this.fx.glow * this.fx.glow
  }

  // v2: lava de muerte súbita sobre el rectángulo visible (con sacudón), proyectiles derretidos y tinte cálido.
  private updateLava(frame: RenderFrame, dt: number, events: GameEvent[]): void {
    const t = frame.terrain
    const z = this.camZ
    const x0 = -(this.camX + this.shakeX) / z
    const y0 = -(this.camY + this.shakeY) / z
    this.lava.update(this.fx, frame.lava, dt, frame.wind, t.w, t.h, x0, x0 + VIEW_W / z, y0, y0 + VIEW_H / z)
    this.fx.lavaY = this.lava.level
    const impacts: Vec2[] = []
    for (const ev of events) if (ev.type === 'impact') impacts.push(ev)
    this.lava.trackShots(this.fx, frame.projectiles, impacts, t.w)
    // tinte: arranca cuando la lava pasó un cuarto del alto del mapa y llega al máximo a tres cuartos
    const L = this.lava.level
    const high = L === null ? 0 : Math.max(0, Math.min(1, ((t.h - L) / t.h - 0.25) / 0.5))
    this.warmG.visible = high > 0
    this.warmG.alpha = high * (0.07 + 0.01 * Math.sin(this.time * 2.3))
  }

  // v4: superficie animada de los líquidos visibles, salpicaduras de proyectiles, tanques en la lava y
  // espuma o chispas en el frente de un flujo.
  private updateLiquids(frame: RenderFrame, dt: number, events: GameEvent[]): void {
    const p = this.painter
    if (!p) return
    const t = frame.terrain
    const z = this.camZ
    const x0 = -(this.camX + this.shakeX) / z
    const y0 = -(this.camY + this.shakeY) / z
    const x1 = x0 + VIEW_W / z
    const y1 = y0 + VIEW_H / z
    // pulido v2: piedra recién enfriada (vapor un rato y grietas que se apagan)
    if (p.cooledFresh.length) this.liquids.cool(p.cooledFresh)
    this.liquids.vent(this.fx, dt)
    if (!p.liqChunk.some((v) => v === 1)) {
      this.liquids.idle()
      return
    }
    this.liquids.update(t, p.surfStamp, CHUNK_W, (i) => p.surfaces[i] ?? null, () => p.lavaSurfaces(t), dt, frame.wind, x0, x1, y0, y1)
    // v2.4: salpicaduras exactas del flujo (RenderFrame.splashes); sin ellas, LiquidView las detecta comparando
    // la posición del proyectil con la grilla (respaldo)
    const exact = frame.splashes !== undefined
    if (exact && dt > 0) for (const s of frame.splashes!) this.liquids.splashAt(this.fx, s.x, s.y)
    const impacts: Vec2[] = []
    for (const ev of events) if (ev.type === 'impact') impacts.push(ev)
    this.liquids.trackShots(this.fx, frame.projectiles, impacts, this.lava.level, exact)
    this.liquids.tanks(this.fx, frame.players, dt)
    if (dt > 0 && p.fresh.length) this.liquids.flowFront(this.fx, p.fresh, x0, x1, y0, y1)
  }

  private reset(): void {
    this.numbers.clear()
    this.lava.reset()
    this.liquids.reset()
    this.flowRect = null
    this.flowLeft = 0
    this.collapse.reset()
    this.snow.reset()
    this.loot.reset()
    this.abyss.reset()
    this.lost.clear()
    this.lastAlive.clear()
    this.painter?.reset()
    this.fx.reset()
    this.extras.reset()
    this.armas.reset()
    for (const v of this.tanks.values()) v.destroy()
    this.tanks.clear()
    for (const v of this.props.values()) v.destroy()
    this.props.clear()
    this.lampKey = ''
    for (const c of this.lampLayer.removeChildren()) c.destroy()
    this.lastShooter = null
    this.near.clear()
    this.alerted.clear()
    this.hitThisShot.clear()
    this.impactSeen = false
    this.version = -1
    this.extras.startTransition()
  }

  private setBiome(art: Art, biome: Biome): void {
    this.biome = biome
    for (const c of this.bg.removeChildren()) c.destroy({ children: true })
    const def = art.backgrounds[biome] ?? art.backgrounds.forest
    this.bgLayers = def.layers.map((tex, i) => {
      const holder = new Container()
      this.bg.addChild(holder)
      return { tex, wrap: def.wrap?.[i] ?? false, holder, tiles: [] }
    })
    this.app.renderer.background.color = def.fog
    this.fx.fog = def.fog
    this.snow.setBiome(biome)
    const p = this.painter
    if (p) {
      p.snowy = biome === 'snow'
      p.markDirty({ x0: 0, y0: 0, x1: p.w, y1: p.h })
    }
  }

  // Pintor y trozos del terreno del tamaño del mundo de esta partida (se rehacen si cambia el tamaño).
  private ensurePainter(t: Terrain): TerrainPainter {
    const old = this.painter
    if (old && old.w === t.w && old.h === t.h) return old
    for (const s of this.backChunks.concat(this.frontChunks, this.liquidChunks)) s.destroy({ texture: true, textureSource: true })
    const p = new TerrainPainter(t.w, t.h)
    if (old) p.craters = old.craters
    p.snowy = this.biome === 'snow'
    const make = (c: { x0: number; texture: Texture }): Sprite => {
      const s = new Sprite(c.texture)
      s.x = c.x0
      return s
    }
    this.backChunks = p.back.chunks.map(make)
    this.frontChunks = p.front.chunks.map(make)
    this.liquidChunks = p.liquid.chunks.map(make)
    for (const s of this.liquidChunks) s.visible = false
    this.backLayer.addChild(...this.backChunks)
    this.frontLayer.addChild(...this.frontChunks)
    this.liquidLayer.addChild(...this.liquidChunks)
    this.painter = p
    this.version = -1
    return p
  }

  // Cámara del frame sin sacudón. El origen del mundo cae siempre en un pixel entero de la pantalla lógica.
  private applyCamera(frame: RenderFrame): void {
    const cam = frame.camera
    const t = frame.terrain
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam && Number.isFinite(cam.zoom) ? cam.zoom : 1))
    const cx = cam && Number.isFinite(cam.cx) ? cam.cx : t.w / 2
    const cy = cam && Number.isFinite(cam.cy) ? cam.cy : t.h / 2
    this.camZ = z
    this.camX = Math.round(VIEW_W / 2 - cx * z)
    this.camY = Math.round(VIEW_H / 2 - cy * z)
  }

  // Ubica el mundo (cámara + sacudón) y los buffers de efectos sobre lo visible, y oculta los trozos fuera de la vista.
  private placeWorld(): void {
    const z = this.camZ
    const wx = this.camX + this.shakeX
    const wy = this.camY + this.shakeY
    this.world.position.set(wx, wy)
    this.world.scale.set(z)
    let ox = -wx / z
    let oy = -wy / z
    if (z === 1) {
      // múltiplos de 4: la trama de Bayer de los efectos queda fija al mundo, igual que en v1
      ox = Math.floor(ox / 4) * 4
      oy = Math.floor(oy / 4) * 4
    }
    this.fx.setView(ox, oy, z)
    for (const s of [this.fxSprite, this.fx.light.root]) {
      s.position.set(ox, oy)
      s.scale.set(1 / z)
    }
    const x0 = -wx / z - 1
    const x1 = x0 + VIEW_W / z + 2
    for (let i = 0; i < this.backChunks.length; i++) {
      const b = this.backChunks[i]
      const vis = b.x < x1 && b.x + b.texture.width > x0
      b.visible = vis
      this.frontChunks[i].visible = vis
      this.liquidChunks[i].visible = vis && this.painter?.liqChunk[i] === 1
    }
  }

  // Capas del fondo repetidas a lo ancho y con parallax. Por capa (v2.3, repeat del manifiesto): 'mirror'
  // alterna la capa con su copia espejada (sin costuras aunque la capa no sea periódica); 'wrap' pone la
  // misma capa una al lado de la otra (la capa empalma sola). En ambos casos
  // cada capa se corre una fracción f del movimiento del terreno, se achica con el zoom en esa proporción
  // y se apoya entre el pie de la pantalla (f = 0) y el pie del mundo (f = 1).
  private placeBackground(t: Terrain): void {
    const n = this.bgLayers.length
    const z = this.camZ
    const footWorld = this.camY + t.h * z
    this.bgLayers.forEach((L, i) => {
      const f = i === 0 || n < 2 ? SKY_PARALLAX : 0.15 + (0.55 * i) / (n - 1)
      const fs = i === 0 || n < 2 ? 0 : f // el cielo no se sacude (como en v1)
      const s = 1 + (z - 1) * f
      const tw = L.tex.width * s
      const th = L.tex.height * s
      let scroll = -this.camX * f
      let foot = VIEW_H + (footWorld - VIEW_H) * f
      if (s === 1) {
        scroll = Math.round(scroll)
        foot = Math.round(foot)
      }
      const first = Math.floor(scroll / tw)
      const startX = first * tw - scroll + Math.round(this.shakeX * fs)
      const y = foot - th + Math.round(this.shakeY * fs)
      const need = Math.max(1, Math.ceil((VIEW_W - startX) / tw))
      while (L.tiles.length < need) {
        const sp = new Sprite(L.tex)
        L.tiles.push(sp)
        L.holder.addChild(sp)
      }
      L.tiles.forEach((sp, k) => {
        sp.visible = k < need
        if (k >= need) return
        const mirrored = !L.wrap && ((first + k) & 1) === 1
        const x = startX + k * tw
        sp.scale.set(mirrored ? -s : s, s)
        sp.position.set(mirrored ? x + tw : x, y)
      })
    })
  }

  private onEvent(ev: GameEvent, frame: RenderFrame): void {
    if (ev.type === 'round') {
      // mapa nuevo: los restos y cráteres de la ronda anterior no pasan
      this.reset()
      return
    }
    // v3: el tanque que cae al abismo se marca antes de que Extras eyecte al tripulante desde los restos
    if (ev.type === 'death' || ev.type === 'fall') this.checkAbyss(ev, frame)
    this.snow.onEvent(ev, frame.terrain)
    if (this.art) this.extras.onEvent(ev, frame, this.art)
    if (FX_TEST && ev.type === 'impact' && ev.source !== 'barrel') {
      const w = WEAPONS[FX_TEST]
      ev = { ...ev, blast: w.blast, radius: w.radius }
    }
    this.armas.onEvent(ev, frame) // v3: beam, quake, pull, hazard, deflect, jetpack, teleport, bonus
    switch (ev.type) {
      case 'impact':
        if (ev.y > frame.terrain.h + 30 || ev.x < -60 || ev.x > frame.terrain.w + 60) return
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
          // v4: bien sumergida, la explosión no hace fuego ni humo (fogonazo ahogado, burbujas y géiser).
          // v2.4: si el sim lo dice (impact.water) se usa eso; si no, se detecta con la grilla (respaldo).
          // (el evento 'impact' todavía no declara water en GameEvent: se lee si llega)
          const water = ev.water
          let wet: boolean
          if (water !== undefined) wet = water
          else {
            const sy = this.liquids.submerged(ev.x, ev.y)
            wet = sy >= 0 && ev.y - sy > ev.radius * 0.5
          }
          if (wet) this.fx.underwater(ev.x, ev.y, ev.radius)
          else if (!this.armas.blast(ev, dir.dx, dir.dy, frame)) this.fx.explosion(ev.blast, ev.x, ev.y, ev.radius, ev.debris, dir.dx, dir.dy)
        }
        if (SCORCH_STYLES.has(ev.blast) && ev.water !== true) this.painter?.addCrater(ev.x, ev.y, ev.radius)
        this.liquids.impact(this.fx, ev.x, ev.y, ev.radius, ev.water) // v4: burbujas y géiser si explotó bajo el agua
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
      case 'lava': {
        const z = this.camZ
        const x0 = -this.camX / z
        this.lava.rise(this.fx, Math.max(0, x0), Math.min(frame.terrain.w, x0 + VIEW_W / z), ev.from === null)
        break
      }
      case 'damage':
        if (ev.cause === 'lava') {
          const p = frame.players.find((q) => q.id === ev.playerId)
          // la banda de muerte súbita si el tanque está en ella; si no, la lava material (v4)
          const L = this.lava.level
          if (p && L !== null && p.y > L - 30) this.lava.burn(this.fx, p.x, p.y)
          else if (p) this.liquids.burn(this.fx, p.x, p.y)
        } else if (ev.cause === 'collapse') {
          // v2.4: aplastado por un derrumbe: polvo del material que cayó y chispas sobre el casco
          const p = frame.players.find((q) => q.id === ev.playerId)
          if (p) this.fx.crushed(p.x, p.y, this.collapse.materialNear(p.x))
        }
        this.hitThisShot.add(ev.playerId)
        this.view(ev.playerId).alert = BUBBLE_TIME
        {
          const p = frame.players.find((q) => q.id === ev.playerId)
          const color = ev.cause === 'lava' ? DMG_LAVA : ev.amount >= 30 ? DMG_BIG : DMG_COLOR
          if (p && ev.amount > 0) this.numbers.spawn(ev.playerId, p.x, p.y - TANK_H - 14, `-${ev.amount}`, color)
        }
        break
      case 'shield': {
        const p = frame.players.find((q) => q.id === ev.playerId)
        if (p && ev.absorbed > 0) this.numbers.spawn(ev.playerId, p.x, p.y - TANK_H - 14, `-${ev.absorbed}`, DMG_SHIELD)
        break
      }
      case 'death': {
        if (this.lost.has(ev.playerId)) break // se perdió en el abismo: sin explosión ni restos en llamas
        const p = frame.players.find((q) => q.id === ev.playerId)
        if (p) this.fx.explosion('fire', p.x, p.y - 6, 12, { 8: 30 })
        this.fx.wreck(ev.playerId)
        break
      }
      case 'fall': {
        if (this.lost.has(ev.playerId)) break
        const p = frame.players.find((q) => q.id === ev.playerId)
        if (ev.parachute) this.view(ev.playerId).startChute(ev.from - ev.to)
        else if (p && ev.water) this.liquids.tankSplash(this.fx, p.x, ev.to) // v4: cayó al agua
        else if (p && !this.snow.landing(frame.terrain, p.x, ev.to, 12)) this.fx.dust(p.x, ev.to, 12, TANK_W) // v3: en la nieve, polvo blanco
        break
      }
      case 'slide': {
        // pulido v2: la sesión mueve al tanque por el path; acá solo se anima (orugas, terrones, sacudón)
        if (ev.path.length < 2 || this.lost.has(ev.playerId)) break
        const dir = Math.sign(ev.path[ev.path.length - 1].x - ev.path[0].x) || 1
        this.view(ev.playerId).startSlide(ev.cause === 'blast' ? 'blast' : 'slope', ev.path.length * PATH_DT, dir) // v3 stub: ice/pull/quake como slope
        if (ev.cause === 'blast') this.fx.dust(ev.path[0].x, ev.path[0].y, 6, TANK_W)
        break
      }
      case 'steam':
        this.liquids.steam(this.fx, ev.x, ev.y, ev.n)
        break
      case 'collapse':
        // v2.4: igual que 'flow' para el diff del pintor; los efectos los arma CollapseView
        this.collapse.start(ev, frame.terrain)
        this.focusPatches(ev)
        break
      case 'flow':
        this.focusPatches(ev)
        break
      case 'prop':
        if (ev.destroyed && this.propToAbyss(ev, frame)) break
        if (ev.destroyed && this.loot.burst(ev, frame.props, this.fx)) break // v3: monedas, billetes y la explosión del objetivo
        if (ev.destroyed) {
          const cols = ev.kind === 'barrel' ? [0xd0362c, 0x8e1e1a, 0x8a8a84] : DEBRIS_COLORS[4].concat(DEBRIS_COLORS[5])
          const prop = frame.props.find((q) => q.id === ev.propId)
          this.fx.splinters(ev.x + (prop ? prop.w / 2 : 0), ev.y + (prop ? prop.h / 2 : 0), cols, 14)
        }
        break
      case 'burn':
        this.fx.burn(ev.x, ev.y, ev.w)
        this.painter?.addCrater(ev.x + ev.w / 2, ev.y, Math.max(3, ev.w / 2))
        break
    }
  }

  // Flujo o derrumbe: mientras se aplican los parches, el diff de la grilla mira solo lo que tocan.
  private focusPatches(ev: Extract<GameEvent, { type: 'flow' | 'collapse' }>): void {
    if (!ev.patches.length) return
    let r: Rect = this.flowRect ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    for (const q of ev.patches) r = { x0: Math.min(r.x0, q.x), y0: Math.min(r.y0, q.y), x1: Math.max(r.x1, q.x + q.w), y1: Math.max(r.y1, q.y + q.h) }
    this.flowRect = r
    this.flowNew = true
    // el evento llega en su t (cuando se aplica el primer parche): quedan patches.length · dt segundos
    this.flowLeft = Math.max(this.flowLeft, ev.patches.length * ev.dt + 0.5)
  }

  // v3: ¿este fall/death es un tanque que se pierde en el abismo? Si lo es, lo suelta (una sola vez).
  // Se reconoce por death.cause = 'abyss', o por una caída hasta el fondo del mapa en una columna de abismo.
  private checkAbyss(ev: Extract<GameEvent, { type: 'death' | 'fall' }>, frame: RenderFrame): void {
    const t = frame.terrain
    if (!t.pits || this.lost.has(ev.playerId)) return
    const p = frame.players.find((q) => q.id === ev.playerId)
    if (!p) return
    const last = this.lastAlive.get(p.id) ?? { x: p.x, y: Math.min(p.y, t.h - 1) }
    let fromY: number
    if (ev.type === 'fall') {
      if (ev.to < t.h - 1 || !t.pits[Math.max(0, Math.min(t.w - 1, Math.round(p.x)))]) return
      fromY = Math.min(ev.from, t.h - 1)
    } else {
      const pits = this.painter?.pits
      if (ev.cause !== 'abyss' && !(pits && pits.lost(t, last.x, last.y))) return
      fromY = Math.min(last.y, t.h - 1)
    }
    this.lost.add(p.id)
    const x = ev.type === 'fall' ? p.x : last.x
    this.dropTank(p, x, fromY)
  }

  private dropTank(p: Player, x: number, floorY: number): void {
    const art = this.art
    if (!art) return
    const t = this.painter
    const facing = p.angle > 90 ? -1 : 1
    const local = facing > 0 ? p.angle : 180 - p.angle
    const frames = art.barrels[p.id % 4]
    const idx = Math.max(0, Math.min(frames.length - 1, Math.round(local / 5)))
    const hx = TANK_W / 2
    const hy = TANK_H / 2
    const parts: Part[] = [
      { tex: frames[idx], x: art.pivotInBody.x - hx, y: art.pivotInBody.y - hy, pivot: art.barrelPivot },
      { tex: art.bodies[p.id % 4], x: -hx, y: -hy },
    ]
    // empuja hacia el centro del abismo y gira para ese lado
    let dir = 0
    if (t?.pits.inPit) {
      const inP = (xx: number): number => t.pits.inPit![Math.max(0, Math.min(t.w - 1, Math.round(xx)))]
      dir = inP(x + 12) - inP(x - 12)
    }
    if (dir === 0) dir = this.rng.next() < 0.5 ? -1 : 1
    const cy = floorY - hy
    this.abyss.drop(parts, x, cy, dir * (14 + this.rng.next() * 10), dir * (1.2 + this.rng.next()), true, facing < 0)
    this.fx.dust(x, floorY, 10, TANK_W)
    this.fx.dust(x - dir * 10, floorY, 4, 8)
    this.extras.eject(p, art, { x, y: cy - 10 })
    const v = this.tanks.get(p.id)
    if (v) {
      v.root.visible = false
      v.overlay.visible = false
    }
  }

  // v3: utilería destruida porque cayó al abismo: la misma imagen cae y se pierde, sin astillas.
  private propToAbyss(ev: Extract<GameEvent, { type: 'prop' }>, frame: RenderFrame): boolean {
    const t = frame.terrain
    if (!t.pits) return false
    const prop = frame.props.find((q) => q.id === ev.propId)
    const w = prop?.w ?? 10
    const h = prop?.h ?? 12
    const cx = Math.round(ev.x + w / 2)
    if (cx < 0 || cx >= t.w || !t.pits[cx]) return false
    const pits = this.painter?.pits
    if (!(ev.y + h >= t.h - 2 || (pits && pits.lost(t, cx, ev.y + h)))) return false
    const view = this.props.get(ev.propId)
    const snap = view?.snapshot() ?? []
    if (!snap.length) return true
    const x0 = Math.min(...snap.map((s) => s.x))
    const x1 = Math.max(...snap.map((s) => s.x + s.tex.width))
    const y0 = Math.min(...snap.map((s) => s.y))
    const y1 = Math.max(...snap.map((s) => s.y + s.tex.height))
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    const parts: Part[] = snap.map((s) => ({ tex: s.tex, x: s.flip ? s.x - mx + s.tex.width : s.x - mx, y: s.y - my, flip: s.flip }))
    const dir = this.rng.next() < 0.5 ? -1 : 1
    this.abyss.drop(parts, mx, my, dir * (6 + this.rng.next() * 10), dir * (1.5 + this.rng.next() * 2), false)
    this.fx.dust(mx, y1, 4, w)
    return true
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
    for (let yy = Math.max(0, Math.round(y) - 1); yy <= Math.round(y) + 6 && yy < t.h; yy++) if (solidCell(t.front[yy * t.w + xi])) return yy
    return -1
  }

  private shotViews(frame: RenderFrame): ShotView[] {
    const out = this.shots
    out.length = 0
    const weapon = this.shotWeapon(frame)
    // v3: los proyectiles de las armas nuevas los dibuja ArmasFx
    if (this.armas.ownsShot(weapon)) return out
    const n = frame.projectiles.length
    frame.projectiles.forEach((p, i) => {
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

  // Arma del tiro en curso (la de ?fxtest manda).
  private shotWeapon(frame: RenderFrame): WeaponId | null {
    return FX_TEST ?? frame.weapon ?? frame.players.find((q) => q.id === frame.shooterId)?.weapon ?? null
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
        // la boca del cañón inclinado, la misma de donde sale el tiro en el sim
        const m = muzzle(p.x, p.y, p.angle, tankTilt(frame.terrain, p.x, p.y))
        const rad = (p.angle * Math.PI) / 180
        const dx = Math.cos(rad)
        const dy = -Math.sin(rad)
        this.fx.muzzle(m.x + dx, m.y + dy, dx, dy)
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
        if (cy > this.viewTop - 10) this.fx.pop(cx, cy)
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
            const x = last.x + (dx * s) / d
            // v3: en la oscuridad del abismo el proyectil no deja estela clara
            // v4: bajo el agua tampoco: deja burbujitas
            const sy = this.liquids.surfaceAbove(x, y)
            if (sy >= 0) this.fx.bubbles(x, y, 1, sy, 1)
            else if (y > this.viewTop - 20 && !(this.painter && this.painter.pits.dark(x, y, this.painter.h) > 0.15)) this.fx.trailPoint(x, y)
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
    const alerts = frame.alerts ?? []
    for (const p of frame.players) {
      seen.add(p.id)
      const v = this.view(p.id)
      v.recoil = Math.max(0, v.recoil - dt)
      // v2.3: RenderFrame.alerts (lo llena el flujo; por ejemplo, frenado en el borde del abismo). Al entrar
      // en la lista el "!" aparece con su tiempo completo; mientras siga, no se apaga; al salir le queda
      // ALERT_LINGER (o lo que le quede de BUBBLE_TIME) y se va solo.
      const inAlerts = alerts.includes(p.id)
      if (inAlerts && !this.alerted.has(p.id)) v.alert = BUBBLE_TIME
      else if (inAlerts) v.alert = Math.max(v.alert, ALERT_LINGER)
      if (inAlerts) this.alerted.add(p.id)
      else this.alerted.delete(p.id)
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
        if (!this.snow.landing(frame.terrain, p.x, p.y, 8)) this.fx.dust(p.x, p.y, 8, TANK_W)
      }
      if (this.lost.has(p.id)) {
        // se perdió en el abismo: lo dibuja AbyssFalls mientras cae; acá no queda nada
        v.root.visible = false
        v.overlay.visible = false
        continue
      }
      if (p.alive && p.y < frame.terrain.h) this.lastAlive.set(p.id, { x: p.x, y: p.y })
      v.update(art, p, p.id === currentId, this.time, frame.wind, this.blocked, frame.terrain, dt)
      // v3: oruga sin tracción patinando en el hielo
      v.slip = this.snow.slip(p.id)
      // polvo de las orugas: una bocanada cada pocos pixels, desde la cola del tanque (v3: en nieve o hielo,
      // nieve en polvo o astillas de hielo de snow.ts)
      if (v.moved !== 0 && dt > 0 && !this.snow.tread(frame.terrain, p, v.moved, v.sliding, dt)) {
        v.dustAcc += Math.abs(v.moved)
        const dir = Math.sign(v.moved)
        if (v.sliding) {
          // pulido v2: deslizándose, terrones desde la oruga del lado de avance (y polvo atrás, más espaciado)
          const strong = v.slideCause === 'blast'
          for (; v.dustAcc >= 2; v.dustAcc -= 2) {
            this.fx.slideClods(p.x + dir * (TANK_W / 2 - 1), p.y, dir, strong)
            if (this.rng.next() < 0.35) this.fx.treadDust(p.x - dir * (TANK_W / 2 - 2), p.y, -dir)
          }
        } else for (; v.dustAcc >= 3; v.dustAcc -= 3) this.fx.treadDust(p.x - dir * (TANK_W / 2 - 2), p.y, -dir)
      }
      v.stepSlide(dt)
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
        v = isLootKind(p.kind) ? this.loot.make() : new PropView(p)
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

  // Fila de mundo del borde de arriba de la vista (sin sacudón).
  private get viewTop(): number {
    return -this.camY / this.camZ
  }

  // Luz fija de los focos: un sprite aditivo por foco, solo se rehacen si cambian. La textura depende de dónde
  // cae el centro respecto de la trama de Bayer (16 variantes): queda igual que pintada en un buffer del mundo.
  private syncLamps(props: Prop[]): void {
    const lamps = props.filter((p) => p.kind === 'lamp' && p.alive)
    const key = lamps.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')
    if (key === this.lampKey) return
    this.lampKey = key
    for (const c of this.lampLayer.removeChildren()) c.destroy()
    for (const p of lamps) {
      const cx = Math.round(p.x + p.w / 2)
      const cy = Math.round(p.y + p.h + 2)
      const bx = Math.floor((cx - LAMP_R) / 4) * 4
      const by = Math.floor((cy - LAMP_R) / 4) * 4
      const k = `${cx - bx},${cy - by}`
      let tex = this.lampTex.get(k)
      if (!tex) {
        const r = new Raster(LAMP_TEX, LAMP_TEX)
        r.light(cx - bx, cy - by, LAMP_R, 0xffb04a, 0.55)
        r.flush()
        tex = canvasTexture(r.canvas)
        this.lampTex.set(k, tex)
      }
      const s = new Sprite(tex)
      s.blendMode = 'add'
      s.position.set(bx, by)
      this.lampLayer.addChild(s)
    }
  }

  private upload(): void {
    this.fxSprite.visible = this.fx.present()
  }

  // Flecha en el borde de arriba de la pantalla por cada proyectil que sale por arriba de la vista.
  private syncArrows(art: Art, frame: RenderFrame): void {
    const z = this.camZ
    const off = frame.projectiles
      .map((p) => ({ x: this.camX + p.x * z, y: this.camY + p.y * z }))
      .filter((p) => p.y < 0 && p.x > -20 && p.x < VIEW_W + 20)
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
      s.x = Math.max(2, Math.min(VIEW_W - w - 2, Math.round(p.x - w / 2)))
      s.y = 2 + (Math.floor(this.time * 6) % 2)
    })
  }
}

