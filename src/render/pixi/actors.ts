// Tanques con tripulante, utilería y globos.
import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { Player, Prop, Terrain } from '../../sim/types'
import { AIR, TANK_H, TANK_W } from '../../sim/types'
import type { Art, Font } from './assets'
import { GLYPHS, OUT } from './fallback'
import { mul } from './raster'

export const RECOIL_TIME = 0.28
export const BUBBLE_TIME = 1.2
export const CHUTE_SPEED = 42 // px/s de bajada colgado del paracaídas
const CHUTE_FOLD = 0.3
export const BUBBLE_HOLD = 3 // máximo que un globo espera oculto a que se despeje el fuego
// Lugares candidatos para el globo, de más cerca a más lejos: primero arriba, después al costado.
const BUBBLE_SPOTS: [number, number][] = (() => {
  const spots: [number, number][] = []
  for (let dy = 6; dy >= -96; dy -= 6) {
    for (let dx = -48; dx <= 48; dx += 8) {
      if (dy > 0 && Math.abs(dx) < 16) continue // no tapar el cartel ni el tanque
      spots.push([dx, dy])
    }
  }
  return spots.sort((a, b) => Math.abs(a[0]) * 1.3 + Math.abs(a[1]) - (Math.abs(b[0]) * 1.3 + Math.abs(b[1])))
})()

const MAX_TILT = 0.35 // ~20°: más que eso el cañón del sim y el dibujo se separan demasiado
const TILT_REACH = 24

// Inclinación de reposo del tanque sobre la grilla: gira sobre el borde de apoyo más cercano al centro
// hasta que el otro lado toca el piso. null si el apoyo abarca el centro (queda derecho).
export function restTilt(t: Terrain, x0: number, floor: number): { angle: number; x: number } | null {
  const g: number[] = []
  for (let i = 0; i < TANK_W; i++) {
    const x = x0 + i
    let y = floor + TILT_REACH
    if (x >= 0 && x < t.w) {
      for (let yy = floor - 2; yy < floor + TILT_REACH && yy < t.h; yy++) {
        if (yy >= 0 && t.front[yy * t.w + x] !== AIR) {
          y = Math.max(floor, yy)
          break
        }
      }
    }
    g.push(y)
  }
  const first = g.indexOf(floor)
  const last = g.lastIndexOf(floor)
  if (first < 0) return null
  const mid = (TANK_W - 1) / 2
  if (first <= mid && last >= mid) return null
  let best = MAX_TILT
  if (last < mid) {
    for (let i = last + 1; i < TANK_W; i++) best = Math.min(best, Math.atan2(g[i] - floor, i - last))
    return best > 0.02 ? { angle: best, x: x0 + last + 1 } : null
  }
  for (let i = first - 1; i >= 0; i--) best = Math.min(best, Math.atan2(g[i] - floor, first - i))
  return best > 0.02 ? { angle: -best, x: x0 + first } : null
}

export type Blocked = (x: number, y: number, w: number, h: number) => boolean

export class TankView {
  readonly root = new Container()
  readonly overlay = new Container()
  private antenna = new Graphics()
  private barrel = new Sprite()
  private body = new Sprite()
  private tread = new Sprite()
  private crew = new Sprite()
  private tag = new Sprite()
  private bubble = new Sprite()
  private tagKey = ''
  recoil = 0
  alert = 0
  ask = 0
  held = false // el globo está esperando oculto
  heldFor = 0
  moved = 0 // cuánto avanzó en x desde el frame anterior (0 si saltó o está destruido)
  dustAcc = 0
  private lastX: number | null = null
  private treadPos = 0
  private tilt = 0
  private chute = new Sprite()
  private chuteLines = new Graphics()
  dropOff = 0 // px que el tanque está por encima de su lugar final (paracaídas)
  landed = false // aterrizó este frame: el renderer levanta el polvo
  private chuteAge = 0
  private fold = 0

  constructor() {
    this.root.addChild(this.antenna, this.barrel, this.body, this.tread, this.crew)
    this.chute.anchor.set(0.5, 1)
    this.chute.visible = false
    this.overlay.addChild(this.chuteLines, this.chute, this.tag, this.bubble)
  }

