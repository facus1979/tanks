// Contrato entre src/game (sesión) y src/render. Lo arma la sesión en cada frame.
import type { Biome, GameEvent, Player, Prop, Terrain, Vec2, WeaponId } from '../sim'

// Pantalla lógica (v2): la cámara muestra VIEW_W × VIEW_H pixels de mundo con zoom 1.
export const VIEW_W = 800
export const VIEW_H = 450

// Cámara en coordenadas de mundo. La arma el flujo (src/game) y el renderer la aplica tal cual:
// el centro de la pantalla muestra el punto (cx, cy) del mundo; zoom 1 = 1 px de mundo por px lógico,
// zoom < 1 se aleja (vuelos largos; mínimo 0,5). El flujo la mantiene dentro del mapa en x; en y puede
// mostrar cielo por encima de 0. El sacudón de las explosiones lo suma el renderer encima.
export interface Camera {
  cx: number
  cy: number
  zoom: number
}

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
  aimPreview: Vec2[] | null // trazador activo: trayectoria completa del tiro que se está apuntando
  camera: Camera // v2; el tamaño del mundo es terrain.w × terrain.h
  lava: number | null // v2: y de la superficie de la lava de muerte súbita (ya animada por la sesión); null = no hay
}

export interface GameRenderer {
  mount(host: HTMLElement): Promise<void>
  setLoop(loop: (dt: number) => void): void
  // Escala la pantalla lógica VIEW_W×VIEW_H a la ventana. Entera si llena al menos el 85% del lado limitante; si no, fraccional.
  resize(): Viewport
  // v2: punto de la ventana (clientX/Y) → coordenadas de mundo, con la cámara del último frame (sin sacudón).
  screenToWorld(clientX: number, clientY: number): Vec2
  // events: los que ocurrieron desde el frame anterior, ya en su momento de playback.
  render(frame: RenderFrame, events: GameEvent[], dt: number): void
}
