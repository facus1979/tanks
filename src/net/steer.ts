// v3 misil teledirigido en el online: constantes y utilidades comunes del anfitrión y del cliente.
//
// Reglas del log (contrato en ./types):
// - El que dispara manda 'steer' por 'input' en tandas de STEER_BATCH ticks (STEER_BATCH · STEER_TICK s).
// - El anfitrión acepta 'steer' solo del peer dueño del tanque del misil (y la sim solo en 'guiding'),
//   lo valida con hooks.apply como cualquier input y lo mete en el log en el orden en que llega.
// - Si lo rechaza, responde { t: 'reject', reason: STEER_REJECT } (el cliente corrige su predicción).
// - Turno vencido, peer caído o guiado colgado (GUIDE_SLACK s más allá de lo que tenía que durar):
//   el anfitrión despacha 'steer' con ceros hasta que el misil cae.
import type { Command } from '../sim'

export type SteerCommand = Extract<Command, { type: 'steer' }>
export type SteerDir = -1 | 0 | 1

export const STEER_BATCH = 2 // ticks por tanda (2 × 0,05 s = 0,1 s)
export const STEER_FLUSH_MS = 100 // si la tanda no se llena, sale igual a los 100 ms
export const STEER_LIVE_MS = 50 // steerLive: hasta 20 por segundo
export const GUIDE_SLACK = 4 // s de margen del anfitrión antes de completar el guiado con ceros
export const STEER_REJECT = 'Guiado rechazado'

export function sameSteer(a: Command, b: Command): boolean {
  if (a.type !== 'steer' || b.type !== 'steer' || a.playerId !== b.playerId || a.dirs.length !== b.dirs.length) return false
  for (let i = 0; i < a.dirs.length; i++) if (a.dirs[i] !== b.dirs[i]) return false
  return true
}

export function validDirs(dirs: unknown): dirs is SteerDir[] {
  return Array.isArray(dirs) && dirs.length > 0 && dirs.length <= 64 && dirs.every((d) => d === -1 || d === 0 || d === 1)
}
