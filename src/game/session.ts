// Sesión local: aplica comandos a la sim, reproduce los tiros en el tiempo y maneja a las IAs.
import { PATH_DT, applyCommand, chooseShot, createMatch, fly } from '../sim'
import type { ShotPlan } from '../sim'
import type {
  Biome,
  Command,
  Difficulty,
  Flight,
  GameEvent,
  GameState,
  Hazard,
  ItemId,
  MatchConfig,
  Player,
  Prop,
  ShopId,
  StepResult,
  Terrain,
  TerrainPatch,
  Vec2,
  WeaponId,
} from '../sim/types'
import { GUIDE_TIME, ITEM_ORDER, TANK_COLORS, JETPACK_RANGE, LAVA, MAX_PLAYERS_BY_SIZE, SHOP, STEER_TICK, SUDDEN_DEATH_CALM, TANK_H, TANK_W, TELEPORT_RANGE, WATER, WEAPONS, fuelFor } from '../sim/types'
import { AIM_PREVIEW_T, HUD_BAR_H, VIEW_W, type Camera, type RenderFrame } from '../render/types'
import type { HudModel, HudSide } from '../ui/hud'
import type { BannerModel, HudExtras, HudNet, MinimapModel, ScoreModel, ShopModel } from '../ui/types'
import { AiClient } from './ai-client'
import { CameraController, MIN_ZOOM, shotZoom } from './camera'
import { pickDemoShot, seededRandom } from './demo'

export interface DemoOptions {
  freeze: boolean
  weapon?: WeaponId // QA: arma del tiro fijo de P1 (&weapon=)
}

// local: todo en este dispositivo. host: corre la sim y la IA, y loguea cada comando aceptado.
// client: réplica; aplica el log del anfitrión y manda su input como pedido.
export type SessionMode = 'local' | 'host' | 'client'

export interface NetSeat {
  mode: SessionMode
  localIds: number[] // jugadores que se controlan desde este dispositivo
  // host: HostRoom.dispatch (valida con applyNet, numera y reparte); client: ClientRoom.input
  route: (command: Command) => boolean | void
}

interface Inbound {
  command: Command
  result: StepResult | null // client: ya aplicado sobre la réplica lógica; se muestra en orden
}

const TURN_COMMANDS = new Set<Command['type']>(['aim', 'selectWeapon', 'move', 'fire', 'useItem'])

interface TimedEvent {
  t: number
  event: GameEvent
}

// Un disparo en reproducción: el estado final ya está resuelto; esto es presentación.
interface Playback {
  t: number
  end: number
  before: GameState
  after: GameState
  flights: { flight: Flight; start: number; dur: number; done: boolean }[]
  timeline: TimedEvent[]
  next: number
  firstImpact: number
  shooterId: number
  weapon: WeaponId
  players: Player[]
  props: Prop[]
  terrain: Terrain // grilla que se ve: arranca en before y suma los cambios de cada evento
  target: Terrain // lo que muestra cada impact/burn (after, o su parte seca donde hay flujo)
  reveal: Map<GameEvent, Int32Array> // pixels que cambia cada impact/burn
  pending: number // pixels todavía sin mostrar
  finisher: GameEvent | null // la muerte que cierra la ronda: arranca la cámara lenta
  // v2.3: si la que cierra la ronda es una caída al abismo, la cámara lenta arranca al empezar la caída
  // (no cuando llega la muerte, que es con el tanque ya perdido) y dura hasta que se pierde
  finisherDrop: Drop | null
  slowDone: boolean
  flightsEnd: number // fin del último vuelo
  zoom: number // zoom de la cámara durante el vuelo (shotZoom)
  // v2: punto donde se asienta la cámara al terminar los vuelos (último impacto o fin del último vuelo)
  settle: Vec2 | null
  // v2 muerte súbita: lava y tiros sin daño que muestra el tiro mientras se reproduce. Arrancan como
  // estaban antes del disparo y cambian cuando llegan los eventos lava y calm en su t.
  lava: number | null
  calmLeft: number
  // v3: tanques que caen al abismo en este tiro (ver planDrops)
  drops: Drop[]
  // v4: flujos de líquido del tiro (eventos flow), con sus parches pendientes
  flows: FlowPlay[]
  // v4: próxima salpicadura por reproducir de cada vuelo (índice en Flight.splashes)
  splashNext: number[]
  // pulido v2: deslizamientos (empuje o pendiente) con la caída que los sigue
  slides: SlidePlay[]
  // v3 teledirigido: el ascenso de un misil guiado termina en este estado (phase 'guiding'); al terminar el
  // playback empieza el guiado. guideQueue: tandas de 'steer' que el anfitrión aceptó durante el ascenso
  // (se aplican sobre after, así el hash de la sala ya las incluye, y se muestran al empezar el guiado).
  guideFrom: GameState | null
  guideQueue: { before: GameState; result: StepResult }[]
  // v3: minas y charcos que se ven (arrancan como antes del tiro y cambian con los eventos hazard)
  hazards: Hazard[]
  // v3: algo grande que la cámara mira un rato (terremoto, agujero negro, botín que cae, teletransporte)
  focus: { x: number; y: number; zoom: number; t1: number } | null
}

// v3 misil teledirigido en la fase 'guiding' (sin playback): el camino que ya devolvieron los 'steer' y
// el cabezal de lo que se muestra. Cada tanda agrega su tramo; el cabezal avanza en tiempo real y nunca
// pasa del final (si el dueño es remoto y la red se atrasa, el misil espera).
interface GuidePlay {
  ownerId: number
  weapon: WeaponId
  pts: Vec2[] // camino desde que empezó el guiado, un punto cada PATH_DT
  t: number // cabezal: segundos mostrados desde que empezó el guiado
  guide0: number // segundos de guiado al empezar (GuidedState.guide)
  zoom: number
  clock: number // dueño de este dispositivo o IA: segundos hasta la próxima tanda
  ticks: number // ticks ya mandados
  plan: (-1 | 0 | 1)[] | null // IA: correcciones por tick (ShotPlan.steer)
  idle: number // anfitrión: segundos sin tandas del dueño remoto
  stuck: number // tandas seguidas que la sim no aceptó
  hint: (Vec2 & { at: number }) | null // steerLive del dueño remoto (vista previa)
}

// v3: eligiendo el destino de un jetpack o un teletransporte.
export interface ItemAimView {
  item: 'jetpack' | 'teleport'
  from: Vec2 // centro del tanque
  to: Vec2 // cursor (ya recortado al rango)
  range: number
}

// Pulido v2: un tanque que se corre por el piso (evento slide). Recorre path desde t0 (un punto cada
// PATH_DT) hasta t1; si después cae (fall que no es al abismo ni con paracaídas), la caída se anima con
// gravedad y el fall se entrega al aterrizar (golpe, polvo, chapuzón). Lo que le pasa a ese tanque después
// en la lista (daño, muerte, escudo, otro deslizamiento) espera a que termine.
// v3: el salto del jetpack se anima igual (su path es el camino del tanque).
interface SlidePlay {
  event: Extract<GameEvent, { type: 'slide' | 'jetpack' }>
  playerId: number
  t0: number
  t1: number // fin del recorrido
  end: number // fin del deslizamiento con su caída (si la hay)
  done: boolean // ya llegó al último punto del recorrido
  fall: { from: number; to: number; t0: number; dur: number } | null
  follow: boolean | null // la cámara lo mira (se decide al empezar)
}

// v4 líquidos: un evento flow en reproducción. Cada parche se copia a la grilla que se ve en
// start + i * dt; el último deja la grilla final. v2.4: también los derrumbes (evento collapse), que tienen
// el mismo formato y se aplican igual.
interface FlowPlay {
  event: Extract<GameEvent, { type: 'flow' | 'collapse' }>
  start: number // t del primer parche (el del evento, corrido después de los impactos si hacía falta)
  dt: number
  end: number // t del último parche
  next: number // próximo parche por aplicar
  info: FlowInfo | null // se calcula al empezar (con la grilla que se ve en ese momento)
  follow: boolean | null // la cámara lo mira mientras corre (se decide al empezar)
}

// Lo que movió un flujo, para el audio y la cámara: celdas que cambiaron por líquido y dónde.
export interface FlowInfo {
  dur: number // segundos que dura (del primer al último parche)
  water: number // celdas que cambiaron con agua (llenándose o vaciándose)
  lava: number // celdas que cambiaron con lava
  solid: number // v2.4: celdas que cambiaron sin líquido de por medio (solo se cuentan en un derrumbe)
  x0: number
  y0: number
  x1: number
  y1: number
}

// v3 abismo: caída animada de un tanque que se pierde por debajo del mapa. Arranca con el evento fall
// (t0) y la muerte llega cuando el tanque ya se perdió de vista (t0 + lost; v2.3, antes t0 + dur).
interface Drop {
  playerId: number
  from: number // y del piso al empezar a caer
  to: number // y final, con el tanque entero por debajo del mapa
  t0: number
  dur: number
  // v2.3: cuándo (desde t0) se pierde de vista el tanque que dibuja el renderer (ver abyssLostAt); el
  // destello y el humo del fondo salen después de esto. Es >= dur.
  lost: number
  follow: boolean | null // la cámara lo acompaña (se decide al empezar la caída)
}

interface AiDrive {
  playerId: number
  token: number
  plan: ShotPlan | null // null mientras el worker piensa
  from: { angle: number; power: number }
  t: number
  think: number
  dur: number
  hold: number
  move: number // pixels con signo que faltan recorrer antes de apuntar (ShotPlan.move)
  moveAcc: number
  // v3: ítems del plan que faltan usar (uno por frame, antes de moverse) y el arma que falta elegir
  items: { item: ItemId; target?: Vec2 }[]
  weapon: WeaponId | null
}

const SETTLE = 0.9
const MOVE_SPEED = 36
const SLOW_SCALE = 0.3
const SLOW_TIME = 1.2
// v2.3: cuánto dura el globo "!" después del último intento contra el tope del borde del abismo.
const ALERT_TIME = 1.2
// v2.4: diferencia de viento entre una vuelta y la siguiente que merece el "!" sobre el tanque del turno
const WIND_ALERT = 6
const LATE = new Set<GameEvent['type']>(['turn', 'wind', 'gameover', 'roundover', 'round', 'shop'])
// Anticipación de la cámara sobre el proyectil (segundos de vuelo hacia adelante).
const LOOKAHEAD = 0.35
// v2 muerte súbita. La lava sube (o aparece desde el fondo) en LAVA_ANIM segundos, con un respiro de
// LAVA_GAP después de la última explosión del tiro; el daño de lava sin t llega LAVA_HIT después de que
// empieza a subir, y el turno siguiente arranca LAVA_TAIL después de que termina de subir.
const LAVA_ANIM = 0.8
const LAVA_GAP = 0.3
const LAVA_HIT = 0.5
const LAVA_TAIL = 0.4
// v3 abismo. Gravedad de la caída (px/s²; más que la del tiro para que se sienta pesada), cuánto se queda
// la cámara mirando el fondo después de que el tanque se perdió y cuánto espera el turno siguiente.
const WIND_NOTICE = 2.5 // v2.2: segundos del aviso de cambio de viento
const ABYSS_G = 700
const ABYSS_MIN = 0.5
const ABYSS_MAX = 1.6
// v2.3: la cámara y el turno se cuentan desde que el tanque se pierde de vista (Drop.lost), no desde el
// fin de la caída de la sesión: el renderer lo suelta con su propia física, más lenta, y el destello del
// fondo sale 0,25 s después de perderse y el humo 1,1 s después. Con 1,8 s se ve el destello y el humo
// empezando a subir (antes la cámara se iba justo cuando arrancaba el humo, o antes en caídas largas).
const ABYSS_HOLD = 1.8
const ABYSS_TAIL = 2.0
// Física con la que el renderer suelta al tanque en el abismo (AbyssFalls en src/render/pixi/abyss.ts):
// gravedad, velocidad inicial (hacia arriba) y dónde termina de desvanecerse (debajo del piso del mapa).
// Solo se usa para saber cuándo se pierde de vista; si el renderer cambia su caída, actualizar acá.
const RENDER_ABYSS_G = 260
const RENDER_ABYSS_VY = -20
const RENDER_ABYSS_GONE = 6
// v2.3: cámara lenta de una caída al abismo que cierra la ronda. Cubre toda la caída hasta que se pierde
// (más un respiro); si eso en SLOW_SCALE pasaría de SLOW_ABYSS_MAX segundos reales, se frena menos.
const SLOW_ABYSS_TAIL = 0.2
const SLOW_ABYSS_MAX = 3.2
// Pixels debajo del mapa donde termina la caída: el tanque, el tripulante y el cartel ya no se ven.
const ABYSS_BELOW = TANK_H + 30
// v4 líquidos. El turno siguiente espera FLOW_TAIL después del último parche; lo que llega después
// del flujo en la lista (daño de lava del turno, escudo, muerte) va FLOW_GAP después de que termina.
// La cámara mira un flujo de FLOW_BIG celdas o más si está a la vista o a menos de FLOW_NEAR px del
// borde de la pantalla, y se queda FLOW_HOLD después de que termina.
const FLOW_TAIL = 0.45
const FLOW_GAP = 0.25
const FLOW_BIG = 300
const FLOW_NEAR = 260
const FLOW_HOLD = 0.35
// v2.4 derrumbe: la cámara lo mira (como al flujo) si cayeron COLLAPSE_BIG celdas o más y está a la vista
// o cerca. El daño del aplastado llega COLLAPSE_GAP después de que se asienta.
const COLLAPSE_BIG = 150
const COLLAPSE_GAP = 0.1
// Después del flujo: consecuencias del cambio de turno que no pueden adelantarse a la animación.
const AFTER_FLOW = new Set<GameEvent['type']>(['damage', 'shield', 'death'])
// Pulido v2, deslizamiento. Gravedad y topes de la caída que sigue a un deslizamiento (la del abismo usa
// abyssDrop), cuánto se queda la cámara después de que el tanque se asentó y cuánto espera el turno.
const SLIDE_FALL_G = 700
const SLIDE_FALL_MIN = 0.12
const SLIDE_FALL_MAX = 0.9
const SLIDE_HOLD = 0.35
const SLIDE_TAIL = 0.4
// Lo de un tanque que espera a que termine su deslizamiento.
const AFTER_SLIDE = new Set<GameEvent['type']>(['damage', 'shield', 'death'])
// v3 teledirigido: ticks por tanda de 'steer' (2 × STEER_TICK = 0,1 s), anticipación de la cámara sobre el
// misil (segundos de vuelo a su velocidad), zoom de la cámara mientras se guía (entre estos topes) y
// segundos sin tandas del dueño remoto tras los que el anfitrión manda ceros (para que el turno no se trabe).
const STEER_BATCH = 2
const GUIDE_LOOKAHEAD = 0.45
const GUIDE_ZOOM_MIN = 0.7
const GUIDE_IDLE = 3
// v3 cámara: cuánto mira un terremoto, un agujero negro (más su duración), el botín que cae y el lugar
// adonde llegó un teletransporte.
const QUAKE_HOLD = 1.6
const PULL_HOLD = 0.5
const LOOT_HOLD = 1.6
const TELEPORT_HOLD = 0.9
// v3 destino de jetpack y teletransporte: velocidad del cursor con teclado o gamepad (px de mundo por s).
export const ITEM_CURSOR_SPEED = 260

// Duración de la caída (no al abismo) de from a to después de un deslizamiento.
export function slideFallDur(from: number, to: number): number {
  return clamp(Math.sqrt((2 * Math.max(0, to - from)) / SLIDE_FALL_G), SLIDE_FALL_MIN, SLIDE_FALL_MAX)
}

// Caída al abismo desde y (piso del tanque) en un mapa de alto h: hasta dónde baja y cuánto tarda.
// También la usa main.ts para que el silbido dure lo mismo que la caída.
export function abyssDrop(from: number, h: number): { to: number; dur: number } {
  const to = h + ABYSS_BELOW
  const dist = Math.max(0, to - from)
  const dur = clamp(Math.sqrt((2 * dist) / ABYSS_G), ABYSS_MIN, ABYSS_MAX)
  return { to, dur }
}

// v2.3: segundos desde que empieza la caída hasta que el tanque que dibuja el renderer se pierde de vista
// (su centro arranca TANK_H/2 arriba del piso y se termina de desvanecer RENDER_ABYSS_GONE px debajo del
// mapa). Nunca menos que la caída de la sesión (dur), que es cuando llega la muerte.
export function abyssLostAt(from: number, h: number): number {
  const dist = Math.max(0, h + RENDER_ABYSS_GONE - (from - TANK_H / 2))
  const a = RENDER_ABYSS_G / 2
  const b = RENDER_ABYSS_VY
  const t = (-b + Math.sqrt(b * b + 4 * a * dist)) / (2 * a)
  return Math.max(abyssDrop(from, h).dur, t)
}

// Un fall que termina por debajo del mapa: el tanque cayó a un abismo (contrato v3).
export function isAbyssFall(event: GameEvent, h: number): boolean {
  return event.type === 'fall' && event.to > h
}

