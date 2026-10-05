// v3 (render-armas): peligros que quedan en el mapa entre turnos (RenderFrame.hazards).
// - Mina: clavada en el piso, con una luz roja que titila (más rápido en su último turno) y una marca del
//   color del dueño. Sprite del manifiesto (props.mine, 2 frames) o el de respaldo de acá.
// - Charco de ácido: capa verde que sigue el piso, con brillos que corren, burbujas que revientan y algo de
//   humo tóxico; se apaga en su último turno y se evapora al vencer.
// Eventos hazard: place (polvo y clic), trigger (destello; el ácido corroe a los que están adentro) y expire.
import type { Texture } from 'pixi.js'
import type { GameEvent, Hazard, Player, Terrain } from '../../sim/types'
import { OUT } from './fallback'
import type { Fx } from './fx'
import type { Motes, PixelLayer } from './pixels'
import { glowTexture, pixelArt, rr, surfaceBelow } from './pixels'

const ACID_BODY = [0x6cbc1e, 0x7ad01e, 0x5aa01a, 0x8cd422]
const ACID_HI = 0xe8ff90
const ACID_DARK = 0x2e6a18

interface Puddle {
  h: Hazard
  cols: number[] // x, y del piso por columna
  version: number
  fade: number // 1 = viva; al vencer baja a 0
  gone: boolean
  acc: number
}

export class HazardsView {
  private mineOff: Texture | null = null
  private mineOn: Texture | null = null
  private puddles = new Map<number, Puddle>()
  private mines = new Map<number, { h: Hazard; fade: number; gone: boolean }>()
  private flashes: { x: number; y: number; age: number; color: number }[] = []
  private time = 0
  // se llama cuando el ácido corroe a un tanque (lo dibuja WeaponsFx)
  onCorrode: (id: number, seconds: number) => void = () => {}

  constructor(
    private fx: Fx,
    private motes: Motes,
  ) {}

  // Frames de la mina pintados por el arte (apagada, prendida); sin ellos, el respaldo procedural.
  setMineArt(off: Texture | null, on: Texture | null): void {
    this.mineOff = off
    this.mineOn = on
  }

  // Respaldo procedural de 10×6 (apagada / prendida), hecho una sola vez.
  private fb: Texture[] = []
  private fallbackMine(on: boolean): Texture {
    const i = on ? 1 : 0
    this.fb[i] ??= pixelArt(['....rr....', '..######..', '.#hhhhhh#.', '#hmmmmmmd#', '#dddddddd#', '.########.'], {
      '#': OUT,
      r: on ? 0xff3a2a : 0x6a1a14,
      h: 0x9a9a90,
      m: 0x5c5c54,
      d: 0x3a3a36,
    })
    return this.fb[i]
  }

  reset(): void {
    this.puddles.clear()
    this.mines.clear()
    this.flashes = []
  }

