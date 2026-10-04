import { PixiRenderer } from './render/pixi/PixiRenderer'
import { Keyboard, weaponSlot } from './input/keyboard'
import { Gamepad, type PadState } from './input/gamepad'
import { TouchControls, fullscreenButton, isTouchDevice, vibrate } from './input/touch'
import { MousePan } from './input/mouse'
import { VIEW_H, VIEW_W, type Viewport } from './render/types'
import { Sfx } from './audio/sfx'
import { ITEM_CURSOR_SPEED, Session, abyssLostAt, isAbyssFall } from './game/session'
import { TargetOverlay } from './input/target'
import type { NetSeat } from './game/session'
import { Online } from './game/online'
import { rememberProfile, withProfile } from './game/profile'
import { normalizeCode, readNetParams } from './net'
import { createOnlineMenuView } from './ui/online'
import { createLobbyView } from './ui/lobby'
import { Hud } from './ui/hud'
import { loadUiAssets } from './ui/assets'
import { createMenuView, refreshLabels } from './ui/menu'
import { createTitleView } from './ui/title'
import { createBannerView } from './ui/banner'
import { createScoreboardView } from './ui/scoreboard'
import { createShopView } from './ui/shop'
import { DEFAULT_CONFIG, type HudControl } from './ui/types'
import { PATH_DT, chooseShot } from './sim'
import {
  ANGLE_SPEED,
  BIOMES,
  MAP_SIZE_ORDER,
  MAX_PLAYERS,
  MAX_PLAYERS_BY_SIZE,
  POWER_SPEED,
  TANK_H,
  TANK_HALF_W,
  WEAPON_ORDER,
  type Biome,
  type GameEvent,
  type ItemId,
  type MapSize,
  type MatchConfig,
  type SlotConfig,
  type WeaponId,
} from './sim/types'

const stage = must(document.querySelector<HTMLElement>('#stage'))
const hudRoot = must(document.querySelector<HTMLElement>('#hud'))

const params = new URLSearchParams(location.search)
const uitest = params.get('uitest')
// &size=small|medium|large en ?play= y ?demo=; sin size, Chico (las capturas de QA de v1 siguen iguales)
const sizeParam: MapSize = (MAP_SIZE_ORDER as string[]).includes(params.get('size') ?? '') ? (params.get('size') as MapSize) : 'small'
const demoParam = uitest ? null : params.get('demo')
const demo =
  demoParam == null
    ? null
    : {
        seed: (Number(demoParam) >>> 0) || 1,
        biome: (BIOMES as string[]).includes(params.get('biome') ?? '') ? (params.get('biome') as Biome) : 'forest',
        freeze: params.get('freeze') !== '0',
        // &ff=<segundos>: con freeze=0 adelanta la partida a paso fijo antes del loop real
        ff: Math.min(600, Math.max(0, Number(params.get('ff')) || 0)),
        // &weapon=<WeaponId>: arma del tiro fijo de P1
        weapon: (WEAPON_ORDER as string[]).includes(params.get('weapon') ?? '') ? (params.get('weapon') as WeaponId) : undefined,
      }

// ?play=<seed>: QA, entra directo a una partida sin pasar por el título ni el menú.
// &humans=N (hot-seat), &bots=N, &rounds=N, &size=.
const playParam = demo || uitest ? null : params.get('play')
// &calm=N (solo con ?play=): la primera ronda arranca con N tiros sin daño ya contados (QA de la muerte súbita)
const calmParam = playParam != null && params.has('calm') ? Math.max(0, Math.round(Number(params.get('calm')) || 0)) : null
// &aisync=1: QA, la IA calcula en el hilo principal (para comparar contra el worker)
const aiSync = params.get('aisync') === '1'
// Online: ?host=1, ?join=CODIGO, ?net=local, ?autotest=1 (scripts/net-test.mjs)
const net = readNetParams()
const netStart = demo || uitest || playParam != null ? null : net.host ? 'host' : net.join ? 'join' : null
// autotest: cada humano apunta con la IA difícil, así la partida de prueba termina rápido
const AUTO_SHOT = { delay: 0.8 }

// v3: J jetpack, E teletransporte (los dos piden destino), N ancla, V deflector
const ITEM_KEYS: Record<string, ItemId> = {
  KeyQ: 'shield',
  KeyF: 'fuel',
  KeyR: 'repair',
  KeyT: 'tracer',
  KeyJ: 'jetpack',
  KeyE: 'teleport',
  KeyN: 'anchor',
  KeyV: 'deflector',
}
// Cámara (v2): Z / X panean a la izquierda / derecha, C recentra en el tanque del turno.
// También: mouse contra el borde, arrastre con el botón del medio (o el izquierdo fuera del tanque y
// del tablero / controles del HUD), stick derecho del gamepad (R3 recentra), dos dedos en táctil (◎ recentra),
// click o arrastre sobre el minimapa (doble click o doble toque recentra).
const PAN_SPEED = 700 // pixels de pantalla por segundo con Z / X, el borde o el stick
// v2 ajuste fino: con Shift (o L3 / Select en el gamepad) ángulo y potencia van a 1/5 de velocidad.
const FINE = 0.2
const DOUBLE_TAP = 0.35 // segundos entre dos toques del minimapa para recentrar