export class Session {
  state: GameState | null = null
  config: MatchConfig | null = null
  // true: la IA calcula en el hilo principal (avance rápido de QA, sin esperar al worker)
  syncAi = false
  private playback: Playback | null = null
  private fx: GameEvent[] = []
  private ai: AiDrive | null = null
  private aiClient: AiClient | null = null
  private aiToken = 0
  private aim: { playerId: number; angle: number; power: number } | null = null
  private message = ''
  private messageT = 0
  private terrainVersion = 0
  private matchId = 0
  private moveAcc = 0
  private shots: { playerId: number; weapon: WeaponId }[] = []
  private lastShooter: number | null = null
  private lastImpact: Vec2 | null = null
  private demo: (DemoOptions & { shotDone: boolean; seed: number }) | null = null
  private frozen = false
  private random: () => number = Math.random
  private phaseT = 0
  private movedT = 0
  private slow = 0
  private slowScale = SLOW_SCALE
  private scale = 1
  private lastHumanId: number | null = null // último humano que tuvo el turno (hot-seat)
  // guía de apuntado: se recalcula solo si cambia la clave (ángulo, potencia, arma, posición, viento...)
  private tracerCache: { key: string; path: Vec2[]; short: boolean } | null = null
  // v2: cámara y minimapa
  private cam = new CameraController()
  private camKey = '' // turno que sigue la cámara; si cambia, vuelve al tanque
  private lastImpacts = new Map<number, Vec2>() // último impacto de cada jugador en la ronda
  // v2 muerte súbita: subida de la lava en curso (presentación) y avisos para el audio
  private lavaAnim: { from: number; to: number; t: number } | null = null
  private windNotice = 0 // v2.2: segundos que queda el aviso de cambio de viento
  private suddenDeathSaid = false // ya se avisó en esta ronda que empezó la muerte súbita
  private suddenDeathNews = false // se avisó y main.ts todavía no lo levantó (sonido y vibración)
  private melts: Vec2[] = [] // proyectiles derretidos en la lava desde la última llamada a pullMelts
  // v3 abismo: tanques perdidos en la ronda (se dibujan debajo del mapa, no apoyados en el fondo) y el
  // tope del borde: el humano que camina hacia un abismo frena una vez; si suelta y vuelve a apretar, cae.
  private lost = new Set<number>()
  private edge: { key: string; dir: -1 | 1; x: number; armed: boolean } | null = null
  private edgeNews = false // frenó en un borde y main.ts todavía no lo levantó (sonido de aviso)
  // v2.3: globo "!" (RenderFrame.alerts): segundos que le quedan a cada jugador. Hoy lo prende solo el
  // tope del borde del abismo, mientras el humano está frenado ahí (y ALERT_TIME después del último intento).
  private alertT = new Map<number, number>()
  // v2.4: "!" pedidos durante un tiro (se ven recién al terminar, que es cuando hay globos) y jugadores con
  // un "!" nuevo que main.ts todavía no levantó (pitido de atención)
  private alertSoon = new Set<number>()
  private alertNews: number[] = []
  private turnAlertKey = '' // turno ya revisado para el "!" de arrancar metido en lava
  // v2.4: salpicaduras para RenderFrame.splashes (aparte de las del audio): las nuevas desde el último frame
  private frameSplashes: Vec2[] = []
  // v4 líquidos: salpicaduras de proyectiles que entraron al agua desde la última llamada a
  // pullSplashes, impactos con el centro bajo el agua y lo que movió cada flujo (para el audio)
  private splashes: Vec2[] = []
  private submerged = new WeakSet<GameEvent>()
  private newProps = new WeakSet<GameEvent>() // v3: eventos prop que agregan utilería (botín que cae)
  // v3 teledirigido: guiado en curso, lado pedido por el input local (-1 izquierda, 1 derecha), plan de la
  // IA que disparó (se pasa al guiado al empezar), tandas propias ya mostradas que el cliente espera ver
  // volver en el log (predicción) y tandas nuevas para el sonido
  private guide: GuidePlay | null = null
  private steerSide: -1 | 0 | 1 = 0
  private aiSteer: { playerId: number; dirs: (-1 | 0 | 1)[] } | null = null
  private predicted: string[] = []
  private steerNews: { dir: -1 | 0 | 1; left: number }[] = []
  // v3: destino de jetpack / teletransporte que se está eligiendo (key: turno en que se empezó)
  private itemAim: { item: 'jetpack' | 'teleport'; playerId: number; key: string; x: number; y: number } | null = null
  private flowInfos = new WeakMap<GameEvent, FlowInfo>()
  // online
  private mode: SessionMode = 'local'
  private localIds = new Set<number>()
  private route: NetSeat['route'] | null = null
  private inbox: Inbound[] = []
  private logic: GameState | null = null // client: réplica con todo el log aplicado (adelante de lo que se ve)
  private accepted = false
  private awaitFire = 0 // client: segundos esperando que el anfitrión confirme el tiro
  private sentReady = new Set<number>()
  private sentNext = false
  netHud: HudNet | null = null

  get netMode(): SessionMode {
    return this.mode
  }

  // Estado autoritativo: client, la réplica con todo el log; si no, con un tiro en
  // reproducción, el de después del tiro.
  get authState(): GameState | null {
    if (this.mode === 'client') return this.logic
    return this.playback ? this.playback.after : this.state
  }

  // host: humano remoto que tiene el turno (para el timer de la sala), con una clave por turno.
  get remoteTurn(): { key: string; playerId: number } | null {
    const s = this.state
    if (this.mode !== 'host' || !s || s.phase !== 'aiming' || this.playback) return null
    const p = s.players[s.current]
    if (!p || !p.alive || !this.controlledByHuman(p) || this.isLocal(p)) return null
    return { key: `${this.matchId}:${s.turn}:${p.id}`, playerId: p.id }
  }

  // Online: te toca a vos (humano de este dispositivo) y podés jugar.
  get myTurn(): boolean {
    return this.mode !== 'local' && this.inputEnabled
  }

  // client: pidió la próxima ronda y espera que el anfitrión la confirme.
  get awaitingHost(): boolean {
    return this.sentNext && this.state?.phase === 'roundover'
  }

