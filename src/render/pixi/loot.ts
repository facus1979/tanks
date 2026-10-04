// v3 recompensas (render): caja de botín (PropKind 'loot') y objetivos pagos ('target').
// - La caja que aparece en medio de la partida baja colgada del paracaídas (el mismo de los tanques) desde
//   arriba de la vista hasta su lugar; apoyada, titila y suelta destellos para que se note.
// - El objetivo lleva una moneda con "$" que flota encima y una mira en las esquinas que parpadea.
// - Al romperse: monedas que giran y rebotan, billetes que aletean, destellos; el objetivo además explota grande.
// Texturas: props.loot y props.target[bioma] del manifiesto si están; si no, las de respaldo de acá.
import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { Biome, GameEvent, Prop, Terrain } from '../../sim/types'
import { METAL } from '../../sim/types'
import type { Art } from './assets'
import { loadManifest, loadTexture } from './assets'
import { OUT } from './fallback'
import type { Fx } from './fx'
import { LIQ } from './liquids'
import { Motes } from './snow'
import { mix, mul, rnd } from './raster'

const CHUTE_SPEED = 42 // px/s, como el tanque
const CHUTE_FOLD = 0.3
const DROP_FROM = 200 // px por encima de su lugar como mucho
const FALL_SPEED = 160 // px/s de una caída sin paracaídas (se quedó sin apoyo)
const CHUTE_MIN = 24 // caídas más largas que esto abren el paracaídas (solo el botín)
const BLINK_EVERY = 1.1 // s entre titileos de la caja apoyada
const BLINK_LEN = 0.22
const GOLD = 0xf2c230
const GOLD_DARK = 0x9a6a14
const BILL = 0x6ab04c

export const isLootKind = (k: Prop['kind']): boolean => k === 'loot' || k === 'target'

// ---------- texturas de respaldo ----------

function canvas(w: number, h: number): { c: HTMLCanvasElement; put: (x: number, y: number, col: number) => void; done: () => Texture } {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  const put = (x: number, y: number, col: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    img.data[i] = (col >> 16) & 255
    img.data[i + 1] = (col >> 8) & 255
    img.data[i + 2] = col & 255
    img.data[i + 3] = 255
  }
  const done = (): Texture => {
    ctx.putImageData(img, 0, 0)
    const t = Texture.from(c)
    t.source.scaleMode = 'nearest'
    return t
  }
  return { c, put, done }
}

// Caja de botín 14×12: madera con esquinas de chapa y un fleje dorado con candado.
function lootFallback(): Texture {
  const w = 14
  const h = 12
  const { put, done } = canvas(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
      let c = y < 3 ? 0xa8845a : (x + (y >> 2)) % 4 === 0 ? 0x6e5236 : 0x8a6a44
      if (y === 3) c = 0x5a422c
      if ((x <= 2 || x >= w - 3) && (y <= 2 || y >= h - 3)) c = 0x8a8a84 // esquinas de chapa
      if (y === 6 || y === 7) c = y === 6 ? 0xffd64a : GOLD_DARK // fleje
      if (x >= 6 && x <= 7 && y >= 5 && y <= 8) c = y === 5 ? 0xfff0a0 : 0xe0a820 // candado
      put(x, y, edge ? OUT : c)
    }
  }
  return done()
}

