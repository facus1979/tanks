// HUD al estilo Broforce: un canvas de 800×450 sobre el del juego, escalado igual y pixelado.
import { ITEM_ORDER, WEAPONS, WORLD_H, WORLD_W, type CrewId, type ItemId, type Vec2, type WeaponId } from '../sim/types'
import type { Viewport } from '../render/types'
import { uiAssets, type UiAssets } from './assets'
import { OUT, css, drawText, measure } from './pixelfont'
import type { HudExtras, HudNet, MinimapInput } from './types'

// Tecla de cada ítem usable (el paracaídas es pasivo). La lee también el flujo de entrada.
export const ITEM_KEYS: Partial<Record<ItemId, string>> = { shield: 'Q', fuel: 'F', repair: 'R', tracer: 'T' }
const ITEM_NAMES: Record<ItemId, string> = { shield: 'ESCUDO', parachute: 'PARACAIDAS', fuel: 'COMBUSTIBLE', repair: 'REPARAR', tracer: 'TRAZADOR' }

export interface HudSide {
  name: string
  tag: string // "P1".."P4", el mismo globo que dibuja el renderer sobre el tanque
  color: number
  crew: CrewId
  hp: number
  alive: boolean
  active: boolean
  you: boolean // el jugador humano de esta pantalla
}

export interface HudModel {
  human: HudSide | null
  rival: HudSide | null
  others: HudSide[] // el resto de los tanques (3 o 4 jugadores): placas compactas
  angle: number
  power: number
  weapon: WeaponId
  ammo: number
  wind: number
  status: string
  showAim: boolean
  // munición de las 8 armas del que tiene el turno (0 = deshabilitada)
  ammoAll: Record<WeaponId, number>
  fuel: number // 0..1 del combustible del turno
  showBar: boolean // selector y combustible: solo en el turno humano
  extras?: HudExtras // ronda, plata, ítems (F10)
}

const PIPS = 6
const DARK = 0x0e0a09
const BRONZE = 0xc4a574
const GOLD = 0xffe27a
const GREY = 0x9a8e80
// Orden de la tira weaponIcons del manifiesto (el de WeaponId en types.ts). También es el de las teclas 1-8.
export const WEAPON_SLOTS: WeaponId[] = ['normal', 'heavy', 'dirt', 'cluster', 'napalm', 'digger', 'roller', 'nuke']
const ICON_ORDER = WEAPON_SLOTS
const SLOT = 18
const BAR_W = SLOT * WEAPON_SLOTS.length + 6
const BAR_H = 38
const BOX = 16

export class Hud implements MinimapInput {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private key = ''
  private vp: Viewport | null = null
  private barVisible = false

  constructor(private root: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = WORLD_W
    this.canvas.height = WORLD_H
    this.canvas.className = 'hud-canvas'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Sin canvas 2D para el HUD')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false
    this.root.replaceChildren(this.canvas)
  }

  place(vp: Viewport): void {
    this.vp = vp
    this.root.style.left = `${vp.x}px`
    this.root.style.top = `${vp.y}px`
    this.root.style.width = `${vp.w}px`
    this.root.style.height = `${vp.h}px`
  }

