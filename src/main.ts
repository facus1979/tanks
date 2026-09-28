import { PixiRenderer } from './render/pixi/PixiRenderer'
import { Keyboard, weaponSlot } from './input/keyboard'
import { Sfx } from './audio/sfx'
import { Session } from './game/session'
import { Hud, WEAPON_SLOTS } from './ui/hud'
import { loadUiAssets } from './ui/assets'
import { Menu, ResultScreen, refreshLabels } from './ui/menu'
import { ANGLE_SPEED, BIOMES, POWER_SPEED, WEAPON_ORDER, type Biome, type WeaponId, type GameEvent, type MatchConfig } from './sim/types'

const stage = must(document.querySelector<HTMLElement>('#stage'))
const hudRoot = must(document.querySelector<HTMLElement>('#hud'))
const menuRoot = must(document.querySelector<HTMLElement>('#menu'))
const overlayRoot = must(document.querySelector<HTMLElement>('#overlay'))

const params = new URLSearchParams(location.search)
const demoParam = params.get('demo')
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

// ?play=<seed>: QA, entra directo a una partida humana contra 2 IAs sin pasar por el menú.
const playParam = demo ? null : params.get('play')

const renderer = new PixiRenderer()
const keys = new Keyboard()
const sfx = new Sfx()
const session = new Session()
const hud = new Hud(hudRoot)
const menu = new Menu(menuRoot, (config) => begin(config), () => sfx.click())
const result = new ResultScreen(overlayRoot, () => begin(lastConfig), () => toMenu(), () => sfx.click())

let mode: 'menu' | 'play' = 'menu'
let lastConfig: MatchConfig = { bots: 2, difficulty: 'normal', biome: 'forest' }
let lastWind: number | null = null
let resultShown = false

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
  if (mode !== 'play' || result.visible || !session.inputEnabled) return
  const weapon = hud.weaponAt(e.clientX, e.clientY)
  if (!weapon) return
  e.preventDefault()
  sfx.click()
  session.select(weapon)
})

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') sfx.toggleMute()
  if (e.code === 'Escape' && result.visible) toMenu()
})

menu.enabled = false
if (demo || playParam != null) menu.hide()
else menu.show()

// Sin top-level await: Pixi importa sus renderers en chunks que dependen de este
// módulo, y en el build eso deja el import dinámico esperando para siempre.
void renderer.mount(stage).then(() => {
  menu.enabled = true
  renderer.setLoop(tick)
  layout()
  window.addEventListener('resize', layout)
  if (demo) {
    session.start({ bots: 3, difficulty: 'hard', biome: demo.biome, seed: demo.seed }, { freeze: demo.freeze, weapon: demo.weapon })
    enterPlay()
    if (demo.freeze) fastForward()
    else if (demo.ff > 0) fastForwardFor(demo.ff)
  } else if (playParam != null) {
    const biome = (BIOMES as string[]).includes(params.get('biome') ?? '') ? (params.get('biome') as Biome) : 'forest'
    begin({ bots: 2, difficulty: 'normal', biome, seed: (Number(playParam) >>> 0) || 1 })
  }
})

function begin(config: MatchConfig): void {
  lastConfig = config
  session.start(config)
  sfx.unlock()
  enterPlay()
}

function enterPlay(): void {
  mode = 'play'
  resultShown = false
  lastWind = null
  menu.hide()
  result.hide()
  stage.hidden = false
  hud.show()
  hud.invalidate()
  keys.capture = true
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  keys.consumePressed()
  layout()
}

function toMenu(): void {
  mode = 'menu'
  sfx.engine(false)
  result.hide()
  hud.hide()
  stage.hidden = true
  keys.capture = false
  menu.show()
}

function layout(): void {
  const vp = renderer.resize()
  hud.place(vp)
  refreshLabels()
}

// Demo congelado: corre la partida a paso fijo hasta el congelamiento sin esperar frames reales.
// En Chrome headless los frames llegan muy espaciados y la captura saldría antes del tiro.
function fastForward(): void {
  const step = 1 / 60
  for (let i = 0; i < 60 * 30 && !session.isFrozen; i++) step1(step, false)
}

// Demo sin congelar: el ticker de Pixi casi no avanza con --virtual-time-budget.
function fastForwardFor(seconds: number): void {
  const step = 1 / 60
  for (let i = 0; i < Math.round(seconds * 60); i++) step1(step, false)
}

function tick(rawDt: number): void {
  step1(Math.min(0.05, Math.max(0, rawDt)), true)
}

function step1(dt: number, live: boolean): void {
  if (mode !== 'play') return
  if (live) handleInput(dt)
  session.update(dt)

  for (const shot of session.pullShots()) sfx.fire(shot.weapon)
  sfx.engine(live && session.moving)
  const frame = session.frame()
  if (!frame) return
  const events = session.pullFx()
  playSounds(events)
  if (frame.wind !== lastWind) {
    lastWind = frame.wind
    sfx.setWind(frame.wind)
  }
  renderer.render(frame, events, dt)
  const model = session.hud()
  if (model) hud.update(model)
  checkEnd()
}

function handleInput(dt: number): void {
  const pressed = keys.consumePressed()
  if (!session.inputEnabled || result.visible) return
  let dAngle = 0
  let dPower = 0
  if (keys.isDown('ArrowLeft')) dAngle += ANGLE_SPEED * dt
  if (keys.isDown('ArrowRight')) dAngle -= ANGLE_SPEED * dt
  if (keys.isDown('ArrowUp')) dPower += POWER_SPEED * dt
  if (keys.isDown('ArrowDown')) dPower -= POWER_SPEED * dt
  session.nudge(dAngle, dPower)
  const left = keys.isDown('KeyA')
  const right = keys.isDown('KeyD')
  if (left !== right) session.move(left ? -1 : 1, dt)
  else session.stopMove()
  const slot = weaponSlot(pressed)
  if (slot >= 0 && slot < WEAPON_SLOTS.length) {
    sfx.click()
    session.select(WEAPON_SLOTS[slot])
  }
  if (pressed.has('Space')) session.fire()
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
        sfx.fall(Math.abs(e.to - e.from))
        break
      case 'death':
        sfx.death()
        break
      case 'empty':
        sfx.empty()
        break
    }
  }
}

function checkEnd(): void {
  const s = session.state
  if (!s || s.phase !== 'gameover' || session.busy) return
  if (session.isDemo) {
    // demo sin congelar: la partida entre IAs sigue con otra seed
    if (!demo?.freeze && session.finishedFor > 3 && session.config) {
      session.start({ ...session.config, seed: ((session.config.seed ?? 1) + 1) >>> 0 }, { freeze: false })
      lastWind = null
    }
    return
  }
  if (resultShown || session.finishedFor < 1.4) return
  resultShown = true
  keys.capture = false
  const winner = session.winner()
  result.show({
    title: session.resultText(),
    winner: winner ? { crew: winner.crew, color: winner.color, name: winner.name } : null,
  })
}

function must<T>(value: T | null): T {
  if (value == null) throw new Error('Falta el markup del juego')
  return value
}
