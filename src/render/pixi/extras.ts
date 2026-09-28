// F10/F11: escudo, trazador, tripulante eyectado y cortina entre rondas. Todo con el dt que recibe el renderer.
import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { GameEvent, Player, Terrain, Vec2 } from '../../sim/types'
import { AIR, SHIELD_HP, WORLD_H, WORLD_W } from '../../sim/types'
import type { RenderFrame } from '../types'
import type { Art } from './assets'
import type { Fx } from './fx'
import { Rng } from './raster'

const SHIELD_RX = 21
const SHIELD_RY = 19
const SHIELD_LINGER = 3 // s que espera el evento que rompe el escudo antes de romperlo solo
const FLASH_TIME = 0.28
const CURTAIN_TIME = 0.75
const CURTAIN_COLOR = 0x0c0a12
const CURTAIN_COLS = 25
const CREW_GRAVITY = 220
const TRACER_STEP = 3.5

interface ShieldState {
  sprite: Sprite
  active: boolean
  wait: number
  flash: number
  breakNow: boolean
}

interface Shard {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  w: number
  h: number
  color: number
}

interface Crew {
  sprite: Sprite
  x: number
  y: number
  vx: number
  vy: number
  vr: number
  bounced: boolean
  age: number
  trail: number
}

// Burbuja pixelada: aro de 2 px, relleno tramado y un brillo arriba a la izquierda.
function shieldTexture(): Texture {
  const w = SHIELD_RX * 2 + 2
  const h = SHIELD_RY * 2 + 2
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return Texture.from(c)
  const img = ctx.createImageData(w, h)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - cx) / SHIELD_RX
      const ny = (y + 0.5 - cy) / SHIELD_RY
      const e = nx * nx + ny * ny
      if (e > 1) continue
      let r = 0x7f
      let g = 0xe0
      let b = 0xff
      let a = 0
      if (e > 0.82) {
        a = e > 0.93 ? 235 : 170
        // brillo: tramo del aro arriba a la izquierda
        const ang = Math.atan2(ny, nx)
        if (ang < -1.9 && ang > -2.7) {
          r = 255
          g = 255
          b = 255
          a = 255
        }
      } else if ((x + y) % 2 === 0) a = 26 + Math.round(e * 40)
      if (a === 0) continue
      const i = (y * w + x) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = a
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = Texture.from(c)
  t.source.scaleMode = 'nearest'
  return t
}

export class Extras {
  readonly layer = new Container()
  readonly curtain = new Graphics()
  private shieldTex: Texture | null = null
  private shields = new Map<number, ShieldState>()
  private shards: Shard[] = []
  private shardG = new Graphics()
  private tracerG = new Graphics()
  private crews: Crew[] = []
  private curtainT = 0
  private rng = new Rng(4242)

  constructor(private fx: Fx) {
    this.layer.addChild(this.tracerG, this.shardG)
    this.curtain.visible = false
  }

  reset(): void {
    for (const s of this.shields.values()) s.sprite.destroy()
    this.shields.clear()
    for (const c of this.crews) c.sprite.destroy()
    this.crews = []
    this.shards = []
    this.shardG.clear()
    this.tracerG.clear()
  }

  // Cortina que barre de izquierda a derecha mostrando el mapa nuevo.
  startTransition(): void {
    this.curtainT = CURTAIN_TIME
    this.drawCurtain()
  }

  private shield(id: number): ShieldState {
    let s = this.shields.get(id)
    if (!s) {
      if (!this.shieldTex) this.shieldTex = shieldTexture()
      const sprite = new Sprite(this.shieldTex)
      sprite.anchor.set(0.5)
      sprite.visible = false
      this.layer.addChild(sprite)
      s = { sprite, active: false, wait: 0, flash: 0, breakNow: false }
      this.shields.set(id, s)
    }
    return s
  }

  onEvent(ev: GameEvent, frame: RenderFrame, art: Art): void {
    if (ev.type === 'shield') {
      const s = this.shield(ev.playerId)
      s.flash = FLASH_TIME
      if (ev.left <= 0) s.breakNow = true
    } else if (ev.type === 'death') {
      const p = frame.players.find((q) => q.id === ev.playerId)
      if (p) this.eject(p, art)
    }
  }

