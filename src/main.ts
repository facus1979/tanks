import { PixiRenderer } from './render/pixi/PixiRenderer'
import { Keyboard, weaponSlot } from './input/keyboard'
import { Gamepad, type PadState } from './input/gamepad'
import { TouchControls, fullscreenButton, isTouchDevice, vibrate } from './input/touch'
import { Sfx } from './audio/sfx'
import { Session } from './game/session'
import type { NetSeat } from './game/session'
import { Online } from './game/online'
import { normalizeCode, readNetParams } from './net'
import { createOnlineMenuView } from './ui/online'
import { createLobbyView } from './ui/lobby'
import { Hud, WEAPON_SLOTS } from './ui/hud'
import { loadUiAssets } from './ui/assets'
import { createMenuView, refreshLabels } from './ui/menu'
import { createTitleView } from './ui/title'
import { createBannerView } from './ui/banner'
import { createScoreboardView } from './ui/scoreboard'
import { createShopView } from './ui/shop'
import { DEFAULT_CONFIG } from './ui/types'
import { chooseShot } from './sim'
import {
  ANGLE_SPEED,
  BIOMES,
  POWER_SPEED,
  WEAPON_ORDER,
  type Biome,
  type GameEvent,
  type ItemId,
  type MatchConfig,
  type SlotConfig,
  type WeaponId,
} from './sim/types'

const stage = must(document.querySelector<HTMLElement>('#stage'))
const hudRoot = must(document.querySelector<HTMLElement>('#hud'))

const params = new URLSearchParams(location.search)
const uitest = params.get('uitest')
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
// &humans=N (hot-seat), &bots=N, &rounds=N.
const playParam = demo || uitest ? null : params.get('play')
// &aisync=1: QA, la IA calcula en el hilo principal (para comparar contra el worker)
const aiSync = params.get('aisync') === '1'
// Online: ?host=1, ?join=CODIGO, ?net=local, ?autotest=1 (scripts/net-test.mjs)
const net = readNetParams()
const netStart = demo || uitest || playParam != null ? null : net.host ? 'host' : net.join ? 'join' : null
// autotest: cada humano apunta con la IA difícil, así la partida de prueba termina rápido
const AUTO_SHOT = { delay: 0.8 }

const ITEM_KEYS: Record<string, ItemId> = { KeyQ: 'shield', KeyF: 'fuel', KeyR: 'repair', KeyT: 'tracer' }

const renderer = new PixiRenderer()
const keys = new Keyboard()
const pad = new Gamepad()
const touch = new TouchControls(stage)
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

void loadUiAssets().then(() => {
  refreshLabels()
  hud.invalidate()
})

// El audio solo arranca con un gesto del usuario.
const unlock = () => sfx.unlock()
window.addEventListener('pointerdown', unlock)
window.addEventListener('keydown', unlock)

// Click en el selector de armas del HUD.
window.addEventListener('pointerdown', (e) => {
  if (screen !== 'play' || overlay !== 'none' || paused || !session.inputEnabled) return
  const weapon = hud.weaponAt(e.clientX, e.clientY)
  if (!weapon) return
  e.preventDefault()
  sfx.click()
  session.select(weapon)
})

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') sfx.toggleMute()
})

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
      session.start({ slots, rounds: 1, difficulty: 'hard', biome: demo.biome, seed: demo.seed }, { freeze: demo.freeze, weapon: demo.weapon })
      enterPlay()
      if (demo.freeze) fastForward()
      else if (demo.ff > 0) fastForwardFor(demo.ff)
    } else if (playParam != null) {
      const biome = (BIOMES as string[]).includes(params.get('biome') ?? '') ? (params.get('biome') as Biome) : 'forest'
      const humans = clampInt(params.get('humans'), 1, 1, 4)
      const bots = clampInt(params.get('bots'), 2, humans > 1 ? 0 : 1, 4 - humans)
      const slots: SlotConfig[] = []
      for (let i = 0; i < humans; i++) slots.push({ kind: 'human' })
      for (let i = 0; i < bots; i++) slots.push({ kind: 'ai' })
      begin({ slots, rounds: clampInt(params.get('rounds'), 1, 1, 10), difficulty: 'normal', biome, seed: (Number(playParam) >>> 0) || 1 })
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
  menu.show(lastConfig, (config) => {
    if (screen !== 'menu') return
    sfx.click()
    menu.hide()
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

// autotest: 2 humanos (anfitrión + un cliente) y 1 IA, 1 ronda; arranca cuando el cliente tomó su casillero.
let autotestBusy = false
function autotestLobby(room: Online): void {
  const lobby = room.lobby
  if (autotestBusy || !lobby || room.started || !room.code) return
  autotestBusy = true
  try {
    if (lobby.slots[1]?.kind !== 'human') room.setSlot(1, 'human')
    if (lobby.slots[2]?.kind !== 'ai') room.setSlot(2, 'ai')
    if (lobby.slots[3]?.kind !== 'off') room.setSlot(3, 'off')
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
  hud.place(vp)
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
    if (!paused) handleInput(dt, pressed, padState)
  }
  if (paused) {
    const frame = session.frame()
    if (frame) renderer.render(frame, [], 0)
    const model = session.hud()
    if (model) hud.update({ ...model, status: 'Pausa' })
    return
  }
  session.update(dt)
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
  sfx.engine(live && session.moving)
  if (!draw) {
    session.pullFx()
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
    pressed: new Set([...a.pressed, ...b.pressed]),
  }
}

function handleInput(dt: number, pressed: Set<string>, padState: ReturnType<Gamepad['poll']> | null): void {
  if (!session.inputEnabled) return
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
  session.nudge(dAngle, dPower)
  const drag = touch.dragAim()
  if (drag) session.aimTo(drag.angle, drag.power)
  const left = keys.isDown('KeyA') || padState?.move === -1
  const right = keys.isDown('KeyD') || padState?.move === 1
  if (left !== right) session.move(left ? -1 : 1, dt)
  else session.stopMove()
  const slot = weaponSlot(pressed)
  if (slot >= 0 && slot < WEAPON_SLOTS.length) {
    sfx.click()
    session.select(WEAPON_SLOTS[slot])
  }
  if (padState?.pressed.has('prevWeapon') || padState?.pressed.has('nextWeapon')) {
    sfx.click()
    session.cycleWeapon(padState.pressed.has('prevWeapon') ? -1 : 1, WEAPON_SLOTS)
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

function playSounds(events: GameEvent[]): void {
  for (const e of events) {
    switch (e.type) {
      case 'impact':
        if (e.source === 'barrel') break // el evento prop del barril ya suena
        if (e.weapon === 'cluster') sfx.bomblet(e.radius, e.debris)
        else sfx.boom(e.blast, e.radius, e.debris)
        break
      case 'burn':
        sfx.burn(e.w)
        break
      case 'prop':
        if (e.destroyed && e.kind === 'barrel') sfx.barrel()
        break
      case 'fall':
        if (e.parachute) sfx.parachute()
        else sfx.fall(Math.abs(e.to - e.from))
        break
      case 'death':
        sfx.death()
        break
      case 'empty':
        sfx.empty()
        break
      case 'shield':
        sfx.shieldHit(e.left)
        break
      case 'item':
        if (e.item === 'shield') sfx.shieldOn()
        else sfx.click()
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