const renderer = new PixiRenderer()
const keys = new Keyboard()
const pad = new Gamepad()
const touch = new TouchControls(stage)
const mouse = new MousePan(stage)
const target = new TargetOverlay()
if (isTouchDevice()) {
  // pantalla completa también fuera de la partida (menú, lobby, tienda)
  const fs = fullscreenButton()
  fs.classList.add('fs-global')
  document.getElementById('app')?.append(fs)
}
const sfx = new Sfx()
const session = new Session()
session.syncAi = aiSync
const hud = new Hud(hudRoot)
const title = createTitleView()
const menu = createMenuView()
const banner = createBannerView()
const scoreboard = createScoreboardView()
const shop = createShopView()
const onlineMenu = createOnlineMenuView()
const lobbyView = createLobbyView()

let screen: 'title' | 'menu' | 'online' | 'lobby' | 'play' = 'title'
let online: Online | null = null
let lobbyShown = false
let wasMyTurn = false
let autoT = 0
let lastTick = performance.now()
let shopState: unknown = null
let mounted = false
// qué vista tapa la partida
let overlay: 'none' | 'banner' | 'score' | 'final' | 'shop' = 'none'
let shopFor: number | null = null
let paused = false
let lastConfig: MatchConfig = DEFAULT_CONFIG
let lastWind: number | null = null
let viewport: Viewport | null = null
// minimapa: puntero que lo está arrastrando y hora del último toque (doble toque recentra)
let miniDrag: number | null = null
let miniTapAt = -Infinity
// HUD C: puntero que mantiene apretado ◀ o ▶ del tablero (mover, como A / D) y para qué lado
let moveHold: { id: number; dir: -1 | 1 } | null = null

void loadUiAssets().then(() => {
  refreshLabels()
  hud.invalidate()
})

// El audio solo arranca con un gesto del usuario.
const unlock = () => sfx.unlock()
window.addEventListener('pointerdown', unlock)
window.addEventListener('keydown', unlock)

// ---------- HUD C: controles del tablero y de la fila de ítems ----------

// Punto de la ventana dentro del tablero inferior del HUD (las últimas hudBar filas de la pantalla).
function inBar(clientX: number, clientY: number): boolean {
  const bar = session.hudBar
  if (!playing() || bar <= 0) return false
  const r = stage.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  const lx = ((clientX - r.left) / r.width) * VIEW_W
  const ly = ((clientY - r.top) / r.height) * VIEW_H
  return lx >= 0 && lx <= VIEW_W && ly >= VIEW_H - bar && ly <= VIEW_H
}

// Control del HUD bajo el puntero (arma, ítem, ◀ ▶), solo durante la partida sin carteles.
const controlAt = (clientX: number, clientY: number): HudControl | null => (playing() ? hud.controlAt(clientX, clientY) : null)

// El puntero empieza sobre el HUD que se toca: un control, el tablero entero o el minimapa. Ahí no
// arrancan el arrastre de cámara, el apuntado táctil ni el paneo contra el borde.
const onHud = (e: PointerEvent): boolean => onMinimap(e) || inBar(e.clientX, e.clientY) || controlAt(e.clientX, e.clientY) != null

// Click o toque en un control: el arma la elige, el ítem lo usa (como Q / F / R / T) y ◀ ▶ mueven
// mientras se mantienen apretados (como A / D; soltar frena). Todo solo en tu turno. En captura, antes
// que el apuntado táctil y el arrastre del #stage.
window.addEventListener(
  'pointerdown',
  (e) => {
    const c = controlAt(e.clientX, e.clientY)
    if (!c) return
    e.preventDefault()
    if (!session.inputEnabled) return
    if (c.kind === 'weapon') {
      sfx.click()
      session.select(c.id)
    } else if (c.kind === 'item') {
      if (!session.useItem(c.id)) sfx.empty()
    } else {
      moveHold = { id: e.pointerId, dir: c.dir }
    }
  },
  true,
)
// deslizar el dedo de ◀ a ▶ (o al revés) cambia de lado sin soltar
window.addEventListener('pointermove', (e) => {
  if (!moveHold || moveHold.id !== e.pointerId) return
  const c = controlAt(e.clientX, e.clientY)
  if (c?.kind === 'move') moveHold.dir = c.dir
})
const endMove = (e: PointerEvent): void => {
  if (moveHold?.id === e.pointerId) moveHold = null
}
window.addEventListener('pointerup', endMove)
window.addEventListener('pointercancel', endMove)
window.addEventListener('blur', () => (moveHold = null))

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') sfx.toggleMute()
})

// v3 destino de jetpack / teletransporte con mouse o toque: el puntero mueve el cursor (mouse) y el click o
// el toque en el mundo lo confirma ahí; el botón derecho cancela. En captura, antes que el arrastre y el
// apuntado táctil.
stage.addEventListener(
  'pointerdown',
  (e) => {
    if (!playing() || !session.aimingItem || onHud(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.button === 2) {
      session.cancelItemAim()
      sfx.click()
      return
    }
    const w = renderer.screenToWorld(e.clientX, e.clientY)
    session.setItemCursor(w.x, w.y)
    if (!session.confirmItemAim()) sfx.empty()
  },
  true,
)
stage.addEventListener('contextmenu', (e) => {
  if (session.aimingItem) e.preventDefault()
})
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !playing() || !session.aimingItem || onHud(e)) return
  const w = renderer.screenToWorld(e.clientX, e.clientY)
  session.setItemCursor(w.x, w.y)
})

// ---------- cámara: minimapa, arrastre y apuntado táctil en mundo ----------

