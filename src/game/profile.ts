// v3 perfil del jugador local: el último nombre, tripulante y color de tanque que usó, guardados en el
// navegador (localStorage; sin él, en modo privado o bloqueado, se juega igual con los valores por defecto).
// Se usan por defecto en el menú (primer casillero humano) y al entrar a una sala online.
import { CREWS, NAME_MAX, TANK_COLORS, type CrewId, type MatchConfig, type SlotConfig } from '../sim/types'

export interface Profile {
  name: string // vacío = el nombre del tripulante
  crew: CrewId
  color: number // índice en TANK_COLORS
}

const STORE = 'tanks.profile.v1'

// Nombre limpio: sin espacios de más y hasta NAME_MAX letras.
export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : ''
}

function valid(p: Partial<Profile> | null | undefined): Profile | null {
  if (!p || typeof p !== 'object') return null
  const crew = CREWS.includes(p.crew as CrewId) ? (p.crew as CrewId) : null
  const color = Number.isInteger(p.color) && (p.color as number) >= 0 && (p.color as number) < TANK_COLORS.length ? (p.color as number) : null
  if (crew == null || color == null) return null
  return { name: cleanName(p.name), crew, color }
}

export function loadProfile(): Profile | null {
  try {
    return valid(JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Profile> | null)
  } catch {
    return null
  }
}

export function saveProfile(p: Profile): void {
  const v = valid(p)
  if (!v) return
  try {
    localStorage.setItem(STORE, JSON.stringify(v))
  } catch {
    // sin almacenamiento: no se recuerda
  }
}

// Índice del casillero del jugador local en una partida local: el primer humano.
function localSlot(config: MatchConfig): number {
  return config.slots.findIndex((s) => s.kind === 'human')
}

// La config con el perfil en el primer casillero humano (nombre, tripulante y color). Si otro casillero ya
// usa ese color o ese tripulante, se le pasa el que tenía el casillero del jugador (siguen siendo únicos).
export function withProfile(config: MatchConfig, p: Profile | null = loadProfile()): MatchConfig {
  const i = localSlot(config)
  if (!p || i < 0) return config
  const slots: SlotConfig[] = config.slots.map((s) => ({ ...s }))
  const mine = slots[i]
  const oldCrew = mine.crew ?? CREWS[i % CREWS.length]
  const oldColor = mine.color ?? i % TANK_COLORS.length
  slots.forEach((s, j) => {
    if (j === i) return
    if ((s.crew ?? CREWS[j % CREWS.length]) === p.crew) s.crew = oldCrew
    if ((s.color ?? j % TANK_COLORS.length) === p.color) s.color = oldColor
  })
  mine.crew = p.crew
  mine.color = p.color
  if (p.name) mine.name = p.name
  return { ...config, slots }
}

// Guarda como perfil lo que el jugador eligió en el menú (primer casillero humano).
export function rememberProfile(config: MatchConfig): void {
  const i = localSlot(config)
  if (i < 0) return
  const s = config.slots[i]
  const prev = loadProfile()
  saveProfile({
    name: cleanName(s.name ?? prev?.name ?? ''),
    crew: s.crew ?? prev?.crew ?? CREWS[i % CREWS.length],
    color: s.color ?? prev?.color ?? i % TANK_COLORS.length,
  })
}