  show(): void {
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  invalidate(): void {
    this.key = ''
  }

  update(model: HudModel): void {
    const key = JSON.stringify(model)
    if (key === this.key) return
    this.key = key
    const ctx = this.ctx
    const assets = uiAssets()
    ctx.clearRect(0, 0, WORLD_W, WORLD_H)
    if (model.human) this.side(assets, model.human, false)
    const right = model.rival ? this.side(assets, model.rival, true) : WORLD_W - 2
    this.compacts(assets, model.others, right, model.showBar)
    this.top(assets, model)
    if (model.extras) this.extras(assets, model.extras, model.showBar)
    if (model.extras?.net) this.net(assets, model.extras.net)
    this.barVisible = model.showBar
    if (model.showBar) this.weaponBar(assets, model)
  }

  // v2: stub del contrato; lo implementa el área vistas junto con el minimapa.
  minimapAt(_clientX: number, _clientY: number): Vec2 | null {
    return null
  }

  // Arma bajo un punto de la ventana (clientX/Y), o null.
  weaponAt(clientX: number, clientY: number): WeaponId | null {
    const vp = this.vp
    if (!vp || !this.barVisible || this.root.hidden) return null
    const rect = this.root.getBoundingClientRect()
    const lx = ((clientX - rect.left) / rect.width) * WORLD_W
    const ly = ((clientY - rect.top) / rect.height) * WORLD_H
    const bx = barX()
    const by = WORLD_H - 2 - BAR_H
    if (ly < by + 2 || ly > by + 4 + BOX + 8 || lx < bx + 3) return null
    const i = Math.floor((lx - bx - 3) / SLOT)
    return i >= 0 && i < WEAPON_SLOTS.length ? WEAPON_SLOTS[i] : null
  }

  private weaponBar(assets: UiAssets, model: HudModel): void {
    const ctx = this.ctx
    const font = assets.font
    const bx = barX()
    const by = WORLD_H - 2 - BAR_H
    rect(ctx, bx, by, BAR_W, BAR_H, OUT)
    rect(ctx, bx + 1, by + 1, BAR_W - 2, BAR_H - 2, BRONZE)
    rect(ctx, bx + 2, by + 2, BAR_W - 4, BAR_H - 4, DARK)
    WEAPON_SLOTS.forEach((id, i) => {
      const x = bx + 3 + i * SLOT
      const y = by + 3
      const ammo = model.ammoAll[id] ?? 0
      const selected = id === model.weapon
      if (selected) {
        rect(ctx, x, y, SLOT - 1, BOX, GOLD)
        rect(ctx, x + 1, y + 1, SLOT - 3, BOX - 2, 0x3a2a18)
      } else {
        rect(ctx, x, y, SLOT - 1, BOX, 0x2a2220)
      }
      ctx.save()
      if (ammo <= 0) {
        ctx.globalAlpha = 0.3
        ctx.filter = 'grayscale(1)'
      }
      this.icon(assets, id, x + 3, y + 2)
      ctx.restore()
      if (ammo > 0 && ammo < 50) {
        const t = `${ammo}`
        drawText(ctx, font, t, x + SLOT - 3 - measure(font, t), y + BOX - font.h, 0xffffff)
      }
      const n = `${i + 1}`
      drawText(ctx, font, n, x + Math.floor((SLOT - 1 - measure(font, n)) / 2), y + BOX + 2, selected ? GOLD : ammo > 0 ? GREY : 0x4a4440)
    })
    // combustible
    const fy = by + BAR_H - 10
    const label = 'COMB'
    const lw = drawText(ctx, font, label, bx + 4, fy + 1, GREY)
    const gx = bx + 8 + lw
    const gw = BAR_W - (gx - bx) - 5
    rect(ctx, gx, fy + 1, gw, 6, OUT)
    rect(ctx, gx + 1, fy + 2, gw - 2, 4, 0x2a2220)
    const fill = Math.round((gw - 2) * Math.max(0, Math.min(1, model.fuel)))
    if (fill > 0) {
      const low = model.fuel < 0.25
      rect(ctx, gx + 1, fy + 2, fill, 4, low ? 0xd0362c : 0x3a9a3a)
      rect(ctx, gx + 1, fy + 2, fill, 1, low ? 0xff7a5a : 0x9ae06a)
    }
  }

  // Devuelve la x más a la izquierda que ocupa la placa.
  private side(assets: UiAssets, side: HudSide, flip: boolean): number {
    const ctx = this.ctx
    const font = assets.font
    const size = 36
    const fx = flip ? WORLD_W - 2 - size : 2
    const fy = WORLD_H - 2 - size
    rect(ctx, fx, fy, size, size, OUT)
    rect(ctx, fx + 1, fy + 1, size - 2, size - 2, side.alive ? side.color : 0x4a4440)
    rect(ctx, fx + 2, fy + 2, size - 4, size - 4, 0x1c1614)
    const portrait = assets.portraits[side.crew]
    ctx.save()
    if (!side.alive) ctx.filter = 'grayscale(1) brightness(0.55)'
    if (portrait) {
      if (flip) {
        ctx.translate(fx + 2 + 32, fy + 2)
        ctx.scale(-1, 1)
        ctx.drawImage(portrait, 0, 0, 32, 32)
      } else {
        ctx.drawImage(portrait, fx + 2, fy + 2, 32, 32)
      }
    } else {
      silhouette(ctx, fx + 2, fy + 2, side.color)
    }
    ctx.restore()

    const name = side.name.toUpperCase()
    const bw = Math.max(80, measure(font, name) + 12)
    const bh = Math.max(22, font.h + 17)
    const bx = flip ? fx - bw + 1 : fx + size - 1
    const by = WORLD_H - 2 - bh
    rect(ctx, bx, by, bw, bh, OUT)
    rect(ctx, bx + 1, by + 1, bw - 2, bh - 2, side.alive ? side.color : 0x4a4440)
    rect(ctx, bx + 2, by + 2, bw - 4, bh - 4, DARK)
    drawText(ctx, font, name, bx + 5, by + 4, side.alive ? 0xffffff : GREY)
    const on = side.alive ? Math.ceil((Math.max(0, side.hp) / 100) * PIPS) : 0
    const pw = this.pips(assets, bx + 5, by + bh - 9, on)
    // número de jugador a la derecha de los pips: el mismo "Pn" del globo sobre el tanque
    const tw = measure(font, side.tag)
    if (bx + 5 + pw + 6 + tw < bx + bw - 4) drawText(ctx, font, side.tag, bx + bw - 5 - tw, by + bh - 9 - font.h + 5, side.alive ? side.color : GREY)
    if (side.active && side.alive) {
      rect(ctx, bx + 2, by - 2, bw - 4, 1, OUT)
      rect(ctx, bx + 2, by - 3, bw - 4, 1, GOLD)
    }
    if (side.you) {
      // pestaña "VOS" sobre el retrato: identifica al humano aunque su tanque esté a la derecha
      const label = 'VOS'
      const lw = measure(font, label)
      const th = font.h + 5
      const tw2 = Math.max(lw + 8, 24)
      const tx = flip ? fx + size - tw2 : fx
      const ty = fy - th + 1
      rect(ctx, tx, ty, tw2, th, OUT)
      rect(ctx, tx + 1, ty + 1, tw2 - 2, th - 1, GOLD)
      rect(ctx, tx + 2, ty + 2, tw2 - 4, th - 2, DARK)
      drawText(ctx, font, label, tx + Math.floor((tw2 - lw) / 2), ty + 3, GOLD)
      rect(ctx, fx + 1, fy + 1, size - 2, 1, GOLD)
    }
    return Math.min(fx, bx)
  }

  // Placas chicas del resto de los tanques: retrato de 16 + nombre + pips. Van en fila hacia la
  // izquierda desde la placa del rival; si chocarían con el selector de armas, suben una fila.
  private compacts(assets: UiAssets, list: HudSide[], right: number, bar: boolean): void {
    if (!list.length) return
    const ctx = this.ctx
    const font = assets.font
    const ps = 20
    const h = 20
    const limit = bar ? barX() + BAR_W + 4 : WORLD_W / 2 - 40
    let x = right - 4
    let y = WORLD_H - 2 - h
    for (const side of list) {
      const name = side.name.toUpperCase()
      const pipW = PIPS * 7 - 3
      const bw = Math.max(pipW + 10, measure(font, name) + 10)
      const w = ps - 1 + bw
      if (x - w < limit && x !== right - 4) {
        x = right - 4
        y -= h + 6
      }
      const bx = x - w
      const rx = bx + bw - 1 // retrato a la derecha, como la placa del rival
      const col = side.alive ? side.color : 0x4a4440
      // cuadro del nombre
      rect(ctx, bx, y, bw, h, OUT)
      rect(ctx, bx + 1, y + 1, bw - 2, h - 2, col)
      rect(ctx, bx + 2, y + 2, bw - 4, h - 4, DARK)
      drawText(ctx, font, name, bx + 5, y + 4, side.alive ? 0xffffff : GREY)
      this.pips(assets, bx + 5, y + h - 9, side.alive ? Math.ceil((Math.max(0, side.hp) / 100) * PIPS) : 0)
      // retrato
      rect(ctx, rx, y, ps, ps, OUT)
      rect(ctx, rx + 1, y + 1, ps - 2, ps - 2, col)
      rect(ctx, rx + 2, y + 2, ps - 4, ps - 4, 0x1c1614)
      const portrait = assets.portraits[side.crew]
      ctx.save()
      if (!side.alive) ctx.filter = 'grayscale(1) brightness(0.55)'
      if (portrait) {
        ctx.translate(rx + 2 + 16, y + 2)
        ctx.scale(-1, 1)
        ctx.drawImage(portrait, 0, 0, 16, 16)
      } else {
        rect(ctx, rx + 2, y + 2, 16, 16, side.color)
      }
      ctx.restore()
      // número de jugador sobre el retrato
      const tw = measure(font, side.tag)
      const tx = rx + ps - tw - 1
      rect(ctx, tx - 2, y - font.h - 2, tw + 4, font.h + 3, OUT)
      drawText(ctx, font, side.tag, tx, y - font.h - 1, side.alive ? side.color : GREY)
      if (side.active && side.alive) {
        rect(ctx, bx + 2, y - 2, bw - 4, 1, OUT)
        rect(ctx, bx + 2, y - 3, bw - 4, 1, GOLD)
      }
      x = bx - 4
    }
  }

  // Devuelve el ancho que ocupan.
  private pips(assets: UiAssets, x: number, y: number, on: number): number {
    const ctx = this.ctx
    const pip = assets.pip
    const width = pip ? PIPS * (pip.w + 3) - 3 : PIPS * 7 - 3
    for (let i = 0; i < PIPS; i++) {
      const lit = i < on
      if (pip) {
        const frame = lit ? 0 : Math.min(1, pip.frames - 1)
        ctx.drawImage(pip.img, frame * pip.w, 0, pip.w, pip.h, x + i * (pip.w + 3), y + 5 - pip.h, pip.w, pip.h)
        continue
      }
      const sx = x + i * 7
      const rows = ['.kk.', 'kyyk', 'krrk', 'krrk', 'kkkk']
      const pal: Record<string, number> = { k: OUT, y: lit ? GOLD : 0x3a3230, r: lit ? 0xd0362c : 0x2a2220 }
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          const c = pal[row[rx]]
          if (c != null) rect(ctx, sx + rx, y + ry, 1, 1, c)
        }
      })
    }
    return width
  }

  private top(assets: UiAssets, model: HudModel): void {
    const ctx = this.ctx
    const font = assets.font
    const h = Math.max(20, font.h + 13)
    const ty = Math.round((h - font.h) / 2)
    const weapon = WEAPONS[model.weapon]
    const weaponName = (weapon?.name ?? model.weapon).toUpperCase()
    const ammoText = model.ammo >= 50 ? '' : `x${model.ammo}`
    const slot = WEAPON_SLOTS.indexOf(model.weapon) + 1
    const angle = `${Math.round(model.angle)}°`
    const power = `${Math.round(model.power)}`
    const bar = 48
    const windN = Math.min(3, Math.ceil(Math.abs(model.wind) / 3.4))
    const windArrows = model.wind === 0 ? '' : (model.wind > 0 ? '>' : '<').repeat(windN)
    const windText = `${Math.abs(Math.round(model.wind))}`

    const lbl = (s: string) => measure(font, s)
    const sections: number[] = [
      lbl('ANG') + 4 + lbl('180°'),
      lbl('POT') + 4 + bar + 4 + lbl('100'),
      12 + 4 + lbl(`${slot}`) + 4 + lbl(weaponName) + (ammoText ? 4 + lbl(ammoText) : 0),
      lbl('VIENTO') + 4 + lbl('>>>') + 3 + lbl('10'),
    ]
    const pad = 7
    const total = sections.reduce((a, b) => a + b, 0) + pad * (sections.length + 1)
    const x0 = Math.round((WORLD_W - total) / 2)
    const y0 = 3
    rect(ctx, x0, y0, total, h, OUT)
    rect(ctx, x0 + 1, y0 + 1, total - 2, h - 2, BRONZE)
    rect(ctx, x0 + 2, y0 + 2, total - 4, h - 4, DARK)
    rect(ctx, x0 + 2, y0 + 2, total - 4, 1, 0x2a2220)

    let x = x0 + pad
    const dim = model.showAim ? 0xffffff : GREY
    // ángulo
    x += drawText(ctx, font, 'ANG', x, y0 + ty, GREY) + 4
    drawText(ctx, font, angle, x, y0 + ty, dim)
    x = x0 + pad + sections[0] + pad
    sep(ctx, x - Math.ceil(pad / 2) - 1, y0 + 4, h - 8)
    // potencia
    x += drawText(ctx, font, 'POT', x, y0 + ty, GREY) + 4
    const by = y0 + Math.round(h / 2) - 3
    rect(ctx, x, by, bar, 6, OUT)
    rect(ctx, x + 1, by + 1, bar - 2, 4, 0x2a2220)
    const fill = Math.round(((bar - 2) * Math.max(0, Math.min(100, model.power))) / 100)
    if (fill > 0) {
      rect(ctx, x + 1, by + 1, fill, 4, 0xe05a1c)
      rect(ctx, x + 1, by + 1, fill, 2, 0xffa23a)
      rect(ctx, x + 1, by + 1, fill, 1, GOLD)
    }
    x += bar + 4
    drawText(ctx, font, power, x, y0 + ty, dim)
    x = x0 + pad * 2 + sections[0] + sections[1] + pad
    sep(ctx, x - Math.ceil(pad / 2) - 1, y0 + 4, h - 8)
    // arma
    const iy = y0 + Math.round((h - 12) / 2)
    this.icon(assets, model.weapon, x, iy)
    x += 16
    x += drawText(ctx, font, `${slot}`, x, y0 + ty, GREY) + 4
    x += drawText(ctx, font, weaponName, x, y0 + ty, 0xffffff) + 4
    if (ammoText) drawText(ctx, font, ammoText, x, y0 + ty, model.ammo > 0 ? GOLD : 0xd0362c)
    x = x0 + pad * 3 + sections[0] + sections[1] + sections[2] + pad
    sep(ctx, x - Math.ceil(pad / 2) - 1, y0 + 4, h - 8)
    // viento
    x += drawText(ctx, font, 'VIENTO', x, y0 + ty, GREY) + 4
    const strength = Math.abs(model.wind) / 10
    const windColor = strength > 0.66 ? 0xff6a3a : strength > 0.33 ? GOLD : 0xbfe8ff
    const arrowsW = lbl('>>>')
    if (windArrows) {
      const aw = lbl(windArrows)
      drawText(ctx, font, windArrows, model.wind > 0 ? x + arrowsW - aw : x, y0 + ty, windColor)
    } else {
      drawText(ctx, font, '-', x + Math.floor(arrowsW / 2) - 1, y0 + ty, GREY)
    }
    x += arrowsW + 3
    drawText(ctx, font, windText, x, y0 + ty, 0xffffff)

    if (model.status) {
      const text = model.status.toUpperCase()
      const w = measure(font, text)
      const sx = Math.round((WORLD_W - w) / 2)
      const sy = y0 + h + 4
      rect(ctx, sx - 5, sy - 3, w + 10, font.h + 6, OUT)
      rect(ctx, sx - 4, sy - 2, w + 8, font.h + 4, DARK)
      drawText(ctx, font, text, sx, sy, GOLD)
    }
  }

  // Esquina superior izquierda: ronda y plata, y debajo los ítems con cantidad y tecla.
  private extras(assets: UiAssets, ex: HudExtras, showItems: boolean): void {
    const ctx = this.ctx
    const font = assets.font
    const round = `RONDA ${ex.round}/${ex.rounds}`
    const money = `$${ex.money}`
    const w = Math.max(measure(font, round), measure(font, money)) + 10
    const h = font.h * 2 + 12
    const x0 = 3
    const y0 = 3
    rect(ctx, x0, y0, w, h, OUT)
    rect(ctx, x0 + 1, y0 + 1, w - 2, h - 2, BRONZE)
    rect(ctx, x0 + 2, y0 + 2, w - 4, h - 4, DARK)
    drawText(ctx, font, round, x0 + 5, y0 + 4, GREY)
    drawText(ctx, font, money, x0 + 5, y0 + 6 + font.h, GOLD)
    let y = y0 + h + 3
    if (ex.shield > 0) {
      const t = `ESCUDO ${Math.ceil(ex.shield)}`
      const tw = measure(font, t) + 8
      rect(ctx, x0, y, tw, font.h + 6, OUT)
      rect(ctx, x0 + 1, y + 1, tw - 2, font.h + 4, 0x2a5aa0)
      drawText(ctx, font, t, x0 + 4, y + 3, 0xffffff)
      y += font.h + 9
    }
    if (ex.tracer) {
      const t = 'TRAZADOR'
      const tw = measure(font, t) + 8
      rect(ctx, x0, y, tw, font.h + 6, OUT)
      rect(ctx, x0 + 1, y + 1, tw - 2, font.h + 4, 0xa07a1a)
      drawText(ctx, font, t, x0 + 4, y + 3, 0xffffff)
      y += font.h + 9
    }
    if (!showItems) return
    for (const id of ITEM_ORDER) {
      const n = ex.items[id] ?? 0
      const key = ITEM_KEYS[id]
      const label = `x${n}`
      const cw = 12 + 4 + measure(font, label) + (key ? 4 + measure(font, key) + 6 : 0) + 6
      rect(ctx, x0, y, cw, 16, OUT)
      rect(ctx, x0 + 1, y + 1, cw - 2, 14, n > 0 ? 0x2a2220 : 0x14100e)
      ctx.save()
      if (n <= 0) ctx.globalAlpha = 0.35
      this.itemIcon(assets, id, x0 + 3, y + 2)
      ctx.restore()
      let tx = x0 + 3 + 12 + 4
      tx += drawText(ctx, font, label, tx, y + 5, n > 0 ? 0xffffff : 0x6a625a) + 4
      if (key) {
        rect(ctx, tx, y + 3, measure(font, key) + 4, font.h + 4, n > 0 ? GOLD : 0x4a4440)
        drawText(ctx, font, key, tx + 2, y + 5, DARK, null)
      }
      y += 17
    }
  }


  // Esquina superior derecha: código de sala, peers con conexión y ping, cuenta regresiva del turno.
  // Debajo del panel superior, centrado: "ESPERANDO A <NOMBRE>...".
  private net(assets: UiAssets, net: HudNet): void {
    const ctx = this.ctx
    const font = assets.font
    const code = net.code
    const rows = net.peers.map((p) => ({
      name: p.name.toUpperCase(),
      ping: p.connected ? (p.ping == null ? '--' : `${Math.round(p.ping)}MS`) : 'OFF',
      ok: p.connected,
    }))
    let inner = measure(font, code)
    for (const r of rows) inner = Math.max(inner, 9 + measure(font, r.name) + 8 + measure(font, r.ping))
    const w = inner + 10
    const h = 4 + font.h + (rows.length ? 4 + rows.length * (font.h + 3) : 0) + 4
    const x0 = WORLD_W - 3 - w
    const y0 = 3
    rect(ctx, x0, y0, w, h, OUT)
    rect(ctx, x0 + 1, y0 + 1, w - 2, h - 2, BRONZE)
    rect(ctx, x0 + 2, y0 + 2, w - 4, h - 4, DARK)
    drawText(ctx, font, code, x0 + 5, y0 + 4, GOLD)
    let y = y0 + 4 + font.h + 4
    for (const r of rows) {
      rect(ctx, x0 + 5, y + 1, 5, 5, OUT)
      rect(ctx, x0 + 6, y + 2, 3, 3, r.ok ? 0x3ac04a : 0xd0362c)
      drawText(ctx, font, r.name, x0 + 14, y, r.ok ? 0xffffff : GREY)
      const pw = measure(font, r.ping)
      const slow = r.ok && r.ping !== '--' && Number.parseInt(r.ping, 10) > 250
      drawText(ctx, font, r.ping, x0 + w - 5 - pw, y, !r.ok ? 0xd0362c : slow ? 0xff6a3a : GREY)
      y += font.h + 3
    }
    let below = y0 + h + 3
    if (net.turnLeft != null) {
      const secs = Math.max(0, Math.ceil(net.turnLeft))
      const urgent = secs <= 10
      const text = String(secs)
      const scale = urgent ? 3 : 2
      const tw = measure(font, text) * scale
      const bw = Math.max(tw + 12, 30)
      const bh = (font.h + 2) * scale + 6
      const bx = WORLD_W - 3 - bw
      rect(ctx, bx, below, bw, bh, OUT)
      rect(ctx, bx + 1, below + 1, bw - 2, bh - 2, urgent ? 0xd0362c : BRONZE)
      rect(ctx, bx + 2, below + 2, bw - 4, bh - 4, urgent ? 0x3a0e0a : DARK)
      bigText(ctx, font, text, bx + Math.floor((bw - tw) / 2), below + 3, scale, urgent ? 0xff5a4a : 0xffffff)
      below += bh + 3
    }
    if (net.waiting) {
      const text = net.waiting.toUpperCase().replace(/…/g, '...')
      const tw = measure(font, text)
      const sx = Math.round((WORLD_W - tw) / 2)
      const sy = 44
      rect(ctx, sx - 6, sy - 4, tw + 12, font.h + 8, OUT)
      rect(ctx, sx - 5, sy - 3, tw + 10, font.h + 6, BRONZE)
      rect(ctx, sx - 4, sy - 2, tw + 8, font.h + 4, DARK)
      drawText(ctx, font, text, sx, sy, /RECONECT|DESCONECT/.test(text) ? 0xff8a6a : GOLD)
    }
  }
  private itemIcon(assets: UiAssets, id: ItemId, x: number, y: number): void {
    const ctx = this.ctx
    const icons = assets.itemIcons
    const index = ITEM_ORDER.indexOf(id)
    if (icons && index >= 0 && index < icons.frames) {
      ctx.drawImage(icons.img, index * icons.w, 0, icons.w, icons.h, x, y, 12, 12)
      return
    }
    rect(ctx, x, y, 12, 12, OUT)
    rect(ctx, x + 1, y + 1, 10, 10, 0x3d8cf0)
    drawText(ctx, assets.font, ITEM_NAMES[id][0], x + 4, y + 3, 0xffffff, null)
  }

  private icon(assets: UiAssets, weapon: WeaponId, x: number, y: number): void {
    const ctx = this.ctx
    const icons = assets.weaponIcons
    const index = ICON_ORDER.indexOf(weapon)
    if (icons && index >= 0 && index < icons.frames) {
      ctx.drawImage(icons.img, index * icons.w, 0, icons.w, icons.h, x, y, 12, 12)
      return
    }
    // respaldo: un obús
    rect(ctx, x + 2, y + 4, 8, 5, OUT)
    rect(ctx, x + 3, y + 5, 5, 3, weapon === 'heavy' ? 0xd0362c : weapon === 'dirt' ? 0x8a5a34 : 0xb8b0a0)
    rect(ctx, x + 8, y + 5, 2, 3, GOLD)
  }
}