const playing = (): boolean => screen === 'play' && overlay === 'none' && !paused
const onMinimap = (e: PointerEvent): boolean => playing() && hud.minimapAt(e.clientX, e.clientY) != null

touch.toWorld = (x, y) => renderer.screenToWorld(x, y)
// v3: eligiendo destino de un ítem, el toque elige el lugar (no apunta)
touch.ignore = (e) => onHud(e) || !!session.aimingItem
// v3: mundo → ventana (inversa de screenToWorld, con la cámara del último frame) para la ayuda de destino
target.toClient = (p) => {
  const vp = viewport
  if (!vp || vp.w <= 0) return { x: 0, y: 0 }
  const a = renderer.screenToWorld(vp.x, vp.y)
  const b = renderer.screenToWorld(vp.x + vp.w, vp.y + vp.h)
  return { x: vp.x + ((p.x - a.x) / (b.x - a.x || 1)) * vp.w, y: vp.y + ((p.y - a.y) / (b.y - a.y || 1)) * vp.h }
}
// el click izquierdo arrastra el mundo salvo sobre el tanque del turno, el tablero, un control del HUD o el minimapa
mouse.blocked = (e) => onHud(e) || onCurrentTank(e.clientX, e.clientY) || !!session.aimingItem
// el mouse contra el borde no panea sobre el tablero ni sobre los ítems de arriba
mouse.noEdge = (x, y) => inBar(x, y) || controlAt(x, y) != null

// Click o toque en el minimapa: centra la cámara ahí; arrastrar mueve el viewport; doble toque recentra.
// En captura, antes que el apuntado táctil del #stage.
window.addEventListener(
  'pointerdown',
  (e) => {
    if (!playing()) return
    const at = hud.minimapAt(e.clientX, e.clientY)
    if (!at) return
    e.preventDefault()
    const now = performance.now() / 1000
    if (now - miniTapAt < DOUBLE_TAP) {
      miniTapAt = -Infinity
      miniDrag = null
      session.recenter()
      return
    }
    miniTapAt = now
    miniDrag = e.pointerId
    session.panTo(at.x, true)
  },
  true,
)
window.addEventListener('pointermove', (e) => {
  if (miniDrag !== e.pointerId || !playing()) return
  const at = hud.minimapAt(e.clientX, e.clientY)
  if (at) session.panTo(at.x, false)
})
const endMini = (e: PointerEvent): void => {
  if (miniDrag === e.pointerId) miniDrag = null
}
window.addEventListener('pointerup', endMini)
window.addEventListener('pointercancel', endMini)

function onCurrentTank(clientX: number, clientY: number): boolean {
  const s = session.state
  const p = s?.players[s.current]
  if (!p || !p.alive) return false
  const w = renderer.screenToWorld(clientX, clientY)
  return Math.abs(w.x - p.x) <= TANK_HALF_W + 4 && w.y >= p.y - TANK_H - 10 && w.y <= p.y + 4
}

menu.onOnline(() => {
  if (screen !== 'menu') return
  sfx.click()
  showOnlineMenu()
})

if (uitest) {
  // la página de prueba de vistas la monta index.html
} else if (demo || playParam != null) {
  // entra directo a la partida
} else if (netStart === 'host') {
  openHost()
} else if (netStart === 'join' && net.join) {
  openJoin(net.join)
} else {
  showTitle()
}

// Online con la pestaña en segundo plano: rAF se frena y la partida de los demás también.
// Un intervalo avanza la sesión a paso fijo mientras no llegan frames.
setInterval(() => {
  if (!online || screen !== 'play') return
  const now = performance.now()
  const late = (now - lastTick) / 1000
  if (late < 0.3) return
  lastTick = now
  const steps = Math.min(120, Math.floor(late * 60))
  for (let i = 0; i < steps; i++) step1(1 / 60, false, i === steps - 1)
}, 100)

// Sin top-level await: Pixi importa sus renderers en chunks que dependen de este
// módulo, y en el build eso deja el import dinámico esperando para siempre.
if (!uitest) {
  void renderer.mount(stage).then(() => {
    mounted = true
    renderer.setLoop(tick)
    layout()
    window.addEventListener('resize', layout)
    if (demo) {
      const slots: SlotConfig[] = [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }]
      session.start(
        { slots, rounds: 1, difficulty: 'hard', biome: demo.biome, size: sizeParam, seed: demo.seed },
        { freeze: demo.freeze, weapon: demo.weapon },
      )
      enterPlay()
      if (demo.freeze) fastForward()
      else if (demo.ff > 0) fastForwardFor(demo.ff)
    } else if (playParam != null) {
      const biome = (BIOMES as string[]).includes(params.get('biome') ?? '') ? (params.get('biome') as Biome) : 'forest'
      // v5: humanos + bots hasta el máximo del tamaño (Chico 4, Mediano 6, Grande 8), p. ej. &size=large&bots=7
      const max = MAX_PLAYERS_BY_SIZE[sizeParam]
      const humans = clampInt(params.get('humans'), 1, 1, max)
      const bots = clampInt(params.get('bots'), Math.min(2, max - humans), humans > 1 ? 0 : 1, max - humans)
      const slots: SlotConfig[] = []
      for (let i = 0; i < humans; i++) slots.push({ kind: 'human' })
      for (let i = 0; i < bots; i++) slots.push({ kind: 'ai' })
      begin({
        slots,
        rounds: clampInt(params.get('rounds'), 1, 1, 10),
        difficulty: 'normal',
        biome,
        size: sizeParam,
        seed: (Number(playParam) >>> 0) || 1,
      })
      if (calmParam != null) session.qaCalm(calmParam)
    }
  })
}

