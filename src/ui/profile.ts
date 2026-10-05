// v3: perfil de cada casillero (nombre, tripulante, color de tanque y, en la IA, personalidad), compartido por
// el menú local y la sala online.
import { CREWS, NAME_MAX, PERSONALITIES, TANK_COLORS, type CrewId, type Personality } from '../sim/types'
import { el } from './kit'

export const CREW_NAMES: Record<CrewId, string> = {
  bandana: 'BANDANA',
  sarge: 'SARGENTO',
  rookie: 'NOVATO',
  desert: 'DESIERTO',
  commando: 'COMANDO',
  goggles: 'TANQUISTA',
  pilot: 'PILOTO',
  colonel: 'CORONEL',
}

// null = al azar (la sim la sortea con la seed).
export const PERSONALITY_NAMES: Record<Personality, string> = {
  aggressive: 'AGRESIVA',
  sniper: 'FRANCOTIRADORA',
  digger: 'CAVADORA',
  opportunist: 'OPORTUNISTA',
}
export const RANDOM_NAME = 'AL AZAR'
export const PERSONALITY_CYCLE: (Personality | null)[] = [null, ...PERSONALITIES]

export function personalityName(p: Personality | null | undefined): string {
  return p ? PERSONALITY_NAMES[p] : RANDOM_NAME
}

export function nextPersonality(p: Personality | null | undefined, dir = 1): Personality | null {
  const i = PERSONALITY_CYCLE.indexOf(p ?? null)
  return PERSONALITY_CYCLE[(i + dir + PERSONALITY_CYCLE.length) % PERSONALITY_CYCLE.length]
}

// Nombre escrito por el jugador: solo lo que dibuja la fuente pixel (letras sin tilde, números, espacio y
// . - ! ?), en mayúsculas, sin espacios dobles ni al principio, hasta NAME_MAX.
export function cleanName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .!?-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^ /, '')
    .slice(0, NAME_MAX)
}

// Siguiente color (índice en TANK_COLORS) en dirección dir que no esté en taken; si todos lo están, el mismo.
export function nextColor(color: number, taken: ReadonlySet<number>, dir = 1): number {
  const n = TANK_COLORS.length
  let c = color
  for (let k = 0; k < n; k++) {
    c = (c + dir + n) % n
    if (!taken.has(c)) return c
  }
  return color
}

// Siguiente tripulante libre en dirección dir.
export function nextCrew(crew: CrewId, taken: ReadonlySet<CrewId>, dir = 1): CrewId {
  let i = CREWS.indexOf(crew)
  for (let k = 0; k < CREWS.length; k++) {
    i = (i + dir + CREWS.length) % CREWS.length
    if (!taken.has(CREWS[i])) return CREWS[i]
  }
  return crew
}

// Colores únicos entre los casilleros usados (en orden: el primero que lo tiene se lo queda; los repetidos
// o inválidos toman el primero libre). Los no usados que choquen también se corren, así al ocuparlos no repiten.
export function uniqueColors<T extends { color: number }>(slots: T[], used: (s: T) => boolean): void {
  const taken = new Set<number>()
  const fix = (s: T) => {
    if (!Number.isInteger(s.color) || s.color < 0 || s.color >= TANK_COLORS.length || taken.has(s.color)) {
      s.color = TANK_COLORS.findIndex((_, i) => !taken.has(i))
      if (s.color < 0) s.color = 0
    }
    taken.add(s.color)
  }
  for (const s of slots) if (used(s)) fix(s)
  for (const s of slots) if (!used(s)) fix(s)
}

// Muestra de color de tanque: un cuadro con contorno (el DOM la pinta con --swatch).
export function swatch(): HTMLElement {
  return el('div', 'swatch')
}

export function setSwatch(node: HTMLElement, color: number | null): void {
  node.style.setProperty('--swatch', color == null ? '#3a3430' : `#${(color & 0xffffff).toString(16).padStart(6, '0')}`)
}

// Campo de texto real (invisible) encima de una celda de nombre, para que en táctil aparezca el teclado del
// sistema. onFocus: la vista entra en edición; onText: texto ya limpio; onDone: salió del campo o Enter.
export function nameInput(onFocus: () => void, onText: (text: string) => void, onDone: () => void): HTMLInputElement {
  const input = document.createElement('input')
  input.className = 'code-input name-input'
  input.setAttribute('inputmode', 'text')
  input.setAttribute('autocapitalize', 'characters')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('enterkeyhint', 'done')
  input.maxLength = NAME_MAX
  input.spellcheck = false
  input.addEventListener('focus', onFocus)
  input.addEventListener('input', () => {
    const t = cleanName(input.value)
    if (t !== input.value) input.value = t
    onText(t)
  })
  input.addEventListener('blur', onDone)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') input.blur()
  })
  return input
}