  get busy(): boolean {
    return this.playback !== null
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  // Si el tanque avanzó hace instantes (para el sonido del motor).
  get moving(): boolean {
    return this.movedT > 0
  }

  get isDemo(): boolean {
    return this.demo !== null
  }

  // Segundos desde que la partida salió de 'aiming' (fin de ronda o de partida); 0 si se juega.
  get finishedFor(): number {
    return this.phaseT
  }

  // Factor de tiempo del último update (cámara lenta en el golpe que cierra la ronda).
  get timeScale(): number {
    return this.scale
  }

  // v2.4: escala de tiempo de lo que viene (la del próximo update): para el audio, que la necesita ya en
  // el frame en que arranca la cámara lenta (el golpe final o la caída al abismo suenan estirados desde el
  // principio) y en el que termina.
  get soundScale(): number {
    return this.slow > 0 ? this.slowScale : 1
  }

  get inputEnabled(): boolean {
    const s = this.state
    if (!s || s.phase !== 'aiming' || this.playback || this.frozen) return false
    const p = s.players[s.current]
    if (this.mode === 'client' && (this.awaitFire > 0 || this.inbox.length > 0)) return false
    return !!p && this.controlledHere(p) && !this.bannerFor()
  }

  start(config: MatchConfig, demo?: DemoOptions, seat?: NetSeat): void {
    this.mode = demo ? 'local' : seat?.mode ?? 'local'
    this.localIds = new Set(seat?.localIds ?? [])
    this.route = seat?.route ?? null
    this.inbox = []
    this.awaitFire = 0
    this.sentReady.clear()
    this.sentNext = false
    const seed = config.seed ?? ((Math.random() * 0xffffffff) >>> 0)
    // v5: hasta MAX_PLAYERS_BY_SIZE[size] casilleros (Chico 4, Mediano 6, Grande 8), igual que createMatch
    const slots = config.slots.slice(0, MAX_PLAYERS_BY_SIZE[config.size ?? 'small'] ?? 4)
    this.config = { ...config, slots, rounds: Math.max(1, Math.round(config.rounds || 1)), seed }
    this.state = createMatch(this.config)
    this.logic = this.mode === 'client' ? this.state : null
    this.playback = null
    this.fx = []
    this.ai = null
    this.aiToken++
    this.aim = null
    this.resetGuide()
    this.message = ''
    this.messageT = 0
    this.terrainVersion++
    this.matchId++
    this.moveAcc = 0
    this.shots = []
    this.lastShooter = null
    this.lastImpact = null
    this.frozen = false
    this.phaseT = 0
    this.movedT = 0
    this.slow = 0
    this.scale = 1
    this.lastHumanId = null
    this.tracerCache = null
    this.resetLava()
    this.resetAbyss()
    // HUD C: el tablero de abajo tapa HUD_BAR_H filas y la cámara apoya el piso encima; el demo congelado
    // de QA no tiene tablero y conserva el encuadre de siempre (piso en el borde de abajo)
    this.cam.bar = demo?.freeze ? 0 : HUD_BAR_H
    this.resetCamera()
    this.demo = demo ? { ...demo, shotDone: false, seed } : null
    this.random = demo ? seededRandom(seed ^ 0x5bd1e995) : Math.random
    if (!demo?.freeze && !this.aiClient && this.mode !== 'client') this.aiClient = new AiClient()
  }

  // QA (?play=...&calm=N): arranca la ronda con N tiros sin daño ya contados, para probar la muerte
  // súbita rápido. Solo en partidas locales, antes del primer tiro.
  qaCalm(calm: number): void {
    const s = this.state
    if (!s || this.mode !== 'local' || this.playback) return
    this.state = { ...s, calm: Math.max(0, Math.round(calm)) }
  }

  // ---------- online ----------

  // host: HostRoom.hooks.apply. Todo comando del log pasa por acá (el del anfitrión y el de los
  // peers, ya verificado por la sala). true si la sim lo aceptó.
  applyNet(command: Command): boolean {
    const s = this.state
    if (this.mode !== 'host' || !s) return false
    // v3: las tandas del teledirigido se aceptan también durante el ascenso (ver applySteer)
    if (command.type === 'steer') {
      this.accepted = false
      return this.applySteer(command)
    }
    if (this.playback) return false
    if (TURN_COMMANDS.has(command.type)) {
      const id = (command as { playerId: number }).playerId
      if (s.phase !== 'aiming' || s.players[s.current]?.id !== id) return false
    }
    this.accepted = false
    return this.dispatch(command) || this.accepted
  }

  // host: comando propio que espera a que termine el tiro en curso (setKind de un peer caído).
  hostCommand(command: Command): void {
    if (this.mode !== 'host') return
    this.inbox.push({ command, result: null })
  }

  // client: ClientRoom.hooks.apply. Se aplica ya sobre la réplica lógica (para el hash) y se
  // muestra en orden cuando termina el tiro en reproducción.
  receive(command: Command): void {
    if (this.mode !== 'client' || !this.logic) return
    let result: StepResult
    try {
      result = applyCommand(this.logic, command)
    } catch (err) {
      console.error(err)
      result = { state: this.logic, events: [] }
    }
    this.logic = result.state
    this.inbox.push({ command, result })
  }

  // client: estado completo del anfitrión (desincronización o reconexión).
  loadSnapshot(state: GameState): void {
    const round = this.state?.round
    this.state = state
    this.logic = state
    this.playback = null
    this.inbox = []
    this.awaitFire = 0
    this.aim = null
    this.terrainVersion++
    this.lavaAnim = null
    this.resetGuide()
    if (round !== state.round) this.newRound()
    // ya empezada (reconexión): no se vuelve a avisar
    if (state.lava != null) this.suddenDeathSaid = true
    // v3: llegó en pleno guiado de un teledirigido: se sigue desde donde está el misil
    if (state.phase === 'guiding') this.beginGuide(state, 'guided', 1)
  }

  // Cañón de otro jugador en vivo (aimLive): solo visual, no toca el estado.
  remoteAim(playerId: number, angle: number, power: number): void {
    const s = this.state
    if (!s || this.playback || s.phase !== 'aiming') return
    const p = s.players[s.current]
    if (!p || p.id !== playerId || this.controlledHere(p)) return
    this.aim = { playerId, angle: clamp(angle, 0, 180), power: clamp(power, 0, 100) }
  }

  // Apuntado en vivo del jugador de turno (para mandar como aimLive), o null.
  liveAim(): { playerId: number; angle: number; power: number } | null {
    const s = this.state
    if (!s || this.playback || s.phase !== 'aiming') return null
    const p = s.players[s.current]
    if (!p || !p.alive) return null
    if (this.aim && this.aim.playerId === p.id) return { ...this.aim }
    return { playerId: p.id, angle: p.angle, power: p.power }
  }

  // Jugador que controla este dispositivo (humano, no IA).
  isLocal(p: Player): boolean {
    if (p.kind !== 'human') return false
    return this.mode === 'local' || this.localIds.has(p.id)
  }

  // ---------- v3 teledirigido ----------

  // El misil que se ve lo dirige el humano de este dispositivo (en hot-seat, el dueño; online, solo si es tuyo).
  get steering(): boolean {
    const s = this.state
    const g = this.guide
    if (!s || !g || s.phase !== 'guiding' || this.playback || this.frozen) return false
    const owner = s.players.find((p) => p.id === g.ownerId)
    return !!owner && this.controlledHere(owner)
  }

  // Lado pedido por el input local mientras se guía: -1 izquierda, 1 derecha, 0 derecho. Se lee al armar
  // cada tanda (cada STEER_BATCH ticks). La sim gira con -1 antihorario y 1 horario en pantalla; con el
  // misil bajando, horario lleva la punta a la izquierda: izquierda = 1, derecha = -1.
  steerInput(side: -1 | 0 | 1): void {
    this.steerSide = side
  }

  // Tandas nuevas desde la última llamada (soplido del cohete): lado de la sim y fracción de guiado que queda.
  pullSteers(): { dir: -1 | 0 | 1; left: number }[] {
    const out = this.steerNews
    this.steerNews = []
    return out
  }

  // Online (steerLive): posición del misil que dirige este dispositivo, para mandarla en vivo; null si no.
  liveSteer(): { playerId: number; x: number; y: number } | null {
    const g = this.guide
    if (!g || !this.steering) return null
    const at = samplePath(g.pts, g.t)
    return { playerId: g.ownerId, x: at.x, y: at.y }
  }

  // Online (steerLive): posición en vivo del misil de otro. Solo visual: la cámara la mira mientras el log
  // todavía no trajo ese tramo.
  remoteSteer(playerId: number, x: number, y: number): void {
    const g = this.guide
    if (!g || g.ownerId !== playerId || !Number.isFinite(x) || !Number.isFinite(y)) return
    g.hint = { x, y, at: performance.now() }
  }

  // ---------- v3 destino de jetpack y teletransporte ----------

  // Destino que se está eligiendo (cursor recortado al rango), o null.
  get aimingItem(): ItemAimView | null {
    const a = this.itemAim
    const s = this.state
    if (!a || !s || !this.inputEnabled) return null
    const p = s.players[s.current]
    if (!p || p.id !== a.playerId || this.turnKey(s) !== a.key || (p.items?.[a.item] ?? 0) <= 0) return null
    const from = { x: p.x, y: p.y - TANK_H / 2 }
    const range = a.item === 'jetpack' ? JETPACK_RANGE : TELEPORT_RANGE
    return { item: a.item, from, to: this.clampTarget(s, from, range, a.x, a.y), range }
  }

  // Empieza a elegir destino (el ítem no se gasta hasta confirmar). El cursor arranca un poco adelante.
  beginItemAim(item: 'jetpack' | 'teleport'): boolean {
    const s = this.state
    if (!this.inputEnabled || !s) return false
    const p = s.players[s.current]
    if ((p.items?.[item] ?? 0) <= 0) {
      this.flash(`Sin ${ITEM_NAMES[item]}`)
      return false
    }
    const ahead = p.angle <= 90 ? 1 : -1
    const range = item === 'jetpack' ? JETPACK_RANGE : TELEPORT_RANGE
    this.itemAim = { item, playerId: p.id, key: this.turnKey(s), x: p.x + ahead * range * 0.5, y: p.y - TANK_H / 2 - 30 }
    this.flash(item === 'jetpack' ? 'Elegi donde saltar' : 'Elegi el destino')
    return true
  }

  // Mueve el cursor (teclado, gamepad) en px de mundo.
  moveItemCursor(dx: number, dy: number): void {
    const v = this.aimingItem
    if (!v || !this.itemAim) return
    this.itemAim.x = v.to.x + dx
    this.itemAim.y = v.to.y + dy
  }

  // Pone el cursor en un punto del mundo (mouse, toque).
  setItemCursor(x: number, y: number): void {
    if (!this.aimingItem || !this.itemAim) return
    this.itemAim.x = x
    this.itemAim.y = y
  }

  // Confirma: manda useItem con el destino. true si la sim lo aceptó.
  confirmItemAim(): boolean {
    const v = this.aimingItem
    const s = this.state
    if (!v || !s) return false
    this.itemAim = null
    const p = s.players[s.current]
    const target = { x: Math.round(v.to.x), y: Math.round(v.to.y) }
    const ok = this.act({ type: 'useItem', playerId: p.id, item: v.item, target })
    if (!ok) this.flash('No se puede')
    return ok
  }

  // Esc: cancela sin gastar el ítem.
  cancelItemAim(): boolean {
    if (!this.itemAim) return false
    this.itemAim = null
    return true
  }

  // v3 perfil: color elegido para el casillero (SlotConfig.color, índice en TANK_COLORS) para los modelos de
  // las vistas (tabla, cartel de turno, tienda, HUD, minimapa). Si la sim ya lo aplica a Player.color da lo
  // mismo; si no lo trae, queda el de la sim. El id del jugador es su índice de casillero.
  private colorOf(p: Player): number {
    const c = this.config?.slots[p.id]?.color
    return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < TANK_COLORS.length ? TANK_COLORS[c] : p.color
  }

  private turnKey(s: GameState): string {
    return `${this.matchId}:${s.turn}:${s.current}`
  }

  // Destino dentro del círculo de alcance y del mapa (en y, desde un poco arriba del cielo hasta el piso).
  private clampTarget(s: GameState, from: Vec2, range: number, x: number, y: number): Vec2 {
    let dx = x - from.x
    let dy = y - from.y
    const d = Math.hypot(dx, dy)
    if (d > range) {
      dx *= range / d
      dy *= range / d
    }
    return { x: clamp(from.x + dx, TANK_W / 2, s.terrain.w - TANK_W / 2), y: clamp(from.y + dy, 0, s.terrain.h - 1) }
  }

  // QA (?autotest=1): apunta a un valor fijo y dispara.
  fireWith(angle: number, power: number): void {
    if (!this.inputEnabled || !this.state) return
    const aim = this.currentAim()
    if (aim) {
      aim.angle = clamp(angle, 0, 180)
      aim.power = clamp(power, 0, 100)
    }
    this.fire()
  }

  // Apuntado absoluto (arrastre táctil). Igual que nudge, se manda a la sim al disparar.
  aimTo(angle: number, power: number): void {
    if (!this.inputEnabled || !this.state) return
    const aim = this.currentAim()
    if (!aim) return
    aim.angle = clamp(Math.round(angle), 0, 180)
    aim.power = clamp(Math.round(power), 0, 100)
  }

  // Ajuste continuo del ángulo y la potencia del humano (con Shift o el paso táctil corto, fino y con
  // decimales). Se manda a la sim al disparar, redondeado a un decimal.
  nudge(dAngle: number, dPower: number): void {
    if (!this.inputEnabled || !this.state || (dAngle === 0 && dPower === 0)) return
    const aim = this.currentAim()
    if (!aim) return
    aim.angle = clamp(aim.angle + dAngle, 0, 180)
    aim.power = clamp(aim.power + dPower, 0, 100)
  }

  move(dir: -1 | 1, dt: number): void {
    if (!this.inputEnabled || !this.state) return
    this.moveAcc += MOVE_SPEED * dt
    let steps = Math.min(3, Math.floor(this.moveAcc))
    this.moveAcc -= steps
    while (steps-- > 0) {
      const s = this.state
      const p = s?.players[s.current]
      if (!s || !p || this.playback) break
      // v2.4: sin combustible: "!" sobre el tanque mientras insiste
      if ((p.fuel ?? 0) <= 0) {
        this.noFuel(p)
        break
      }
      if (this.edgeStop(s, p, dir)) {
        this.moveAcc = 0
        break
      }
      if (!this.act({ type: 'move', playerId: p.id, dir })) break
      this.movedT = 0.12
      // v2.4: ese paso gastó lo último que quedaba
      const after = this.state?.players.find((q) => q.id === p.id)
      if (after && after.alive && (after.fuel ?? 0) <= 0 && !this.playback) this.noFuel(after)
    }
  }

  // v2.4: el humano se quedó sin combustible al moverse: "!" y el cartel de siempre en el HUD.
  private noFuel(p: Player): void {
    this.alert(p.id)
    this.flash('Sin combustible')
  }

  // v2.4: globo "!" sobre un jugador por ALERT_TIME. Con un tiro en reproducción no hay globos, así que
  // queda pedido y se prende al terminar el tiro (si no, se gastaría el tiempo sin verse).
  private alert(id: number | undefined): void {
    if (id == null || this.demo?.freeze) return
    if (this.playback) {
      this.alertSoon.add(id)
      return
    }
    if (!this.alertT.has(id)) this.alertNews.push(id)
    this.alertT.set(id, ALERT_TIME)
  }

  // Jugadores con un "!" nuevo desde la última llamada (para el pitido).
  pullAlerts(): number[] {
    const out = this.alertNews
    this.alertNews = []
    return out
  }

  // Soltó la dirección (o no aprieta ninguna): el tope del borde queda armado y el próximo intento
  // en la misma dirección, desde el mismo lugar, pasa y cae.
  stopMove(): void {
    this.moveAcc = 0
    if (this.edge) this.edge.armed = true
  }

  // true una vez cada vez que el humano frena en el borde de un abismo (sonido de aviso).
  pullEdgeWarning(): boolean {
    const news = this.edgeNews
    this.edgeNews = false
    return news
  }

  // v3: el paso siguiente tiraría al tanque al abismo. Lo frena la primera vez (aviso) y lo deja pasar
  // si el jugador soltó y volvió a apretar hacia el mismo lado sin moverse de ahí. Solo para el input
  // humano: la sim permite caer y la IA decide por su cuenta.
  private edgeStop(s: GameState, p: Player, dir: -1 | 1): boolean {
    const key = `${this.matchId}:${s.turn}:${p.id}`
    const e = this.edge
    const same = !!e && e.key === key && e.dir === dir && e.x === p.x
    if (same && e.armed) {
      // pasa y cae: el globo se apaga (la caída se ve sola)
      this.edge = null
      this.alertT.delete(p.id)
      return false
    }
    if (same) {
      // sigue apretando desde el tope: el globo sigue prendido mientras esté frenado
      this.alertT.set(p.id, ALERT_TIME)
      return true
    }
    if (!this.stepFallsIntoAbyss(s, p, dir)) {
      // se alejó del borde o cambió de turno: el tope (y su globo) se olvida
      if (e && (e.key !== key || e.x !== p.x)) {
        this.edge = null
        this.alertT.delete(p.id)
      }
      return false
    }
    this.edge = { key, dir, x: p.x, armed: false }
    this.edgeNews = true
    this.alertT.set(p.id, ALERT_TIME)
    this.flash('Abismo! Apreta otra vez')
    return true
  }

  // Prueba el paso en una copia (applyCommand es puro) y mira si termina en una caída al abismo.
  private stepFallsIntoAbyss(s: GameState, p: Player, dir: -1 | 1): boolean {
    // sin columnas de abismo en el mapa no hace falta probar nada (Chico, mapas de v2)
    const pits = s.terrain.pits
    if (!pits) return false
    let near = false
    const x0 = Math.max(0, Math.round(p.x) - TANK_W)
    const x1 = Math.min(s.terrain.w - 1, Math.round(p.x) + TANK_W)
    for (let x = x0; x <= x1 && !near; x++) near = pits[x] === 1
    if (!near) return false
    try {
      const r = applyCommand(s, { type: 'move', playerId: p.id, dir })
      return hasAbyss(r.events, s.terrain.h)
    } catch {
      return false
    }
  }

  select(weapon: WeaponId): void {
    if (!this.inputEnabled || !this.state) return
    const p = this.state.players[this.state.current]
    if ((p.ammo[weapon] ?? 0) <= 0) {
      this.flash('Sin municion')
      return
    }
    this.act({ type: 'selectWeapon', playerId: p.id, weapon })
  }

  // Arma anterior/siguiente con munición (gamepad).
  cycleWeapon(dir: -1 | 1, order: WeaponId[]): void {
    if (!this.inputEnabled || !this.state) return
    const p = this.state.players[this.state.current]
    const at = Math.max(0, order.indexOf(p.weapon))
    for (let i = 1; i <= order.length; i++) {
      const w = order[(at + dir * i + order.length * 2) % order.length]
      if ((p.ammo[w] ?? 0) > 0) {
        if (w !== p.weapon) this.act({ type: 'selectWeapon', playerId: p.id, weapon: w })
        return
      }
    }
  }

  fire(): void {
    if (!this.inputEnabled || !this.state) return
    this.commitAimAndFire(this.state.players[this.state.current].id)
  }

  // Q/F/R/T: escudo, combustible, reparación, trazador; v3: ancla y deflector. Devuelve true si se aplicó.
  // v3: jetpack y teletransporte sin destino entran en el modo de elegir destino (true si empezó).
  useItem(item: ItemId, target?: Vec2): boolean {
    if (!this.inputEnabled || !this.state) return false
    if ((item === 'jetpack' || item === 'teleport') && !target) return this.beginItemAim(item)
    const p = this.state.players[this.state.current]
    if ((p.items?.[item] ?? 0) <= 0) {
      this.flash(`Sin ${ITEM_NAMES[item]}`)
      return false
    }
    const ok = this.act(target ? { type: 'useItem', playerId: p.id, item, target } : { type: 'useItem', playerId: p.id, item })
    if (!ok) this.flash('No se puede')
    return ok
  }

  // Primer ítem usable del inventario (botón B del gamepad).
  firstUsableItem(): ItemId | null {
    const s = this.state
    if (!s) return null
    const p = s.players[s.current]
    for (const id of USABLE) {
      if ((p?.items?.[id] ?? 0) <= 0) continue
      if (id === 'shield' && p.shield > 0) continue
      if (id === 'tracer' && p.tracer) continue
      if (id === 'anchor' && p.anchored) continue
      if (id === 'deflector' && p.deflector) continue
      return id
    }
    return null
  }

  // ---------- rondas, tienda, hot-seat ----------

  nextRound(): void {
    const s = this.state
    if (!s || s.phase !== 'roundover') return
    // client: la próxima ronda la decide el anfitrión
    if (this.mode === 'client') {
      this.sentNext = true
      return
    }
    this.act({ type: 'nextRound' })
    this.skipEmptyShop()
  }

  // Humanos que todavía no terminaron de comprar, en orden de jugador.
  shopQueue(): Player[] {
    const s = this.state
    if (!s || s.phase !== 'shop') return []
    return s.players.filter((p) => this.isLocal(p) && !p.ready && !this.sentReady.has(p.id))
  }

  shopModel(playerId: number): ShopModel | null {
    const s = this.state
    const p = s?.players.find((q) => q.id === playerId)
    if (!s || !p) return null
    return {
      playerId: p.id,
      name: p.name,
      color: this.colorOf(p),
      crew: p.crew,
      money: p.money,
      round: Math.min(s.rounds, s.round + 1),
      rounds: s.rounds,
      rows: SHOP.map((e) => {
        const owned = ownedOf(p, e.id)
        return {
          id: e.id,
          kind: e.kind,
          name: e.name,
          price: e.price,
          qty: e.qty,
          owned,
          max: e.max,
          canBuy: p.money >= e.price && owned + e.qty <= e.max,
          canSell: owned > 0,
        }
      }),
    }
  }

  buy(playerId: number, id: ShopId): boolean {
    if (this.mode === 'client' && !this.shopModel(playerId)?.rows.find((r) => r.id === id)?.canBuy) return false
    return this.act({ type: 'buy', playerId, id })
  }

  sell(playerId: number, id: ShopId): boolean {
    if (this.mode === 'client' && !this.shopModel(playerId)?.rows.find((r) => r.id === id)?.canSell) return false
    return this.act({ type: 'sell', playerId, id })
  }

  ready(playerId: number): void {
    if (this.mode === 'client') {
      this.sentReady.add(playerId)
      this.act({ type: 'ready', playerId })
      return
    }
    this.act({ type: 'ready', playerId })
    this.skipEmptyShop()
  }

  scoreModel(): ScoreModel | null {
    const s = this.state
    if (!s) return null
    return {
      round: s.round,
      rounds: s.rounds,
      roundWinnerId: s.roundWinnerId ?? null,
      final: s.phase === 'gameover',
      winnerId: s.winnerId,
      rows: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: this.colorOf(p),
        crew: p.crew,
        alive: p.alive,
        roundsWon: p.roundsWon ?? 0,
        kills: p.kills ?? 0,
        earned: s.earnings?.[p.id] ?? 0,
        money: p.money ?? 0,
      })),
    }
  }

  // Hot-seat: el humano que tiene que ver el cartel antes de jugar, o null.
  bannerFor(): Player | null {
    const s = this.state
    if (!s || s.phase !== 'aiming' || this.playback || this.demo) return null
    const p = s.players[s.current]
    if (!p || !p.alive || !this.isLocal(p) || p.id === this.lastHumanId) return null
    // solo entre humanos del mismo dispositivo
    if (s.players.filter((q) => this.isLocal(q) && q.alive).length < 2) {
      this.lastHumanId = p.id
      return null
    }
    return p
  }

  bannerModel(): BannerModel | null {
    const p = this.bannerFor()
    const s = this.state
    if (!p || !s) return null
    return { name: p.name, color: this.colorOf(p), crew: p.crew, round: s.round, rounds: s.rounds }
  }

  ackBanner(): void {
    const p = this.bannerFor()
    if (p) this.lastHumanId = p.id
  }

  update(dt: number): void {
    if (!this.frozen) {
      this.windNotice = Math.max(0, this.windNotice - dt)
      for (const [id, t] of this.alertT) {
        if (t - dt <= 0) this.alertT.delete(id)
        else this.alertT.set(id, t - dt)
      }
    }
    this.step(dt)
    if (!this.frozen) {
      this.updateCamera(dt)
      this.lavaTurnAlert()
    }
  }

  // v2.4: un tanque que arranca su turno metido en lava (de la grilla, o debajo de la superficie de la
  // lava de la muerte súbita) muestra el "!". Se revisa una vez por turno, cuando ya no hay tiro.
  private lavaTurnAlert(): void {
    const s = this.state
    if (!s || this.playback || s.phase !== 'aiming') return
    const key = `${this.matchId}:${s.turn}:${s.current}`
    if (key === this.turnAlertKey) return
    this.turnAlertKey = key
    const p = s.players[s.current]
    if (p && p.alive && inLava(s, p)) this.alert(p.id)
  }

  private step(dt: number): void {
    this.scale = 1
    if (!this.state || this.frozen) return
    if (this.movedT > 0) this.movedT -= dt
    if (this.messageT > 0) {
      this.messageT -= dt
      if (this.messageT <= 0) this.message = ''
    }
    if (this.slow > 0) {
      this.scale = this.slowScale
      this.slow = Math.max(0, this.slow - dt)
    }
    if (this.awaitFire > 0) this.awaitFire = Math.max(0, this.awaitFire - dt)
    if (this.lavaAnim) {
      this.lavaAnim.t += dt * this.scale
      if (this.lavaAnim.t >= LAVA_ANIM) this.lavaAnim = null
    }
    if (this.playback) {
      this.advance(dt * this.scale)
      return
    }
    this.drain()
    if (this.playback) return
    if (this.state.phase === 'guiding') {
      // v3: teledirigido en la bajada (también el cliente: dirige el suyo y muestra el de los demás)
      this.phaseT = 0
      this.stepGuide(dt)
      return
    }
    if (this.state.phase !== 'aiming') {
      this.phaseT += dt
      // demo: la partida entre IAs sigue sola (tienda de IAs incluida)
      if (this.demo && this.state.phase === 'roundover' && this.phaseT > 1.5) this.nextRound()
      return
    }
    this.phaseT = 0
    if (this.mode === 'client') return
    this.driveAi(dt)
  }

  // ---------- v3 teledirigido: guiado ----------

  // Empieza el guiado desde el estado con phase 'guiding' (al terminar el ascenso o con un snapshot).
  private beginGuide(state: GameState, weapon: WeaponId, zoom: number): void {
    const gs = state.guided
    if (!gs) return
    const plan = this.aiSteer && this.aiSteer.playerId === gs.ownerId ? this.aiSteer.dirs : null
    this.aiSteer = null
    this.guide = {
      ownerId: gs.ownerId,
      weapon,
      pts: [{ x: gs.x, y: gs.y }],
      t: 0,
      guide0: Number.isFinite(gs.guide) ? gs.guide : GUIDE_TIME,
      zoom: clamp(zoom, GUIDE_ZOOM_MIN, 1),
      clock: 0,
      ticks: 0,
      plan,
      idle: 0,
      stuck: 0,
      hint: null,
    }
  }

  private resetGuide(): void {
    this.guide = null
    this.steerSide = 0
    this.aiSteer = null
    this.predicted = []
    this.steerNews = []
    this.itemAim = null
  }

  // Avanza el cabezal y, si el misil es de este dispositivo (humano local o IA del anfitrión/local), arma
  // una tanda de STEER_BATCH ticks cada STEER_BATCH × STEER_TICK segundos. La tanda se manda al empezar su
  // ventana con el lado que se aprieta en ese momento: así el camino siempre va una tanda adelante del
  // cabezal y el misil no se frena esperando (la demora del input es de una tanda, 0,1 s).
  private stepGuide(dt: number): void {
    const s = this.state
    const g = this.guide
    if (!s || !g) {
      if (s?.phase === 'guiding') this.beginGuide(s, 'guided', 1)
      return
    }
    const end = (g.pts.length - 1) * PATH_DT
    g.t = Math.min(end, g.t + dt)
    const owner = s.players.find((p) => p.id === g.ownerId)
    if (!owner) return
    const here = this.controlledHere(owner)
    const ai = !this.controlledByHuman(owner) && this.mode !== 'client'
    if (here || ai) {
      g.clock -= dt
      if (g.clock > 0) return
      const span = STEER_BATCH * STEER_TICK
      g.clock = Math.max(-span, g.clock) + span
      const dirs: (-1 | 0 | 1)[] = []
      for (let i = 0; i < STEER_BATCH; i++) {
        const side = here ? this.steerSide : 0
        dirs.push(here ? ((-side) as -1 | 0 | 1) : g.plan?.[g.ticks + i] ?? 0)
      }
      g.ticks += STEER_BATCH
      if (this.act({ type: 'steer', playerId: owner.id, dirs })) g.stuck = 0
      else if (++g.stuck === 40) console.warn('teledirigido: la sim no acepta las tandas de steer')
    } else if (this.mode === 'host') {
      // dueño remoto que no manda nada (se colgó o tiene la pestaña dormida): ceros para que el misil caiga
      g.idle += dt
      if (g.idle > GUIDE_IDLE) {
        g.idle = 0
        this.act({ type: 'steer', playerId: owner.id, dirs: new Array(STEER_BATCH).fill(0) })
      }
    }
  }

  // Una tanda de 'steer' que llega a la sesión: la propia (local o del anfitrión), la del log (cliente, con
  // pre) o una de la sala (anfitrión). Durante el ascenso del misil (anfitrión, playback con guideFrom) se
  // aplica sobre after y queda en cola. true si la sim la aceptó.
  private applySteer(command: Extract<Command, { type: 'steer' }>, pre?: StepResult): boolean {
    const pb = this.playback
    if (pb) {
      const before = pb.after
      if (!pb.guideFrom || before.phase !== 'guiding' || before.guided?.ownerId !== command.playerId) return false
      const r = pre ?? safeApply(before, command)
      if (!r || (r.state === before && r.events.length === 0)) return false
      pb.after = r.state
      pb.guideQueue.push({ before, result: r })
      this.accepted = true
      return true
    }
    const s = this.state
    if (!s || s.phase !== 'guiding' || s.guided?.ownerId !== command.playerId) return false
    const r = pre ?? safeApply(s, command)
    if (!r || (r.state === s && r.events.length === 0)) return false
    this.accepted = true
    this.takeSteer(s, r, command)
    return true
  }

  // Muestra el resultado de una tanda: si el misil sigue guiado, su tramo se suma al camino; si terminó
  // (chocó o se acabó el guiado), lo que falta ver del camino, el vuelo final y las explosiones van como un
  // tiro normal (playback), empalmados sin corte.
  private takeSteer(before: GameState, r: StepResult, command?: Extract<Command, { type: 'steer' }>): void {
    if (!this.guide) this.beginGuide(before, 'guided', 1)
    const g = this.guide
    if (!g) {
      this.state = r.state
      return
    }
    g.idle = 0
    if (command) {
      const left = clamp((g.guide0 - g.ticks * STEER_TICK) / Math.max(1e-6, g.guide0), 0, 1)
      for (const d of command.dirs.slice(0, 1)) this.steerNews.push({ dir: d, left })
    }
    const base = before.guided?.t ?? 0
    const flights = (r.flights ?? []).slice().sort((a, b) => (a.startT ?? 0) - (b.startT ?? 0))
    const off = steerOffset(base, flights, r.events)
    if (r.state.phase === 'guiding') {
      for (const f of flights) appendPath(g.pts, f.path)
      // la sim no mandó el tramo: el punto nuevo sale del estado
      if (!flights.length && r.state.guided) appendPath(g.pts, [{ x: r.state.guided.x, y: r.state.guided.y }])
      this.state = r.state
      if (r.events.length) this.fx.push(...r.events)
      for (const e of r.events) this.noteEvent(e, null, before, r.state)
      return
    }
    // lo que todavía no se vio del camino, remuestreado cada PATH_DT desde el cabezal
    const end = (g.pts.length - 1) * PATH_DT
    const n = Math.max(0, Math.ceil((end - g.t) / PATH_DT - 1e-6))
    const prefix: Vec2[] = []
    for (let k = 0; k <= n; k++) prefix.push(samplePath(g.pts, Math.min(end, g.t + k * PATH_DT)))
    const lead = n * PATH_DT
    let merged = false
    const out: Flight[] = flights.map((f) => {
      const start = (f.startT ?? 0) - off + lead
      if (!merged && Math.abs(start - lead) < 2 * PATH_DT) {
        merged = true
        const path = prefix.slice()
        appendPath(path, f.path)
        const shift = (prefix.length - 1) * PATH_DT
        return { ...f, path, startT: 0, splashes: f.splashes?.map((sp) => ({ ...sp, t: sp.t + shift })) }
      }
      return { ...f, startT: Math.max(0, start) }
    })
    if (!merged && prefix.length > 1) {
      // sin vuelo que empalme (la sim no lo mandó): el resto del camino como un vuelo sin impacto propio
      const last = prefix[prefix.length - 1]
      out.unshift({ path: prefix, impact: { kind: 'out', x: last.x, y: last.y }, startT: 0 })
    }
    const events = r.events.map((e) => {
      const t = (e as { t?: unknown }).t
      return typeof t === 'number' && Number.isFinite(t) ? ({ ...e, t: Math.max(0, t - off + lead) } as GameEvent) : e
    })
    this.guide = null
    this.startPlayback(before, r.state, events, out, g.ownerId, { weapon: g.weapon, guided: true, zoom: g.zoom })
  }

  // Posición y velocidad del misil en el cabezal.
  private guideNow(g: GuidePlay): { x: number; y: number; vx: number; vy: number } {
    const at = samplePath(g.pts, g.t)
    const end = (g.pts.length - 1) * PATH_DT
    let vx = 0
    let vy = 0
    if (g.pts.length > 1) {
      const t0 = Math.max(0, Math.min(g.t, end - PATH_DT))
      const a = samplePath(g.pts, t0)
      const b = samplePath(g.pts, t0 + PATH_DT)
      vx = (b.x - a.x) / PATH_DT
      vy = (b.y - a.y) / PATH_DT
    } else if (this.state?.guided) {
      vx = this.state.guided.vx
      vy = this.state.guided.vy
    }
    return { x: at.x, y: at.y, vx, vy }
  }

  // Segundos de guiado que quedan en lo que se ve.
  private guideLeft(g: GuidePlay): number {
    return Math.max(0, g.guide0 - g.t)
  }

  pullFx(): GameEvent[] {
    const events = this.fx
    this.fx = []
    return events
  }

  // Proyectiles que se derritieron en la lava desde la última llamada (chisporroteo).
  pullMelts(): Vec2[] {
    const melts = this.melts
    this.melts = []
    return melts
  }

  // v4: proyectiles que entraron al agua desde la última llamada (salpicadura), en su momento del vuelo.
  pullSplashes(): Vec2[] {
    const out = this.splashes
    this.splashes = []
    return out
  }

  // v3: el evento prop trajo utilería nueva (caja de botín que aparece y cae): sonido de paracaídas.
  isNewProp(event: GameEvent): boolean {
    return this.newProps.has(event)
  }

  // v4: el impacto fue con el centro bajo el agua (explosión sumergida, sonido apagado).
  isSubmerged(event: GameEvent): boolean {
    return this.submerged.has(event)
  }

  // v4: qué movió un evento flow (v2.4: o collapse) ya entregado (celdas, duración, zona), o null.
  flowInfo(event: GameEvent): FlowInfo | null {
    return this.flowInfos.get(event) ?? null
  }

  // true una vez por ronda, cuando empieza la muerte súbita (aviso sonoro y vibración).
  pullSuddenDeath(): boolean {
    const news = this.suddenDeathNews
    this.suddenDeathNews = false
    return news
  }

  // Disparos que salieron desde la última llamada (para el audio).
  pullShots(): { playerId: number; weapon: WeaponId }[] {
    const shots = this.shots
    this.shots = []
    return shots
  }

  frame(): RenderFrame | null {
    const s = this.state
    if (!s) return null
    const pb = this.playback
    const biome: Biome = s.biome ?? 'forest'
    if (pb) {
      return {
        biome,
        terrain: pb.terrain,
        terrainVersion: this.terrainVersion,
        matchId: this.matchId,
        props: pb.props,
        players: pb.players,
        current: pb.before.current,
        wind: pb.before.wind,
        projectiles: this.projectiles(pb),
        shooterId: pb.shooterId,
        weapon: pb.weapon,
        freeze: this.frozen,
        aimPreview: null,
        camera: this.cam.camera,
        lava: this.lavaView(),
        splashes: this.takeFrameSplashes(),
        hazards: pb.hazards,
        guided: null,
      }
    }
    const g = this.guide
    if (g && s.phase === 'guiding') {
      // v3: teledirigido en la bajada: el misil sale del camino de los steer, en el cabezal
      const m = this.guideNow(g)
      return {
        biome,
        terrain: s.terrain,
        terrainVersion: this.terrainVersion,
        matchId: this.matchId,
        props: s.props ?? [],
        players: this.withLost(s.players, s.terrain.h),
        current: s.current,
        wind: s.wind,
        projectiles: [{ x: m.x, y: m.y }],
        shooterId: g.ownerId,
        weapon: g.weapon,
        freeze: this.frozen,
        aimPreview: null,
        camera: this.cam.camera,
        lava: this.lavaView(),
        splashes: this.takeFrameSplashes(),
        hazards: s.hazards ?? [],
        guided: { x: m.x, y: m.y, vx: m.vx, vy: m.vy, guide: this.guideLeft(g) },
      }
    }
    const aim = this.aimGuide(s)
    return {
      biome,
      terrain: s.terrain,
      terrainVersion: this.terrainVersion,
      matchId: this.matchId,
      props: s.props ?? [],
      players: this.withLost(this.playersWithAim(s), s.terrain.h),
      current: s.current,
      wind: s.wind,
      projectiles: [],
      shooterId: null,
      weapon: null,
      freeze: this.frozen,
      aimPreview: aim ? aim.path : null,
      aimPreviewShort: aim ? aim.short : undefined,
      camera: this.cam.camera,
      lava: this.lavaView(),
      alerts: this.alerts(s),
      splashes: this.takeFrameSplashes(),
      hazards: s.hazards ?? [],
      guided: null,
    }
  }

  // v2.4: salpicaduras nuevas desde el frame anterior (cada una llega una sola vez, en el frame en que el
  // playback pasó su momento); undefined si no hay.
  private takeFrameSplashes(): Vec2[] | undefined {
    if (!this.frameSplashes.length) return undefined
    const out = this.frameSplashes
    this.frameSplashes = []
    return out
  }

  // v2.4: main.ts avanzó sin dibujar (avance rápido, pestaña en segundo plano): lo que era para ese frame
  // ya pasó y no se muestra después, todo junto y fuera de tiempo.
  skipFrame(): void {
    this.frameSplashes = []
  }

  // v2.3: ids con globo "!" ahora (solo entre tiros: con un tiro en reproducción no hay ninguno). Un
  // jugador muerto o que ya no está no lo muestra aunque le quede tiempo.
  private alerts(s: GameState): number[] | undefined {
    if (!this.alertT.size) return undefined
    const ids = [...this.alertT.keys()].filter((id) => s.players.some((p) => p.id === id && p.alive))
    return ids.length ? ids : undefined
  }

  // ---------- muerte súbita (v2) ----------

  // y de la superficie de la lava que se ve: subiendo suave tras el evento lava; con un tiro en
  // reproducción, la del tiro (la de antes hasta que llega el evento); si no, la del estado.
  private lavaView(): number | null {
    const a = this.lavaAnim
    if (a) {
      const k = clamp(a.t / LAVA_ANIM, 0, 1)
      const e = k * k * (3 - 2 * k) // arranca y se asienta suave
      return a.from + (a.to - a.from) * e
    }
    if (this.playback) return this.playback.lava
    return this.state?.lava ?? null
  }

  private resetLava(): void {
    this.lavaAnim = null
    this.suddenDeathSaid = false
    this.suddenDeathNews = false
    this.melts = []
  }

  // Eventos de la muerte súbita, en su momento (playback) o al aplicarse (fuera de un tiro).
  // v2.4: before / after: estados de antes y después del comando (para los "!" del viento, la muerte súbita
  // y la falta de munición).
  private noteEvent(event: GameEvent, pb: Playback | null, before: GameState | null, after: GameState | null): void {
    const turnId = after ? after.players[after.current]?.id : undefined
    if (event.type === 'empty') this.alert(event.playerId)
    // viento que cambia mucho de una vuelta a la otra: "!" sobre el tanque del turno
    if (event.type === 'wind' && before && Math.abs(event.value - before.wind) >= WIND_ALERT) this.alert(turnId)
    if (event.type === 'lava') {
      const shown = this.lavaView()
      const h = (pb ? pb.terrain : this.state?.terrain)?.h ?? 450
      // sin lava todavía: aparece subiendo desde el fondo del mapa
      const from = shown ?? event.from ?? h
      this.lavaAnim = from !== event.to ? { from, to: event.to, t: 0 } : null
      if (pb) {
        pb.lava = event.to
        pb.calmLeft = Math.max(0, event.warn)
      }
      if (event.from == null) this.announceSuddenDeath(turnId)
    } else if (event.type === 'calm') {
      if (pb) pb.calmLeft = Math.max(0, event.left)
      if (event.left <= 0) this.announceSuddenDeath(turnId)
    }
  }

  private announceSuddenDeath(turnId: number | undefined): void {
    if (this.suddenDeathSaid || this.demo?.freeze) return
    this.suddenDeathSaid = true
    this.suddenDeathNews = true
    // v2.4: "!" sobre el tanque del turno (el que va a tener que escapar de la lava primero)
    this.alert(turnId)
  }

  // HudExtras.suddenDeath: tiros sin daño que faltan y si la lava ya sube.
  private suddenDeathModel(s: GameState): HudExtras['suddenDeath'] {
    const pb = this.playback
    const calmLeft = pb ? pb.calmLeft : Math.max(0, SUDDEN_DEATH_CALM - (s.calm ?? 0))
    // v2.2: la lava puede quedar frenada (alguien le pegó a otro): activa solo con la cuenta en cero
    return { active: this.lavaView() !== null && calmLeft <= 0, calmLeft }
  }

  // ---------- cámara (v2) ----------

  get camera(): Camera {
    return this.cam.camera
  }

  // HUD C: filas de abajo de la pantalla (px lógicos) que tapa el tablero; 0 en el demo congelado.
  get hudBar(): number {
    return this.cam.bar
  }

  // Hay cámara móvil: el mapa es más ancho que la pantalla.
  get scrolls(): boolean {
    return !this.cam.fixed
  }

  // Se puede panear: mapa más ancho que la pantalla y sin tiro en vuelo.
  get canPan(): boolean {
    return !!this.state && !this.playback && !this.frozen && !this.cam.fixed
  }

  // Paneo a mano en px de mundo (Z / X, borde, arrastre, stick derecho, dos dedos).
  panBy(dx: number): void {
    if (this.canPan) this.cam.pan(dx)
  }

  // Minimapa: centra la cámara en x (smooth: con viaje; si no, salta, para el arrastre).
  panTo(x: number, smooth: boolean): void {
    if (this.canPan) this.cam.centerOn(x, smooth)
  }

  // C, doble toque en el minimapa o botón de recentrar: vuelve al tanque del turno.
  recenter(): void {
    if (!this.playback) this.cam.recenter()
  }

  private updateCamera(dt: number): void {
    const s = this.state
    if (!s) return
    const pb = this.playback
    const t = pb ? pb.terrain : s.terrain
    if (this.cam.world.w !== t.w || this.cam.world.h !== t.h) this.resetCamera()
    if (pb) {
      const now = this.projectiles(pb)
      const fall = this.fallFocus(pb)
      const slide = now.length ? null : this.slideFocus(pb)
      // v3: terremoto, agujero negro, botín que cae o destino del teletransporte (después de los vuelos)
      const focus = pb.focus && pb.t <= pb.focus.t1 && !now.length ? pb.focus : null
      if (fall) {
        // v3: un tanque cae al abismo: la cámara lo acompaña hasta el borde de abajo del mundo
        this.cam.followFall(fall.x, fall.y)
      } else if (now.length) {
        // el grupo de proyectiles (racimo) y dónde van a estar en un rato: la cámara mira adelante
        const ahead = this.projectiles(pb, pb.t + LOOKAHEAD, true)
        let x0 = Infinity
        let x1 = -Infinity
        let y0 = Infinity
        let y1 = -Infinity
        for (const p of [...now, ...ahead]) {
          x0 = Math.min(x0, p.x)
          x1 = Math.max(x1, p.x)
          y0 = Math.min(y0, p.y)
          y1 = Math.max(y1, p.y)
        }
        this.cam.followShot((x0 + x1) / 2, (y0 + y1) / 2, pb.zoom)
      } else if (focus) {
        this.cam.watch(focus.x, focus.y, focus.zoom)
      } else if (slide) {
        // pulido v2: un tanque se desliza (el del turno o uno que estaba en pantalla): la cámara lo acompaña
        this.cam.followSlide(slide.x, slide.y)
      } else if (pb.t < pb.flightsEnd) {
        this.cam.holdShot(pb.zoom)
      } else {
        // v4: un flujo grande a la vista o cerca: la cámara lo mira mientras corre
        const flow = this.flowFocus(pb)
        // si no, se queda donde terminó el tiro (también mientras sube la lava y quema a los de cerca)
        const at = pb.settle ?? pb.players.find((p) => p.id === pb.shooterId) ?? null
        if (flow) this.cam.watch(flow.x, flow.y, flow.zoom)
        else if (at) this.cam.settleAt(at.x, at.y)
        else this.cam.holdShot(1)
      }
    } else if (s.phase === 'guiding' && this.guide) {
      // v3: el misil guiado, con anticipación según su velocidad (mira hacia donde va)
      const g = this.guide
      const m = this.guideNow(g)
      let x = m.x + m.vx * GUIDE_LOOKAHEAD
      let y = m.y + m.vy * GUIDE_LOOKAHEAD
      // online: el tramo del dueño remoto todavía no llegó por el log; la vista previa en vivo adelanta la cámara
      const hint = g.hint && performance.now() - g.hint.at < 400 && g.t >= (g.pts.length - 1) * PATH_DT - 1e-6 ? g.hint : null
      if (hint) {
        x = hint.x
        y = hint.y
      }
      this.cam.followShot(x, y, g.zoom)
    } else if (s.phase === 'aiming') {
      const key = `${this.matchId}:${s.turn}:${s.current}`
      if (key !== this.camKey) {
        // turno nuevo: la cámara vuelve al tanque aunque el anterior haya paneado
        this.camKey = key
        if (this.cam.mode === 'manual') this.cam.mode = 'tank'
      }
      const p = s.players[s.current]
      // v3: eligiendo destino de jetpack o teletransporte: la cámara encuadra el tanque y el cursor
      const ia = this.aimingItem
      if (ia && this.cam.mode !== 'manual') this.cam.followTank((ia.from.x + ia.to.x) / 2, Math.min(p?.y ?? ia.from.y, ia.to.y + TANK_H))
      else if (p) this.cam.followTank(p.x, p.y)
    } else if (this.cam.mode === 'shot') {
      this.cam.holdShot(1)
    }
    this.cam.update(dt)
  }

  private minimap(players: Player[], currentIndex: number, terrain: Terrain): MinimapModel | null {
    if (terrain.w <= VIEW_W) return null
    const pb = this.playback
    const lastImpacts: MinimapModel['lastImpacts'] = []
    for (const [playerId, at] of this.lastImpacts) {
      const p = players.find((q) => q.id === playerId)
      if (p) lastImpacts.push({ playerId, x: at.x, y: at.y, color: this.colorOf(p) })
    }
    return {
      terrain,
      terrainVersion: this.terrainVersion,
      view: this.cam.view(),
      // el perdido en un abismo queda marcado en el fondo del mapa
      tanks: players.map((p, i) => ({ id: p.id, x: p.x, y: Math.min(p.y, terrain.h), color: this.colorOf(p), alive: p.alive, current: i === currentIndex })),
      projectiles: pb ? this.projectiles(pb) : this.guide && this.state?.phase === 'guiding' ? [samplePath(this.guide.pts, this.guide.t)] : [],
      lastImpacts,
      lava: this.lavaView(),
    }
  }

  hud(): HudModel | null {
    const s = this.state
    if (!s) return null
    const pb = this.playback
    const players = pb ? pb.players : this.withLost(this.playersWithAim(s), s.terrain.h)
    const currentIndex = pb ? pb.before.current : s.current
    const current = players[currentIndex]
    const human = this.focusHuman(players, current) ?? players[0] ?? null
    let rival: Player | undefined
    if (current && human && current.id !== human.id) rival = current
    // en el tiro del humano, el rival más cerca del impacto
    if (!rival && this.lastImpact && current?.id === human?.id && this.lastShooter === human?.id) {
      const hit = this.lastImpact
      let best = Infinity
      for (const p of players) {
        if (p.id === human?.id) continue
        const d = Math.hypot(p.x - hit.x, p.y - hit.y)
        if (d < best) {
          best = d
          rival = p
        }
      }
    }
    if (!rival && this.lastShooter != null && this.lastShooter !== human?.id) {
      rival = players.find((p) => p.id === this.lastShooter)
    }
    if (!rival) rival = players.find((p) => p.id !== human?.id && p.alive) ?? players.find((p) => p.id !== human?.id)
    const demoP1 = this.demo ? players[0]?.id : null
    const side = (p: Player | undefined | null): HudSide | null =>
      p
        ? {
            name: p.name,
            tag: `P${p.id + 1}`,
            color: this.colorOf(p),
            crew: p.crew,
            hp: Math.round(p.hp),
            alive: p.alive,
            active: !!current && p.id === current.id,
            you: !!human && p.id === human.id && (this.mode === 'local' ? human.kind === 'human' || p.id === demoP1 : this.isLocal(human)),
          }
        : null
    // el resto de los tanques, en orden de jugador, con placa compacta
    const others: HudSide[] = []
    for (const p of players) {
      if (p.id === human?.id || p.id === rival?.id) continue
      const o = side(p)
      if (o) others.push(o)
    }
    // La munición sale del estado final para que el tiro ya se vea descontado.
    const ammoOwner = pb ? pb.after.players.find((p) => p.id === current?.id) : current
    const weapon = current?.weapon ?? 'normal'
    const ammoAll = {} as Record<WeaponId, number>
    for (const id of Object.keys(WEAPONS) as WeaponId[]) ammoAll[id] = ammoOwner?.ammo?.[id] ?? 0
    // extras: plata e inventario del humano en foco (el del estado, ya descontado)
    const focus = (pb ? pb.after : s).players.find((p) => p.id === human?.id)
    const items = {} as Record<ItemId, number>
    for (const id of ITEM_ORDER) items[id] = focus?.items?.[id] ?? 0
    const shieldOwner = pb ? pb.players.find((p) => p.id === current?.id) : current
    return {
      human: side(human),
      rival: side(rival),
      others,
      angle: current?.angle ?? 0,
      power: current?.power ?? 0,
      weapon,
      ammo: ammoOwner?.ammo?.[weapon] ?? 0,
      wind: pb ? pb.before.wind : s.wind,
      status: this.status(s, current),
      showAim: !!current && !pb && s.phase !== 'guiding',
      ammoAll,
      // pulido v2: el tanque lleno es el combustible de un turno en este mapa (fuelFor del ancho)
      fuel: current ? Math.max(0, current.fuel ?? 0) / fuelFor(s.width ?? s.terrain.w) : 0,
      showBar: !!current && this.controlledHere(current) && s.phase === 'aiming',
      // el demo congelado se compara contra capturas previas: sin extras
      extras: this.demo?.freeze ? undefined : {
        round: s.round ?? 1,
        rounds: s.rounds ?? 1,
        money: focus?.money ?? 0,
        items,
        shield: Math.max(0, shieldOwner?.shield ?? 0),
        tracer: !!ammoOwner?.tracer,
        net: this.netHud,
        minimap: this.minimap(players, currentIndex, pb ? pb.terrain : s.terrain),
        suddenDeath: this.suddenDeathModel(s),
        // v3: barra de guiado del teledirigido y ayuda de destino de jetpack / teletransporte
        guide: this.guide && s.phase === 'guiding' && !pb ? { left: this.guideLeft(this.guide), total: Math.max(GUIDE_TIME, this.guide.guide0) } : null,
        aimItem: this.aimingItem?.item ?? null,
      },
    }
  }

  resultText(): string {
    const s = this.state
    if (!s || s.winnerId == null) return 'Empate'
    const winner = s.players.find((p) => p.id === s.winnerId)
    if (!winner) return 'Empate'
    const humans = s.players.filter((p) => p.kind === 'human').length
    const alone = this.mode === 'local' ? humans === 1 : s.players.filter((p) => this.isLocal(p)).length === 1
    return this.controlledHere(winner) && alone ? 'Ganaste' : `Gano ${winner.name}`
  }

  winner(): Player | null {
    const s = this.state
    if (!s || s.winnerId == null) return null
    return s.players.find((p) => p.id === s.winnerId) ?? null
  }

  // ---------- interno ----------

  private status(s: GameState, current: Player | undefined): string {
    if (this.message) return this.message
    if (s.phase === 'gameover' && !this.playback) return this.resultText()
    if (s.phase === 'guiding' && !this.playback) {
      // v3: teledirigido en la bajada
      const owner = s.players.find((p) => p.id === this.guide?.ownerId)
      if (owner && this.controlledHere(owner)) return 'Guia con izquierda y derecha'
      return owner ? `${owner.name} guia el misil` : ''
    }
    if (s.phase !== 'aiming' && !this.playback) return 'Fin de ronda'
    if (this.playback || !current) return ''
    if (this.windNotice > 0) return 'Cambia el viento'
    if (this.controlledHere(current)) {
      return s.players.filter((p) => this.isLocal(p)).length > 1 ? `Turno de ${current.name}` : 'Tu turno'
    }
    if (this.controlledByHuman(current)) return `Turno de ${current.name}`
    return `${current.name} apunta`
  }

  // Humano en foco para el HUD: el de turno, o el último que jugó, o el primero.
  private focusHuman(players: Player[], current: Player | undefined): Player | undefined {
    if (current && this.isLocal(current) && !this.demo) return current
    if (this.lastHumanId != null) {
      const p = players.find((q) => q.id === this.lastHumanId)
      if (p) return p
    }
    return players.find((p) => this.isLocal(p)) ?? players.find((p) => p.kind === 'human')
  }

  // Humano (en cualquier dispositivo): no lo maneja la IA.
  private controlledByHuman(p: Player): boolean {
    if (p.kind !== 'human') return false
    return !this.demo
  }

  // Humano de este dispositivo: el input local lo mueve.
  private controlledHere(p: Player): boolean {
    return this.controlledByHuman(p) && this.isLocal(p)
  }

  private flash(text: string): void {
    this.message = text
    this.messageT = 1.1
  }

  private skipEmptyShop(): void {
    // sin humanos en la tienda (todas IAs): la ronda arranca sola
    const s = this.state
    if (this.mode === 'client' || !s || s.phase !== 'shop' || s.players.some((p) => p.kind === 'human' && !p.ready)) return
    const any = s.players[0]
    if (any) this.act({ type: 'ready', playerId: any.id })
  }

  // Guía de apuntado del humano que juega en este dispositivo (en hot-seat el del turno, online solo el
  // local en su turno; nunca la IA). Con trazador, la trayectoria completa; sin trazador (pulido v2),
  // solo los puntos de los primeros AIM_PREVIEW_T segundos (short). Se calcula con fly y las mismas
  // opciones que el trazador (viento, lava, tanques, utilería) y se cachea: solo se recalcula cuando
  // cambian ángulo, potencia, arma, posición, viento, lava o la grilla, no en cada frame.
  private aimGuide(s: GameState): { path: Vec2[]; short: boolean } | null {
    if (s.phase !== 'aiming') return null
    const p = s.players[s.current]
    if (!p || !p.alive || !this.controlledHere(p) || this.bannerFor()) return null
    // v3: eligiendo destino de un ítem, la guía del tiro no se muestra (el destino lo dibuja main.ts)
    if (this.aimingItem) return null
    const aim = this.aim && this.aim.playerId === p.id ? this.aim : p
    const angle = quantize(aim.angle)
    const power = quantize(aim.power)
    const short = !p.tracer
    const key = `${this.matchId}:${s.turn}:${p.id}:${p.x}:${p.y}:${angle}:${power}:${p.weapon}:${s.wind}:${s.lava}:${short}:${this.terrainVersion}`
    if (this.tracerCache?.key === key) return this.tracerCache
    let path: Vec2[] = []
    try {
      path = fly({ terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: s.wind, lava: s.lava ?? undefined }).path
    } catch (err) {
      console.error(err)
    }
    if (short) path = headOfPath(path, AIM_PREVIEW_T)
    this.tracerCache = { key, path, short }
    return this.tracerCache
  }

  private currentAim(): { playerId: number; angle: number; power: number } | null {
    const s = this.state
    if (!s) return null
    const p = s.players[s.current]
    if (!p) return null
    if (!this.aim || this.aim.playerId !== p.id) this.aim = { playerId: p.id, angle: p.angle, power: p.power }
    return this.aim
  }

  private playersWithAim(s: GameState): Player[] {
    const p = s.players[s.current]
    if (!p || !this.aim || this.aim.playerId !== p.id) return s.players
    if (p.angle === this.aim.angle && p.power === this.aim.power) return s.players
    const players = s.players.slice()
    players[s.current] = { ...p, angle: this.aim.angle, power: this.aim.power }
    return players
  }

  private commitAimAndFire(playerId: number, exact = false): void {
    const s = this.state
    if (!s) return
    const p = s.players[s.current]
    if (!p || p.id !== playerId) return
    const aim = this.currentAim()
    if (aim) {
      const angle = exact ? aim.angle : quantize(aim.angle)
      const power = exact ? aim.power : quantize(aim.power)
      if (angle !== p.angle || power !== p.power || this.mode !== 'local') this.act({ type: 'aim', playerId, angle, power })
    }
    this.act({ type: 'fire', playerId })
    if (this.mode === 'client') this.awaitFire = 4
  }

  // Comando pedido desde este dispositivo (input, IA, timer). En línea va por la sala: el
  // anfitrión lo numera y lo aplica con applyNet; el cliente lo manda como pedido.
  private act(command: Command): boolean {
    if (this.mode === 'local' || !this.route) return this.dispatch(command)
    if (this.mode === 'client' && (!this.state || this.playback)) return false
    if (this.mode === 'client' && command.type === 'steer') {
      // v3: predicción del que dirige: la tanda se muestra ya (la sim es determinista) y, cuando vuelve en el
      // log del anfitrión, drain la reconoce y no la aplica de nuevo
      const s = this.state!
      const r = s.phase === 'guiding' ? safeApply(s, command) : null
      if (!r || (r.state === s && r.events.length === 0)) return false
      if (this.route(command) === false) return false
      this.predicted.push(steerKey(command))
      this.takeSteer(s, r, command)
      return true
    }
    return this.route(command) !== false
  }

  // Muestra lo que llegó por la red (client) o lo diferido (host), en orden, sin pisar un tiro.
  private drain(): void {
    while (this.inbox.length && !this.playback && this.state) {
      const item = this.inbox.shift()!
      const c = item.command
      if (this.mode !== 'client') {
        this.act(c)
        continue
      }
      const s = this.state
      if (c.type === 'steer' && this.predicted.length) {
        // v3: tanda propia que ya se mostró por predicción
        if (this.predicted[0] === steerKey(c)) {
          this.predicted.shift()
          continue
        }
        // el anfitrión metió otra cosa (ceros por turno vencido): la vista salta a la réplica lógica
        console.warn('online: el teledirigido se desincronizó de la predicción')
        if (this.logic) this.loadSnapshot(this.logic)
        return
      }
      const ok = this.dispatch(c, item.result ?? undefined)
      if (c.type === 'move' && ok) this.movedT = 0.12
      if (c.type === 'aim' && this.aim?.playerId === c.playerId) {
        const p = s.players.find((q) => q.id === c.playerId)
        if (!p || !this.isLocal(p)) this.aim = null
      }
      if (c.type === 'fire' || c.type === 'setKind') this.awaitFire = 0
    }
  }

  // Devuelve false si la sim rechazó o no implementa el comando. pre: resultado ya calculado (client).
  private dispatch(command: Command, pre?: StepResult): boolean {
    if (command.type === 'steer') return this.applySteer(command, pre)
    const s = this.state
    if (!s || this.playback) return false
    let result
    try {
      result = pre ?? applyCommand(s, command)
    } catch (err) {
      if (command.type !== 'move') console.error(err)
      return false
    }
    this.accepted = result.state !== s || result.events.length > 0
    if (command.type === 'fire') {
      this.aim = null
      this.ai = null
      this.itemAim = null
      this.startPlayback(s, result.state, result.events, result.flights ?? [], command.playerId)
      return true
    }
    // v3: un paso que cae al abismo se reproduce como un tiro sin vuelos, para animar la caída antes
    // de la muerte y del cambio de turno (si no, el tanque desaparecería de golpe)
    // pulido v2: lo mismo si el paso termina en un deslizamiento por la pendiente (y quizás una caída)
    if (command.type === 'move' && (hasAbyss(result.events, s.terrain.h) || result.events.some((e) => e.type === 'slide'))) {
      this.aim = null
      this.ai = null
      this.moveAcc = 0
      this.edge = null
      this.startPlayback(s, result.state, result.events, [], command.playerId)
      return true
    }
    // v3: jetpack y teletransporte se reproducen (el salto, el destello, la caída si no hay piso) antes de seguir
    if (command.type === 'useItem' && result.events.some((e) => e.type === 'jetpack' || e.type === 'teleport' || e.type === 'fall' || e.type === 'slide')) {
      this.moveAcc = 0
      this.edge = null
      this.itemAim = null
      this.startPlayback(s, result.state, result.events, [], command.playerId)
      return true
    }
    const changed = result.state !== s
    this.state = result.state
    if (result.events.length) this.fx.push(...result.events)
    for (const e of result.events) this.noteEvent(e, null, s, result.state)
    if (result.events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    if (command.type === 'move' && changed && result.state.terrain !== s.terrain) this.terrainVersion++
    // v4: un flujo (o un derrumbe, v2.4) fuera de un tiro (no debería pasar) muestra directamente la grilla final
    else if (result.events.some((e) => e.type === 'flow' || e.type === 'collapse')) this.terrainVersion++
    if (result.events.some((e) => e.type === 'round') || (s.phase !== 'aiming' && result.state.phase === 'aiming')) this.newRound()
    return changed
  }

  // Mapa nuevo: el renderer limpia cráteres y restos con el matchId nuevo.
  private newRound(): void {
    this.terrainVersion++
    this.matchId++
    this.aim = null
    this.ai = null
    this.aiToken++
    this.lastShooter = null
    this.lastImpact = null
    this.lastHumanId = null
    this.phaseT = 0
    this.slow = 0
    this.tracerCache = null
    this.resetGuide()
    this.sentReady.clear()
    this.sentNext = false
    this.resetLava()
    this.resetAbyss()
    this.resetCamera()
  }

  // Mapa nuevo: la cámara salta al tanque del turno y se borran las marcas de impacto del minimapa.
  private resetCamera(): void {
    const s = this.state
    this.lastImpacts.clear()
    this.camKey = ''
    if (!s) return
    const p = s.players[s.current]
    this.cam.reset(s.terrain.w, s.terrain.h, p ? { x: p.x, y: p.y } : null)
  }

  // opts (v3 teledirigido): weapon, el arma del tiro (el final del guiado no la saca de before); guided, es el
  // final de un guiado (no vuelve a sonar el disparo); zoom, el de la cámara (sigue el del guiado).
  private startPlayback(
    before: GameState,
    after: GameState,
    events: GameEvent[],
    flights: Flight[],
    shooterId: number,
    opts?: { weapon?: WeaponId; guided?: boolean; zoom?: number },
  ): void {
    if (events.some((e) => e.type === 'empty')) this.flash('Sin municion')
    // v2.3: un tiro o una caída apagan el globo "!" del borde
    this.alertT.clear()
    const timed = flights.map((flight) => ({
      flight,
      start: flight.startT ?? 0,
      dur: Math.max(0, (flight.path.length - 1) * PATH_DT),
      done: false,
    }))
    const flightsEnd = timed.reduce((m, f) => Math.max(m, f.start + f.dur), 0)
    let lastT = 0
    let firstImpact = Infinity
    let bigBlast = false
    // v2 muerte súbita: calm, lava y lo que viene después de la lava (o el daño de lava) sin t propio
    // se ubican al final del tiro, cuando ya se asentaron las explosiones (ver abajo).
    const deferred: TimedEvent[] = []
    let lavaPhase = false
    const timeline: TimedEvent[] = events.map((event) => {
      if (event.type === 'impact') {
        lastT = Number.isFinite(event.t) ? event.t : flightsEnd
        firstImpact = Math.min(firstImpact, lastT)
        if (event.blast === 'nuke' || event.blast === 'bigfire') bigBlast = true
      }
      if (LATE.has(event.type)) return { t: Infinity, event }
      // v3: el guiado empieza cuando termina el ascenso (el evento guide no trae t)
      if (event.type === 'guide') return { t: flightsEnd, event }
      const own = ownT(event)
      if (event.type === 'lava' || (event.type === 'damage' && event.cause === 'lava')) lavaPhase = true
      if (own == null && (lavaPhase || event.type === 'calm') && event.type !== 'impact') {
        const item = { t: NaN, event }
        deferred.push(item)
        return item
      }
      return { t: own ?? lastT, event }
    })
    // v4: flujos de líquido; corre después del flujo lo que no puede adelantarse a la animación
    const flows = planFlows(timeline)
    // pulido v2: deslizamientos; lo que le pasa a ese tanque después espera a que termine (y su caída)
    const slides: SlidePlay[] = []
    planSlides(timeline, before.terrain.h, slides)
    // v3: caídas al abismo con su momento ya conocido (la muerte se corre al final de la caída)
    const drops: Drop[] = []
    this.planDrops(before, timeline, drops)
    // Base de la lava: después de los vuelos, de los flujos y de todo lo que ya tiene su momento.
    let base = flightsEnd
    for (const e of timeline) if (Number.isFinite(e.t)) base = Math.max(base, e.t)
    for (const f of flows) base = Math.max(base, f.end + FLOW_GAP)
    for (const sl of slides) base = Math.max(base, sl.end)
    const lavaEvent = events.find((e) => e.type === 'lava')
    const hasLava = !!lavaEvent || deferred.some((d) => d.event.type === 'damage')
    const lavaT = (lavaEvent && ownT(lavaEvent)) ?? base + LAVA_GAP
    for (const d of deferred) {
      if (d.event.type === 'lava') d.t = lavaT
      else if (d.event.type === 'calm') d.t = hasLava ? lavaT : base
      else d.t = lavaT + LAVA_HIT
    }
    // las que caen por un evento diferido (después de la lava) se ubican ahora
    planSlides(timeline, before.terrain.h, slides)
    this.planDrops(before, timeline, drops)
    timeline.sort((a, b) => a.t - b.t)
    if (!Number.isFinite(firstImpact)) firstImpact = flightsEnd
    // el turno siguiente espera a que el tanque se pierda y la cámara mire un momento el fondo
    const dropsEnd = drops.reduce((m, d) => Math.max(m, d.t0 + d.lost + ABYSS_TAIL), 0)
    const eventsEnd = timeline.reduce((m, e) => (Number.isFinite(e.t) ? Math.max(m, e.t) : m), 0)
    const hasShot = flights.length > 0 || timeline.some((e) => e.event.type === 'impact')
    const settle = hasShot ? SETTLE + (bigBlast ? 0.5 : 0) : 0
    // con lava, el turno siguiente espera a que termine de subir
    const lavaEnd = hasLava ? lavaT + LAVA_ANIM + LAVA_TAIL : 0
    // con flujo, el turno siguiente espera a que el líquido termine de correr
    const flowsEnd = flows.reduce((m, f) => Math.max(m, f.end + FLOW_TAIL), 0)
    // con deslizamientos, el turno siguiente espera a que el tanque se asiente
    const slidesEnd = slides.reduce((m, sl) => Math.max(m, sl.end + SLIDE_TAIL), 0)
    const weapon = opts?.weapon ?? before.players.find((p) => p.id === shooterId)?.weapon ?? 'normal'
    // v3: ascenso de un teledirigido: el playback termina justo en el apogeo (sin asentarse) y sigue el guiado
    const guideFrom = after.phase === 'guiding' && after.guided ? after : null
    // v3: el teletransporte espera un momento con la cámara en el destino
    const tpEnd = events.some((e) => e.type === 'teleport') ? TELEPORT_HOLD : 0
    const { terrain, target, reveal, pending } = splitTerrain(before.terrain, after.terrain, timeline, flows)
    // la ronda termina con este tiro: la última muerte va en cámara lenta
    let finisher: GameEvent | null = null
    if (after.phase !== 'aiming' && !this.demo?.freeze) {
      for (const e of timeline) if (e.event.type === 'death' && Number.isFinite(e.t)) finisher = e.event
    }
    const finisherDrop = finisher?.type === 'death' ? drops.find((d) => d.playerId === finisher.playerId) ?? null : null
    this.playback = {
      t: 0,
      end: guideFrom ? flightsEnd : Math.max(Math.max(flightsEnd, eventsEnd) + settle, lavaEnd, dropsEnd, flowsEnd, slidesEnd, tpEnd),
      before,
      after,
      flights: timed,
      timeline,
      next: 0,
      firstImpact,
      shooterId,
      weapon,
      players: before.players.map((p) => this.shownPlayer({ ...p }, before.terrain.h)),
      props: (before.props ?? []).map((p) => ({ ...p })),
      terrain,
      target,
      reveal,
      pending,
      finisher,
      finisherDrop,
      slowDone: false,
      flightsEnd,
      zoom:
        opts?.zoom ??
        shotZoom(
          flights.map((f) => f.path),
          before.terrain.h,
          this.cam.bar,
        ),
      settle: null,
      lava: before.lava ?? null,
      calmLeft: Math.max(0, SUDDEN_DEATH_CALM - (before.calm ?? 0)),
      drops,
      flows,
      splashNext: flights.map(() => 0),
      slides,
      guideFrom,
      guideQueue: [],
      hazards: (before.hazards ?? []).map((h) => ({ ...h })),
      focus: null,
    }
    if (hasShot) {
      if (!opts?.guided) this.shots.push({ playerId: shooterId, weapon })
      this.lastShooter = shooterId
    }
    this.advance(0)
  }

  private advance(dt: number): void {
    const pb = this.playback
    if (!pb) return
    pb.t += dt
    this.landFlights(pb)
    // antes de entregar: el fall que llega al terminar un deslizamiento apoya al tanque en su piso nuevo
    this.stepSlides(pb)
    while (pb.next < pb.timeline.length && pb.timeline[pb.next].t <= pb.t) {
      this.deliver(pb, pb.timeline[pb.next].event)
      pb.next++
    }
    this.stepFlows(pb)
    this.stepSplashes(pb)
    this.stepDrops(pb)
    this.slowDrop(pb)
    if (this.demo?.freeze && this.demo.shotDone && pb.t >= pb.firstImpact + 0.35) {
      this.frozen = true
      return
    }
    if (pb.t < pb.end) return
    while (pb.next < pb.timeline.length) {
      this.deliver(pb, pb.timeline[pb.next].event)
      pb.next++
    }
    // lo que no llegó a mostrarse (cráteres o parches de flujo) aparece con la grilla final
    if (pb.pending > 0 || pb.flows.some((f) => f.next < f.event.patches.length)) this.terrainVersion++
    // v3: fin del ascenso de un teledirigido: el estado es el del apogeo y empieza el guiado
    this.state = pb.guideFrom ?? pb.after
    this.playback = null
    this.phaseT = 0
    // v2.4: los "!" pedidos durante el tiro se prenden ahora, que se ven
    for (const id of this.alertSoon) this.alert(id)
    this.alertSoon.clear()
    if (pb.guideFrom) {
      this.beginGuide(pb.guideFrom, pb.weapon, pb.zoom)
      // tandas que el anfitrión aceptó durante el ascenso (la última puede cerrar el guiado con un playback)
      for (const q of pb.guideQueue) {
        if (this.playback) break
        this.takeSteer(q.before, q.result)
      }
      return
    }
    // al terminar el tiro, la cámara va al tanque del turno siguiente
    this.cam.mode = 'tank'
  }

  // Vuelos que terminaron: la cámara se asienta en su punto final si no hubo impacto, y los que se
  // derritieron en la lava (sin explosión ni evento impact) chisporrotean.
  private landFlights(pb: Playback): void {
    for (const f of pb.flights) {
      if (f.done || pb.t < f.start + f.dur) continue
      f.done = true
      const path = f.flight.path
      const end: Vec2 | null = path.length ? path[path.length - 1] : null
      if (f.flight.impact.kind === 'lava') {
        const at = { x: f.flight.impact.x, y: f.flight.impact.y }
        this.melts.push(at)
        pb.settle = at
        this.lastImpacts.set(pb.shooterId, at)
      } else if (!pb.settle && end) {
        pb.settle = { x: end.x, y: end.y }
      }
    }
  }

  private deliver(pb: Playback, event: GameEvent): void {
    // v4: explosión con el centro bajo el agua. v2.4: lo dice la sim (Impact.water del vuelo de ese
    // impacto); si no viene (barriles, sim sin el dato), la heurística de mirar la grilla antes del cráter.
    if (event.type === 'impact') {
      const water = impactWater(pb, event)
      if (water ?? underwater(pb.terrain, event.x, event.y)) this.submerged.add(event)
    }
    if (event.type === 'flow' || event.type === 'collapse') this.startFlow(pb, event)
    // v2.2: el viento cambia por vuelta; se avisa unos segundos al cambiar
    if (event.type === 'wind') this.windNotice = WIND_NOTICE
    this.fx.push(event)
    this.noteEvent(event, pb, pb.before, pb.after)
    if (event === pb.finisher && !pb.finisherDrop) this.startSlow(SLOW_TIME, SLOW_SCALE)
    const pixels = pb.reveal.get(event)
    if (pixels && pixels.length) {
      const { front, back } = pb.target
      for (const i of pixels) {
        pb.terrain.front[i] = front[i]
        pb.terrain.back[i] = back[i]
      }
      pb.pending -= pixels.length
      this.terrainVersion++
    }
    switch (event.type) {
      case 'impact':
        this.lastImpact = { x: event.x, y: event.y }
        pb.settle = this.lastImpact
        if (event.source !== 'barrel') this.lastImpacts.set(pb.shooterId, { x: event.x, y: event.y })
        break
      case 'damage': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) p.hp = event.hp
        break
      }
      case 'shield': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) p.shield = event.left
        break
      }
      case 'death': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) {
          p.alive = false
          p.hp = 0
        }
        const drop = pb.drops.find((d) => d.playerId === event.playerId)
        if (drop) {
          // se perdió en el abismo: queda debajo del mapa hasta que termine la ronda
          this.lost.add(event.playerId)
          if (p) p.y = drop.to
        }
        break
      }
      case 'fall': {
        const p = pb.players.find((q) => q.id === event.playerId)
        const final = pb.after.players.find((q) => q.id === event.playerId)
        if (p) {
          // al abismo: la y la anima stepDrops; si no, el tanque se apoya en su piso nuevo
          if (!pb.drops.some((d) => d.playerId === event.playerId)) p.y = event.to
          // la x de un tanque que se desliza la lleva su recorrido (el fall es vertical)
          if (final && !pb.slides.some((sl) => sl.playerId === event.playerId)) p.x = final.x
        }
        break
      }
      case 'prop': {
        const prop = pb.props.find((q) => q.id === event.propId)
        const final = pb.after.props?.find((q) => q.id === event.propId)
        if (!prop && !event.destroyed) {
          // v3: utilería que aparece en el tiro (caja de botín que cae en paracaídas): entra con este evento
          pb.props.push(final ? { ...final } : { id: event.propId, kind: event.kind, x: event.x, y: event.y, w: 12, h: 12, alive: true })
          this.newProps.add(event)
          // la cámara mira dónde cae el botín
          if (event.kind === 'loot') this.focusOn(pb, final ? final.x + final.w / 2 : event.x, final ? final.y : event.y, 1, LOOT_HOLD)
        } else if (prop) {
          prop.alive = !event.destroyed
          if (final) {
            prop.x = final.x
            prop.y = final.y
          }
        }
        break
      }
      // ---------- v3 ----------
      case 'hazard': {
        const h = event.hazard
        pb.hazards = pb.hazards.filter((q) => q.id !== h.id)
        if (event.action === 'place') pb.hazards.push({ ...h })
        break
      }
      case 'quake':
        this.focusOn(pb, event.x, event.y, this.fitZoom(event.radius * 2.4), QUAKE_HOLD)
        break
      case 'pull':
        this.focusOn(pb, event.x, event.y, this.fitZoom(event.radius * 2.4), (Number.isFinite(event.duration) ? event.duration : 1) + PULL_HOLD)
        break
      case 'teleport': {
        const p = pb.players.find((q) => q.id === event.playerId)
        if (p) {
          p.x = event.to.x
          p.y = event.to.y
        }
        this.focusOn(pb, event.to.x, event.to.y - TANK_H / 2, 1, TELEPORT_HOLD)
        break
      }
      default:
        break
    }
  }

  // v3: la cámara mira (x, y) con ese zoom hasta hold segundos de tiro desde ahora; el tiro dura al menos eso.
  private focusOn(pb: Playback, x: number, y: number, zoom: number, hold: number): void {
    if (this.cam.fixed && zoom >= 1) {
      // mapa Chico: la cámara no se mueve, solo se estira el tiro para ver lo que pasa
      pb.end = Math.max(pb.end, pb.t + hold)
      return
    }
    pb.focus = { x, y, zoom, t1: pb.t + hold }
    pb.end = Math.max(pb.end, pb.t + hold)
  }

  // Zoom que entra un ancho de mundo w (con margen del alto útil).
  private fitZoom(w: number): number {
    return clamp(Math.min(1, (VIEW_W * 0.85) / Math.max(1, w), (this.cam.usableH * 0.85) / Math.max(1, w * 0.6)), MIN_ZOOM, 1)
  }

  // ---------- líquidos (v4) ----------

  // Empieza un flujo: mide qué mueve (con la grilla que se ve ahora) y decide si la cámara lo mira.
  // v2.4: un derrumbe (collapse) igual: mide todo lo que cambia y es grande desde COLLAPSE_BIG celdas.
  private startFlow(pb: Playback, event: Extract<GameEvent, { type: 'flow' | 'collapse' }>): void {
    const f = pb.flows.find((q) => q.event === event)
    if (!f || f.info) return
    const collapse = event.type === 'collapse'
    const info = measureFlow(pb.terrain, event.patches, f.end - f.start, collapse)
    f.info = info
    this.flowInfos.set(event, info)
    // grande y a la vista o cerca: la cámara se queda mirándolo; lejos o chico, no hace falta ir
    const v = this.cam.view()
    const big = collapse ? Math.max(event.cells, info.solid) >= COLLAPSE_BIG : info.water + info.lava >= FLOW_BIG
    const near = info.x1 >= v.x - FLOW_NEAR && info.x0 <= v.x + v.w + FLOW_NEAR
    f.follow = !this.cam.fixed && big && near
  }

  // Parches de flujo que ya llegaron: se copian a la grilla que se ve y el render repinta.
  private stepFlows(pb: Playback): void {
    for (const f of pb.flows) {
      if (!f.info) continue // el evento todavía no se entregó
      const patches = f.event.patches
      let changed = false
      while (f.next < patches.length && f.start + f.next * f.dt <= pb.t) {
        applyPatch(pb.terrain, patches[f.next])
        f.next++
        changed = true
      }
      if (changed) this.terrainVersion++
    }
  }

  // Salpicaduras de los vuelos, en el momento en que cada proyectil entra al agua.
  private stepSplashes(pb: Playback): void {
    pb.flights.forEach((f, k) => {
      const list = f.flight.splashes
      if (!list) return
      while (pb.splashNext[k] < list.length && f.start + list[pb.splashNext[k]].t <= pb.t) {
        const sp = list[pb.splashNext[k]++]
        this.splashes.push({ x: sp.x, y: sp.y })
        this.frameSplashes.push({ x: sp.x, y: sp.y })
      }
    })
  }

  // Flujo que la cámara mira ahora (centro y zoom que lo encuadra), o null.
  private flowFocus(pb: Playback): { x: number; y: number; zoom: number } | null {
    for (const f of pb.flows) {
      if (!f.info || !f.follow || pb.t < f.start || pb.t > f.end + FLOW_HOLD) continue
      const { x0, y0, x1, y1 } = f.info
      const w = Math.max(1, x1 - x0 + 1)
      const h = Math.max(1, y1 - y0 + 1)
      // el alto útil es el que no tapa el tablero del HUD
      const zoom = clamp(Math.min(1, (VIEW_W * 0.8) / w, (this.cam.usableH * 0.8) / h), MIN_ZOOM, 1)
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom }
    }
    return null
  }

  // ---------- abismo (v3) ----------

  // Arma las caídas al abismo de un tiro (o de un paso) sobre la línea de tiempo, en el orden de los
  // eventos (antes de ordenarla). Cada fall que termina debajo del mapa (o una muerte 'abyss' sin fall)
  // empieza una caída en su t; el daño y la muerte de ese tanque que vienen después en la lista se
  // corren al final de la caída, así se ve caer y perderse antes de morir. Se llama dos veces: los
  // eventos con t todavía sin decidir (NaN, los diferidos de la lava) se toman en la segunda pasada.
  private planDrops(before: GameState, timeline: TimedEvent[], drops: Drop[]): void {
    const h = before.terrain.h
    for (let i = 0; i < timeline.length; i++) {
      const { event, t } = timeline[i]
      if (!Number.isFinite(t)) continue
      let from: number
      if (event.type === 'fall' && isAbyssFall(event, h)) from = event.from
      else if (event.type === 'death' && event.cause === 'abyss') from = before.players.find((p) => p.id === event.playerId)?.y ?? h
      else continue
      const id = event.playerId
      if (drops.some((d) => d.playerId === id)) continue
      const { to, dur } = abyssDrop(from, h)
      const lost = abyssLostAt(from, h)
      drops.push({ playerId: id, from, to, t0: t, dur, lost, follow: null })
      // v2.3: la muerte (y el golpe lejano) llega cuando el tanque que dibuja el renderer se pierde de
      // vista, no al final de la caída de la sesión (que es más rápida)
      for (let j = i; j < timeline.length; j++) {
        const e = timeline[j]
        if ((e.event.type === 'death' || e.event.type === 'damage') && e.event.playerId === id && Number.isFinite(e.t)) {
          e.t = Math.max(e.t, t + lost)
        }
      }
    }
  }

  // v2.3: la caída al abismo que cierra la ronda va en cámara lenta desde que empieza hasta que el tanque
  // se pierde de vista (más SLOW_ABYSS_TAIL), en tiempo del tiro. Si eso en SLOW_SCALE dura más de
  // SLOW_ABYSS_MAX segundos reales (caídas muy largas), se frena un poco menos para no hacerla eterna.
  private slowDrop(pb: Playback): void {
    const d = pb.finisherDrop
    if (!d || pb.slowDone || pb.t < d.t0) return
    pb.slowDone = true
    const span = Math.max(0, d.t0 + d.lost + SLOW_ABYSS_TAIL - pb.t)
    if (span <= 0) return
    const scale = Math.max(SLOW_SCALE, span / SLOW_ABYSS_MAX)
    this.startSlow(span / scale, scale)
  }

  // Cámara lenta: seconds son segundos reales (no de tiro) a escala scale.
  private startSlow(seconds: number, scale: number): void {
    this.slow = seconds
    this.slowScale = scale
  }

  // Posición de los tanques que caen: aceleración constante desde el piso hasta debajo del mapa,
  // ajustada para llegar justo al final de la caída (cuando llega la muerte).
  private stepDrops(pb: Playback): void {
    for (const d of pb.drops) {
      if (pb.t < d.t0) continue
      const p = pb.players.find((q) => q.id === d.playerId)
      if (!p || !p.alive) continue
      const k = clamp((pb.t - d.t0) / d.dur, 0, 1)
      p.y = d.from + (d.to - d.from) * k * k
    }
  }

  // Caída que la cámara acompaña ahora: la del tanque del turno, o la de uno que estaba en pantalla
  // cuando empezó a caer. Sigue un momento (ABYSS_HOLD) después de perderse, mirando el fondo.
  private fallFocus(pb: Playback): Vec2 | null {
    const currentId = pb.before.players[pb.before.current]?.id
    const h = pb.terrain.h
    for (const d of pb.drops) {
      if (pb.t < d.t0 || pb.t > d.t0 + d.lost + ABYSS_HOLD) continue
      const p = pb.players.find((q) => q.id === d.playerId)
      if (!p) continue
      if (d.follow === null) {
        const v = this.cam.view()
        const seen = p.x >= v.x && p.x <= v.x + v.w && d.from >= v.y && d.from - TANK_H <= v.y + v.h
        d.follow = d.playerId === currentId || seen
      }
      if (d.follow) return { x: p.x, y: Math.min(p.y, h) }
    }
    return null
  }

  // ---------- deslizamiento (pulido v2) ----------

  // Tanques que se deslizan: siguen su recorrido (un punto cada PATH_DT) y, si después caen, bajan con
  // gravedad hasta el piso del fall (que se entrega al aterrizar).
  private stepSlides(pb: Playback): void {
    for (const sl of pb.slides) {
      if (pb.t < sl.t0) continue
      const p = pb.players.find((q) => q.id === sl.playerId)
      if (!p || !p.alive || this.lost.has(p.id)) continue
      const path = sl.event.path
      if (!sl.done && path.length) {
        const at = pb.t < sl.t1 ? samplePath(path, pb.t - sl.t0) : path[path.length - 1]
        p.x = at.x
        p.y = at.y
        if (pb.t >= sl.t1) sl.done = true
      }
      const f = sl.fall
      if (f && sl.done && pb.t >= f.t0 && pb.t <= f.t0 + f.dur) {
        const k = clamp((pb.t - f.t0) / f.dur, 0, 1)
        p.y = f.from + (f.to - f.from) * k * k
      }
    }
  }

  // Deslizamiento que la cámara acompaña ahora: el del tanque del turno o el de uno que estaba en pantalla
  // cuando empezó. Sigue un momento (SLIDE_HOLD) después de que el tanque se asentó.
  private slideFocus(pb: Playback): Vec2 | null {
    const currentId = pb.before.players[pb.before.current]?.id
    for (const sl of pb.slides) {
      if (pb.t < sl.t0 || pb.t > sl.end + SLIDE_HOLD) continue
      const p = pb.players.find((q) => q.id === sl.playerId)
      if (!p || this.lost.has(p.id)) continue
      if (sl.follow === null) {
        const v = this.cam.view()
        const seen = p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y - TANK_H <= v.y + v.h
        sl.follow = sl.playerId === currentId || seen
      }
      if (sl.follow) return { x: p.x, y: p.y - TANK_H / 2 }
    }
    return null
  }

  // Tanque perdido en el abismo: se dibuja debajo del mapa (no apoyado en el fondo ni en su último piso).
  // Sirve también para un snapshot (online): un tanque muerto con el piso en el fondo del mapa cayó.
  private shownPlayer(p: Player, h: number): Player {
    if (!p.alive && (this.lost.has(p.id) || p.y >= h)) p.y = Math.max(p.y, h + ABYSS_BELOW)
    return p
  }

  private withLost(players: Player[], h: number): Player[] {
    if (!players.some((p) => !p.alive && (this.lost.has(p.id) || p.y >= h))) return players
    return players.map((p) => (p.alive ? p : this.shownPlayer({ ...p }, h)))
  }

  private resetAbyss(): void {
    this.lost.clear()
    this.edge = null
    this.alertT.clear()
    this.alertSoon.clear()
    this.alertNews = []
    this.turnAlertKey = ''
    this.edgeNews = false
  }

  // Proyectiles en vuelo en el tiempo t del tiro. hold: los que siguen en vuelo ahora pero terminan antes
  // de t quedan en su punto final (la anticipación de la cámara mira hasta dónde llega el vuelo).
  private projectiles(pb: Playback, t = pb.t, hold = false): Vec2[] {
    const out: Vec2[] = []
    for (const f of pb.flights) {
      const local = t - f.start
      if (f.flight.path.length === 0 || local < 0) continue
      if (local > f.dur) {
        if (hold && pb.t - f.start <= f.dur) out.push(f.flight.path[f.flight.path.length - 1])
        continue
      }
      out.push(samplePath(f.flight.path, local))
    }
    return out
  }

  private driveAi(dt: number): void {
    const s = this.state
    if (!s || s.phase !== 'aiming') return
    const actor = s.players[s.current]
    if (!actor || !actor.alive || this.controlledByHuman(actor)) {
      this.ai = null
      return
    }
    if (!this.ai || this.ai.playerId !== actor.id) {
      const scripted = !!this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id
      const token = ++this.aiToken
      this.ai = {
        playerId: actor.id,
        token,
        plan: null,
        from: { angle: actor.angle, power: actor.power },
        t: 0,
        think: scripted ? 0.15 : 0.45,
        dur: 0.45,
        hold: scripted ? 0.1 : 0.3,
        move: 0,
        moveAcc: 0,
        items: [],
        weapon: null,
      }
      const client = this.aiClient
      if (scripted || this.demo?.freeze || this.syncAi || !client || !client.available) {
        this.setPlan(this.ai, this.plan(s, actor))
      } else {
        const seed = (this.random() * 0x100000000) >>> 0
        const difficulty: Difficulty = this.config?.difficulty ?? 'normal'
        client
          .choose(s, difficulty, seed)
          .catch((err) => {
            console.error(err)
            return fallbackPlan(actor)
          })
          .then((plan) => {
            const ai = this.ai
            if (!ai || ai.token !== token || this.state !== s) return
            this.setPlan(ai, plan)
          })
      }
    }
    const ai = this.ai
    if (!ai.plan) {
      // pensando en el worker: el cañón tantea alrededor de donde estaba
      ai.t += dt
      const aim = this.currentAim()
      if (aim) {
        const k = Math.min(1, ai.t / 0.4)
        aim.angle = clamp(ai.from.angle + Math.sin(ai.t * 2.3) * 5 * k, 0, 180)
        aim.power = clamp(ai.from.power + Math.sin(ai.t * 1.7 + 1) * 4 * k, 0, 100)
      }
      return
    }
    // v3: ítems del plan, uno por frame (jetpack y teletransporte arman un playback y esto sigue después)
    if (ai.items.length) {
      const it = ai.items.shift()!
      const ok = it.target ? this.act({ type: 'useItem', playerId: actor.id, item: it.item, target: it.target }) : this.act({ type: 'useItem', playerId: actor.id, item: it.item })
      if (!ok) console.warn('IA: la sim no aceptó el ítem', it.item)
      return
    }
    if (ai.weapon) {
      const w = ai.weapon
      ai.weapon = null
      const now = this.state?.players.find((p) => p.id === actor.id)
      if (now && now.weapon !== w) this.act({ type: 'selectWeapon', playerId: actor.id, weapon: w })
    }
    if (ai.move !== 0) {
      ai.moveAcc += MOVE_SPEED * dt
      let steps = Math.min(3, Math.floor(ai.moveAcc))
      ai.moveAcc -= steps
      const dir: -1 | 1 = ai.move > 0 ? 1 : -1
      while (steps-- > 0 && ai.move !== 0) {
        if (!this.act({ type: 'move', playerId: actor.id, dir })) {
          ai.move = 0
          break
        }
        ai.move -= dir
        this.movedT = 0.12
      }
      return
    }
    ai.t += dt
    const k = clamp((ai.t - ai.think) / ai.dur, 0, 1)
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    const aim = this.currentAim()
    if (aim) {
      aim.angle = ai.from.angle + (ai.plan.angle - ai.from.angle) * e
      aim.power = ai.from.power + (ai.plan.power - ai.from.power) * e
    }
    if (ai.t >= ai.think + ai.dur + ai.hold) {
      if (aim) {
        aim.angle = ai.plan.angle
        aim.power = ai.plan.power
      }
      if (this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id) this.demo.shotDone = true
      // v3: correcciones del teledirigido que la sesión reproduce durante el guiado
      const dirs = planSteer(ai.plan)
      this.aiSteer = dirs ? { playerId: actor.id, dirs } : null
      this.commitAimAndFire(actor.id, true)
    }
  }

  // Con el plan en la mano: arma, recorrido y duración del apuntado. Si el worker tardó más
  // que el "pensar" de siempre, el apuntado arranca ya desde donde quedó el cañón.
  private setPlan(ai: AiDrive, plan: ShotPlan): void {
    const s = this.state
    const actor = s?.players.find((p) => p.id === ai.playerId)
    if (!s || !actor) return
    const aim = this.currentAim()
    ai.from = aim ? { angle: aim.angle, power: aim.power } : { angle: actor.angle, power: actor.power }
    const turn = Math.abs(plan.angle - ai.from.angle) / 180 + Math.abs(plan.power - ai.from.power) / 200
    ai.plan = plan
    ai.dur = clamp(0.45 + turn * 1.1, 0.45, 1.3)
    ai.think = Math.max(0, ai.think - ai.t)
    ai.t = 0
    ai.move = Math.round(plan.move ?? 0)
    ai.moveAcc = 0
    // v3: primero los ítems del plan (ShotPlan.items), después el arma; los aplica driveAi de a uno
    ai.items = planItems(plan)
    ai.weapon = plan.weapon
    if (!ai.items.length && plan.weapon !== actor.weapon) {
      ai.weapon = null
      this.act({ type: 'selectWeapon', playerId: actor.id, weapon: plan.weapon })
    }
  }

  private plan(s: GameState, actor: Player): ShotPlan {
    const difficulty: Difficulty = this.config?.difficulty ?? 'normal'
    try {
      if (this.demo && !this.demo.shotDone && actor.id === s.players[0]?.id) {
        return pickDemoShot(s, this.demo.seed, this.demo.weapon)
      }
      return chooseShot(s, difficulty, this.random)
    } catch (err) {
      console.error(err)
      return fallbackPlan(actor)
    }
  }
}

