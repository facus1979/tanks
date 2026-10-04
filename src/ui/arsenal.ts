// v3: datos de vista del arsenal (16 armas y 9 ítems) compartidos por el HUD, la tienda y el flujo:
// teclas de los ítems, la tecla de cada arma, descripciones de una línea e íconos con respaldo legible.
//
// Barra de armas de 16 (HUD): dos filas de 8 en el orden de WEAPON_ORDER (fila 1: las clásicas, fila 2: las
// de v3). Teclas (las lee el flujo con weaponForKey):
// - 1 a 8 eligen la columna: el arma de la fila 1; si esa ya está elegida, alterna con la de la fila 2 de la
//   misma columna (1 → Normal, 1 otra vez → Teledirigido). Si la de la fila 1 no tiene munición y la de la
//   fila 2 sí, va directo a la de abajo.
// - Shift + 1 a 8 elige directo la de la fila 2.
// - Tab / Shift+Tab (y la rueda del mouse, y X/Y del gamepad) pasan a la siguiente / anterior con munición.
// - Click o toque en la barra: el arma bajo el puntero (Hud.controlAt / weaponAt).
import { ITEM_ORDER, WEAPON_ORDER, type ItemId, type ShopId, type WeaponId } from '../sim/types'
import type { UiAssets } from './assets'
import { OUT, drawText } from './pixelfont'

// Tecla de cada ítem usable (el paracaídas es pasivo). v3: J jetpack, K teletransporte (los dos de moverse,
// juntos), N ancla (aNcla) y E escudo deflector. Teclas que ya usa el juego y no se pueden reusar: flechas,
// A/D, espacio, Shift, M, Q/F/R/T, P, Z/X/C, Esc, 1–8, Tab.
export const ITEM_KEYS: Partial<Record<ItemId, string>> = { shield: 'Q', fuel: 'F', repair: 'R', tracer: 'T', jetpack: 'J', teleport: 'K', anchor: 'N', deflector: 'E' }
// Lo mismo por KeyboardEvent.code, para el flujo.
export const ITEM_CODES: Record<string, ItemId> = Object.fromEntries(Object.entries(ITEM_KEYS).map(([id, k]) => [`Key${k}`, id as ItemId]))

export const ITEM_NAMES: Record<ItemId, string> = {
  shield: 'ESCUDO',
  parachute: 'PARACAIDAS',
  fuel: 'COMBUSTIBLE',
  repair: 'REPARAR',
  tracer: 'TRAZADOR',
  jetpack: 'JETPACK',
  teleport: 'TELEPORT',
  anchor: 'ANCLA',
  deflector: 'DEFLECTOR',
}

// Lo nuevo de v3 (la tienda lo marca con "NUEVO").
export const NEW_IN_V3: ReadonlySet<ShopId> = new Set<ShopId>(['guided', 'bouncer', 'laser', 'mine', 'quake', 'blackhole', 'acid', 'wall', 'jetpack', 'teleport', 'anchor', 'deflector'])

// Descripción de una línea (tienda). Solo caracteres de la fuente pixel (sin tildes visibles: se limpian).
export const SHOP_DESC: Record<ShopId, string> = {
  normal: 'EL OBUS DE SIEMPRE',
  heavy: 'EXPLOSION GRANDE, MUCHO DANO',
  dirt: 'TIRA UNA BOLA DE TIERRA QUE ENTIERRA',
  cluster: 'SE PARTE EN 5 BOMBITAS EN EL AIRE',
  napalm: 'FUEGO QUE CORRE Y QUEMA LA MADERA',
  digger: 'CAVA UN TUNEL EN LA DIRECCION DEL TIRO',
  roller: 'RUEDA CUESTA ABAJO HASTA CHOCAR',
  nuke: 'LA MAS GRANDE. CUIDADO CON VOS',
  guided: 'EN LA BAJADA LO DIRIGIS CON < >',
  bouncer: 'REBOTA Y EXPLOTA EN CADA REBOTE',
  laser: 'RAYO RECTO, SIN VIENTO; LO FRENA LA PIEDRA',
  mine: 'QUEDA CLAVADA Y EXPLOTA SI PASAN CERCA',
  quake: 'SACUDE Y DERRUMBA UNA ZONA GRANDE',
  blackhole: 'CHUPA TANQUES Y ESCOMBROS AL CENTRO',
  acid: 'CORROE PIEDRA Y METAL; DEJA UN CHARCO',
  wall: 'LEVANTA UNA PARED ALTA PARA CUBRIRTE',
  shield: 'ABSORBE 30 DE DANO',
  parachute: 'ANULA EL PROXIMO GOLPE DE CAIDA',
  fuel: 'MAS COMBUSTIBLE PARA MOVERTE',
  repair: 'CURA 25 DE VIDA',
  tracer: 'MUESTRA LA TRAYECTORIA DEL PROXIMO TIRO',
  jetpack: 'SALTO HASTA UN PUNTO CERCANO',
  teleport: 'APARECES DONDE ELIJAS, LEJOS',
  anchor: 'NO TE EMPUJAN NI PATINAS HASTA TU TURNO',
  deflector: 'DESVIA EL PROXIMO PROYECTIL',
}

