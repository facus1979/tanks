// Página de prueba de las vistas: ?uitest=online|lobby|title|menu|banner|score|final|shop|hud con modelos falsos.
// index.html la carga solo si la query trae uitest; main.ts puede llamar mountUiTest(name) si prefiere.
import { BEDROCK, BRICK, DIRT, ITEM_ORDER, MAP_SIZES, SHOP, STONE, WOOD, type MapSize, type ShopId, type Terrain } from '../sim/types'
import { loadUiAssets } from './assets'
import { Hud } from './hud'
import { refreshLabels } from './kit'
import { createBannerView } from './banner'
import { createLobbyView } from './lobby'
import { createMenuView } from './menu'
import { createOnlineMenuView } from './online'
import { createScoreboardView } from './scoreboard'
import { createShopView } from './shop'
import { createTitleView } from './title'
import type { LobbyModel, MinimapModel, ScoreModel, ShopModel } from './types'

const ROWS = [
  { id: 0, name: 'BANDANA', color: 0x3d8cf0, crew: 'bandana' as const, alive: true, roundsWon: 2, kills: 3, earned: 1150, money: 1750 },
  { id: 1, name: 'SARGENTO', color: 0xe23d3d, crew: 'sarge' as const, alive: false, roundsWon: 1, kills: 1, earned: 420, money: 900 },
  { id: 2, name: 'NOVATO', color: 0xe2c13d, crew: 'rookie' as const, alive: false, roundsWon: 0, kills: 0, earned: 80, money: 300 },
]

function shopModel(money: number, owned: Record<string, number>): ShopModel {
  return {
    playerId: 0,
    name: 'Bandana',
    color: 0x3d8cf0,
    crew: 'bandana',
    money,
    round: 2,
    rounds: 3,
    rows: SHOP.map((s) => ({
      ...s,
      owned: owned[s.id] ?? 0,
      canBuy: money >= s.price && (owned[s.id] ?? 0) + s.qty <= s.max,
      canSell: (owned[s.id] ?? 0) >= s.qty,
    })),
  }
}

const params = new URLSearchParams(location.search)

function lobbyModel(role: 'host' | 'client'): LobbyModel {
  const host = role === 'host'
  return {
    role,
    link: 'http://localhost:5173/?join=TANK-4F7K',
    mySlot: host ? 0 : null,
    status: 'ESPERANDO JUGADORES',
    canStart: false,
    lobby: {
      code: 'TANK-4F7K',
      rounds: 3,
      difficulty: 'normal',
      biome: 'rotate',
      turnSeconds: 45,
      // sin &size= el lobby no trae size (como un anfitrión anterior a v2): se ve CHICO
      ...(params.get('size') ? { size: params.get('size') as MapSize } : {}),
      slots: [
        { kind: 'human', name: 'Facu', crew: 'bandana', owner: 'host', connected: true },
        { kind: 'human', name: 'Sargento', crew: 'sarge', owner: 'peer1', connected: true },
        { kind: 'human', name: '', crew: 'rookie', owner: null, connected: false },
        { kind: 'ai', name: 'IA', crew: 'desert', owner: null, connected: true },
      ],
    },
  }
}

