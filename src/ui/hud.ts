// HUD C, "tablero Broforce" (pulido v2): un canvas de 800×450 sobre el del juego, escalado igual y pixelado.
// Referencia aprobada: scripts/lookdev/hud-proposals.mjs, propuesta C (preview/hud-c.png).
//
// Disposición (coordenadas lógicas):
// - Abajo, a lo ancho y de HUD_BAR_H de alto, el tablero con los datos del que tiene el turno:
//   retrato + nombre + vida + escudo | ÁNG | POT | VIENTO | COMB (◀ ▶) | las 8 armas.
// - Arriba a la izquierda: ronda y plata, y al lado la fila de ítems (botones de 22 con su tecla).
// - Arriba al centro: el minimapa (mapas que scrollean) y debajo, en una sola columna centrada, los
//   carteles: estado ("TU TURNO", …), aviso o cartel de muerte súbita y "ESPERANDO A …" de la red.
// - Arriba a la derecha: las placas compactas de los demás tanques apiladas, y debajo de ellas el panel
//   de red (código de sala, peers con ping) y la cuenta regresiva del turno. v2.3: con 5 a 8 tanques las
//   placas se reparten en dos columnas espejadas (la izquierda debajo de ronda e ítems), máximo 4 por lado.
// - Flechas en los bordes hacia los tanques fuera de cámara, entre los paneles de arriba de cada lado y el
//   tablero; se juntan o se agrupan si no entran, y la del tanque del turno va en dorado y titila.
// Sin extras (demo congelado) no hay tablero ni ítems: solo las placas de todos y el estado.
import { ITEM_ORDER, SHIELD_HP, WEAPONS, type CrewId, type ItemId, type Vec2, type WeaponId } from '../sim/types'
import { HUD_BAR_H, VIEW_H, VIEW_W, type Viewport } from '../render/types'
import { uiAssets, type UiAssets } from './assets'
import { OUT, drawText, measure } from './pixelfont'
import { MinimapTerrain, drawEdgeArrows, drawMinimap, minimapLayout, minimapPoint, type MinimapLayout } from './minimap'
import {
  BRONZE,
  BRONZE_D,
  BTN,
  DARK,
  DEAD,
  FUEL,
  FUEL_HI,
  FUEL_LOW,
  GOLD,
  GREY,
  INK,
  POW_LO,
  POW_MID,
  SHIELD,
  SHIELD_HI,
  WHITE,
  bigText,
  button,
  dial,
  divider,
  measureBig,
  mix,
  moveArrow,
  panel,
  rect,
  segBar,
  windChevrons,
  windColor,
} from './hudkit'
import type { HudControl, HudExtras, HudNet, MinimapInput } from './types'

// Tecla de cada ítem usable (el paracaídas es pasivo). La lee también el flujo de entrada.
export const ITEM_KEYS: Partial<Record<ItemId, string>> = { shield: 'Q', fuel: 'F', repair: 'R', tracer: 'T' }
const ITEM_NAMES: Record<ItemId, string> = { shield: 'ESCUDO', parachute: 'PARACAIDAS', fuel: 'COMBUSTIBLE', repair: 'REPARAR', tracer: 'TRAZADOR', jetpack: 'JETPACK', teleport: 'TELEPORT', anchor: 'ANCLA', deflector: 'DEFLECTOR' }

export interface HudSide {
  name: string
  tag: string // "P1".."P8", el mismo globo que dibuja el renderer sobre el tanque
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
  others: HudSide[] // el resto de los tanques
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
  showBar: boolean // controles (armas, ítems, mover) activos: solo en el turno de un humano de esta pantalla
  extras?: HudExtras // ronda, plata, ítems; ausente en el demo congelado (sin tablero)
}

const PIPS = 6
// vida: verde, amarilla y roja
const HP_HI = 0x5ec46a
const HP_MID = 0xf0c040
const HP_LO = 0xe0483a
// Orden de la tira weaponIcons del manifiesto (el de WeaponId en types.ts). También es el de las teclas 1-8.
export const WEAPON_SLOTS: WeaponId[] = ['normal', 'heavy', 'dirt', 'cluster', 'napalm', 'digger', 'roller', 'nuke']
const BLINK_MS = 280 // titileo del tanque del turno en el minimapa
// v2 muerte súbita
const SD_WARN_AT = 3 // el aviso "MUERTE SÚBITA EN N" aparece con calmLeft <= 3
const SD_PULSE_MS = 1400 // período del titileo suave del indicador de lava activa
const SD_STEPS = 5 // niveles del titileo (cada cambio de nivel redibuja el HUD)
const LAVA = 0xff7a2a // el mismo naranja de la lava del minimapa
const LAVA_HOT = 0xffd27a
const LAVA_DEEP = 0xd0362c