// Columnas y filas de la barra de armas.
export const ARMS_COLS = 8
export const ARMS_ROWS = 2

// Arma que elige la tecla de número `digit` (1..8). shift: fila 2 directa. current: el arma elegida ahora.
// ammo: munición de cada arma (para saltar a la fila 2 si la 1 está vacía). null si la tecla no aplica.
export function weaponForKey(digit: number, current: WeaponId, shift = false, ammo?: Partial<Record<WeaponId, number>>): WeaponId | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > ARMS_COLS) return null
  const top = WEAPON_ORDER[digit - 1]
  const bottom = WEAPON_ORDER[digit - 1 + ARMS_COLS]
  if (!bottom) return top ?? null
  if (shift) return bottom
  if (current === top) return bottom
  if (ammo && (ammo[top] ?? 0) <= 0 && (ammo[bottom] ?? 0) > 0) return bottom
  return top
}

// Respaldo de ícono (si el manifiesto todavía no trae el frame): letra o símbolo sobre un color propio.
const WEAPON_FALLBACK: Record<WeaponId, { ch: string; c: number }> = {
  normal: { ch: 'N', c: 0xb8b0a0 },
  heavy: { ch: 'P', c: 0xd0362c },
  dirt: { ch: 'T', c: 0x8a5a34 },
  cluster: { ch: 'R', c: 0xe0a030 },
  napalm: { ch: 'F', c: 0xff6a1c },
  digger: { ch: 'E', c: 0x9a8a70 },
  roller: { ch: 'O', c: 0x5a6a7a },
  nuke: { ch: '!', c: 0xe2c13d },
  guided: { ch: '>', c: 0xe23d3d },
  bouncer: { ch: 'B', c: 0x5ec46a },
  laser: { ch: '-', c: 0x3ad0c8 },
  mine: { ch: '*', c: 0xf0903a },
  quake: { ch: 'Z', c: 0xa0784a },
  blackhole: { ch: 'O', c: 0xa65ae0 },
  acid: { ch: 'A', c: 0x9ae03a },
  wall: { ch: 'M', c: 0xb08a5a },
}
const ITEM_FALLBACK: Record<ItemId, { ch: string; c: number }> = {
  shield: { ch: 'E', c: 0x3d8cf0 },
  parachute: { ch: 'P', c: 0xe0e0e0 },
  fuel: { ch: 'C', c: 0x3a9a3a },
  repair: { ch: '+', c: 0xe23d3d },
  tracer: { ch: '?', c: 0xffd23a },
  jetpack: { ch: 'J', c: 0xff8a3a },
  teleport: { ch: 'T', c: 0xc07aff },
  anchor: { ch: 'A', c: 0x8aa0b0 },
  deflector: { ch: 'D', c: 0x7ab8ff },
}

export function isItem(id: ShopId): id is ItemId {
  return (ITEM_ORDER as string[]).includes(id)
}

// Dibuja el ícono 12×12 de un arma o ítem en (x, y): el frame del manifiesto (weaponIcons en el orden de
// WEAPON_ORDER, itemIcons en el de ITEM_ORDER) o, si falta, el respaldo. off: apagado (sin munición).
export function drawArsenalIcon(ctx: CanvasRenderingContext2D, assets: UiAssets, id: ShopId, x: number, y: number, off = false): void {
  const item = isItem(id)
  const strip = item ? assets.itemIcons : assets.weaponIcons
  const index = item ? ITEM_ORDER.indexOf(id) : WEAPON_ORDER.indexOf(id as WeaponId)
  ctx.save()
  if (off) {
    ctx.globalAlpha = item ? 0.45 : 0.35
    ctx.filter = 'grayscale(1)'
  }
  if (strip && index >= 0 && index < strip.frames) {
    ctx.drawImage(strip.img, index * strip.w, 0, strip.w, strip.h, x, y, 12, 12)
  } else {
    const fb = item ? ITEM_FALLBACK[id] : WEAPON_FALLBACK[id as WeaponId]
    const c = fb?.c ?? 0xb8b0a0
    ctx.fillStyle = hex(OUT)
    ctx.fillRect(x, y, 12, 12)
    ctx.fillStyle = hex(c)
    ctx.fillRect(x + 1, y + 1, 10, 10)
    ctx.fillStyle = hex(0x2a2220)
    ctx.fillRect(x + 2, y + 2, 8, 8)
    const ch = fb?.ch ?? id[0].toUpperCase()
    // la letra centrada (los glifos miden 1 a 5 de ancho)
    const g = assets.font.glyphs.get(ch)
    const gw = g ? g.w : 5
    drawText(ctx, assets.font, ch, x + Math.floor((12 - gw) / 2), y + Math.floor((12 - assets.font.h) / 2), c, null)
  }
  ctx.restore()
}

function hex(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`
}