export async function mountUiTest(name: string): Promise<boolean> {
  const forced = Number(new URLSearchParams(location.search).get('s'))
  if (forced) (window as unknown as { __uiScale?: number }).__uiScale = forced
  await loadUiAssets()
  refreshLabels()
  if (name === 'title') createTitleView().show(() => console.log('start'))
  else if (name === 'menu') createMenuView().show(null, (c) => console.log('play', JSON.stringify(c)))
  else if (name === 'banner') createBannerView().show({ name: 'Sargento', color: 0xe23d3d, crew: 'sarge', round: 2, rounds: 3 }, () => console.log('go'))
  else if (name === 'score' || name === 'final') {
    const model: ScoreModel = { round: 3, rounds: 3, roundWinnerId: 0, final: name === 'final', winnerId: 0, rows: ROWS }
    createScoreboardView().show(model, () => console.log('continue'), () => console.log('menu'))
  } else if (name === 'shop') {
    let money = 1250
    const owned: Record<string, number> = { heavy: 2, shield: 1 }
    const view = createShopView()
    const change = (id: ShopId, dir: number) => {
      const s = SHOP.find((e) => e.id === id)
      if (!s) return
      money -= s.price * dir
      owned[id] = (owned[id] ?? 0) + s.qty * dir
      view.update(shopModel(money, owned))
    }
    view.show(shopModel(money, owned), { buy: (id) => change(id, 1), sell: (id) => change(id, -1), ready: () => console.log('ready') })
  } else if (name === 'hud') {
    document.body.style.background = '#2a3a34'
    const root = document.createElement('div')
    root.id = 'hud'
    root.style.cssText = 'position:fixed;z-index:20'
    document.body.append(root)
    const hud = new Hud(root)
    const items = Object.fromEntries(ITEM_ORDER.map((id, i) => [id, i % 3])) as Record<(typeof ITEM_ORDER)[number], number>
    // escala entera que entre en la ventana, como el juego
    const k = Math.max(1, Math.floor(Math.min(innerWidth / 800, innerHeight / 450)))
    hud.place({ x: Math.round((innerWidth - 800 * k) / 2), y: Math.round((innerHeight - 450 * k) / 2), w: 800 * k, h: 450 * k } as never)
    // ?uitest=hud usa un minimapa falso de mapa Grande; &size=medium|small lo cambia (small = sin minimapa)
    const size = (params.get('size') ?? 'large') as MapSize
    const minimap = size in MAP_SIZES && size !== 'small' ? fakeMinimap(size) : null
    // v2 muerte súbita: &sd=N muestra "MUERTE SÚBITA EN N" (calmLeft = N); &sd=lava la muestra activa
    // con la banda de lava en el minimapa, 80 px de mundo sobre el fondo. &status=TEXTO prueba la convivencia.
    const sdParam = params.get('sd')
    const suddenDeath = sdParam == null ? null : sdParam === 'lava' ? { active: true, calmLeft: 0 } : { active: false, calmLeft: Number(sdParam) || 0 }
    if (minimap && suddenDeath?.active) minimap.lava = MAP_SIZES[size].h - 80
    const side = (n: number, name: string, color: number, crew: 'bandana' | 'sarge') => ({ name, tag: `P${n}`, color, crew, hp: 80, alive: true, active: n === 1, you: n === 1 })
    const model: Parameters<Hud['update']>[0] = {
      human: side(1, 'Bandana', 0x3d8cf0, 'bandana'),
      rival: side(2, 'Sargento', 0xe23d3d, 'sarge'),
      others: [],
      angle: 45,
      power: 60,
      weapon: 'heavy',
      ammo: 2,
      wind: 4,
      status: params.get('status') ?? '',
      showAim: true,
      ammoAll: { normal: 99, heavy: 2, dirt: 3, cluster: 0, napalm: 2, digger: 2, roller: 2, nuke: 1 },
      fuel: 0.7,
      showBar: true,
      extras: {
        round: 2,
        rounds: 3,
        money: 1250,
        items,
        shield: 25,
        tracer: true,
        net: params.has('net')
          ? { role: 'host', code: 'TANK-4F7K', peers: [{ name: 'Sargento', connected: true, ping: 48 }, { name: 'Novato', connected: false, ping: null }], turnLeft: Number(params.get('net')) || 27, waiting: 'ESPERANDO A SARGENTO…' }
          : null,
        minimap,
        suddenDeath,
      },
    }
    // el flujo llama a update en cada frame; acá también, para ver el titileo del turno
    const tick = () => {
      hud.update(model)
      requestAnimationFrame(tick)
    }
    tick()
    root.addEventListener('pointerdown', (e) => console.log('minimapAt', JSON.stringify(hud.minimapAt(e.clientX, e.clientY))))
  } else if (name === 'online') {
    const view = createOnlineMenuView()
    const handlers = { host: () => console.log('host'), join: (c: string) => { console.log('join', c); view.error('SALA NO ENCONTRADA') }, back: () => console.log('back') }
    view.show(handlers, params.get('join') ?? undefined)
  } else if (name === 'lobby') {
    const view = createLobbyView()
    const model = lobbyModel(params.get('role') === 'client' ? 'client' : 'host')
    const push = (fn: (m: LobbyModel) => void) => {
      fn(model)
      view.update({ ...model, lobby: { ...model.lobby }, canStart: model.lobby.slots.filter((s) => s.kind !== 'off').length >= 2 })
    }
    view.show(model, {
      claim: (i) => push((m) => { m.lobby.slots[i] = { ...m.lobby.slots[i], owner: 'me', name: 'Yo', connected: true }; m.mySlot = i }),
      release: () => push((m) => { if (m.mySlot != null) m.lobby.slots[m.mySlot] = { ...m.lobby.slots[m.mySlot], owner: null, name: '' }; m.mySlot = null }),
      setSlot: (i, kind) => push((m) => { m.lobby.slots[i] = { ...m.lobby.slots[i], kind, owner: kind === 'human' ? null : null } }),
      setOption: (key, v) => push((m) => { (m.lobby as unknown as Record<string, unknown>)[key] = v }),
      start: () => console.log('start'),
      leave: () => console.log('leave'),
    })
  } else return false
  return true
}