// v3: el botón B del gamepad (y ÍTEM táctil) prueba en este orden; jetpack y teletransporte piden destino
const USABLE: ItemId[] = ['shield', 'repair', 'fuel', 'tracer', 'deflector', 'anchor', 'jetpack', 'teleport']
const ITEM_NAMES: Record<ItemId, string> = {
  shield: 'escudo',
  parachute: 'paracaidas',
  fuel: 'combustible',
  repair: 'reparacion',
  tracer: 'trazador',
  jetpack: 'jetpack',
  teleport: 'teletransporte',
  anchor: 'ancla',
  deflector: 'deflector',
}

function ownedOf(p: Player, id: ShopId): number {
  if (id in WEAPONS) return p.ammo?.[id as WeaponId] ?? 0
  return p.items?.[id as ItemId] ?? 0
}

function fallbackPlan(actor: Player): ShotPlan {
  return { angle: actor.angle, power: Math.max(40, actor.power), weapon: 'normal' }
}

const BURN_REACH = 8

// Pulido v2: arma los deslizamientos de un tiro (o de un paso) sobre la línea de tiempo, en el orden de
// los eventos (antes de ordenarla). Cada slide arranca en su t, pero no antes de que termine el anterior
// del mismo tanque, y dura (puntos − 1) · PATH_DT. Lo que le pasa a ese tanque después en la lista espera:
// el primer fall va al final del recorrido (si es una caída común, más lo que tarda en caer: se entrega al
// aterrizar); daño, escudo y muerte, al final del deslizamiento con su caída. Al abismo, el fall arranca
// al final del recorrido y planDrops hace el resto. Se llama dos veces (como planDrops): los slides con t
// todavía sin decidir (NaN, diferidos de la lava) se toman en la segunda pasada.
function planSlides(timeline: TimedEvent[], h: number, slides: SlidePlay[]): void {
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i]
    const ev = item.event
    // v3: el salto del jetpack se anima igual que un deslizamiento (path del tanque cada PATH_DT)
    if ((ev.type !== 'slide' && ev.type !== 'jetpack') || !Number.isFinite(item.t) || slides.some((sl) => sl.event === ev)) continue
    const id = ev.playerId
    const prev = slides.reduce((m, sl) => (sl.playerId === id ? Math.max(m, sl.end) : m), -Infinity)
    const t0 = Math.max(item.t, prev)
    item.t = t0
    const t1 = t0 + Math.max(0, ev.path.length - 1) * PATH_DT
    const sl: SlidePlay = { event: ev, playerId: id, t0, t1, end: t1, done: false, fall: null, follow: null }
    let fell = false
    for (let j = i + 1; j < timeline.length; j++) {
      const e = timeline[j]
      const next = e.event
      if (!('playerId' in next) || next.playerId !== id || !Number.isFinite(e.t)) continue
      if (next.type === 'slide' || next.type === 'jetpack') break // el siguiente deslizamiento se encadena solo
      if (next.type === 'fall' && !fell) {
        fell = true
        if (next.to > h || next.parachute || next.to <= next.from) {
          // abismo (lo anima planDrops) o paracaídas (lo anima el renderer): arranca al final del recorrido
          e.t = Math.max(e.t, t1)
          sl.end = Math.max(sl.end, e.t)
        } else {
          const dur = slideFallDur(next.from, next.to)
          e.t = Math.max(e.t, t1 + dur)
          sl.fall = { from: next.from, to: next.to, t0: e.t - dur, dur }
          sl.end = Math.max(sl.end, e.t)
        }
      } else if (AFTER_SLIDE.has(next.type)) {
        e.t = Math.max(e.t, sl.end)
      }
    }
    slides.push(sl)
  }
}