// Objetivo 32×20 por bioma: camión de suministros (bosque, jungla) o tanque de combustible (industrial, nieve).
function targetFallback(biome: Biome): Texture {
  const w = 32
  const h = 20
  const { put, done } = canvas(w, h)
  const box = (x0: number, y0: number, x1: number, y1: number, fill: (x: number, y: number) => number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, x === x0 || x === x1 || y === y0 || y === y1 ? OUT : fill(x, y))
  }
  const wheel = (cx: number): void => {
    for (let y = 14; y < 20; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        const d = Math.hypot(x - cx, y - 16.5)
        if (d <= 3.2) put(x, y, d > 2.3 ? OUT : d < 1 ? 0x8a8a84 : 0x2a2622)
      }
    }
  }
  if (biome === 'forest' || biome === 'jungle') {
    const tarp = biome === 'jungle' ? 0x5a6a34 : 0x6a6440
    box(1, 2, 21, 15, (x, y) => (y < 5 ? mix(tarp, 0xffffff, 0.15) : (x % 5 === 0 ? mul(tarp, 0.75) : tarp)))
    box(22, 6, 30, 15, (x, y) => (y < 10 && x > 24 ? 0x9ab8c4 : y === 14 ? 0x3a3a24 : 0x4e5a30))
    box(4, 7, 12, 11, () => 0xe2dcc8) // cartel
    for (let x = 6; x <= 10; x++) put(x, 9, x % 2 ? 0xc8302a : 0xe2dcc8)
    wheel(6)
    wheel(17)
    wheel(26)
  } else {
    const body = biome === 'snow' ? 0xd8dcdc : 0xb8402a
    const stripe = biome === 'snow' ? 0xc8302a : 0xf0d040
    for (let y = 3; y <= 14; y++) {
      for (let x = 2; x <= 29; x++) {
        const ey = (y - 8.5) / 6
        const ex = x < 6 ? (6 - x) / 4 : x > 25 ? (x - 25) / 4 : 0
        const d = ex * ex + ey * ey
        if (d > 1) continue
        let c = d > 0.8 ? OUT : y < 6 ? mix(body, 0xffffff, 0.3) : y > 12 ? mul(body, 0.65) : body
        if (d <= 0.8 && (y === 8 || y === 9)) c = stripe
        put(x, y, c)
      }
    }
    // patas y válvula
    for (const lx of [7, 24]) for (let y = 15; y < 20; y++) put(lx, y, y === 19 ? OUT : 0x4a4a46)
    for (let y = 0; y < 3; y++) put(15, y, OUT)
    put(14, 0, OUT)
    put(16, 0, OUT)
  }
  return done()
}

// Moneda de 7×7 con una "S" cruzada (el "$" de los objetivos pagos).
function dollarTexture(): Texture {
  const { put, done } = canvas(7, 7)
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const d = Math.hypot(x - 3, y - 3)
      if (d > 3.4) continue
      put(x, y, d > 2.6 ? GOLD_DARK : x + y < 5 ? 0xffe680 : GOLD)
    }
  }
  const S = ['.##', '#..', '.#.', '..#', '##.']
  S.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && put(2 + x, 1 + y, 0x7a4a0c)))
  put(3, 0, 0x7a4a0c)
  put(3, 6, 0x7a4a0c)
  return done()
}

// ---------- kit compartido ----------

export class LootKit {
  readonly overlay = new Container() // mundo, encima del terreno: marcadores, titileo y monedas
  readonly motes = new Motes()
  private loot: Texture | null = null
  private targets: Partial<Record<Biome, Texture>> = {}
  private fallbackLoot: Texture | null = null
  private fallbackTargets: Partial<Record<Biome, Texture>> = {}
  private dollarTex: Texture | null = null
  biome: Biome = 'forest'
  dt = 0
  time = 0
  viewTop = 0
  firstSync = true // el primer sync de la partida: lo que ya está en el mapa no cae
  terrain: Terrain | null = null
  dust: (x: number, y: number, n: number, w: number) => void = () => {}

  constructor() {
    this.overlay.addChild(this.motes.layer)
    this.motes.solid = (x, y) => {
      const t = this.terrain
      if (!t) return false
      const xi = Math.round(x)
      const yi = Math.round(y)
      if (xi < 0 || yi < 0 || xi >= t.w || yi >= t.h) return false
      const m = t.front[yi * t.w + xi]
      return m !== 0 && LIQ[m] === 0 // ni aire ni líquido
    }
  }

  // Texturas opcionales del manifiesto (props.loot, props.target[bioma]); sin ellas, las de respaldo.
  async load(): Promise<void> {
    const m = await loadManifest()
    const p = m?.props
    this.loot = await loadTexture(p?.loot)
    if (p?.target) {
      for (const [b, file] of Object.entries(p.target)) {
        const t = await loadTexture(file)
        if (t) this.targets[b as Biome] = t
      }
    }
  }

  lootTex(): Texture {
    if (this.loot) return this.loot
    if (!this.fallbackLoot) this.fallbackLoot = lootFallback()
    return this.fallbackLoot
  }

  targetTex(): Texture {
    const b = this.biome
    const t = this.targets[b]
    if (t) return t
    let f = this.fallbackTargets[b]
    if (!f) {
      f = targetFallback(b)
      this.fallbackTargets[b] = f
    }
    return f
  }

  dollar(): Texture {
    if (!this.dollarTex) this.dollarTex = dollarTexture()
    return this.dollarTex
  }

  make(): LootProp {
    return new LootProp(this)
  }

  reset(): void {
    this.motes.clear()
    this.firstSync = true
  }

  // Al terminar el sync de la utilería de cada frame.
  endFrame(): void {
    this.firstSync = false
    this.motes.update(this.dt, this.time)
  }

