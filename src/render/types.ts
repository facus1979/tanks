// Contrato entre src/game (sesión) y src/render. Lo arma la sesión en cada frame.
import type { Biome, GameEvent, Player, Prop, Terrain, Vec2, WeaponId } from '../sim'

// Pantalla lógica (v2): la cámara muestra VIEW_W × VIEW_H pixels de mundo con zoom 1.
export const VIEW_W = 800
export const VIEW_H = 450

// HUD C (pulido v2): alto en pixels lógicos del tablero inferior del HUD. Durante la partida la cámara
// encuadra de modo que el piso del mundo quede por encima del tablero (las últimas HUD_BAR_H filas de la
// pantalla las tapa el HUD). Fuera de la partida (demo congelado, título) no hay tablero.
export const HUD_BAR_H = 62

// Pulido v2: segundos de vuelo que muestra la guía corta de apuntado (sin trazador).
export const AIM_PREVIEW_T = 0.35

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
  // Trayectoria del tiro que se está apuntando. Con trazador: completa. Sin trazador (pulido v2): solo el
  // comienzo, los puntos de los primeros AIM_PREVIEW_T segundos (aimPreviewShort = true).
  aimPreview: Vec2[] | null
  aimPreviewShort?: boolean
  camera: Camera // v2; el tamaño del mundo es terrain.w × terrain.h
  lava: number | null // v2: y de la superficie de la lava de muerte súbita (ya animada por la sesión); null = no hay
  alerts?: number[] // v2.3: ids de jugadores que muestran el globo "!" ahora (por ejemplo, frenado en el borde del abismo)
  splashes?: Vec2[] // v2.4: proyectiles que entraron al agua desde el frame anterior (en su momento exacto de playback)
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
