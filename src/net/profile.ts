// v3 perfil en la sala: nombre, tripulante y color de cada casillero.
//
// Reglas (las aplica el anfitrión; el flujo y las vistas pueden usar cleanName para mostrar lo mismo
// antes de mandarlo):
// - Nombre: sin tildes (Ñ → N), solo los caracteres que tiene la fuente pixel del juego
//   (letras, dígitos, espacio y . , : ! ? - / % +), espacios repetidos colapsados, recortado a
//   NAME_MAX. Vacío → el nombre del tripulante.
// - Tripulante: cualquiera de CREWS; se pueden repetir entre casilleros (el color los distingue).
// - Color: índice en TANK_COLORS. Los 8 casilleros de la sala tienen SIEMPRE una permutación de los
//   8 colores (también los 'off'), así nunca hay dos tanques del mismo color. Si el color pedido lo
//   tiene un casillero 'off', se intercambian. Si lo tiene un casillero ocupado (humano o IA), NO se
//   rechaza: se asigna el siguiente libre (pedido + 1, + 2… en ronda) intercambiándolo con el 'off'
//   que lo tenía; si no hay ninguno libre (8 ocupados), el casillero conserva el suyo. El cliente ve
//   el color que le quedó en el lobby (no hay 'reject' por color tomado: es la regla más amable para
//   una sala casual y evita un ida y vuelta).
import { CREWS, NAME_MAX, TANK_COLORS } from '../sim'
import type { CrewId } from '../sim'
import type { LobbySlot } from './types'

const FONT_CHARS = /[^A-Za-z0-9 .,:!?\-/%+]/g

// Nombre saneado a la fuente del juego y recortado a NAME_MAX ('' si no queda nada).
export function cleanName(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(FONT_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim()
}

export function isCrew(crew: unknown): crew is CrewId {
  return typeof crew === 'string' && (CREWS as string[]).includes(crew)
}

export function isColor(color: unknown): color is number {
  return Number.isInteger(color) && (color as number) >= 0 && (color as number) < TANK_COLORS.length
}

// Asigna a slots[i] el color pedido o el siguiente libre (ver arriba). Mantiene la permutación.
// Devuelve el color que le quedó.
export function assignColor(slots: LobbySlot[], i: number, want: number): number {
  const me = slots[i]
  const mine = me.color ?? i
  const n = TANK_COLORS.length
  for (let k = 0; k < n; k++) {
    const c = (want + k) % n
    if (c === mine) return mine
    const j = slots.findIndex((s, idx) => idx !== i && (s.color ?? idx) === c)
    if (j < 0) {
      me.color = c // nadie lo tiene (no debería pasar con la permutación, pero por las dudas)
      return c
    }
    if (slots[j].kind !== 'off') continue // tomado por un casillero ocupado: probar el siguiente
    slots[j].color = mine // intercambio con el 'off'
    me.color = c
    return c
  }
  return mine
}