  // Botín u objetivo destruido: monedas, billetes y destellos (y la explosión grande del objetivo).
  // Devuelve true si el evento era de botín u objetivo (el renderer no tira sus astillas de madera).
  burst(ev: Extract<GameEvent, { type: 'prop' }>, props: Prop[], fx: Fx): boolean {
    if (!isLootKind(ev.kind)) return false
    const prop = props.find((q) => q.id === ev.propId)
    const big = ev.kind === 'target'
    const w = prop?.w ?? (big ? 32 : 14)
    const h = prop?.h ?? (big ? 20 : 12)
    const cx = ev.x + w / 2
    const cy = ev.y + h / 2
    if (big) {
      fx.explosion('bigfire', cx, cy - 2, 24, { [METAL]: 40 })
      fx.splinters(cx, cy, [0x8a8a84, 0x5a5a56, 0xb0b0a8, 0x2a2622], 16)
    } else fx.splinters(cx, cy, [0xa8845a, 0x8a6a44, 0x6e5236, 0x8a8a84], 12)
    const nCoins = big ? 22 : 14
    const nBills = big ? 14 : 8
    const s = ev.propId * 31 + Math.round(this.time * 10)
    for (let i = 0; i < nCoins; i++) {
      const a = -Math.PI * (0.15 + 0.7 * rnd(i, s, 231))
      const sp = 60 + rnd(i, s, 232) * (big ? 130 : 100)
      this.motes.spawn({ kind: 'coin', x: cx + (rnd(i, s, 233) - 0.5) * w * 0.6, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 300, life: 1.6 + rnd(i, s, 234) * 0.8, color: i % 4 === 0 ? 0xffe680 : GOLD, phase: rnd(i, s, 235) * 6.28 })
    }
    for (let i = 0; i < nBills; i++) {
      const a = -Math.PI * (0.2 + 0.6 * rnd(i, s, 241))
      const sp = 40 + rnd(i, s, 242) * 70
      this.motes.spawn({ kind: 'bill', x: cx, y: cy - 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, drag: 2.2, ay: 40, life: 2.2 + rnd(i, s, 243) * 1, color: i % 3 === 0 ? 0x8ac86a : BILL, phase: rnd(i, s, 244) * 6.28 })
    }
    for (let i = 0; i < (big ? 10 : 7); i++) {
      this.motes.spawn({ kind: 'star', x: cx + (rnd(i, s, 251) - 0.5) * w * 1.4, y: cy + (rnd(i, s, 252) - 0.5) * h * 1.6, vy: -8, life: 0.4 + rnd(i, s, 253) * 0.5, color: i % 2 ? 0xffffff : 0xfff0a0 })
    }
    return true
  }
}

// ---------- una caja u objetivo ----------

export class LootProp {
  readonly root = new Container() // capa de utilería (entre la pared de fondo y el frente)
  private body = new Sprite()
  private flash = new Sprite() // copia aditiva para el titileo
  private chute = new Sprite()
  private lines = new Graphics()
  private mark = new Container() // en el overlay del kit: moneda y mira del objetivo
  private coin = new Sprite()
  private sight = new Graphics()
  private shownY: number | null = null
  private chuteOn = false
  private chuteAge = 0
  private fold = 0
  private sightKey = ''
  private sparkleAcc = 0

  constructor(private kit: LootKit) {
    this.flash.blendMode = 'add'
    this.chute.anchor.set(0.5, 1)
    this.chute.visible = false
    this.root.addChild(this.lines, this.chute, this.body, this.flash)
    this.mark.addChild(this.sight, this.coin)
    kit.overlay.addChild(this.mark)
  }

  destroy(): void {
    this.root.destroy({ children: true })
    this.mark.destroy({ children: true })
  }

  snapshot(): { tex: Texture; x: number; y: number; flip: boolean }[] {
    if (!this.root.visible) return []
    return [{ tex: this.body.texture, x: this.body.x, y: this.body.y, flip: false }]
  }