// v4: arma los flujos de un tiro sobre la línea de tiempo (antes de ordenarla). Cada flow arranca en su
// t, pero nunca antes del último impacto o quema que lo precede en la lista (el líquido corre por el
// cráter ya abierto), y dura (parches − 1) · dt. Lo que viene después del flujo en la lista y pertenece
// al cambio de turno (daño de lava de inicio de turno, escudo, muerte) se corre a FLOW_GAP después de
// que termina si la sim no le puso un t mayor; el vapor sin t propio va con el arranque del flujo.
// v2.4: los derrumbes (collapse) se arman igual. Lo que viene después en la lista (otro derrumbe o el flujo
// de líquidos) arranca cuando el derrumbe terminó (corre sobre la tierra ya asentada), y el daño del
// aplastado (cause 'collapse'), aunque la sim lo ponga antes, llega COLLAPSE_GAP después de que se asentó.
function planFlows(timeline: TimedEvent[]): FlowPlay[] {
  const flows: FlowPlay[] = []
  let lastSrc = 0
  let collapseEnd = -Infinity
  for (let i = 0; i < timeline.length; i++) {
    const { event, t } = timeline[i]
    if ((event.type === 'impact' || event.type === 'burn') && Number.isFinite(t)) lastSrc = Math.max(lastSrc, t)
    if ((event.type !== 'flow' && event.type !== 'collapse') || event.patches.length === 0) continue
    const dt = Number.isFinite(event.dt) ? Math.max(0, event.dt) : 0
    const start = Math.max(Number.isFinite(event.t) ? event.t : 0, lastSrc)
    const end = start + (event.patches.length - 1) * dt
    timeline[i].t = start
    flows.push({ event, start, dt, end, next: 0, info: null, follow: null })
    if (event.type === 'collapse') {
      lastSrc = Math.max(lastSrc, end)
      collapseEnd = Math.max(collapseEnd, end)
    }
    for (let j = i + 1; j < timeline.length; j++) {
      const e = timeline[j]
      if (e.event.type === 'steam' && ownT(e.event) == null && Number.isFinite(e.t)) e.t = Math.max(e.t, start)
      else if (AFTER_FLOW.has(e.event.type) && Number.isFinite(e.t) && e.t < end + FLOW_GAP) e.t = end + FLOW_GAP
    }
  }
  if (Number.isFinite(collapseEnd)) {
    for (const e of timeline) {
      if (e.event.type === 'damage' && e.event.cause === 'collapse' && Number.isFinite(e.t)) e.t = Math.max(e.t, collapseEnd + COLLAPSE_GAP)
    }
  }
  return flows
}