  startChute(height: number): void {
    if (height < 3) return
    this.dropOff = height
    this.chuteAge = 0
    this.fold = 0
  }

  stepChute(dt: number, alive: boolean): void {
    if (!alive) {
      this.dropOff = 0
      this.fold = 0
      return
    }
    if (this.dropOff > 0) {
      this.chuteAge += dt
      this.dropOff = Math.max(0, this.dropOff - CHUTE_SPEED * dt)
      if (this.dropOff === 0) {
        this.fold = CHUTE_FOLD
        this.landed = true
      }
    } else if (this.fold > 0) this.fold = Math.max(0, this.fold - dt)
  }

  destroy(): void {
    this.root.destroy({ children: true })
    this.overlay.destroy({ children: true })
  }

  update(art: Art, p: Player, current: boolean, time: number, wind: number, blocked?: Blocked, terrain?: Terrain): void {
    const facing = p.angle > 90 ? -1 : 1
    const x0 = Math.round(p.x) - TANK_W / 2
    const swing = this.dropOff > 0 ? Math.sin(time * 3.2) : 0
    const top = Math.round(p.y) - TANK_H - Math.round(this.dropOff)
    const root = this.root
    root.visible = true
    root.scale.x = facing
    // El sim apoya el tanque derecho sobre su punto más alto; acá se inclina hasta tocar la pendiente.
    const lean = p.alive && terrain ? restTilt(terrain, x0, Math.round(p.y)) : null
    const target = lean ? lean.angle : 0
    this.tilt = this.lastX === null ? target : this.tilt + (target - this.tilt) * 0.35
    if (Math.abs(this.tilt - target) < 0.004) this.tilt = target
    const px = lean ? lean.x : x0 + TANK_W / 2
    root.pivot.set(facing > 0 ? px - x0 : x0 + TANK_W - px, TANK_H)
    root.x = px
    root.y = top + TANK_H
    root.rotation = this.tilt + swing * 0.05

    const alive = p.alive
    const dx = this.lastX === null ? 0 : p.x - this.lastX
    this.lastX = p.x
    this.moved = alive && Math.abs(dx) <= 4 ? dx : 0
    // Los eslabones corren un pixel por pixel recorrido, en el espacio local (espejado) del sprite.
    this.treadPos -= this.moved * facing
    const k = this.recoil > 0 ? this.recoil / RECOIL_TIME : 0
    const kick = Math.round(2 * k)
    this.body.texture = alive ? art.bodies[p.id % 4] : art.wreck
    this.body.x = alive && k > 0.5 ? -1 : 0
    this.barrel.visible = alive
    this.tread.visible = alive
    if (alive) {
      const frames = art.treads[p.id % 4]
      const n = frames.length
      const tt = frames[((Math.round(this.treadPos) % n) + n) % n]
      this.tread.texture = tt
      this.tread.x = this.body.x
      this.tread.y = TANK_H - tt.height
    }
    this.crew.visible = alive
    this.antenna.visible = alive
    if (alive) {
      const local = facing > 0 ? p.angle : 180 - p.angle
      const frames = art.barrels[p.id % 4]
      const idx = Math.max(0, Math.min(frames.length - 1, Math.round(local / 5)))
      this.barrel.texture = frames[idx]
      const rad = (idx * 5 * Math.PI) / 180
      // el cañón compensa la inclinación: apunta al ángulo del sim
      this.barrel.pivot.set(art.barrelPivot.x, art.barrelPivot.y)
      this.barrel.rotation = -this.tilt * facing
      this.barrel.x = art.pivotInBody.x - Math.round(Math.cos(rad) * kick)
      this.barrel.y = art.pivotInBody.y + Math.round(Math.sin(rad) * kick)
      this.crew.texture = art.crews[p.crew] ?? art.crews.bandana
      this.crew.x = art.crewInBody.x
      // traqueteo del tripulante mientras anda
      const bump = this.moved !== 0 && Math.floor(Math.abs(this.treadPos) / 3) % 2 === 1 ? 1 : 0
      this.crew.y = art.crewInBody.y + (k > 0.6 ? 1 : bump)
      this.drawAntenna(art, p.color, time, wind * facing, k)
    }

    const cx = Math.round(p.x)
    this.drawChute(art, cx, top, swing, alive)
    let y = top - 26
    this.tag.visible = alive && current
    if (this.tag.visible) {
      const key = `P${p.id + 1}:${p.color}`
      if (key !== this.tagKey) {
        this.tag.texture?.destroy(true)
        this.tag.texture = tagTexture(`P${p.id + 1}`, p.color, art.font)
        this.tagKey = key
      }
      this.tag.x = cx - Math.floor(this.tag.texture.width / 2)
      this.tag.y = y
      y -= 14
    }
    const b = this.alert > 0 ? art.alert : this.ask > 0 ? art.ask : null
    this.held = false
    this.bubble.visible = b !== null && alive
    if (b && alive) {
      this.bubble.texture = b
      // Nunca encima del fuego o el humo: busca un lugar libre arriba o al costado; si no hay, espera.
      const bx = cx - 5
      const by = this.tag.visible ? y - 1 : top - 25
      const fits = (dx: number, dy: number): boolean => {
        const x = bx + dx
        const y = by + dy
        return x >= 0 && y >= 0 && x + b.width <= (terrain?.w ?? Infinity) && !blocked?.(x, y, b.width, b.height)
      }
      const spot = BUBBLE_SPOTS.find(([dx, dy]) => fits(dx, dy))
      if (spot) {
        this.bubble.x = bx + spot[0]
        this.bubble.y = by + spot[1]
      } else {
        this.bubble.visible = false
        this.held = true
      }
    }
  }

