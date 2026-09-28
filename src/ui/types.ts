// Contrato entre las vistas (src/ui/**, las implementa el área "vistas")
// y el flujo del juego (src/main.ts + src/game/**, que las crea y las alimenta).
// Las vistas no conocen a la sesión: reciben modelos y avisan con callbacks.
import type { Biome, CrewId, Difficulty, ItemId, MatchConfig, ShopId } from '../sim'
import type { LobbyState, Role } from '../net/types'

// ---------- título y menú ----------

// src/ui/title.ts
export interface TitleView {
  show(onStart: () => void): void // logo animado; cualquier tecla, click o botón del gamepad
  hide(): void
}

// src/ui/menu.ts: 4 casilleros (humano / IA / vacío, nombre, tripulante), rondas, dificultad, bioma.
export interface MenuView {
  show(initial: MatchConfig | null, onPlay: (config: MatchConfig) => void): void
  hide(): void
}

// ---------- hot-seat ----------

// src/ui/banner.ts: "TURNO DE <NOMBRE>" con retrato; entre turnos de humanos distintos.
export interface BannerModel {
  name: string
  color: number
  crew: CrewId
  round: number
  rounds: number
}
export interface BannerView {
  show(model: BannerModel, onGo: () => void): void // espacio, click o botón A
  hide(): void
}

// ---------- tabla entre rondas ----------

export interface ScoreRow {
  id: number
  name: string
  color: number
  crew: CrewId
  alive: boolean // sobrevivió la ronda
  roundsWon: number
  kills: number
  earned: number // plata ganada en esta ronda
  money: number // plata total
}
export interface ScoreModel {
  round: number
  rounds: number
  roundWinnerId: number | null
  final: boolean // true: fin de la partida; winnerId es el campeón
  winnerId: number | null
  rows: ScoreRow[]
}
// src/ui/scoreboard.ts
export interface ScoreboardView {
  show(model: ScoreModel, onContinue: () => void, onMenu: () => void): void
  hide(): void
}

// ---------- tienda ----------

export interface ShopRow {
  id: ShopId
  kind: 'weapon' | 'item'
  name: string
  price: number
  qty: number // unidades por paquete
  owned: number
  max: number
  canBuy: boolean
  canSell: boolean
}
export interface ShopModel {
  playerId: number
  name: string
  color: number
  crew: CrewId
  money: number
  round: number // la ronda que viene
  rounds: number
  rows: ShopRow[]
}
// src/ui/shop.ts: una pantalla por humano, en orden. Navegable con teclado, mouse y gamepad.
export interface ShopView {
  show(model: ShopModel, handlers: { buy: (id: ShopId) => void; sell: (id: ShopId) => void; ready: () => void }): void
  update(model: ShopModel): void // después de cada compra/venta
  hide(): void
}

// ---------- HUD ----------

// Campos que el HUD suma a su modelo (src/ui/hud.ts). Los llena la sesión.
export interface HudExtras {
  round: number
  rounds: number
  money: number // del humano que está jugando (o del último humano)
  items: Record<ItemId, number> // inventario de ese humano
  shield: number // escudo activo del jugador de turno
  tracer: boolean
  net?: HudNet | null
}

// ---------- online ----------

// src/ui/online.ts: "CREAR SALA" / "UNIRSE" (con campo de código) / volver. prefill: código del link ?join=.
export interface OnlineMenuView {
  show(handlers: { host: () => void; join: (code: string) => void; back: () => void }, prefill?: string): void
  hide(): void
  error(message: string): void
}

export interface LobbyModel {
  role: Role
  lobby: LobbyState
  link: string // URL para compartir (…/?join=CODIGO)
  mySlot: number | null
  status: string // "CONECTANDO…", "ESPERANDO JUGADORES", errores
  canStart: boolean // anfitrión: al menos 2 casilleros ocupados y todos los humanos conectados
}

// src/ui/lobby.ts: código grande + botón copiar link, 4 casilleros (anfitrión los configura: humano remoto /
// IA / vacío, y los ajustes de partida; cliente toma un casillero libre), estado de cada peer, empezar / salir.
export interface LobbyView {
  show(
    model: LobbyModel,
    handlers: {
      claim: (slot: number) => void
      release: () => void
      setSlot: (slot: number, kind: 'human' | 'ai' | 'off') => void // solo anfitrión
      setOption: (key: 'rounds' | 'difficulty' | 'biome' | 'turnSeconds', value: number | string) => void // solo anfitrión
      start: () => void // solo anfitrión
      leave: () => void
    },
  ): void
  update(model: LobbyModel): void
  hide(): void
}

// Estado de red para el HUD (lo llena el flujo; null en partida local).
export interface HudNet {
  role: Role
  code: string
  peers: { name: string; connected: boolean; ping: number | null }[]
  turnLeft: number | null // segundos que le quedan al turno actual, si hay límite
  waiting: string | null // "ESPERANDO A <NOMBRE>…", "RECONECTANDO…"
}

// ---------- menú: valores por defecto ----------

export const DEFAULT_CONFIG: MatchConfig = {
  slots: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }],
  rounds: 3,
  difficulty: 'normal' as Difficulty,
  biome: 'rotate' as Biome | 'rotate',
}