function showTitle(): void {
  screen = 'title'
  stage.hidden = true
  hud.hide()
  title.show(() => {
    sfx.unlock()
    sfx.click()
    title.hide()
    toMenu()
  })
}

function begin(config: MatchConfig): void {
  lastConfig = config
  session.start(config)
  sfx.unlock()
  enterPlay()
}

function enterPlay(): void {
  screen = 'play'
  lastWind = null
  paused = false
  closeOverlay()
  menu.hide()
  title.hide()
  stage.hidden = false
  hud.show()
  hud.invalidate()
  keys.capture = true
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  keys.consumePressed()
  pad.suppress()
  touch.setRecenter(session.scrolls)
  layout()
}

function toMenu(): void {
  leaveOnline()
  screen = 'menu'
  paused = false
  sfx.engine(false)
  closeOverlay()
  hud.hide()
  stage.hidden = true
  keys.capture = false
  // v3: el primer casillero humano arranca con el perfil guardado (nombre, tripulante y color)
  menu.show(withProfile(lastConfig), (config) => {
    if (screen !== 'menu') return
    sfx.click()
    menu.hide()
    rememberProfile(config)
    begin(config)
  })
}

// ---------- online ----------

function showOnlineMenu(message?: string): void {
  leaveOnline()
  screen = 'online'
  sfx.engine(false)
  closeOverlay()
  menu.hide()
  title.hide()
  hud.hide()
  stage.hidden = true
  keys.capture = false
  onlineMenu.show(
    {
      host: () => {
        if (screen !== 'online') return
        sfx.click()
        openHost()
      },
      join: (raw) => {
        if (screen !== 'online') return
        const code = normalizeCode(raw)
        if (!code) {
          sfx.empty()
          onlineMenu.error('CODIGO INVALIDO')
          return
        }
        sfx.click()
        openJoin(code)
      },
      back: () => {
        if (screen !== 'online') return
        sfx.click()
        onlineMenu.hide()
        toMenu()
      },
    },
    net.join ?? undefined,
  )
  if (message) onlineMenu.error(message)
}

function openHost(): void {
  openRoom('host')
}

function openJoin(code: string): void {
  openRoom('client', code)
}

function openRoom(role: 'host' | 'client', code?: string): void {
  leaveOnline()
  onlineMenu.hide()
  title.hide()
  menu.hide()
  hud.hide()
  stage.hidden = true
  keys.capture = false
  screen = 'lobby'
  lobbyShown = false
  const room: Online = new Online(role, net.kind, session, {
    lobby: () => {
      if (online !== room) return
      if (net.autotest && role === 'host') autotestLobby(room)
      refreshLobby()
    },
    start: (config, seat, pending) => {
      if (online !== room) return
      startOnline(config, seat, pending)
    },
    end: (reason) => {
      if (online !== room) return
      online = null
      showOnlineMenu(reason.toUpperCase())
    },
    peer: (joined) => sfx.peer(joined),
  })
  online = room
  void room.open(code).then(() => {
    if (online === room && net.autotest && role === 'host') autotestLobby(room)
  })
}

// autotest: 2 humanos (anfitrión + un cliente) y el resto IA, 1 ronda; arranca cuando el cliente tomó
// su casillero. Por defecto 3 casilleros (2 humanos + 1 IA) en el tamaño por defecto; con &players=N
// (v5, scripts/net-test.mjs --players N) usa N casilleros y el mapa más chico que los admite.
const AUTO_PLAYERS = Math.max(3, Math.min(MAX_PLAYERS, Math.round(Number(params.get('players')) || 3)))
let autotestBusy = false
function autotestLobby(room: Online): void {
  const lobby = room.lobby
  if (autotestBusy || !lobby || room.started || !room.code) return
  autotestBusy = true
  try {
    if (params.has('players')) {
      // el tamaño primero: el anfitrión no deja ocupar casilleros por encima del límite del mapa
      const size = MAP_SIZE_ORDER.find((k) => MAX_PLAYERS_BY_SIZE[k] >= AUTO_PLAYERS) ?? 'large'
      if (lobby.size !== size) room.setOption('size', size)
    }
    if (lobby.slots[1]?.kind !== 'human') room.setSlot(1, 'human')
    for (let i = 2; i < lobby.slots.length; i++) {
      const kind = i < AUTO_PLAYERS ? 'ai' : 'off'
      if (lobby.slots[i]?.kind !== kind) room.setSlot(i, kind)
    }
    if (lobby.rounds !== 1) room.setOption('rounds', 1)
    // fuera del callback de la sala: el hello del cliente todavía se está procesando
    if (room.canStart()) setTimeout(() => online === room && !room.started && room.start(), 300)
  } finally {
    autotestBusy = false
  }
}

function refreshLobby(): void {
  if (!online || screen !== 'lobby') return
  const model = online.lobbyModel()
  if (!model) return
  if (lobbyShown) {
    lobbyView.update(model)
    return
  }
  lobbyShown = true
  const room = online
  lobbyView.show(model, {
    claim: (slot) => {
      sfx.click()
      room.claim(slot)
    },
    release: () => {
      sfx.click()
      room.release()
    },
    setSlot: (slot, kind) => {
      sfx.click()
      room.setSlot(slot, kind)
    },
    setOption: (key, value) => {
      sfx.click()
      room.setOption(key, value)
    },
    start: () => {
      if (!room.start()) sfx.empty()
      else sfx.click()
    },
    leave: () => {
      sfx.click()
      toMenu()
    },
  })
}

