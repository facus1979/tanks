// Contrato entre src/game (sesión) y src/render. Lo arma la sesión en cada frame.
import type { Biome, GameEvent, Player, Prop, Terrain, Vec2, WeaponId } from '../sim'

export interface Viewport {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

export interface RenderFrame {
  biome: Biome
  terrain: Terrain
  terrainVersion: number // sube cada vez que cambia la grilla; el renderer repinta solo entonces
  matchId: number // cambia en cada partida nueva: el renderer limpia cráteres, restos y partículas
  props: Prop[]
  players: Player[]
  current: number // índice en players del que tiene el turno
  wind: number
  projectiles: Vec2[] // proyectiles en vuelo ahora (más de uno con racimo)
  shooterId: number | null // quién disparó el tiro en curso (para el retroceso)
  weapon: WeaponId | null // arma del tiro en curso (del estado antes de disparar); null sin tiro
  freeze: boolean // modo demo: congela partículas y animaciones en el frame actual
}

export interface GameRenderer {
  mount(host: HTMLElement): Promise<void>
  setLoop(loop: (dt: number) => void): void
  // Escala 800×450 a la ventana. Entera si llena al menos el 85% del lado limitante; si no, fraccional.
  resize(): Viewport
  // events: los que ocurrieron desde el frame anterior, ya en su momento de playback.
  render(frame: RenderFrame, events: GameEvent[], dt: number): void
}