// ---------- geometría del tablero (x lógicas) ----------
// Cinco separadores; cada sección empieza 7 px después del suyo. Las armas quedan contra el borde derecho.
const BAR_Y = VIEW_H - HUD_BAR_H
const BAR_TOP = BAR_Y + 6 // fila de los rótulos
const DIV = [140, 259, 370, 477, 596]
const SEC = { ang: DIV[0] + 7, pot: DIV[1] + 7, wind: DIV[2] + 7, fuel: DIV[3] + 7, arms: DIV[4] + 6 }
const SEC_W = { ang: DIV[1] - DIV[0] - 7, pot: DIV[2] - DIV[1] - 7, wind: DIV[3] - DIV[2] - 7, fuel: DIV[4] - DIV[3] - 7 }
const SLOT_GAP = 2
const DIAL_R = 17
const ITEM_STEP = BTN + 2
// Margen táctil alrededor de cada botón, en px lógicos (≈ 8 px CSS a ×2). Entre vecinos gana el más cercano.
const TOUCH = 4
// Placas de los demás tanques. v2.3: desde SPLIT_AT placas se reparten en dos columnas compactas (izquierda
// y derecha), más juntas, con el Pn en un chip al costado y el nombre recortado a PLATE_NAME_MAX.
const PLATE_H = 20
const PLATE_STEP = 30
const PLATE_STEP_DENSE = 24
const SPLIT_AT = 4
const PLATE_NAME_MAX = 56

interface HitBox {
  x: number
  y: number
  w: number
  h: number
  ctl: HudControl
}

export class Hud implements MinimapInput {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private key = ''
  private vp: Viewport | null = null
  private mm: MinimapLayout | null = null // dónde quedó el minimapa en el último dibujo
  private mmTerrain = new MinimapTerrain()
  private hits: HitBox[] = [] // controles activos del último dibujo

  constructor(private root: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = VIEW_W
    this.canvas.height = VIEW_H
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
    const now = performance.now()
    const ex = model.extras ?? null
    const mm = ex?.minimap ?? null
    // la grilla no entra en la clave (son bytes); su cambio lo marca terrainVersion
    const blink = !!mm && mm.tanks.some((t) => t.current && t.alive) && Math.floor(now / BLINK_MS) % 2 === 0
    // muerte súbita activa: el indicador titila suave; el nivel del pulso entra en la clave
    const sd = ex?.suddenDeath ?? null
    const pulse = sd?.active ? sdPulse(now) : -1
    const assets = uiAssets()
    const sock = ex ? sockFrame(model.wind, now, assets.windsock?.frames ?? 7) : -1
    const key = JSON.stringify(model, (k, v) => (k === 'terrain' ? undefined : v)) + (blink ? '*' : '') + pulse + '/' + sock
    if (key === this.key) return
    this.key = key
    const ctx = this.ctx
    ctx.clearRect(0, 0, VIEW_W, VIEW_H)
    this.hits = []

    // el tablero muestra al que tiene el turno; las placas, a todos los demás (sin tablero, a todos)
    const sides = [model.human, model.rival, ...model.others].filter((s): s is HudSide => !!s)
    const subject = ex ? (sides.find((s) => s.active) ?? model.human ?? model.rival) : null
    const plates = sides.filter((s) => s !== subject).sort((a, b) => tagNum(a) - tagNum(b))

    // arriba a la izquierda: ronda, plata e ítems
    const leftBottom = ex ? this.roundAndItems(assets, ex, model.showBar) : 3

    // arriba al centro: minimapa y la columna de carteles debajo
    this.mm = mm ? minimapLayout(mm.terrain) : null
    let below = 6
    if (mm && this.mm) {
      drawMinimap(ctx, this.mm, mm, this.mmTerrain.image(mm.terrain, mm.terrainVersion), blink)
      below = this.mm.y + this.mm.h + 3 + 4
    }
    if (model.status) below = this.banner(assets, model.status.toUpperCase(), below, GOLD) + 3
    if (sd) below = this.suddenDeath(assets, sd, below, pulse)
    if (ex?.net?.waiting) {
      const text = ex.net.waiting.toUpperCase().replace(/…/g, '...')
      below = this.banner(assets, text, below + 1, /RECONECT|DESCONECT/.test(text) ? 0xff8a6a : GOLD, BRONZE) + 3
    }

    // placas: arriba a la derecha (y con 5 o más tanques también a la izquierda, debajo de los ítems);
    // debajo de la columna derecha, la red
    const pl = this.plates(assets, plates, leftBottom)
    let rightBottom = pl.right
    if (ex?.net) rightBottom = this.net(assets, ex.net, rightBottom + 6)

    if (subject) this.board(assets, model, subject, ex?.shield ?? 0, sock)
    if (mm) {
      // las flechas de cada borde arrancan debajo de lo que haya arriba de ese lado
      const pad = Math.max(10, assets.font.h + 4)
      const lim = { leftTop: (pl.left ?? leftBottom) + pad, rightTop: rightBottom + pad, bottom: (subject ? BAR_Y : VIEW_H) - 12 }
      drawEdgeArrows(ctx, assets.font, mm, lim, blink)
    }
  }

  // Punto de la ventana → mundo si cae sobre el minimapa (con margen táctil); si no, null.
  minimapAt(clientX: number, clientY: number): Vec2 | null {
    const mm = this.mm
    if (!mm || !this.vp || this.root.hidden) return null
    const p = this.toLogical(clientX, clientY)
    return p ? minimapPoint(mm, p.x, p.y) : null
  }