function startOnline(config: MatchConfig, seat: NetSeat, _snapshotPending: boolean): void {
  lobbyView.hide()
  lobbyShown = false
  lastConfig = config
  session.start(config, undefined, seat)
  sfx.unlock()
  wasMyTurn = false
  autoT = 0
  enterPlay()
}

function leaveOnline(): void {
  if (!online) return
  const room = online
  online = null
  room.close()
  lobbyView.hide()
  lobbyShown = false
  session.netHud = null
}

function closeOverlay(): void {
  banner.hide()
  scoreboard.hide()
  shop.hide()
  overlay = 'none'
  shopFor = null
  keys.consumePressed()
  pad.suppress()
}

function layout(): void {
  if (!mounted) return
  const vp = renderer.resize()
  viewport = vp
  hud.place(vp)
  touch.place(vp, session.hudBar)
  refreshLabels()
}

// Demo congelado: corre la partida a paso fijo hasta el congelamiento sin esperar frames reales.
// En Chrome headless los frames llegan muy espaciados y la captura saldría antes del tiro.
function fastForward(): void {
  const step = 1 / 60
  session.syncAi = true
  for (let i = 0; i < 60 * 30 && !session.isFrozen; i++) step1(step, false)
  session.syncAi = aiSync
}

// Demo sin congelar: el ticker de Pixi casi no avanza con --virtual-time-budget.
function fastForwardFor(seconds: number): void {
  const step = 1 / 60
  session.syncAi = true
  for (let i = 0; i < Math.round(seconds * 60); i++) step1(step, false)
  session.syncAi = aiSync
}

function tick(rawDt: number): void {
  lastTick = performance.now()
  touch.setActive(screen === 'play' && overlay === 'none')
  mouse.active = playing()
  if (!mouse.active) mouse.cancel()
  if (!playing()) {
    moveHold = null
    target.show(null)
    touch.setSteer(false)
  }
  step1(Math.min(0.05, Math.max(0, rawDt)), true)
}

function step1(dt: number, live: boolean, draw = true): void {
  if (screen !== 'play') return
  const padState = live ? mergePad(pad.poll(), touch.poll()) : null
  if (live && overlay === 'none') {
    const pressed = keys.consumePressed()
    // online no hay pausa: la partida sigue para los demás
    if (!online && (pressed.has('KeyP') || padState?.pressed.has('pause'))) {
      paused = !paused
      sfx.click()
      sfx.engine(false)
    }
    if (!paused) {
      handleCamera(dt, pressed, padState)
      handleInput(dt, pressed, padState)
    }
  }
  if (paused) {
    const frame = session.frame()
    if (frame) renderer.render(frame, [], 0)
    const model = session.hud()
    if (model) hud.update({ ...model, status: 'Pausa' })
    return
  }
  session.update(dt)
  // v2.4: los sonidos se estiran (y bajan de tono) con la cámara lenta, también los que ya suenan
  sfx.setTimeScale(session.soundScale)
  if (online) {
    online.update(dt)
    session.netHud = online.hudNet()
    const mine = session.myTurn
    if (mine && !wasMyTurn) {
      sfx.yourTurn()
      vibrate([40, 60, 40])
    }
    wasMyTurn = mine
    if (net.autotest && mine && overlay === 'none') {
      autoT += dt
      if (autoT >= AUTO_SHOT.delay) {
        autoT = 0
        const s = session.state
        if (s) {
          const plan = chooseShot(s, 'hard')
          session.fireWith(plan.angle, plan.power)
        }
      }
    } else autoT = 0
  }

  for (const shot of session.pullShots()) sfx.fire(shot.weapon)
  // v3: soplido del cohete en cada tanda del teledirigido; en táctil, ◀ ▶ mientras lo dirige este dispositivo
  for (const st of session.pullSteers()) sfx.missile(st.dir, st.left)
  if (live) touch.setSteer(session.steering && playing())
  for (const _ of session.pullMelts()) sfx.melt()
  // v4: proyectiles que entran al agua, en su momento del vuelo
  for (const _ of session.pullSplashes()) sfx.splash()
  // v3: el tanque frenó solo en el borde de un abismo
  if (session.pullEdgeWarning()) sfx.edgeWarn()
  // v2.4: "!" nuevo sobre un tanque (sin munición, sin combustible, viento, muerte súbita, lava)
  if (session.pullAlerts().length && live) sfx.alert()
  if (session.pullSuddenDeath() && live) {
    // empieza la muerte súbita: sirena corta y vibración en táctil
    sfx.suddenDeath()
    vibrate([60, 40, 60, 40, 120])
  }
  sfx.engine(live && session.moving)
  if (!draw) {
    session.pullFx()
    session.skipFrame()
    flow()
    return
  }
  const frame = session.frame()
  if (!frame) return
  const events = session.pullFx()
  playSounds(events)
  if (frame.wind !== lastWind) {
    lastWind = frame.wind
    sfx.setWind(frame.wind)
  }
  renderer.render(frame, events, dt * session.timeScale)
  // v3: ayuda de destino de jetpack / teletransporte (encima del juego, con la cámara de este frame)
  target.show(live && playing() ? session.aimingItem : null)
  const model = session.hud()
  if (model) hud.update(model)
  flow()
}

