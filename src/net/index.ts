// Entrada del online. Contrato de mensajes en ./types; salas en ./host y ./client.
//
// URL (la interpreta el flujo con readNetParams):
//   ?net=local            transporte BroadcastChannel (pestañas del mismo navegador)
//   ?host=1               abre una sala al arrancar
//   ?join=TANK-XXXX       entra a esa sala al arrancar (el link de compartir)
//   ?autotest=1           prueba e2e (scripts/net-test.mjs): el anfitrión arma 2 humanos + 1 IA,
//                         1 ronda, y ambos disparan con ángulos fijos hasta el fin. El flujo expone
//                         window.__tanksNet = { role, code, seq, hash, phase }.
import type { NetTransport } from './base'
import { LocalTransport } from './local'
import { PeerTransport } from './peer'
import type { TransportKind } from './types'
import { normalizeCode } from './util'

export * from './types'
export { HOST_ID } from './base'
export type { LinkStatus, NetTransport } from './base'
export { HostRoom } from './host'
export type { HostHooks, RoomPeerEvent, RoomPeerInfo } from './host'
export { ClientRoom } from './client'
export type { ClientHooks } from './client'
export {
  ROOM_ALPHABET,
  compress,
  decompress,
  decompressText,
  isRoomCode,
  makeRoomCode,
  normalizeCode,
  reconnectToken,
  roomLink,
} from './util'

export function createTransport(kind: TransportKind): NetTransport {
  return kind === 'local' ? new LocalTransport() : new PeerTransport()
}

export interface NetParams {
  kind: TransportKind
  host: boolean
  join: string | null // código normalizado, o null
  autotest: boolean
}

export function readNetParams(search: string = location.search): NetParams {
  const q = new URLSearchParams(search)
  const join = q.get('join')
  return {
    kind: q.get('net') === 'local' ? 'local' : 'peer',
    host: q.get('host') === '1',
    join: join ? normalizeCode(join) : null,
    autotest: q.get('autotest') === '1',
  }
}

// Estado que el flujo publica para net-test (y para depurar desde la consola).
export interface NetDebug {
  role: 'host' | 'client'
  code: string
  seq: number
  hash: number
  phase: string // Phase de la sim, o 'lobby' antes de empezar
}

declare global {
  interface Window {
    __tanksNet?: NetDebug
  }
}
