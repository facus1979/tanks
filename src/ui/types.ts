// Contrato entre las vistas (src/ui/**, las implementa el área "vistas")
// y el flujo del juego (src/main.ts + src/game/**, que las crea y las alimenta).
// Las vistas no conocen a la sesión: reciben modelos y avisan con callbacks.
import type { Biome, CrewId, Difficulty, ItemId, MatchConfig, ShopId } from '../sim'

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
}

// ---------- menú: valores por defecto ----------

export const DEFAULT_CONFIG: MatchConfig = {
  slots: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }],
  rounds: 3,
  difficulty: 'normal' as Difficulty,
  biome: 'rotate' as Biome | 'rotate',
}