// Gamepad y controles táctiles se suman: los dos devuelven el mismo formato.
function mergePad(a: PadState, b: PadState): PadState {
  const clamp1 = (n: number): number => Math.max(-1, Math.min(1, n))
  return {
    angle: clamp1(a.angle + b.angle),
    power: clamp1(a.power + b.power),
    move: a.move || b.move,
    steer: clamp1(a.steer + b.steer),
    pan: clamp1(a.pan + b.pan),
    fine: a.fine || b.fine,
    stepAngle: a.stepAngle + b.stepAngle,
    stepPower: a.stepPower + b.stepPower,
    pressed: new Set([...a.pressed, ...b.pressed]),
  }
}

// Paneo y recentrado de la cámara. Anda en cualquier turno (también mirando a la IA), salvo con un
// tiro en vuelo; en mapas Chico la cámara es fija y esto no hace nada.
function handleCamera(dt: number, pressed: Set<string>, padState: PadState | null): void {
  const dragDx = mouse.pollDrag() + touch.pollPan()
  if (pressed.has('KeyC') || padState?.pressed.has('recenter')) session.recenter()
  if (!session.canPan) return
  const zoom = session.camera.zoom || 1
  let dir = 0
  if (keys.isDown('KeyZ')) dir -= 1
  if (keys.isDown('KeyX')) dir += 1
  dir += padState?.pan ?? 0
  dir += mouse.edge()
  dir = Math.max(-1, Math.min(1, dir))
  // arrastrar el mundo: la cámara va al revés que el puntero, a la escala de la pantalla
  const scale = (viewport?.scale || 1) * zoom
  const dx = (dir * PAN_SPEED * dt) / zoom - dragDx / scale
  if (dx !== 0) session.panBy(dx)
}

function handleInput(dt: number, pressed: Set<string>, padState: ReturnType<Gamepad['poll']> | null): void {
  // v3 teledirigido: ← → (o A / D), el stick o la cruceta, y en táctil ◀ ▶ o arrastrar, dirigen el misil
  if (session.steering) {
    let side = 0
    if (keys.isDown('ArrowLeft') || keys.isDown('KeyA')) side -= 1
    if (keys.isDown('ArrowRight') || keys.isDown('KeyD')) side += 1
    if (padState) side += Math.abs(padState.steer) >= 0.5 ? Math.sign(padState.steer) : 0
    session.steerInput(side < 0 ? -1 : side > 0 ? 1 : 0)
    return
  }
  session.steerInput(0)
  if (!session.inputEnabled) return
  // v3: eligiendo destino de jetpack o teletransporte
  if (session.aimingItem) {
    handleItemAim(dt, pressed, padState)
    return
  }
  let dAngle = 0
  let dPower = 0
  if (keys.isDown('ArrowLeft')) dAngle += ANGLE_SPEED * dt
  if (keys.isDown('ArrowRight')) dAngle -= ANGLE_SPEED * dt
  if (keys.isDown('ArrowUp')) dPower += POWER_SPEED * dt
  if (keys.isDown('ArrowDown')) dPower -= POWER_SPEED * dt
  if (padState) {
    dAngle += padState.angle * ANGLE_SPEED * dt
    dPower += padState.power * POWER_SPEED * dt
  }
  // ajuste fino: Shift mantenido (o L3 / Select) a 1/5; los pasos táctiles ya vienen en grados
  const fine = keys.isDown('ShiftLeft') || keys.isDown('ShiftRight') || !!padState?.fine
  const k = fine ? FINE : 1
  session.nudge(dAngle * k + (padState?.stepAngle ?? 0), dPower * k + (padState?.stepPower ?? 0))
  const drag = touch.dragAim()
  if (drag) session.aimTo(drag.angle, drag.power)
  const left = keys.isDown('KeyA') || padState?.move === -1 || moveHold?.dir === -1
  const right = keys.isDown('KeyD') || padState?.move === 1 || moveHold?.dir === 1
  if (left !== right) session.move(left ? -1 : 1, dt)
  else session.stopMove()
  // v3: 1 a 9 y 0 eligen las primeras 10 del orden de la barra; Tab / Shift+Tab y la rueda recorren las 16
  const slot = weaponSlot(pressed)
  if (slot >= 0 && slot < WEAPON_ORDER.length) {
    sfx.click()
    session.select(WEAPON_ORDER[slot])
  }
  if (pressed.has('Tab')) {
    sfx.click()
    session.cycleWeapon(keys.isDown('ShiftLeft') || keys.isDown('ShiftRight') ? -1 : 1, WEAPON_ORDER)
  }
  const wheel = takeWheel()
  if (wheel) {
    sfx.click()
    session.cycleWeapon(wheel, WEAPON_ORDER)
  }
  if (padState?.pressed.has('prevWeapon') || padState?.pressed.has('nextWeapon')) {
    sfx.click()
    session.cycleWeapon(padState.pressed.has('prevWeapon') ? -1 : 1, WEAPON_ORDER)
  }
  for (const code of pressed) {
    const item = ITEM_KEYS[code]
    if (item && !session.useItem(item)) sfx.empty()
  }
  if (padState?.pressed.has('item')) {
    const item = session.firstUsableItem()
    if (!item || !session.useItem(item)) sfx.empty()
  }
  if (pressed.has('Space') || padState?.pressed.has('fire')) session.fire()
}