function isLiquid(m: number): boolean {
  return m === WATER || m === LAVA
}

// Copia el rectángulo del parche (front y back completos) a la grilla, recortado a sus bordes.
function applyPatch(terrain: Terrain, p: TerrainPatch): void {
  const { w, h } = terrain
  const x0 = Math.max(0, p.x)
  const x1 = Math.min(w, p.x + p.w)
  const y0 = Math.max(0, p.y)
  const y1 = Math.min(h, p.y + p.h)
  if (x1 <= x0 || y1 <= y0) return
  for (let y = y0; y < y1; y++) {
    const src = (y - p.y) * p.w + (x0 - p.x)
    const dst = y * w + x0
    terrain.front.set(p.front.subarray(src, src + x1 - x0), dst)
    terrain.back.set(p.back.subarray(src, src + x1 - x0), dst)
  }
}

// Qué mueve un flujo partiendo de la grilla que se ve: aplica los parches sobre una copia de front y
// cuenta las celdas que cambian con agua o con lava, con la caja que las encierra. v2.4: con all (derrumbe)
// también cuenta y encierra las que cambian sin líquido (solid).
function measureFlow(grid: Terrain, patches: TerrainPatch[], dur: number, all = false): FlowInfo {
  const { w, h } = grid
  const scratch = grid.front.slice()
  const info: FlowInfo = { dur, water: 0, lava: 0, solid: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const p of patches) {
    for (let r = 0; r < p.h; r++) {
      const y = p.y + r
      if (y < 0 || y >= h) continue
      for (let c = 0; c < p.w; c++) {
        const x = p.x + c
        if (x < 0 || x >= w) continue
        const gi = y * w + x
        const v = p.front[r * p.w + c]
        const old = scratch[gi]
        if (v === old) continue
        scratch[gi] = v
        if (v === LAVA || old === LAVA) info.lava++
        else if (v === WATER || old === WATER) info.water++
        else if (all) info.solid++
        else continue
        if (x < info.x0) info.x0 = x
        if (x > info.x1) info.x1 = x
        if (y < info.y0) info.y0 = y
        if (y > info.y1) info.y1 = y
      }
    }
  }
  if (!Number.isFinite(info.x0)) {
    // no cambió ningún líquido (raro): la caja es la del primer parche
    const p = patches[0]
    info.x0 = p?.x ?? 0
    info.y0 = p?.y ?? 0
    info.x1 = p ? p.x + p.w - 1 : 0
    info.y1 = p ? p.y + p.h - 1 : 0
  }
  return info
}

