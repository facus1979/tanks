// Cámara del flujo (v2): sigue al tanque del turno y al proyectil en vuelo, y respeta el paneo a mano.
// Trabaja en coordenadas de mundo (ver Camera en src/render/types.ts). El sacudón lo suma el renderer.
// En mapas que entran en pantalla a lo ancho (Chico) queda fija: centrada en x y con el piso apoyado en el
// tablero del HUD.
//
// HUD C (pulido v2): durante la partida el HUD tapa las últimas `bar` (= HUD_BAR_H) filas de la pantalla.
// La cámara apoya el piso del mundo (y = h) justo arriba del tablero: en pantalla queda en VIEW_H − bar
// con zoom 1, y con zoom < 1 igual (el mundo se achica, el piso sigue sobre el tablero). Lo que se recorta
// es cielo de arriba (bar / zoom px de mundo). En Chico (800×450) también: el mapa entra a lo ancho, así
// que queda con zoom 1 (pixel art nítido) y corrido hacia arriba, sin los 62 px de cielo más altos; un tiro
// que sube por encima se ve con la flecha del borde, como siempre. Un zoom fijo de 388/450 para que entre
// entero se descartó: escala fraccional (pixels desparejos) y franjas fuera del mundo a los costados.
// Con bar = 0 (demo congelado de QA, sin tablero) todo queda como antes.
import { HUD_BAR_H, VIEW_H, VIEW_W, type Camera } from '../render/types'
import type { Vec2 } from '../sim/types'

export const MIN_ZOOM = 0.5

// Suavizado: tiempo (s) que tarda en llegar más o menos al objetivo (amortiguado crítico, sin saltos).
const TANK_TIME = 0.45 // siguiendo al tanque del turno
const SHOT_TIME = 0.2 // siguiendo al proyectil
const IMPACT_TIME = 0.35 // después del último impacto, mientras se asienta el tiro
const FALL_TIME = 0.25 // acompañando a un tanque que cae al abismo (v3)
const SLIDE_TIME = 0.35 // acompañando a un tanque que se desliza (pulido v2)
const WATCH_TIME = 0.5 // mirando un flujo de líquido (v4): viaje tranquilo, el agua corre despacio
const ZOOM_TIME = 0.55
const MAX_SPEED = 4000 // px de mundo por segundo
// El tanque queda un poco por debajo del centro: se ve más cielo para apuntar.
const TANK_LIFT = 40

// manual: el jugador paneó; la cámara se queda donde la dejó hasta recentrar o cambiar de turno.
export type CameraMode = 'tank' | 'manual' | 'shot'

// HUD C: margen de arriba que ocupan el minimapa y los carteles (px lógicos) y cuánto puede subir la cámara
// por encima del encuadre normal para no tapar un objetivo alto.
const TOP_SAFE = 100
const MAX_RISE = 160

export class CameraController {
  mode: CameraMode = 'tank'
  private w = VIEW_W
  private h = VIEW_H
  private cx = VIEW_W / 2
  private cy = VIEW_H / 2
  private zoom = 1
  private vx = 0
  private vy = 0
  private vz = 0
  private tx = VIEW_W / 2
  private ty = VIEW_H / 2
  private tz = 1
  private time = TANK_TIME
  // Filas de abajo de la pantalla que tapa el tablero del HUD (px lógicos). Lo fija la sesión al empezar.
  bar = HUD_BAR_H

  // El mapa entra en pantalla: cámara fija, sin paneo ni zoom.
  get fixed(): boolean {
    return this.w <= VIEW_W
  }

  get camera(): Camera {
    if (this.fixed) return { cx: this.w / 2, cy: this.floorY(1), zoom: 1 }
    return { cx: this.cx, cy: this.cy, zoom: this.zoom }
  }

  // Tamaño del mundo con el que se armó (reset).
  get world(): { w: number; h: number } {
    return { w: this.w, h: this.h }
  }

  // Alto de pantalla útil (px lógicos): lo que no tapa el tablero del HUD.
  get usableH(): number {
    return VIEW_H - this.bar
  }

