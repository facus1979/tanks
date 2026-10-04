// v3 perfil en la sala: nombre, tripulante y color de cada casillero.
//
// Reglas (las aplica el anfitrión; el flujo y las vistas pueden usar cleanName para mostrar lo mismo
// antes de mandarlo):
// - Nombre: sin tildes (Ñ → N), solo los caracteres que tiene la fuente pixel del juego
//   (letras, dígitos, espacio y . , : ! ? - / % +), espacios repetidos colapsados, recortado a
//   NAME_MAX. Vacío → el nombre del tripulante.
// - Tripulante y color: los dos únicos entre casilleros, con la misma regla. Color = índice en TANK_COLORS,
//   tripulante = uno de CREWS. Los 8 casilleros de la sala tienen SIEMPRE una permutación de los 8 colores
//   y otra de los 8 tripulantes (también los 'off'), así nunca hay dos tanques iguales. Si el pedido lo
//   tiene un casillero 'off', se intercambian. Si lo tiene un casillero ocupado (humano, con o sin
//   dueño, o IA), NO se rechaza: se asigna el siguiente libre (en ronda, en el orden de TANK_COLORS /
//   CREWS) intercambiándolo con el 'off' que lo tenía; si no hay ninguno libre (8 ocupados), el
//   casillero conserva el suyo. El cliente ve en el lobby lo que le quedó (no hay 'reject' por color o
//   tripulante tomado: es la regla más amable para una sala casual y evita un ida y vuelta).
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

// Asigna a slots[i] el valor pedido de key (o el siguiente libre, ver arriba) manteniendo la permutación.
// values: los 8 valores posibles en orden; def(idx): el valor por defecto del casillero idx si no lo tiene.
function assignUnique<T>(slots: LobbySlot[], i: number, get: (s: LobbySlot, idx: number) => T, set: (s: LobbySlot, v: T) => void, values: T[], want: T): T {
  const me = slots[i]
  const mine = get(me, i)
  const n = values.length
  const start = Math.max(0, values.indexOf(want))
  for (let k = 0; k < n; k++) {
    const c = values[(start + k) % n]
    if (c === mine) return mine
    const j = slots.findIndex((s, idx) => idx !== i && get(s, idx) === c)
    if (j < 0) {
      set(me, c) // nadie lo tiene (no debería pasar con la permutación, pero por las dudas)
      return c
    }
    if (slots[j].kind !== 'off') continue // tomado por un casillero ocupado: probar el siguiente
    set(slots[j], mine) // intercambio con el 'off'
    set(me, c)
    return c
  }
  return mine
}

const COLOR_IDS = TANK_COLORS.map((_, k) => k)

// Color pedido o el siguiente libre. Devuelve el que le quedó.
export function assignColor(slots: LobbySlot[], i: number, want: number): number {
  return assignUnique(slots, i, (s, idx) => s.color ?? idx, (s, v) => (s.color = v), COLOR_IDS, want)
}

// Tripulante pedido o el siguiente libre. Devuelve el que le quedó.
export function assignCrew(slots: LobbySlot[], i: number, want: CrewId): CrewId {
  return assignUnique(slots, i, (s) => s.crew, (s, v) => (s.crew = v), CREWS, want)
}