  private drawChute(art: Art, cx: number, top: number, swing: number, alive: boolean): void {
    const g = this.chuteLines
    g.clear()
    const open = this.dropOff > 0
    const folding = this.fold > 0
    this.chute.visible = alive && (open || folding)
    if (!this.chute.visible) return
    const k = folding ? this.fold / CHUTE_FOLD : 1
    const opened = Math.min(1, this.chuteAge / 0.18)
    const sx = (0.4 + 0.6 * opened) * (folding ? 1 + (1 - k) * 0.3 : 1)
    const sy = (0.3 + 0.7 * opened) * (folding ? 0.2 + 0.8 * k : 1)
    const c = this.chute
    c.texture = art.props.parachute
    c.scale.set(sx, sy)
    c.alpha = folding ? k : 1
    c.x = cx + Math.round(swing * 2)
    c.y = top - 6 + (folding ? Math.round((1 - k) * 6) : 0)
    if (!open) return
    const hw = (c.texture.width / 2) * sx * 0.9
    g.moveTo(c.x - hw, c.y).lineTo(cx - 4, top + 3).stroke({ width: 1, color: 0x2a2a24 })
    g.moveTo(c.x + hw, c.y).lineTo(cx + 4, top + 3).stroke({ width: 1, color: 0x2a2a24 })
  }

  private drawAntenna(art: Art, color: number, time: number, wind: number, recoil: number): void {
    const g = this.antenna
    g.clear()
    const ax = art.antennaInBody.x
    const ay = art.antennaInBody.y
    const sway = recoil > 0.3 ? -1 : 0
    g.rect(ax, ay - 12, 1, 12).fill(0x3a3a34)
    const flap = Math.floor(time * (5 + Math.abs(wind) * 0.6)) % 2
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 6 - y; x++) {
        const droop = x > 3 - flap ? 1 : 0
        const c = x === 5 - y || y === 3 ? OUT : color
        g.rect(ax - (1 + x) + sway, ay - 12 + y + droop, 1, 1).fill(c)
      }
    }
  }
}