  // Control del HUD bajo un punto de la ventana: arma (8 ranuras), ítem usable (escudo, combustible,
  // reparar, trazador; el paracaídas es pasivo) o mover ◀ ▶. Solo en el turno de un humano de esta
  // pantalla (showBar). Cada botón de 22 cuenta con TOUCH px lógicos de margen alrededor; si el punto cae
  // en el margen de dos vecinos, gana el centro más cercano. Devuelve también armas sin munición e ítems
  // en 0 (el flujo decide si los ignora), así el toque no se cuela al mundo. Fuera de todo: null.
  controlAt(clientX: number, clientY: number): HudControl | null {
    if (!this.vp || this.root.hidden || !this.hits.length) return null
    const p = this.toLogical(clientX, clientY)
    if (!p) return null
    let best: HitBox | null = null
    let bestD = Infinity
    for (const b of this.hits) {
      if (p.x < b.x - TOUCH || p.x >= b.x + b.w + TOUCH || p.y < b.y - TOUCH || p.y >= b.y + b.h + TOUCH) continue
      const d = Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2))
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best ? best.ctl : null
  }

  // Arma bajo un punto de la ventana (clientX/Y), o null. Compatibilidad: delega en controlAt.
  weaponAt(clientX: number, clientY: number): WeaponId | null {
    const c = this.controlAt(clientX, clientY)
    return c?.kind === 'weapon' ? c.id : null
  }

  private toLogical(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.root.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return { x: ((clientX - rect.left) / rect.width) * VIEW_W, y: ((clientY - rect.top) / rect.height) * VIEW_H }
  }

  // ---------- tablero inferior ----------

  private board(assets: UiAssets, model: HudModel, who: HudSide, shield: number, sock: number): void {
    const ctx = this.ctx
    const font = assets.font
    const y0 = BAR_Y
    const top = BAR_TOP
    // franja: contorno, filo de bronce con remaches y fondo oscuro
    rect(ctx, 0, y0, VIEW_W, HUD_BAR_H, OUT)
    rect(ctx, 0, y0 + 1, VIEW_W, 2, BRONZE)
    rect(ctx, 0, y0 + 3, VIEW_W, 1, BRONZE_D)
    rect(ctx, 0, y0 + 4, VIEW_W, HUD_BAR_H - 4, DARK)
    for (let x = 6; x < VIEW_W; x += 40) {
      rect(ctx, x, y0 + 1, 2, 2, BRONZE_D)
      rect(ctx, x, y0 + 1, 1, 1, mix(BRONZE, WHITE, 0.4))
    }
    for (const d of DIV) divider(ctx, d, top - 1, HUD_BAR_H - 8)
    const label = (s: string, x: number) => drawText(ctx, font, s, x, top + 1, GREY)
    // fuera del apuntado (vuelo, IA pensando) los números se apagan un poco
    const dimmed = !model.showAim
    const tone = (c: number) => (dimmed ? mix(c, GREY, 0.45) : c)

    // --- retrato, nombre, vida y escudo
    this.portrait(assets, who, 4, top + 2, 36, false)
    if (who.you && who.alive) {
      rect(ctx, 5, top + 3, 34, 1, GOLD)
      drawText(ctx, font, 'VOS', 22 - Math.floor(measure(font, 'VOS') / 2), top + 41, GOLD)
    } else {
      drawText(ctx, font, who.tag, 22 - Math.floor(measure(font, who.tag) / 2), top + 41, who.alive ? who.color : GREY)
    }
    const nx = 46
    drawText(ctx, font, clip(font, who.name.toUpperCase(), DIV[0] - nx - 4), nx, top + 1, who.alive ? WHITE : GREY)
    this.hpBar(assets, nx, top + 12, DIV[0] - nx - 6, 10, who.alive ? who.hp : 0, 2)
    this.shieldBar(assets, nx, top + 32, DIV[0] - nx - 6, who.alive ? shield : 0)

    // --- ÁNG: número ×3 y el dial chico a la derecha
    let x = SEC.ang
    label('ANG', x)
    const dialCx = x + SEC_W.ang - DIAL_R - 3
    this.number(assets, `${fine(model.angle)}°`, x, top + 16, tone(WHITE), dialCx - DIAL_R - 4 - x)
    dial(ctx, dialCx, top + 40, DIAL_R, model.angle, dimmed)

    // --- POT: número ×3 y barra de 10 segmentos
    x = SEC.pot
    label('POT', x)
    this.number(assets, fine(model.power), x, top + 12, tone(GOLD), SEC_W.pot - 4)
    segBar(ctx, x, top + 36, SEC_W.pot - 6, 11, model.power / 100, [POW_LO, POW_MID, GOLD], 10)

    // --- VIENTO: número ×3, chevrons según fuerza y dirección, y la manga que flamea
    x = SEC.wind
    label('VIENTO', x)
    const wind = Math.round(Math.abs(model.wind))
    if (sock >= 0) this.windsock(assets, sock, x + SEC_W.wind - 35, top - 2)
    bigText(ctx, font, `${wind}`, x + 2, top + 12, wind === 0 ? GREY : windColor(model.wind), 3)
    windChevrons(ctx, x, top + 31, Math.round(model.wind), 2)

    // --- COMB: bidón, barra segmentada, % y los botones ◀ ▶
    x = SEC.fuel
    const fw = SEC_W.fuel - 6
    const lw = label('COMB', x)
    this.itemIcon(assets, 'fuel', x + lw + 6, top - 2, model.fuel <= 0)
    const fuel = Math.max(0, Math.min(1, model.fuel))
    const low = fuel < 0.25
    segBar(ctx, x, top + 12, fw, 10, fuel, low ? [FUEL_LOW, 0xff7a5a, 0xffc0a0] : [FUEL, FUEL_HI, 0xd8ffb0], 6)
    const canMove = model.showBar && fuel > 0
    const by = top + 26
    for (const dir of [-1, 1] as const) {
      const bx = dir < 0 ? x : x + fw - BTN
      button(ctx, font, bx, by, BTN, { on: canMove, key: dir < 0 ? 'A' : 'D' })
      moveArrow(ctx, bx + 7 + (dir > 0 ? 1 : 0), by + 6, dir, canMove ? WHITE : GREY)
      if (model.showBar) this.hits.push({ x: bx, y: by, w: BTN, h: BTN, ctl: { kind: 'move', dir } })
    }
    const pct = `${Math.round(fuel * 100)}%`
    drawText(ctx, font, pct, x + Math.floor((fw - measure(font, pct)) / 2), by + 8, low ? 0xff7a5a : FUEL_HI)

    // --- ARMAS: nombre y munición del arma elegida arriba, las 8 ranuras abajo
    x = SEC.arms
    const name = (WEAPONS[model.weapon]?.name ?? model.weapon).toUpperCase()
    const w0 = drawText(ctx, font, name, x + 1, top + 1, WHITE)
    if (model.ammo < 50) drawText(ctx, font, `x${model.ammo}`, x + w0 + 6, top + 1, model.ammo > 0 ? GOLD : FUEL_LOW)
    WEAPON_SLOTS.forEach((id, i) => {
      const sx = x + i * (BTN + SLOT_GAP)
      const sy = top + 11
      this.weaponSlot(assets, id, i, sx, sy, model.ammoAll[id] ?? 0, id === model.weapon)
      if (model.showBar) this.hits.push({ x: sx, y: sy, w: BTN, h: BTN, ctl: { kind: 'weapon', id } })
    })
  }

  // Número grande del tablero en ×3. Si no entra en maxW (ángulo con décimas), la parte decimal y el
  // "°" van en ×2 apoyados en la misma base; si ni así entra, todo en ×2.
  private number(assets: UiAssets, text: string, x: number, y: number, color: number, maxW: number): void {
    const ctx = this.ctx
    const font = assets.font
    if (measureBig(font, text, 3) <= maxW) {
      bigText(ctx, font, text, x, y, color, 3)
      return
    }
    const cut = text.search(/[,°]/)
    const head = cut < 0 ? text : text.slice(0, cut)
    const tail = cut < 0 ? '' : text.slice(cut)
    const hw = measureBig(font, head, 3)
    if (hw + 3 + measureBig(font, tail, 2) <= maxW) {
      bigText(ctx, font, head, x, y, color, 3)
      bigText(ctx, font, tail, x + hw + 3, y + font.h, color, 2)
      return
    }
    bigText(ctx, font, text, x, y + font.h, color, 2)
  }

  private weaponSlot(assets: UiAssets, id: WeaponId, i: number, x: number, y: number, ammo: number, sel: boolean): void {
    const ctx = this.ctx
    const font = assets.font
    button(ctx, font, x, y, BTN, { on: ammo > 0, sel })
    // tecla arriba a la izquierda (chica y apagada), ícono corrido a la derecha, munición abajo
    drawText(ctx, font, `${i + 1}`, x + 3, y + 3, sel ? GOLD : ammo > 0 ? GREY : DEAD)
    this.icon(assets, id, x + 7, y + 3, ammo <= 0)
    if (ammo > 0 && ammo < 50) {
      const t = `${ammo}`
      drawText(ctx, font, t, x + 19 - measure(font, t), y + 15, WHITE)
    }
  }

  // Escudo: ícono, barra azul de SHIELD_HP y el número.
  // Vida de 0 a 100: barra continua (verde, amarilla bajo 60, roja bajo 30) y el número a la derecha (×sc).
  private hpBar(assets: UiAssets, x: number, y: number, w: number, h: number, hp: number, sc: number): void {
    const font = assets.font
    const v = Math.max(0, Math.min(100, Math.ceil(hp)))
    const c = v > 60 ? HP_HI : v > 30 ? HP_MID : HP_LO
    const n = `${v}`
    const nw = measure(font, n) * sc
    const ny = y + Math.floor((h - font.h * sc) / 2)
    // segmentos solo en la barra grande; en las placas, con 5 px de alto, quedarían como rayitas
    segBar(this.ctx, x, y, w - nw - 4, h, v / 100, [mix(c, OUT, 0.35), c, mix(c, WHITE, 0.45)], sc > 1 ? 10 : 0)
    if (sc > 1) bigText(this.ctx, font, n, x + w - nw, ny, v > 0 ? c : GREY, sc)
    else drawText(this.ctx, font, n, x + w - nw, ny, v > 0 ? c : GREY)
  }

  private shieldBar(assets: UiAssets, x: number, y: number, w: number, sh: number): void {
    const font = assets.font
    const n = `${Math.ceil(Math.max(0, sh))}`
    this.itemIcon(assets, 'shield', x, y - 3, sh <= 0)
    const nw = measure(font, n)
    segBar(this.ctx, x + 14, y, w - 14 - nw - 4, 6, sh / SHIELD_HP, [SHIELD, SHIELD_HI, 0xd8ecff])
    drawText(this.ctx, font, n, x + w - nw, y, sh > 0 ? SHIELD_HI : GREY)
  }

  private windsock(assets: UiAssets, frame: number, x: number, y: number): void {
    const s = assets.windsock
    if (!s) return
    this.ctx.drawImage(s.img, frame * s.w, 0, s.w, s.h, x, y, s.w, s.h)
  }

  // ---------- arriba a la izquierda ----------

  // Ronda y plata en un panel, y a su derecha los 5 ítems en botones de 22. Devuelve la y de abajo.
  private roundAndItems(assets: UiAssets, ex: HudExtras, active: boolean): number {
    const ctx = this.ctx
    const font = assets.font
    const r = `RONDA ${ex.round}/${ex.rounds}`
    const m = `$${ex.money}`
    const x0 = 3
    const y0 = 3
    const w = Math.max(measure(font, r), measure(font, m)) + 12
    const h = Math.max(24, font.h * 2 + 12)
    panel(ctx, x0, y0, w, h)
    drawText(ctx, font, r, x0 + 6, y0 + 5, GREY)
    drawText(ctx, font, m, x0 + 6, y0 + 8 + font.h, GOLD)
    let ix = x0 + w + 3
    for (const id of ITEM_ORDER) {
      const n = ex.items[id] ?? 0
      const key = ITEM_KEYS[id] ?? ''
      // el trazador encendido queda marcado en dorado
      button(ctx, font, ix, y0 + 1, BTN, { on: n > 0, sel: id === 'tracer' && ex.tracer, key })
      this.itemIcon(assets, id, ix + 3, y0 + 6, n <= 0)
      const t = `${n}`
      drawText(ctx, font, t, ix + 19 - measure(font, t), y0 + 16, n > 0 ? WHITE : 0x6a625a)
      if (active && key) this.hits.push({ x: ix, y: y0 + 1, w: BTN, h: BTN, ctl: { kind: 'item', id } })
      ix += ITEM_STEP
    }
    return y0 + Math.max(h, BTN + 1)
  }

  // ---------- arriba al centro ----------

  // Cartel centrado de una línea (estado, "ESPERANDO A…"). Devuelve la y de abajo.
  private banner(assets: UiAssets, text: string, y: number, color: number, edge: number | null = null): number {
    const ctx = this.ctx
    const font = assets.font
    const w = measure(font, text)
    const x = Math.round((VIEW_W - w) / 2)
    const h = font.h + 7
    if (edge != null) {
      rect(ctx, x - 6, y, w + 12, h + 2, OUT)
      rect(ctx, x - 5, y + 1, w + 10, h, edge)
      rect(ctx, x - 4, y + 2, w + 8, h - 2, DARK)
      drawText(ctx, font, text, x, y + 4, color)
      return y + h + 2
    }
    rect(ctx, x - 5, y, w + 10, h, OUT)
    rect(ctx, x - 4, y + 1, w + 8, h - 2, DARK)
    drawText(ctx, font, text, x, y + 3, color)
    return y + h
  }

  // Muerte súbita, centrado desde y0. Antes: chip chico "MUERTE SÚBITA EN N" (solo con calmLeft <= 3).
  // Activa: cartel más grande con marco de lava que titila suave y una franja de lava abajo.
  // pulse: nivel 0..SD_STEPS-1 del titileo. Devuelve la y donde termina (y0 si no dibuja nada).
  private suddenDeath(assets: UiAssets, sd: NonNullable<HudExtras['suddenDeath']>, y0: number, pulse: number): number {
    const ctx = this.ctx
    const font = assets.font
    if (!sd.active) {
      if (sd.calmLeft > SD_WARN_AT) return y0
      const n = Math.max(0, Math.ceil(sd.calmLeft))
      const text = `MUERTE SÚBITA EN ${n}`
      const w = measure(font, text)
      const sx = Math.round((VIEW_W - w) / 2)
      const sy = y0 + 3
      // con 1 tiro de margen el borde pasa de naranja a rojo
      rect(ctx, sx - 5, sy - 3, w + 10, font.h + 6, OUT)
      rect(ctx, sx - 4, sy - 2, w + 8, font.h + 4, n <= 1 ? LAVA_DEEP : LAVA)
      rect(ctx, sx - 3, sy - 1, w + 6, font.h + 2, DARK)
      const lw = drawText(ctx, font, 'MUERTE SÚBITA EN ', sx, sy, LAVA_HOT)
      drawText(ctx, font, `${n}`, sx + lw, sy, WHITE)
      return sy + font.h + 6
    }
    const t = pulse / Math.max(1, SD_STEPS - 1) // 0..1
    const text = 'MUERTE SÚBITA'
    const w = measure(font, text)
    const bw = w + 24
    const bh = font.h + 14
    const bx = Math.round((VIEW_W - bw) / 2)
    const by = y0 + 1
    rect(ctx, bx, by, bw, bh, OUT)
    rect(ctx, bx + 1, by + 1, bw - 2, bh - 2, mix(LAVA_DEEP, LAVA, t))
    rect(ctx, bx + 2, by + 2, bw - 4, bh - 4, OUT)
    rect(ctx, bx + 3, by + 3, bw - 6, bh - 6, 0x2a0c08)
    // franja de lava al pie del cartel: superficie ondulada más clara, cuerpo naranja
    const ly = by + bh - 6
    rect(ctx, bx + 3, ly + 1, bw - 6, 2, LAVA)
    for (let x = bx + 3; x < bx + bw - 3; x++) {
      const crest = (x + Math.round(t * 4)) % 6 < 2
      rect(ctx, x, crest ? ly : ly + 1, 1, 1, mix(LAVA, LAVA_HOT, 0.6))
    }
    // gotitas de lava a los costados del texto
    const ty = by + 4
    for (const dx of [6, bw - 8]) {
      rect(ctx, bx + dx, ty + 1, 2, 2, mix(LAVA, LAVA_HOT, t))
      rect(ctx, bx + dx, ty + 3, 2, 1, LAVA_DEEP)
    }
    drawText(ctx, font, text, bx + Math.round((bw - w) / 2), ty, mix(LAVA, LAVA_HOT, t))
    return by + bh + 3
  }

  // ---------- placas de los demás tanques ----------

  // Con 1 a 3 placas (2 a 4 tanques con tablero): columna contra el borde derecho como siempre, con el Pn
  // arriba de cada placa. Con 4 o más (5 a 8 tanques; en el demo sin tablero, 4 o más tanques): dos
  // columnas compactas espejadas, la mitad (redondeando para abajo) a la izquierda, debajo de ronda e
  // ítems, y el resto a la derecha; en orden de Pn, de izquierda a derecha y de arriba abajo. Así ningún
  // costado pasa de 4 placas y las flechas de borde tienen lugar debajo de cada columna.
  // leftTop: y desde donde puede arrancar la columna izquierda. Devuelve la y de abajo de cada lado
  // (left = null si a la izquierda no hay placas).
  private plates(assets: UiAssets, list: HudSide[], leftTop: number): { left: number | null; right: number } {
    if (!list.length) return { left: null, right: 3 }
    if (list.length < SPLIT_AT) return { left: null, right: this.plateStack(assets, list) }
    const nLeft = Math.floor(list.length / 2)
    const left = this.plateColumn(assets, list.slice(0, nLeft), -1, leftTop + 6)
    const right = this.plateColumn(assets, list.slice(nLeft), 1, 4)
    return { left, right }
  }

  // Columna clásica (2 a 4 tanques): nombre, pips y retrato de 16, con el Pn (y VOS) arriba.
  private plateStack(assets: UiAssets, list: HudSide[]): number {
    const ctx = this.ctx
    const font = assets.font
    const right = VIEW_W - 3
    let y = font.h + 7
    for (const side of list) {
      const name = side.name.toUpperCase()
      const bw = Math.max(PIPS * 6 + 8, measure(font, name) + 10)
      const bx = right - (PLATE_H - 1) - bw
      this.plateBody(assets, side, bx, y, bw, name)
      this.portrait(assets, side, bx + bw - 1, y, PLATE_H, true)
      // número de jugador: el mismo "Pn" del globo sobre el tanque; el humano de esta pantalla, con VOS
      const tw = measure(font, side.tag)
      const tx = right - tw - 1
      rect(ctx, tx - 2, y - font.h - 3, tw + 4, font.h + 3, OUT)
      drawText(ctx, font, side.tag, tx, y - font.h - 2, side.alive ? side.color : GREY)
      if (side.you) {
        const vw = measure(font, 'VOS')
        rect(ctx, tx - vw - 7, y - font.h - 3, vw + 4, font.h + 3, OUT)
        drawText(ctx, font, 'VOS', tx - vw - 5, y - font.h - 2, GOLD)
      }
      y += PLATE_STEP
    }
    return y - PLATE_STEP + PLATE_H
  }

  // Columna compacta pegada a un borde (dir −1 izquierda, 1 derecha): retrato hacia afuera, el cuerpo
  // con nombre y vida, y el Pn en un chip hacia adentro (borde dorado si es el humano de esta pantalla).
  // Todas las placas de la columna miden lo mismo (el nombre más largo, con tope; los demás se recortan)
  // para que los chips queden alineados. Devuelve la y de abajo.
  private plateColumn(assets: UiAssets, list: HudSide[], dir: -1 | 1, y0: number): number {
    const ctx = this.ctx
    const font = assets.font
    let nameW = 0
    for (const s of list) nameW = Math.max(nameW, measure(font, s.name.toUpperCase()))
    nameW = Math.min(nameW, PLATE_NAME_MAX)
    const bw = Math.max(PIPS * 6 + 8, nameW + 10)
    const tw = measure(font, 'P8') // chip de ancho fijo
    // x del retrato y del cuerpo según el lado; el retrato se superpone 1 px con el cuerpo
    const px = dir > 0 ? VIEW_W - 3 - PLATE_H : 3
    const bx = dir > 0 ? px - bw + 1 : px + PLATE_H - 1
    const tx = dir > 0 ? bx - tw - 5 : bx + bw + 5
    let y = y0
    for (const side of list) {
      this.plateBody(assets, side, bx, y, bw, clip(font, side.name.toUpperCase(), nameW))
      // retrato mirando hacia el centro de la pantalla
      this.portrait(assets, side, px, y, PLATE_H, dir > 0)
      const ty = y + Math.floor((PLATE_H - font.h) / 2)
      rect(ctx, tx - 2, ty - 2, tw + 4, font.h + 4, side.you ? GOLD : OUT)
      rect(ctx, tx - 1, ty - 1, tw + 2, font.h + 2, OUT)
      drawText(ctx, font, side.tag, tx + Math.floor((tw - measure(font, side.tag)) / 2), ty, side.alive ? side.color : GREY)
      y += PLATE_STEP_DENSE
    }
    return y - PLATE_STEP_DENSE + PLATE_H
  }

  // Cuerpo de una placa: panel del color del jugador (gris si murió), nombre, barra de vida y, si tiene
  // el turno (solo pasa en el demo, donde no hay tablero), la raya dorada encima.
  private plateBody(assets: UiAssets, side: HudSide, bx: number, y: number, bw: number, name: string): void {
    const ctx = this.ctx
    panel(ctx, bx, y, bw, PLATE_H, side.alive ? side.color : DEAD)
    drawText(ctx, assets.font, name, bx + 5, y + 4, side.alive ? WHITE : GREY)
    this.hpBar(assets, bx + 5, y + PLATE_H - 8, bw - 10, 5, side.alive ? side.hp : 0, 1)
    if (side.active && side.alive) {
      rect(ctx, bx + 2, y - 2, bw - 4, 1, OUT)
      rect(ctx, bx + 2, y - 3, bw - 4, 1, GOLD)
    }
  }

  // ---------- arriba a la derecha ----------

  // Panel de red debajo de las placas, contra el borde derecho: código de sala, peers con conexión y
  // ping, y debajo la cuenta regresiva del turno. Devuelve la y de abajo.
  private net(assets: UiAssets, net: HudNet, y0: number): number {
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
    const x0 = VIEW_W - 3 - w
    panel(ctx, x0, y0, w, h)
    drawText(ctx, font, code, x0 + 5, y0 + 4, GOLD)
    let y = y0 + 4 + font.h + 4
    for (const r of rows) {
      rect(ctx, x0 + 5, y + 1, 5, 5, OUT)
      rect(ctx, x0 + 6, y + 2, 3, 3, r.ok ? 0x3ac04a : 0xd0362c)
      drawText(ctx, font, r.name, x0 + 14, y, r.ok ? WHITE : GREY)
      const pw = measure(font, r.ping)
      const slow = r.ok && r.ping !== '--' && Number.parseInt(r.ping, 10) > 250
      drawText(ctx, font, r.ping, x0 + w - 5 - pw, y, !r.ok ? 0xd0362c : slow ? 0xff6a3a : GREY)
      y += font.h + 3
    }
    let bottom = y0 + h
    if (net.turnLeft != null) {
      const secs = Math.max(0, Math.ceil(net.turnLeft))
      const urgent = secs <= 10
      const text = String(secs)
      const scale = 2 // en ×3 los huecos de los dígitos se tapan con el contorno; la urgencia la da el rojo
      const tw = measureBig(font, text, scale)
      const bw = Math.max(tw + 12, 30)
      const bh = font.h * scale + 9
      const bx = VIEW_W - 3 - bw
      const by = bottom + 3
      panel(ctx, bx, by, bw, bh, urgent ? 0xd0362c : BRONZE, urgent ? 0x3a0e0a : DARK)
      bigText(ctx, font, text, bx + Math.floor((bw - tw) / 2), by + 4, urgent ? 0xff5a4a : WHITE, scale)
      bottom = by + bh
    }
    return bottom
  }

  // ---------- piezas ----------

  // Retrato con marco del color del jugador; s = 36 (32 px de retrato) o 20 (retrato a 16).
  private portrait(assets: UiAssets, side: HudSide, x: number, y: number, s: number, flip: boolean): void {
    const ctx = this.ctx
    rect(ctx, x, y, s, s, OUT)
    rect(ctx, x + 1, y + 1, s - 2, s - 2, side.alive ? side.color : DEAD)
    rect(ctx, x + 2, y + 2, s - 4, s - 4, INK)
    const img = assets.portraits[side.crew]
    const ps = s - 4
    ctx.save()
    if (!side.alive) ctx.filter = 'grayscale(1) brightness(0.55)'
    if (img) {
      if (flip) {
        ctx.translate(x + 2 + ps, y + 2)
        ctx.scale(-1, 1)
        ctx.drawImage(img, 0, 0, ps, ps)
      } else {
        ctx.drawImage(img, x + 2, y + 2, ps, ps)
      }
    } else {
      silhouette(ctx, x + 2, y + 2, ps, side.color)
    }
    ctx.restore()
  }

  private itemIcon(assets: UiAssets, id: ItemId, x: number, y: number, off = false): void {
    const ctx = this.ctx
    const icons = assets.itemIcons
    const index = ITEM_ORDER.indexOf(id)
    ctx.save()
    if (off) {
      ctx.globalAlpha = 0.45
      ctx.filter = 'grayscale(1)'
    }
    if (icons && index >= 0 && index < icons.frames) {
      ctx.drawImage(icons.img, index * icons.w, 0, icons.w, icons.h, x, y, 12, 12)
    } else {
      rect(ctx, x, y, 12, 12, OUT)
      rect(ctx, x + 1, y + 1, 10, 10, 0x3d8cf0)
      drawText(ctx, assets.font, ITEM_NAMES[id][0], x + 4, y + 3, WHITE, null)
    }
    ctx.restore()
  }

  private icon(assets: UiAssets, weapon: WeaponId, x: number, y: number, off = false): void {
    const ctx = this.ctx
    const icons = assets.weaponIcons
    const index = WEAPON_SLOTS.indexOf(weapon)
    ctx.save()
    if (off) {
      ctx.globalAlpha = 0.35
      ctx.filter = 'grayscale(1)'
    }
    if (icons && index >= 0 && index < icons.frames) {
      ctx.drawImage(icons.img, index * icons.w, 0, icons.w, icons.h, x, y, 12, 12)
    } else {
      // respaldo: un obús
      rect(ctx, x + 2, y + 4, 8, 5, OUT)
      rect(ctx, x + 3, y + 5, 5, 3, weapon === 'heavy' ? 0xd0362c : weapon === 'dirt' ? 0x8a5a34 : 0xb8b0a0)
      rect(ctx, x + 8, y + 5, 2, 3, GOLD)
    }
    ctx.restore()
  }
}