function barX(): number {
  return Math.round((WORLD_W - BAR_W) / 2)
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.fillStyle = css(c)
  ctx.fillRect(x, y, w, h)
}

function sep(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  rect(ctx, x, y, 1, h, 0x3a3028)
}

function silhouette(ctx: CanvasRenderingContext2D, x: number, y: number, color: number): void {
  rect(ctx, x, y, 32, 32, 0x2a2220)
  rect(ctx, x + 9, y + 6, 14, 6, color)
  rect(ctx, x + 10, y + 12, 12, 10, 0xd8966c)
  rect(ctx, x + 12, y + 15, 2, 2, OUT)
  rect(ctx, x + 18, y + 15, 2, 2, OUT)
  rect(ctx, x + 6, y + 23, 20, 9, 0x4a5a2a)
}

// Texto ampliado por un factor entero (cuenta regresiva).
function bigText(ctx: CanvasRenderingContext2D, font: UiAssets['font'], text: string, x: number, y: number, scale: number, color: number): void {
  const w = measure(font, text) + 2
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = font.h + 2
  const t = tmp.getContext('2d')
  if (!t) return
  drawText(t, font, text, 0, 0, color)
  ctx.drawImage(tmp, 0, 0, w, tmp.height, x, y, w * scale, tmp.height * scale)
}