const q = new URLSearchParams(location.search).get('uitest')
if (q) void mountUiTest(q)

// ---------- minimapa falso (v2) ----------

// Terreno inventado con relieve: meseta, montaña con cueva, búnker de ladrillo, torre, colinas y un cráter.
function fakeTerrain(w: number, h: number): Terrain {
  const front = new Uint8Array(w * h)
  const g = (x: number, c: number, s: number) => Math.exp(-(((x - c) / s) ** 2))
  const k = w / 2400 // los accidentes se reparten a lo ancho de cualquier tamaño
  const surf = (x: number) => {
    const u = x / k
    let y = 362 + Math.sin(u / 37) * 6 + Math.sin(u / 11) * 2
    y -= 225 * g(u, 790, 95) + 70 * g(u, 900, 40)
    if (u < 250) y = 330
    if (u >= 1150 && u < 1470) y = 300
    y -= 70 * g(u, 1960, 60) + 45 * g(u, 2130, 45)
    y += 40 * g(u, 466, 70) + 34 * g(u, 1683, 52)
    return Math.round(Math.max(110, Math.min(h - 30, y)))
  }
  const fill = (x0: number, y0: number, x1: number, y1: number, m: number) => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) front[y * w + x] = m
  }
  for (let x = 0; x < w; x++) fill(x, surf(x), x, h - 1, DIRT)
  fill(10, 330, Math.round(249 * k), 343, STONE)
  const mesa = (u: number) => Math.round(u * k)
  fill(mesa(1150), 300, mesa(1470) - 1, 307, STONE)
  fill(mesa(1240), 308, mesa(1240) + 150, 368, BRICK)
  fill(mesa(1240) + 10, 318, mesa(1240) + 140, 356, 0)
  fill(mesa(1360), 218, mesa(1360) + 58, 299, WOOD)
  fill(mesa(760) - 60, 380, mesa(760) + 60, 400, 0) // cueva
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - mesa(1878), y - (surf(mesa(1878)) + 3))
    if (d < 14 && front[y * w + x] === DIRT) front[y * w + x] = 0
  }
  fill(0, h - 6, w - 1, h - 1, BEDROCK)
  return { w, h, front, back: new Uint8Array(w * h) }
}

function fakeMinimap(size: MapSize): MinimapModel {
  const { w, h } = MAP_SIZES[size]
  const terrain = fakeTerrain(w, h)
  const floor = (x: number) => {
    let y = 0
    while (y < h - 1 && terrain.front[y * w + x] === 0) y++
    return y
  }
  const k = w / 2400
  const colors = [0x3d8cf0, 0xe23d3d, 0xe2c13d, 0x3dbe5a, 0xa65ae0, 0xf0903a]
  const xs = [130, 830, 1205, 1500, 1955, 2290].map((x) => Math.round(x * k))
  const view = { x: Math.round(1060 * k), y: 0, w: 800, h: 450 }
  const tanks = xs.map((x, id) => ({ id, x, y: floor(x), color: colors[id], alive: id !== 1, current: id === 2 }))
  return {
    terrain,
    terrainVersion: 1,
    view,
    tanks,
    projectiles: [{ x: view.x + 640, y: 92 }],
    lastImpacts: [{ playerId: 2, x: Math.round(1878 * k), y: floor(Math.round(1878 * k)), color: colors[2] }],
  }
}