  onEvent(ev: Extract<GameEvent, { type: 'hazard' }>, players: Player[]): void {
    const h = ev.hazard
    const k = this.fx.kit
    if (ev.action === 'place') {
      if (h.kind === 'mine') {
        // se clava: polvito, clic metálico
        this.fx.dust(h.x, h.y, 4, 8)
        for (let i = 0; i < 5; i++) k.spark(h.x, h.y - 2, rr(-60, 60), -rr(30, 80), rr(0.1, 0.2))
        this.flashes.push({ x: h.x, y: h.y - 3, age: 0, color: 0xff6040 })
      } else {
        for (let i = 0; i < 12; i++) this.motes.add({ x: h.x + rr(-h.radius, h.radius), y: h.y - 1, vy: -rr(10, 30), drag: 1, life: rr(0.4, 1), c0: ACID_HI, c1: 0x7ad01e })
      }
    } else if (ev.action === 'trigger') {
      if (h.kind === 'mine') {
        // se activó: destello rojo fuerte (la explosión llega con su impacto)
        this.flashes.push({ x: h.x, y: h.y - 3, age: 0, color: 0xff2a1a })
        k.light(h.x, h.y - 3, 30, 0xff3a2a, 0.6, 0.2)
      } else {
        // el charco quema: burbujas, humo y los tanques adentro se corroen
        for (let i = 0; i < 16; i++) this.motes.add({ x: h.x + rr(-h.radius, h.radius), y: h.y - 1, vy: -rr(14, 40), drag: 1, life: rr(0.4, 1), c0: ACID_HI, c1: 0x7ad01e, size: rr(0, 1) < 0.3 ? 2 : 1 })
        for (let i = 0; i < 4; i++) k.soft({ x0: h.x + rr(-h.radius, h.radius), y0: h.y - 3, vx: this.fx.wind + rr(-5, 5), vy: -rr(12, 22), drag: 1.2, r0: 2, r1: rr(5, 8), life: rr(1.2, 1.8), inner: 0xb4c488, edge: 0x6a7a48, a0: 0.7, keep: 0.25 })
        for (const p of players) if (p.alive && Math.abs(p.x - h.x) < h.radius + 14 && Math.abs(p.y - h.y) < 20) this.onCorrode(p.id, 2.5)
      }
    } else {
      if (h.kind === 'acid') {
        // se evapora
        for (let i = 0; i < 6; i++) k.soft({ x0: h.x + rr(-h.radius, h.radius), y0: h.y - 2, vx: this.fx.wind + rr(-5, 5), vy: -rr(14, 26), drag: 1.2, r0: 1.5, r1: rr(4, 7), life: rr(1, 1.6), inner: 0xe0ead0, edge: 0x9aa88a, a0: 0.7, keep: 0.25 })
        const p = this.puddles.get(h.id)
        if (p) p.gone = true
      } else {
        const m = this.mines.get(h.id)
        if (m) m.gone = true
        this.flashes.push({ x: h.x, y: h.y - 3, age: 0, color: 0xff2a1a })
      }
    }
  }

  private surface(t: Terrain, h: Hazard): number[] {
    const cols: number[] = []
    const r = Math.max(4, Math.round(h.radius))
    for (let cx = Math.round(h.x) - r; cx <= h.x + r; cx++) {
      const sy = surfaceBelow(t, cx, h.y - 14, h.y + 16)
      if (sy >= 0) cols.push(cx, sy)
    }
    return cols
  }

  update(list: Hazard[] | undefined, t: Terrain, version: number, dt: number, view: { x0: number; x1: number }): void {
    this.time += dt
    const seen = new Set<number>()
    for (const h of list ?? []) {
      seen.add(h.id)
      if (h.kind === 'mine') {
        const m = this.mines.get(h.id)
        if (m) m.h = h
        else this.mines.set(h.id, { h, fade: 1, gone: false })
      } else {
        let p = this.puddles.get(h.id)
        if (!p) {
          p = { h, cols: this.surface(t, h), version, fade: 0, gone: false, acc: 0 }
          this.puddles.set(h.id, p)
        }
        if (p.version !== version || p.h.x !== h.x || p.h.y !== h.y) {
          // el piso cambió (explosión, derrumbe) o el charco se movió: vuelve a apoyarse
          p.cols = this.surface(t, h)
          p.version = version
        }
        p.h = h
      }
    }
    // lo que salió de la lista sin evento expire también se va, desvaneciéndose
    for (const [id, m] of this.mines) {
      if (!seen.has(id)) m.gone = true
      if (m.gone) m.fade -= dt * 4
      if (m.fade <= 0) this.mines.delete(id)
    }
    for (const [id, p] of this.puddles) {
      if (!seen.has(id)) p.gone = true
      p.fade = p.gone ? p.fade - dt * 1.5 : Math.min(1, p.fade + dt * 3)
      if (p.gone && p.fade <= 0) {
        this.puddles.delete(id)
        continue
      }
      if (dt <= 0 || p.cols.length === 0) continue
      // burbujas y humo solo en los charcos que se ven
      const x = p.h.x
      if (x + p.h.radius < view.x0 || x - p.h.radius > view.x1) continue
      p.acc += dt * (4 + p.h.radius * 0.3) * p.fade
      for (; p.acc >= 1; p.acc--) {
        const j = Math.floor(rr(0, p.cols.length / 2)) * 2
        this.motes.add({ x: p.cols[j], y: p.cols[j + 1] - 2, vy: -rr(6, 16), drag: 1.5, life: rr(0.25, 0.6), c0: ACID_HI, c1: 0x9cf040, size: rr(0, 1) < 0.25 ? 2 : 1 })
        if (rr(0, 1) < 0.12)
          this.fx.kit.soft({ x0: p.cols[j], y0: p.cols[j + 1] - 3, vx: this.fx.wind + rr(-4, 4), vy: -rr(8, 16), drag: 1.2, r0: 1.5, r1: rr(3.5, 6), life: rr(1, 1.6), inner: 0xb4c488, edge: 0x6a7a48, a0: 0.45, keep: 0.25 })
      }
    }
    for (const f of this.flashes) f.age += dt
    this.flashes = this.flashes.filter((f) => f.age < 0.25)
  }