// v3: modo de elegir destino. Flechas (o el stick) mueven el cursor, Espacio / Enter (o A) confirman y
// Esc (o B, o la tecla del mismo ítem) cancelan sin gastarlo. Mouse y toque van por pointer (ver arriba).
function handleItemAim(dt: number, pressed: Set<string>, padState: PadState | null): void {
  const aim = session.aimingItem
  if (!aim) return
  const fine = keys.isDown('ShiftLeft') || keys.isDown('ShiftRight') ? FINE : 1
  let dx = 0
  let dy = 0
  if (keys.isDown('ArrowLeft')) dx -= 1
  if (keys.isDown('ArrowRight')) dx += 1
  if (keys.isDown('ArrowUp')) dy -= 1
  if (keys.isDown('ArrowDown')) dy += 1
  if (padState) {
    dx -= padState.angle
    dy -= padState.power
  }
  const v = ITEM_CURSOR_SPEED * dt * fine
  if (dx || dy) session.moveItemCursor(dx * v, dy * v)
  const again = [...pressed].some((code) => ITEM_KEYS[code] === aim.item)
  if (pressed.has('Escape') || again || padState?.pressed.has('item')) {
    session.cancelItemAim()
    sfx.click()
    return
  }
  if (pressed.has('Space') || pressed.has('Enter') || pressed.has('NumpadEnter') || padState?.pressed.has('fire')) {
    if (!session.confirmItemAim()) sfx.empty()
  }
}

// v3: rueda del mouse sobre el juego: recorre las armas (una por "muesca", acumulando el trackpad).
let wheelAcc = 0
stage.addEventListener(
  'wheel',
  (e) => {
    if (!playing()) return
    e.preventDefault()
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY
  },
  { passive: false },
)
function takeWheel(): -1 | 0 | 1 {
  if (Math.abs(wheelAcc) < 60) return 0
  const dir = wheelAcc > 0 ? 1 : -1
  wheelAcc = 0
  return dir
}

function playSounds(events: GameEvent[]): void {
  const h = session.state?.terrain.h ?? 450
  for (const e of events) {
    switch (e.type) {
      case 'impact':
        if (e.source === 'barrel') break // el evento prop del barril ya suena
        // v4: con el centro bajo el agua suena apagado y burbujeante
        if (session.isSubmerged(e)) sfx.boomUnder(e.radius)
        else if (e.weapon === 'cluster') sfx.bomblet(e.radius, e.debris)
        else sfx.boom(e.blast, e.radius, e.debris)
        break
      case 'burn':
        sfx.burn(e.w)
        break
      case 'prop':
        if (e.destroyed && e.kind === 'barrel') sfx.barrel()
        // v3: caja de botín rota (con monedas) u objetivo pago destruido; la caja que aparece cae en paracaídas
        else if (e.destroyed && e.kind === 'loot') sfx.lootBreak()
        else if (e.destroyed && e.kind === 'target') sfx.targetDown()
        else if (!e.destroyed && e.kind === 'loot' && session.isNewProp(e)) sfx.lootDrop()
        break
      // ---------- v3 ----------
      case 'beam':
        sfx.beam(Math.hypot(e.x1 - e.x0, e.y1 - e.y0))
        break
      case 'quake':
        sfx.quake(e.radius)
        break
      case 'pull':
        sfx.blackhole(e.duration)
        break
      case 'hazard':
        if (e.hazard.kind === 'mine') {
          if (e.action === 'place') sfx.mineArm()
          else if (e.action === 'trigger' || e.action === 'expire') sfx.mineTrigger()
        } else if (e.action !== 'expire') sfx.acidBubble(e.action === 'trigger' ? 1 : 0.6)
        break
      case 'deflect':
        sfx.deflect()
        break
      case 'jetpack':
        sfx.jetpack(Math.max(0, e.path.length - 1) * PATH_DT)
        break
      case 'teleport':
        sfx.teleport()
        break
      case 'guide':
        sfx.guideStart()
        break
      case 'bonus':
        sfx.bonus(e.kind)
        break
      case 'fall':
        // v3: al abismo, silbido que se aleja durante la caída; v2.3: dura hasta que el tanque se pierde
        // de vista, que es cuando llega la muerte con el golpe lejano (abyssLostAt)
        if (isAbyssFall(e, h)) sfx.abyssFall(abyssLostAt(e.from, h))
        else if (e.water) sfx.plunge(Math.abs(e.to - e.from)) // v4: cayó al agua, sin daño
        else if (e.parachute) sfx.parachute()
        else sfx.fall(Math.abs(e.to - e.from))
        break
      case 'slide': {
        // pulido v2: raspado mientras dura el recorrido (con golpe seco al empezar si fue un empuje); la
        // caída que puede seguir llega como fall al aterrizar y suena como siempre
        const path = e.path
        let dist = 0
        for (let i = 1; i < path.length; i++) dist += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
        if (path.length > 1) sfx.slide((path.length - 1) * PATH_DT, dist, e.cause === 'blast' ? 'blast' : 'slope') // v3 stub: ice/pull/quake suenan como slope
        break
      }
      case 'death':
        // perdido en el abismo: golpe lejano, sin la explosión del tanque
        if (e.cause === 'abyss') sfx.abyssThud()
        else sfx.death()
        break
      case 'damage':
        if (e.cause === 'lava') sfx.lavaBurn()
        else if (e.cause === 'collapse') sfx.crush() // v2.4: aplastado por un derrumbe
        break
      case 'collapse': {
        // v2.4: rumor de tierra y piedras mientras dura el derrumbe, más fuerte cuanto más cayó
        const info = session.flowInfo(e)
        if (e.cells > 0 || (info && info.solid > 0)) sfx.collapse(info?.dur ?? e.dt * Math.max(0, e.patches.length - 1), Math.max(e.cells, info?.solid ?? 0))
        break
      }
      case 'flow': {
        // v4: líquido corriendo mientras dura el flujo; grave y burbujeante si lo que más se movió es lava
        const info = session.flowInfo(e)
        if (info && info.water + info.lava > 0) sfx.flow(info.dur, info.water + info.lava, info.lava > info.water)
        break
      }
      case 'steam':
        sfx.steam(e.n)
        break
      case 'lava':
        sfx.lavaRise(e.from == null ? 1.4 : 1)
        break
      case 'empty':
        sfx.empty()
        break
      case 'shield':
        sfx.shieldHit(e.left)
        break
      case 'item':
        if (e.item === 'shield') sfx.shieldOn()
        else if (e.item === 'anchor' || e.item === 'deflector') sfx.itemOn(e.item)
        // v3: jetpack y teletransporte suenan con su propio evento (jetpack / teleport)
        else if (e.item !== 'jetpack' && e.item !== 'teleport') sfx.click()
        break
      case 'roundover':
        sfx.roundEnd()
        break
    }
  }
}