// Globo "P1".."P4" como tagBubble() del look-test.
function tagTexture(label: string, fill: number, font: Font | null): Texture {
  const glyphs = [...label].map((ch) => glyph(ch, font))
  const textW = glyphs.reduce((a, g) => a + g.w + 1, 0) - 1
  const w = textW + 6
  const c = document.createElement('canvas')
  c.width = w + 1
  c.height = 14
  const ctx = c.getContext('2d')
  if (!ctx) return Texture.from(c)
  const img = ctx.createImageData(c.width, c.height)
  const put = (x: number, y: number, col: number): void => {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return
    const i = (y * c.width + x) * 4
    img.data[i] = (col >> 16) & 255
    img.data[i + 1] = (col >> 8) & 255
    img.data[i + 2] = col & 255
    img.data[i + 3] = 255
  }
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < w; x++) {
      if ((y === 0 || y === 10) && (x === 0 || x === w - 1)) continue
      const edge = y === 0 || y === 10 || x === 0 || x === w - 1
      put(x, y, edge ? OUT : y === 9 ? mul(fill, 0.7) : fill)
    }
  }
  const px = Math.round(w / 2) - 2
  const tail = ['kwwwk', '.kwk.', '..k..']
  tail.forEach((row, ty) => {
    for (let tx = 0; tx < row.length; tx++) if (row[tx] !== '.') put(px + tx, 10 + ty, row[tx] === 'k' ? OUT : fill)
  })
  let gx = 3
  for (const g of glyphs) {
    for (const [x, y] of g.px) put(gx + x + 1, 3 + y + 1, OUT)
    for (const [x, y] of g.px) put(gx + x, 3 + y, 0xffffff)
    gx += g.w + 1
  }
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}

function glyph(ch: string, font: Font | null): { w: number; px: [number, number][] } {
  if (font) {
    const i = font.chars.indexOf(ch)
    if (i >= 0) {
      const px: [number, number][] = []
      let maxX = 0
      for (let y = 0; y < Math.min(font.glyphH, 6); y++) {
        for (let x = 0; x < font.glyphW; x++) {
          const k = (y * font.data.width + i * font.glyphW + x) * 4
          if (font.data.data[k + 3] > 0 && font.data.data[k] > 128) {
            px.push([x, y])
            maxX = Math.max(maxX, x)
          }
        }
      }
      if (px.length) return { w: maxX + 1, px }
    }
  }
  const rows = GLYPHS[ch] ?? GLYPHS.P
  const px: [number, number][] = []
  rows.forEach((row, y) => [...row].forEach((c, x) => c === '#' && px.push([x, y])))
  return { w: rows[0].length, px }
}

export class PropView {
  readonly root = new Container()
  private sprites: Sprite[] = []
  private kind: Prop['kind']

  constructor(prop: Prop) {
    this.kind = prop.kind
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }

  private need(n: number): void {
    while (this.sprites.length < n) {
      const s = new Sprite()
      this.sprites.push(s)
      this.root.addChild(s)
    }
    for (let i = 0; i < this.sprites.length; i++) this.sprites[i].visible = i < n
  }

  update(art: Art, p: Prop, time: number, wind: number): void {
    this.root.visible = p.alive
    if (!p.alive) return
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    const bottom = y + p.h
    if (this.kind === 'ladder') {
      const tile = art.props.ladderTile
      const th = Math.max(1, tile.height)
      const n = Math.max(1, Math.ceil(p.h / th))
      this.need(n)
      for (let i = 0; i < n; i++) {
        const s = this.sprites[i]
        s.texture = tile
        s.x = x
        s.y = y + i * th
      }
      return
    }
    this.need(1)
    const s = this.sprites[0]
    s.scale.x = 1
    let t: Texture
    switch (this.kind) {
      case 'barrel':
        t = art.props.barrel
        break
      case 'crate':
        t = art.props.crate
        break
      case 'lamp':
        t = art.props.lamp
        break
      case 'flag': {
        const f = art.props.flag
        t = f[Math.floor(time * (4 + Math.abs(wind) * 0.8)) % f.length]
        break
      }
      case 'windsock': {
        const f = art.props.windsock
        t = f[Math.max(0, Math.min(f.length - 1, Math.round(((wind + 10) / 20) * (f.length - 1))))]
        break
      }
      default:
        t = art.props.crate
    }
    s.texture = t
    s.x = x
    s.y = this.kind === 'lamp' ? y : bottom - t.height
    if (this.kind === 'flag' && wind < 0 && art.props.flag.length > 1) {
      s.scale.x = -1
      s.x = x + 2
    }
  }
}