  // Charcos en la capa de abajo (sobre el terreno, debajo de los tanques); minas y luces arriba.
  draw(under: PixelLayer, glow: PixelLayer, players: Player[]): void {
    for (const p of this.puddles.values()) {
      const last = p.h.turns <= 1
      const a = p.fade * (last ? 0.75 : 1)
      const n = p.cols.length / 2
      for (let i = 0; i < n; i++) {
        const x = p.cols[i * 2]
        const y = p.cols[i * 2 + 1]
        const u = Math.abs(i - (n - 1) / 2) / Math.max(1, n / 2)
        const th = u < 0.55 ? 3 : u < 0.85 ? 2 : 1
        // hundido en el piso: la superficie del charco es la del terreno, corroída hacia abajo
        const c = ACID_BODY[(x * 7 + Math.floor(this.time * 3 + x * 0.3)) & 3]
        under.rect(x, y - 1, 1, th, c, a)
        under.px(x, y - 1 + th, ACID_DARK, a * 0.8)
        // brillo que corre por la superficie
        if (((x + Math.floor(this.time * 9)) % 11 === 0 && u < 0.8) || (x * 13 + Math.floor(this.time * 2)) % 17 === 0) under.px(x, y - 1, ACID_HI, a)
      }
      if (n) glow.sprite(glowTexture(Math.round(8 + p.h.radius * 0.6)), p.h.x, p.cols[Math.floor(n / 2) * 2 + 1] - 2, { tint: 0x5aa01a, alpha: 0.35 * a * (0.85 + 0.15 * Math.sin(this.time * 3 + p.h.id)) })
    }
    for (const m of this.mines.values()) {
      const h = m.h
      const period = h.turns <= 1 ? 0.35 : 1
      const on = (this.time + h.id * 0.37) % period < 0.12
      const tex = on ? (this.mineOn ?? this.fallbackMine(true)) : (this.mineOff ?? this.fallbackMine(false))
      // clavada: el borde de abajo 1 px dentro del piso
      under.sprite(tex, h.x, h.y + 1, { ax: 0.5, ay: 1, alpha: Math.max(0, m.fade) })
      // marca del dueño a un costado de la luz
      const owner = players.find((p) => p.id === h.ownerId)
      if (owner) under.rect(h.x + 2, h.y - tex.height + 2, 2, 1, owner.color, Math.max(0, m.fade))
      if (on) glow.sprite(glowTexture(h.turns <= 1 ? 12 : 9), h.x, h.y - tex.height + 1, { tint: 0xff3a2a, alpha: 0.8 * m.fade })
    }
    for (const f of this.flashes) glow.sprite(glowTexture(16), f.x, f.y, { tint: f.color, alpha: 1 - f.age / 0.25 })
  }
}