  // Rectángulo de mundo que realmente se ve (sin sacudón ni lo que tapa el tablero).
  view(): { x: number; y: number; w: number; h: number } {
    const c = this.camera
    const w = VIEW_W / c.zoom
    const h = this.usableH / c.zoom
    return { x: c.cx - w / 2, y: c.cy - h / 2, w, h }
  }

  // Mapa nuevo (partida o ronda): salta sin transición al foco.
  reset(w: number, h: number, focus: Vec2 | null): void {
    this.w = Math.max(1, w)
    this.h = Math.max(1, h)
    this.mode = 'tank'
    this.zoom = this.tz = 1
    this.vx = this.vy = this.vz = 0
    this.time = TANK_TIME
    const x = focus ? focus.x : this.w / 2
    const y = focus ? focus.y - TANK_LIFT : this.h / 2
    this.cx = this.tx = this.clampX(x, 1)
    this.cy = this.ty = this.clampY(y, 1)
  }

  // Apuntando: sigue al tanque, salvo que el jugador haya paneado.
  followTank(x: number, y: number): void {
    if (this.mode === 'manual') {
      this.tz = 1
      this.time = TANK_TIME
      return
    }
    this.mode = 'tank'
    this.tx = x
    this.ty = y - TANK_LIFT
    this.tz = 1
    this.time = TANK_TIME
  }

  // Tiro en vuelo: centro del grupo (ya con anticipación) y el zoom del tiro.
  followShot(x: number, y: number, zoom: number): void {
    this.mode = 'shot'
    this.tx = x
    this.ty = y
    this.tz = zoom
    this.time = SHOT_TIME
  }

  // Entre vuelos (racimo, rodadora) se queda donde está.
  holdShot(zoom: number): void {
    this.mode = 'shot'
    this.tz = zoom
  }

  // Tiro terminado, mientras se asientan las explosiones: mira el último impacto y vuelve a zoom 1.
  settleAt(x: number, y: number): void {
    this.mode = 'shot'
    this.tx = x
    this.ty = y
    this.tz = 1
    this.time = IMPACT_TIME
  }

  // v4: un flujo de líquido grande corre a la vista o cerca: la cámara lo encuadra (centro de la zona
  // que cambia y un zoom que la entra) mientras corre, con el suavizado de después del impacto.
  watch(x: number, y: number, zoom: number): void {
    this.mode = 'shot'
    this.tx = x
    this.ty = y
    this.tz = zoom
    this.time = WATCH_TIME
  }

  // v3: un tanque cae al abismo. La cámara lo acompaña rápido y vuelve a zoom 1; clampY la frena con el
  // borde de abajo del mundo apoyado sobre el tablero del HUD (nunca muestra lo que hay debajo).
  followFall(x: number, y: number): void {
    this.mode = 'shot'
    this.tx = x
    this.ty = y
    this.tz = 1
    this.time = FALL_TIME
  }

  // Pulido v2: un tanque se desliza (empuje o pendiente). La cámara lo acompaña con suavizado y vuelve a
  // zoom 1, sin saltos.
  followSlide(x: number, y: number): void {
    this.mode = 'shot'
    this.tx = x
    this.ty = y
    this.tz = 1
    this.time = SLIDE_TIME
  }

  // Paneo a mano (dx en px de mundo), sin retraso: la cámara va pegada al dedo o al mouse.
  pan(dx: number, dy = 0): void {
    if (this.fixed || (dx === 0 && dy === 0)) return
    this.mode = 'manual'
    this.cx = this.tx = this.clampX(this.cx + dx, this.zoom)
    this.cy = this.ty = this.clampY(this.cy + dy, this.zoom)
    this.vx = this.vy = 0
  }

  // Centra en x (minimapa). smooth: viaja con el suavizado del tanque; si no, salta (arrastre).
  centerOn(x: number, smooth: boolean): void {
    if (this.fixed) return
    this.mode = 'manual'
    this.tx = this.clampX(x, this.zoom)
    this.time = TANK_TIME
    if (!smooth) {
      this.cx = this.tx
      this.vx = 0
    }
  }