  private eject(p: Player, art: Art): void {
    const sprite = new Sprite(art.crews[p.crew] ?? art.crews.bandana)
    sprite.anchor.set(0.5)
    const dir = this.rng.next() < 0.5 ? -1 : 1
    const x = p.x
    const y = p.y - 24
    sprite.x = Math.round(x)
    sprite.y = Math.round(y)
    this.layer.addChild(sprite)
    this.crews.push({
      sprite,
      x,
      y,
      vx: dir * (40 + this.rng.next() * 40),
      vy: -(150 + this.rng.next() * 50),
      vr: dir * (7 + this.rng.next() * 4),
      bounced: false,
      age: 0,
      trail: 0,
    })
  }

  update(art: Art, frame: RenderFrame, dt: number, time: number, dropOf: (id: number) => number): void {
    this.updateShields(frame, dt, time, dropOf)
    this.updateShards(dt)
    this.updateCrews(frame.terrain, dt)
    this.drawTracer(frame.aimPreview ?? null, time)
    this.updateCurtain(dt)
    void art
  }

  private updateShields(frame: RenderFrame, dt: number, time: number, dropOf: (id: number) => number): void {
    for (const p of frame.players) {
      const s = this.shield(p.id)
      s.flash = Math.max(0, s.flash - dt)
      const cx = Math.round(p.x)
      const cy = Math.round(p.y - 12 - dropOf(p.id))
      if (s.active && (s.breakNow || !p.alive)) {
        this.breakShield(cx, cy)
        s.active = false
      }
      s.breakNow = false
      if (p.shield > 0 && p.alive) {
        s.active = true
        s.wait = 0
      } else if (s.active) {
        // el estado ya perdió el escudo pero el evento que lo rompe todavía no llegó
        s.wait += dt
        if (s.wait > SHIELD_LINGER) {
          this.breakShield(cx, cy)
          s.active = false
        }
      }
      const sp = s.sprite
      sp.visible = s.active
      if (!s.active) continue
      const low = p.shield > 0 && p.shield < SHIELD_HP * 0.35
      const pulse = 0.5 + 0.5 * Math.sin(time * (low ? 14 : 4.5) + p.id)
      const k = s.flash / FLASH_TIME
      sp.x = cx
      sp.y = cy
      sp.alpha = Math.min(1, (p.shield > 0 ? 0.5 + 0.35 * pulse : 0.35) + k * 0.5)
      sp.tint = k > 0.4 ? 0xffffff : 0xcfefff
      const grow = 1 + 0.1 * k
      sp.scale.set(grow)
      if (low && Math.floor(time * 10) % 4 === 0) sp.visible = false
    }
  }

