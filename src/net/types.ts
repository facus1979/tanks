// Contrato del online P2P. El anfitrión es la autoridad: corre la sim (y la IA) y
// reparte la lista ordenada de comandos aceptados. Cada cliente aplica esa lista sobre
// su réplica; como la sim es determinista, todos llegan al mismo estado.
import type { Biome, Command, CrewId, Difficulty, MatchConfig, PlayerKind } from '../sim'

export const NET_VERSION = 1

export type Role = 'host' | 'client'

// Transporte intercambiable: 'peer' = WebRTC vía PeerJS (internet), 'local' = BroadcastChannel
// entre pestañas del mismo navegador (pruebas sin red). ?net=local lo fuerza.
export type TransportKind = 'peer' | 'local'

export interface Transport {
  readonly kind: TransportKind
  // Anfitrión: abre la sala y devuelve el código (p. ej. "TANK-4F7K").
  host(code?: string): Promise<string>
  // Cliente: se conecta a la sala del código.
  join(code: string): Promise<void>
  // Anfitrión → un peer o todos; cliente → siempre al anfitrión (to se ignora).
  send(to: string | 'all', msg: NetMessage): void
  onMessage(cb: (from: string, msg: NetMessage) => void): void
  onPeer(cb: (peerId: string, state: 'join' | 'leave') => void): void
  close(): void
}

export interface LobbySlot {
  kind: PlayerKind | 'off'
  name: string
  crew: CrewId
  owner: 'host' | string | null // quién lo controla: el anfitrión, un peerId o nadie (IA / libre)
  connected: boolean
}

export interface LobbyState {
  code: string
  slots: LobbySlot[] // siempre 4
  rounds: number
  difficulty: Difficulty
  biome: Biome | 'random' | 'rotate'
  turnSeconds: number // límite por turno humano remoto; 0 = sin límite
}

export type NetMessage =
  // cliente → anfitrión
  | { t: 'hello'; version: number; name: string; token: string } // token: para reconectar al mismo casillero
  | { t: 'claim'; slot: number }
  | { t: 'release' }
  | { t: 'input'; command: Command } // pedido; el anfitrión valida que sea del jugador de ese peer
  | { t: 'aimLive'; playerId: number; angle: number; power: number } // vista previa, no entra al log
  // anfitrión → clientes
  | { t: 'welcome'; peerId: string; lobby: LobbyState }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'start'; config: MatchConfig; seq: number; slotOfPeer: Record<string, number> }
  | { t: 'cmd'; seq: number; command: Command } // log ordenado, sin huecos
  | { t: 'hash'; seq: number; hash: number } // estado después de aplicar el comando seq
  | { t: 'snapshot'; seq: number; data: string } // estado completo (encodeState + compresión, base64)
  | { t: 'timer'; playerId: number; left: number } // segundos que le quedan al turno
  | { t: 'reject'; reason: string }
  | { t: 'bye'; reason: string }
  // ambos
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }

// Reglas del log de comandos (las cumple el anfitrión):
// - Solo entran comandos que applyCommand aceptó (cambió el estado o produjo eventos).
// - 'aim' no entra en cada frame: el anfitrión mete el último aim del jugador antes de
//   fire / move / selectWeapon / useItem y al cerrar su turno. En vivo viaja 'aimLive'.
// - Turno vencido de un humano remoto: el anfitrión despacha 'fire' en su nombre.
// - Peer desconectado: el anfitrión despacha { type: 'setKind', kind: 'ai' } y la IA juega ese tanque.
//   Si vuelve con el mismo token, 'setKind' 'human' y recibe un snapshot.