// Con el ajuste fino el valor puede tener décimas; se muestran solo si las hay, con coma decimal.
function fine(v: number): string {
  return Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)}` : v.toFixed(1).replace('.', ',')
}

function tagNum(s: HudSide): number {
  return Number.parseInt(s.tag.replace(/\D/g, ''), 10) || 0
}

// Recorta un texto con "." al final para que entre en w.
function clip(font: UiAssets['font'], text: string, w: number): string {
  if (measure(font, text) <= w) return text
  let t = text
  while (t.length > 1 && measure(font, `${t}.`) > w) t = t.slice(0, -1)
  return `${t}.`
}

// Cuadro de la manga de viento: el de la fuerza actual (−10..10 en `frames` pasos) y, con viento, cada
// tanto una ráfaga que la estira un cuadro más hacia el lado del viento (en el tope, la afloja uno), más
// seguido cuanto más fuerte sopla. Así flamea sin dejar de leerse la dirección.
function sockFrame(wind: number, now: number, frames: number): number {
  const base = Math.max(0, Math.min(frames - 1, Math.round(((wind + 10) / 20) * (frames - 1))))
  if (Math.abs(wind) < 0.5) return base
  const period = Math.max(160, 560 - 36 * Math.abs(wind))
  if (Math.floor(now / period) % 2 === 0) return base
  const gust = base + Math.sign(wind)
  return gust >= 0 && gust < frames ? gust : base - Math.sign(wind)
}

// Nivel del titileo de la muerte súbita activa: seno cuantizado en SD_STEPS escalones.
function sdPulse(now: number): number {
  const s = (Math.sin((now / SD_PULSE_MS) * Math.PI * 2) + 1) / 2
  return Math.min(SD_STEPS - 1, Math.floor(s * SD_STEPS))
}

function silhouette(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: number): void {
  const k = s / 32
  const r = (rx: number, ry: number, w: number, h: number, c: number) => rect(ctx, x + Math.round(rx * k), y + Math.round(ry * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), c)
  r(0, 0, 32, 32, 0x2a2220)
  r(9, 6, 14, 6, color)
  r(10, 12, 12, 10, 0xd8966c)
  r(12, 15, 2, 2, OUT)
  r(18, 15, 2, 2, OUT)
  r(6, 23, 20, 9, 0x4a5a2a)
}