// Pantallas entre turnos y rondas, según la fase de la partida.
function flow(): void {
  const s = session.state
  // online la fase puede cambiar por el anfitrión con una pantalla abierta
  if (s && online) {
    if ((overlay === 'score' && s.phase !== 'roundover') || (overlay === 'shop' && s.phase !== 'shop')) closeOverlay()
    else if (overlay === 'shop' && shopFor != null && s !== shopState) {
      shopState = s
      const m = session.shopModel(shopFor)
      if (m) shop.update(m)
    }
  }
  if (!s || overlay !== 'none' || session.busy) return
  if (session.isDemo) {
    // demo sin congelar: la partida entre IAs sigue con otra seed
    if (s.phase === 'gameover' && !demo?.freeze && session.finishedFor > 3 && session.config) {
      session.start({ ...session.config, seed: ((session.config.seed ?? 1) + 1) >>> 0 }, { freeze: false })
      lastWind = null
    }
    return
  }
  switch (s.phase) {
    case 'aiming': {
      const model = session.bannerModel()
      if (!model) return
      overlay = 'banner'
      sfx.engine(false)
      sfx.banner()
      banner.show(model, () => {
        if (overlay !== 'banner') return
        session.ackBanner()
        closeOverlay()
      })
      return
    }
    case 'roundover': {
      if (session.finishedFor < 1.4 || session.awaitingHost) return
      // la última ronda va directo a la tabla final
      if (s.round >= s.rounds) {
        session.nextRound()
        return
      }
      const model = session.scoreModel()
      if (!model) return
      overlay = 'score'
      sfx.engine(false)
      scoreboard.show(
        model,
        () => {
          if (overlay !== 'score') return
          sfx.click()
          closeOverlay()
          session.nextRound()
        },
        () => {
          if (overlay !== 'score') return
          sfx.click()
          toMenu()
        },
      )
      return
    }
    case 'shop': {
      const next = session.shopQueue()[0]
      if (next) openShop(next.id)
      return
    }
    case 'gameover': {
      if (session.finishedFor < 1.4) return
      const model = session.scoreModel()
      if (!model) return
      overlay = 'final'
      sfx.engine(false)
      if (model.winnerId != null) sfx.champion()
      else sfx.roundEnd()
      scoreboard.show(
        { ...model, final: true },
        () => {
          if (overlay !== 'final') return
          sfx.click()
          // online la revancha se arma de nuevo desde el lobby
          if (online) {
            const role = online.role
            toMenu()
            if (role === 'host') openHost()
            else showOnlineMenu()
            return
          }
          begin(lastConfig)
        },
        () => {
          if (overlay !== 'final') return
          sfx.click()
          toMenu()
        },
      )
      return
    }
  }
}

function openShop(playerId: number): void {
  const model = session.shopModel(playerId)
  if (!model) return
  overlay = 'shop'
  shopFor = playerId
  shopState = session.state
  sfx.engine(false)
  const refresh = () => {
    const m = session.shopModel(playerId)
    if (m && shopFor === playerId) shop.update(m)
  }
  shop.show(model, {
    buy: (id) => {
      if (shopFor !== playerId) return
      if (session.buy(playerId, id)) sfx.buy()
      else sfx.empty()
      refresh()
    },
    sell: (id) => {
      if (shopFor !== playerId) return
      if (session.sell(playerId, id)) sfx.sell()
      else sfx.empty()
      refresh()
    },
    ready: () => {
      if (shopFor !== playerId) return
      sfx.click()
      closeOverlay()
      session.ready(playerId)
    },
  })
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Math.round(Number(raw))
  return Math.max(lo, Math.min(hi, raw != null && Number.isFinite(n) && n > 0 ? n : fallback))
}

function must<T>(value: T | null): T {
  if (value == null) throw new Error('Falta el markup del juego')
  return value
}