// v2.4: Impact.water del vuelo que terminó en este impacto (mismo punto, a menos de 1 px), o undefined si
// ningún vuelo coincide o la sim no lo informa.
function impactWater(pb: Playback, event: Extract<GameEvent, { type: 'impact' }>): boolean | undefined {
  if (event.source === 'barrel') return undefined
  let best: Flight['impact'] | null = null
  let bestD = 1
  for (const f of pb.flights) {
    const im = f.flight.impact
    const d = Math.abs(im.x - event.x) + Math.abs(im.y - event.y)
    if (d <= bestD) {
      bestD = d
      best = im
    }
  }
  return best?.water
}

// Respaldo (v4): el centro de la explosión está bajo el agua (la celda del impacto o la de arriba).
function underwater(t: Terrain, x: number, y: number): boolean {
  const cx = Math.round(x)
  const cy = Math.round(y)
  if (cx < 0 || cx >= t.w) return false
  for (const yy of [cy, cy - 1]) {
    if (yy >= 0 && yy < t.h && t.front[yy * t.w + cx] === WATER) return true
  }
  return false
}

// Reparte los pixels que cambian entre before y after entre los impact/burn del tiro, para que
// cada cráter aparezca en el momento de su evento. Cada pixel va al primer evento (en el tiempo)
// que lo alcanza; si ninguno, al más cercano. target es la grilla que muestran esos eventos.
// v4: los pixels que cubre algún parche de flujo los termina de pintar el flujo. A los impactos les
// toca solo la parte "seca" del cambio, tomada del primer parche que cubre ese pixel: si ahí ya hay
// líquido, el impacto abre aire (si había algo sólido) y el líquido llega con el flujo; si el líquido
// se fue o se volvió piedra, eso también lo muestra el flujo.
function splitTerrain(
  before: Terrain,
  after: Terrain,
  timeline: TimedEvent[],
  flows: FlowPlay[],
): { terrain: Terrain; target: Terrain; reveal: Map<GameEvent, Int32Array>; pending: number } {
  const reveal = new Map<GameEvent, Int32Array>()
  const sources = timeline
    .map((e) => e.event)
    .filter((e): e is Extract<GameEvent, { type: 'impact' | 'burn' }> => e.type === 'impact' || e.type === 'burn')
  if (after === before || after.w !== before.w || after.h !== before.h || (sources.length === 0 && flows.length === 0)) {
    return { terrain: after, target: after, reveal, pending: 0 }
  }
  const { w, h } = before
  // v4: primer parche (en el tiempo) que cubre cada pixel; 0 = ninguno
  const patches = flows
    .flatMap((f) => f.event.patches.map((p, i) => ({ p, t: f.start + i * f.dt })))
    .sort((a, b) => a.t - b.t)
    .map((q) => q.p)
  const cover = patches.length ? new Int32Array(w * h) : null
  if (cover) {
    patches.forEach((p, k) => {
      const x0 = Math.max(0, p.x)
      const x1 = Math.min(w, p.x + p.w)
      for (let y = Math.max(0, p.y); y < Math.min(h, p.y + p.h); y++) {
        for (let x = x0; x < x1; x++) {
          const gi = y * w + x
          if (cover[gi] === 0) cover[gi] = k + 1
        }
      }
    })
  }
  // con flujo, los impactos muestran after salvo en los pixels del flujo (ahí, la parte seca)
  const target: Terrain = cover ? { ...after, front: after.front.slice(), back: after.back.slice() } : after
  const changed: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (before.front[i] === after.front[i] && before.back[i] === after.back[i]) continue
    const k = cover ? cover[i] : 0
    if (k > 0) {
      const p = patches[k - 1]
      const x = i % w
      const y = (i - x) / w
      const pi = (y - p.y) * p.w + (x - p.x)
      const fp = p.front[pi]
      const bf = before.front[i]
      let pre: number
      if (isLiquid(fp)) pre = bf === 0 || isLiquid(bf) ? bf : 0 // cráter que después se inunda
      else if (isLiquid(bf)) pre = bf // se vació o se volvió piedra: lo muestra el flujo
      else pre = fp
      const preBack = p.back[pi]
      target.front[i] = pre
      target.back[i] = preBack
      if (pre === bf && preBack === before.back[i]) continue // todo el cambio es del flujo
    }
    changed.push(i)
  }
  const terrain: Terrain = { ...before, front: before.front.slice(), back: before.back.slice() }
  if (sources.length === 0 || changed.length === 0) {
    // sin impactos ni quemas: lo seco aparece ya y el flujo hace el resto
    for (const i of changed) {
      terrain.front[i] = target.front[i]
      terrain.back[i] = target.back[i]
    }
    return { terrain, target, reveal, pending: 0 }
  }
  const reach = (e: (typeof sources)[number], x: number, y: number): number => {
    if (e.type === 'impact') {
      const r = Math.max(4, e.radius)
      // la excavadora cava un túnel largo: se lo da a su impacto aunque quede lejos
      return Math.hypot(x - e.x, y - e.y) / (e.blast === 'dig' ? r * 10 : r)
    }
    const dx = x < e.x ? e.x - x : x > e.x + e.w ? x - e.x - e.w : 0
    return Math.hypot(dx, y - e.y) / BURN_REACH
  }
  const buckets: number[][] = sources.map(() => [])
  for (const i of changed) {
    const x = i % w
    const y = (i - x) / w
    let pick = -1
    let best = Infinity
    let bestAt = 0
    for (let k = 0; k < sources.length; k++) {
      const d = reach(sources[k], x, y)
      if (d <= 1.15) {
        pick = k
        break
      }
      if (d < best) {
        best = d
        bestAt = k
      }
    }
    buckets[pick >= 0 ? pick : bestAt].push(i)
  }
  sources.forEach((e, k) => reveal.set(e, Int32Array.from(buckets[k])))
  return { terrain, target, reveal, pending: changed.length }
}

