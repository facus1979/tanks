// Entrada del online. Contrato de mensajes en ./types; salas en ./host y ./client.
//
// URL (la interpreta el flujo con readNetParams):
//   ?net=local            transporte BroadcastChannel (pestañas del mismo navegador)
//   ?host=1               abre una sala al arrancar
//   ?join=TANK-XXXX       entra a esa sala al arrancar (el link de compartir)
//   ?autotest=1           prueba e2e (scripts/net-test.mjs): el anfitrión arma 2 humanos + 1 IA,
//                         1 ronda, y ambos disparan con ángulos fijos hasta el fin. El flujo expone
//                         window.__tanksNet = { role, code, seq, hash, phase, players, size }.
//   &players=N            (con autotest, v5) N casilleros: 2 humanos + N-2 IA, en el mapa más chico
//                         que los admite (8 → Grande).
//   v3 (pedidos al flujo para net-test, ver scripts/net-test.mjs):
//   - con autotest, cada pestaña manda su perfil antes de empezar: el anfitrión setProfile({ name: 'Ana Ñandú',
//     crew: 'sarge', color: 4 }) y el cliente room.profile('Beto Pérez', 'rookie', 4) (el mismo color: el
//     anfitrión le asigna el siguiente libre). window.__tanksNet.names / colors con los de la partida.
//   - &weapon=guided: con autotest, los humanos tiran con el teledirigido (la sim les da munición en modo
//     de prueba) y lo dirigen con un patrón fijo (por ejemplo, 3 tandas de [1, 1] y después ceros).
//     window.__tanksNet.steer = room.steerStats() en el cliente y guided = cuántos tiros guiados hubo.
import type { NetTransport } from './base'
import { LocalTransport } from './local'
import { PeerTransport } from './peer'
import type { TransportKind } from './types'
import { normalizeCode } from './util'

export * from './types'
export { HOST_ID } from './base'
export type { LinkStatus, NetTransport } from './base'
export { HostRoom } from './host'
export type { GuidedInfo, HostHooks, ProfileInput, RoomPeerEvent, RoomPeerInfo } from './host'
export { ClientRoom } from './client'
export type { ClientHooks, SteerStats } from './client'
export { assignColor, assignCrew, cleanName, isColor, isCrew } from './profile'
export { GUIDE_SLACK, STEER_BATCH, STEER_FLUSH_MS, STEER_LIVE_MS, STEER_REJECT, sameSteer } from './steer'
export type { SteerCommand, SteerDir } from './steer'
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
  players?: number // tanques de la partida (v5), si empezó
  size?: string // tamaño del mapa de la partida, si empezó
  names?: string[] // v3: Player.name de la partida (net-test compara las dos pestañas)
  colors?: number[] // v3: Player.color de la partida
  guided?: number // v3: tiros teledirigidos de la partida (con &weapon=guided)
  steer?: { confirmed: number; corrected: number; avgMs: number | null; maxMs: number | null } // v3: cliente
}

declare global {
  interface Window {
    __tanksNet?: NetDebug
  }
}