  // C, doble toque en el minimapa o botón de recentrar: vuelve a seguir al tanque.
  recenter(): void {
    if (this.mode === 'manual') this.mode = 'tank'
  }

  update(dt: number): void {
    if (this.fixed || dt <= 0) return
    ;[this.zoom, this.vz] = smoothDamp(this.zoom, clamp(this.tz, MIN_ZOOM, 1), this.vz, ZOOM_TIME, dt, 4)
    this.zoom = clamp(this.zoom, MIN_ZOOM, 1)
    ;[this.cx, this.vx] = smoothDamp(this.cx, this.clampX(this.tx, this.zoom), this.vx, this.time, dt, MAX_SPEED)
    ;[this.cy, this.vy] = smoothDamp(this.cy, this.clampY(this.ty, this.zoom), this.vy, this.time, dt, MAX_SPEED)
    // el zoom cambia los límites: nunca mostrar fuera del mapa en x ni debajo del piso
    this.cx = this.clampX(this.cx, this.zoom)
    this.cy = this.clampY(this.cy, this.zoom)
    if (this.mode === 'manual') {
      // el objetivo manual también queda dentro de los límites del zoom actual
      this.tx = this.clampX(this.tx, this.zoom)
      this.ty = this.cy
    }
  }

  // En x, dentro del mundo; si el mundo entra entero, centrado.
  private clampX(x: number, zoom: number): number {
    const half = VIEW_W / (2 * zoom)
    if (this.w <= half * 2) return this.w / 2
    return clamp(x, half, this.w - half)
  }

  // En y, el piso del mundo queda apoyado sobre el tablero (como en v1 quedaba en el borde de abajo); con
  // zoom < 1 se ve más cielo arriba. Si el objetivo queda tan alto que lo taparían el minimapa y los carteles
  // de arriba (una cima de montaña en Mediano/Grande), la cámara sube lo justo para dejarlo a TOP_SAFE px del
  // borde de arriba, hasta MAX_RISE px de mundo; lo de abajo del mundo queda detrás del tablero.
  private clampY(y: number, zoom: number): number {
    const floor = this.floorY(zoom)
    if (this.bar <= 0) return floor
    const need = y + (VIEW_H / 2 - TOP_SAFE) / zoom
    return clamp(need, floor - MAX_RISE / zoom, floor)
  }

  // Centro en y que deja el piso del mundo (h) en la fila VIEW_H − bar de la pantalla.
  private floorY(zoom: number): number {
    return this.h - (VIEW_H / 2 - this.bar) / zoom
  }
}

// Zoom de un tiro, calculado una vez con el recorrido completo: se aleja si el vuelo es más ancho que
// la pantalla o si sube por encima de lo que se ve con zoom 1 (el piso queda siempre abajo, sobre el
// tablero del HUD: el alto útil es VIEW_H − bar).
export function shotZoom(paths: Vec2[][], worldH: number, bar = HUD_BAR_H): number {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  for (const path of paths) {
    for (const p of path) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
    }
  }
  if (!Number.isFinite(minX)) return 1
  const span = maxX - minX
  const bySpan = span > 0 ? (VIEW_W * 0.8) / span : 1
  // el tope de lo visible es worldH - (VIEW_H - bar) / zoom; 30 px de aire sobre el apogeo
  const rise = worldH - minY + 30
  const byTop = rise > 0 ? (VIEW_H - bar) / rise : 1
  return clamp(Math.min(1, bySpan, byTop), MIN_ZOOM, 1)
}

// Amortiguado crítico (Game Programming Gems 4, "smooth damp"): velocidad continua, sin pasarse.
function smoothDamp(cur: number, target: number, vel: number, time: number, dt: number, maxSpeed: number): [number, number] {
  const omega = 2 / Math.max(0.0001, time)
  const x = omega * dt
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const maxChange = maxSpeed * time
  const change = clamp(cur - target, -maxChange, maxChange)
  const to = cur - change
  const temp = (vel + omega * change) * dt
  let v = (vel - omega * temp) * k
  let out = to + (change + temp) * k
  if (target - cur > 0 === out > target) {
    out = target
    v = 0
  }
  return [out, v]
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