// Comienzo de un recorrido (un punto cada PATH_DT): los puntos de los primeros dur segundos, con el
// último interpolado justo en dur si el vuelo sigue más allá.
function headOfPath(path: Vec2[], dur: number): Vec2[] {
  const n = Math.floor(dur / PATH_DT + 1e-9)
  if (path.length <= n + 1) return path
  const head = path.slice(0, n + 1)
  if (dur - n * PATH_DT > 1e-6) head.push(samplePath(path, dur))
  return head
}

function samplePath(path: Vec2[], t: number): Vec2 {
  if (path.length === 1) return path[0]
  const u = t / PATH_DT
  const i = Math.min(path.length - 2, Math.floor(u))
  const f = Math.min(1, u - i)
  return {
    x: path[i].x + (path[i + 1].x - path[i].x) * f,
    y: path[i].y + (path[i + 1].y - path[i].y) * f,
  }
}

function steerKey(c: Extract<Command, { type: 'steer' }>): string {
  return `${c.playerId}:${c.dirs.join(',')}`
}

// applyCommand sin excepciones (null si la sim tiró).
function safeApply(state: GameState, command: Command): StepResult | null {
  try {
    return applyCommand(state, command)
  } catch (err) {
    console.error(err)
    return null
  }
}

// v3: los tiempos (startT de los vuelos, t de los eventos) de una tanda de 'steer' pueden venir contados
// desde el disparo (absolutos) o desde el comienzo de la tanda. base: GuidedState.t antes de la tanda.
// Devuelve cuánto restar para pasarlos a "desde el comienzo de la tanda": absolutos si el primer vuelo
// arranca en base o después; si no traen startT, se decide con el impacto (si su t queda más cerca del final
// del vuelo contado desde la tanda o desde el disparo).
function steerOffset(base: number, flights: Flight[], events: GameEvent[]): number {
  if (!(base > 1e-6)) return 0
  if (flights.some((f) => f.startT != null)) {
    const first = Math.min(...flights.map((f) => f.startT ?? 0))
    if (first >= base - 1e-3) return base
    if (first > 1e-6) return 0
  }
  const relEnd = flights.reduce((m, f) => Math.max(m, (f.startT ?? 0) + Math.max(0, f.path.length - 1) * PATH_DT), 0)
  const imp = events.find((e): e is Extract<GameEvent, { type: 'impact' }> => e.type === 'impact')
  if (imp && Number.isFinite(imp.t)) return Math.abs(imp.t - relEnd) <= Math.abs(imp.t - (base + relEnd)) ? 0 : base
  return 0
}

// Suma un tramo al camino, sin repetir el primer punto si es el último que ya estaba.
function appendPath(pts: Vec2[], path: Vec2[]): void {
  let i = 0
  const last = pts[pts.length - 1]
  if (last && path.length && Math.abs(path[0].x - last.x) + Math.abs(path[0].y - last.y) < 0.5) i = 1
  for (; i < path.length; i++) pts.push({ x: path[i].x, y: path[i].y })
}

// v3: correcciones del plan de la IA para el teledirigido (ShotPlan.steer, interno de sim). Acepta una lista
// de -1/0/1 por tick o una lista de tandas (se aplana).
function planSteer(plan: ShotPlan): (-1 | 0 | 1)[] | null {
  const raw = (plan as { steer?: unknown }).steer
  if (!Array.isArray(raw)) return null
  return (raw.flat(2) as unknown[]).map((v) => (typeof v === 'number' && v > 0 ? 1 : typeof v === 'number' && v < 0 ? -1 : 0))
}

// v3: ítems del plan de la IA: ids sueltos o { item | id, target } (jetpack y teletransporte con destino).
function planItems(plan: ShotPlan): { item: ItemId; target?: Vec2 }[] {
  const raw = (plan as { items?: unknown }).items
  if (!Array.isArray(raw)) return []
  const out: { item: ItemId; target?: Vec2 }[] = []
  for (const it of raw) {
    if (typeof it === 'string' && (ITEM_ORDER as string[]).includes(it)) out.push({ item: it as ItemId })
    else if (it && typeof it === 'object') {
      const o = it as { item?: unknown; id?: unknown; target?: unknown }
      const id = (o.item ?? o.id) as string
      const tg = o.target as Vec2 | undefined
      if ((ITEM_ORDER as string[]).includes(id)) out.push({ item: id as ItemId, target: tg && Number.isFinite(tg.x) && Number.isFinite(tg.y) ? { x: tg.x, y: tg.y } : undefined })
    }
  }
  // v3: el destino de jetpack y teletransporte puede venir aparte (ShotPlan.itemTarget)
  const extra = (plan as { itemTarget?: unknown }).itemTarget as Vec2 | undefined
  if (extra && Number.isFinite(extra.x)) for (const o of out) if ((o.item === 'jetpack' || o.item === 'teleport') && !o.target) o.target = { x: extra.x, y: extra.y }
  return out
}

// t propio de un evento (los que lo traen opcional); el de impact se maneja aparte.
function ownT(event: GameEvent): number | null {
  if (event.type === 'impact') return null
  const t = (event as { t?: unknown }).t
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

// Un decimal: el ajuste fino (Shift, paso táctil) mueve de a 0,2 y eso tiene que llegar a la sim.
function quantize(v: number): number {
  return Math.round(v * 10) / 10
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// v2.4: el tanque está metido en lava: alguna celda de lava de la grilla en su caja, o el piso debajo de
// la superficie de la lava de la muerte súbita.
function inLava(s: GameState, p: Player): boolean {
  if (s.lava != null && p.y > s.lava) return true
  const t = s.terrain
  const x0 = Math.max(0, Math.round(p.x - TANK_W / 2))
  const x1 = Math.min(t.w - 1, Math.round(p.x + TANK_W / 2))
  const y0 = Math.max(0, Math.round(p.y - TANK_H))
  const y1 = Math.min(t.h - 1, Math.round(p.y))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (t.front[y * t.w + x] === LAVA) return true
  }
  return false
}

// v3: los eventos traen una caída al abismo (fall por debajo del mapa o muerte con cause 'abyss').
function hasAbyss(events: GameEvent[], h: number): boolean {
  return events.some((e) => isAbyssFall(e, h) || (e.type === 'death' && e.cause === 'abyss'))
}