  private breakShield(cx: number, cy: number): void {
    const cols = [0x7fe0ff, 0xbdf2ff, 0xffffff]
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + this.rng.next() * 0.2
      const sp = 45 + this.rng.next() * 60
      this.shards.push({
        x: cx + Math.cos(a) * SHIELD_RX,
        y: cy + Math.sin(a) * SHIELD_RY,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 25,
        age: 0,
        life: 0.55 + this.rng.next() * 0.4,
        w: 2 + Math.floor(this.rng.next() * 3),
        h: 1 + Math.floor(this.rng.next() * 2),
        color: cols[i % cols.length],
      })
    }
    this.fx.flash = Math.max(this.fx.flash, 0.12)
  }

  private updateShards(dt: number): void {
    const g = this.shardG
    if (this.shards.length === 0) {
      if (g.visible) g.clear()
      return
    }
    g.clear()
    const live: Shard[] = []
    for (const s of this.shards) {
      s.age += dt
      if (s.age >= s.life) continue
      s.vy += 260 * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
      g.rect(Math.round(s.x), Math.round(s.y), s.w, s.h).fill({ color: s.color, alpha: 1 - (s.age / s.life) ** 2 })
      live.push(s)
    }
    this.shards = live
  }

  private solid(t: Terrain, x: number, y: number): boolean {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || xi >= t.w || yi < 0 || yi >= t.h) return false
    return t.front[yi * t.w + xi] !== AIR
  }

  private updateCrews(t: Terrain, dt: number): void {
    if (dt <= 0) return
    const live: Crew[] = []
    for (const c of this.crews) {
      c.age += dt
      const px = c.x
      const py = c.y
      c.vy += CREW_GRAVITY * dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      c.sprite.rotation += c.vr * dt
      let done = c.age > 5 || c.y > WORLD_H + 24 || c.x < -24 || c.x > WORLD_W + 24
      if (!done && c.vy > 0 && this.solid(t, c.x, c.y + 5)) {
        if (c.bounced) {
          this.puff(c.x, c.y + 4)
          done = true
        } else {
          c.bounced = true
          c.y = py
          c.vy *= -0.45
          c.vx *= 0.6
          c.vr *= 0.6
          this.fx.dust(c.x, c.y + 5, 3, 6)
        }
      }
      // estela de humo cada pocos pixels recorridos
      c.trail += Math.hypot(c.x - px, c.y - py)
      while (c.trail >= 4) {
        c.trail -= 4
        this.fx.trailPoint(c.x, c.y)
      }
      if (done) c.sprite.destroy()
      else {
        c.sprite.x = Math.round(c.x)
        c.sprite.y = Math.round(c.y)
        live.push(c)
      }
    }
    this.crews = live
  }

  private puff(x: number, y: number): void {
    for (let i = 0; i < 4; i++) this.fx.trailPoint(x + (i - 1.5) * 2, y - i)
    this.fx.dust(x, y, 4, 8)
  }

  // Puntos cada ~3.5 px que titilan, y una cruz donde termina el tiro.
  private drawTracer(path: Vec2[] | null, time: number): void {
    const g = this.tracerG
    g.clear()
    if (!path || path.length < 2) return
    let toNext = TRACER_STEP
    let n = 0
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]
      const b = path[i]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 0.001) continue
      let pos = 0
      while (pos + toNext <= len) {
        pos += toNext
        toNext = TRACER_STEP
        const x = Math.round(a.x + ((b.x - a.x) * pos) / len)
        const y = Math.round(a.y + ((b.y - a.y) * pos) / len)
        n++
        if (y < -2 || x < -2 || x > WORLD_W + 2) continue
        const ph = (n * 0.37 + time * 3.3) % 1
        const on = ph < 0.6
        g.rect(x, y, 2, 2).fill({ color: on ? 0xfff3a8 : 0xffffff, alpha: on ? 1 : 0.4 })
      }
      toNext -= len - pos
    }
    const end = path[path.length - 1]
    if (end.y >= 0 && end.y < WORLD_H && end.x >= 0 && end.x < WORLD_W) {
      const ex = Math.round(end.x)
      const ey = Math.round(end.y)
      const r = 3 + (Math.floor(time * 4) % 2)
      g.rect(ex - r - 1, ey - 1, r * 2 + 3, 3).fill({ color: 0x14121c, alpha: 0.7 })
      g.rect(ex - 1, ey - r - 1, 3, r * 2 + 3).fill({ color: 0x14121c, alpha: 0.7 })
      g.rect(ex - r, ey, r * 2 + 1, 1).fill(0xff5a3c)
      g.rect(ex, ey - r, 1, r * 2 + 1).fill(0xff5a3c)
      g.rect(ex, ey, 1, 1).fill(0xffffff)
    }
  }

  private updateCurtain(dt: number): void {
    if (this.curtainT <= 0) return
    this.curtainT = Math.max(0, this.curtainT - dt)
    this.drawCurtain()
  }

  private drawCurtain(): void {
    const g = this.curtain
    g.clear()
    if (this.curtainT <= 0) {
      g.visible = false
      return
    }
    g.visible = true
    const u = 1 - this.curtainT / CURTAIN_TIME
    const w = WORLD_W / CURTAIN_COLS
    for (let i = 0; i < CURTAIN_COLS; i++) {
      const start = (i / CURTAIN_COLS) * 0.6
      const local = Math.min(1, Math.max(0, (u - start) / 0.4))
      const h = Math.ceil(((1 - local) * WORLD_H) / 6) * 6
      if (h > 0) g.rect(i * w, 0, w, Math.min(WORLD_H, h)).fill(CURTAIN_COLOR)
    }
  }
}