  update(art: Art, p: Prop, time: number, wind: number): void {
    void wind
    const kit = this.kit
    const alive = p.alive
    this.root.visible = alive
    this.mark.visible = alive
    if (!alive) return
    const loot = p.kind === 'loot'
    const tex = loot ? kit.lootTex() : kit.targetTex()
    this.body.texture = tex
    this.flash.texture = tex
    const dt = kit.dt
    // dónde se dibuja: el botín nuevo cae desde arriba de la vista; si el sim lo baja mucho de golpe, también
    if (this.shownY === null) {
      if (loot && !kit.firstSync && dt > 0) {
        this.shownY = Math.min(p.y - 40, Math.max(p.y - DROP_FROM, kit.viewTop - tex.height - 24))
        this.openChute()
      } else this.shownY = p.y
    } else if (p.y > this.shownY + CHUTE_MIN && loot && !this.chuteOn) this.openChute()
    if (p.y < this.shownY) this.shownY = p.y
    if (this.shownY < p.y && dt > 0) {
      this.shownY = Math.min(p.y, this.shownY + (this.chuteOn ? CHUTE_SPEED : FALL_SPEED) * dt)
      if (this.shownY >= p.y) {
        if (this.chuteOn) {
          this.chuteOn = false
          this.fold = CHUTE_FOLD
        }
        kit.dust(p.x + p.w / 2, p.y + p.h, 6, p.w)
      }
    }
    if (this.chuteOn) this.chuteAge += dt
    else if (this.fold > 0) this.fold = Math.max(0, this.fold - dt)
    const swing = this.chuteOn ? Math.sin(time * 3.2) : 0
    const x = Math.round(p.x + p.w / 2 - tex.width / 2 + swing * 1.5)
    const bottom = Math.round(this.shownY + p.h)
    const y = bottom - tex.height
    this.body.x = x
    this.body.y = y
    this.flash.x = x
    this.flash.y = y
    this.root.rotation = 0
    this.drawChute(art, Math.round(p.x + p.w / 2 + swing * 2), y)
    const landed = this.shownY >= p.y
    // titileo del botín apoyado (y destellos sueltos) para que se note
    if (loot && landed) {
      const ph = time % BLINK_EVERY
      this.flash.visible = ph < BLINK_LEN
      this.flash.alpha = 0.55 * (1 - ph / BLINK_LEN)
      this.sparkleAcc += dt
      if (this.sparkleAcc > 0.45) {
        this.sparkleAcc = 0
        const k = Math.floor(time * 10)
        kit.motes.spawn({ kind: 'star', x: x + rnd(k, p.id, 261) * tex.width, y: y + rnd(k, p.id, 262) * tex.height * 0.6, vy: -6, life: 0.45, color: 0xfff6c0 })
      }
    } else this.flash.visible = false
    // objetivo: moneda con "$" que flota encima y mira en las esquinas
    this.coin.visible = !loot
    this.sight.visible = !loot && Math.floor(time * 2.5) % 3 !== 2
    if (!loot) {
      const c = kit.dollar()
      this.coin.texture = c
      this.coin.x = Math.round(p.x + p.w / 2 - c.width / 2)
      this.coin.y = y - c.height - 4 - (Math.floor(time * 2) % 2)
      const key = `${x},${y},${tex.width},${tex.height}`
      if (key !== this.sightKey) {
        this.sightKey = key
        const g = this.sight
        g.clear()
        const x0 = x - 3
        const y0 = y - 3
        const x1 = x + tex.width + 2
        const y1 = y + tex.height + 2
        const L = 4
        for (const [cx, cy, sx, sy] of [
          [x0, y0, 1, 1],
          [x1, y0, -1, 1],
          [x0, y1, 1, -1],
          [x1, y1, -1, -1],
        ]) {
          g.rect(sx > 0 ? cx : cx - L + 1, cy, L, 1).fill(GOLD)
          g.rect(cx, sy > 0 ? cy : cy - L + 1, 1, L).fill(GOLD)
        }
      }
    }
  }

  private openChute(): void {
    this.chuteOn = true
    this.chuteAge = 0
    this.fold = 0
  }

  private drawChute(art: Art, cx: number, top: number): void {
    const g = this.lines
    g.clear()
    const folding = this.fold > 0
    this.chute.visible = this.chuteOn || folding
    if (!this.chute.visible) return
    const k = folding ? this.fold / CHUTE_FOLD : 1
    const opened = Math.min(1, this.chuteAge / 0.18)
    const sx = (0.4 + 0.6 * opened) * (folding ? 1 + (1 - k) * 0.3 : 1) * 0.8
    const sy = (0.3 + 0.7 * opened) * (folding ? 0.2 + 0.8 * k : 1) * 0.8
    const c = this.chute
    c.texture = art.props.parachute
    c.scale.set(sx, sy)
    c.alpha = folding ? k : 1
    c.x = cx
    c.y = top - 5 + (folding ? Math.round((1 - k) * 5) : 0)
    if (!this.chuteOn) return
    const hw = (c.texture.width / 2) * sx * 0.9
    g.moveTo(c.x - hw, c.y).lineTo(cx - 3, top + 1).stroke({ width: 1, color: 0x2a2a24 })
    g.moveTo(c.x + hw, c.y).lineTo(cx + 3, top + 1).stroke({ width: 1, color: 0x2a2a24 })
  }
}
