// Página de prueba de las vistas: ?uitest=online|lobby|title|menu|banner|score|final|shop|hud con modelos falsos.
// v3: ?uitest=hud muestra la barra de 16 armas (&weapon=<WeaponId> elige una; &guide=S la barra de guiado con
// S segundos; &aim=jetpack|teleport la ayuda de destino), ?uitest=shop la tienda con las 8 armas y 4 ítems nuevos
// (si SHOP todavía no los trae, con precios de prueba), ?uitest=profile el menú con nombres, colores elegidos y
// personalidades, y ?uitest=lobby la sala con colores y personalidades (&keys=ArrowLeft,Space edita el nombre).
// index.html la carga solo si la query trae uitest; main.ts puede llamar mountUiTest(name) si prefiere.
import { BEDROCK, BRICK, CREWS, DIRT, GUIDE_TIME, ITEM_ORDER, WEAPONS, WEAPON_ORDER, type ItemId, type ShopEntry, MAP_SIZES, MAX_PLAYERS_BY_SIZE, SHOP, STONE, TANK_COLORS, WOOD, type MapSize, type MatchConfig, type ShopId, type Terrain, type WeaponId } from '../sim/types'
import { loadUiAssets } from './assets'
import { Hud } from './hud'
import { refreshLabels } from './kit'
import { createBannerView } from './banner'
import { createLobbyView } from './lobby'
import { compactSlots, createMenuView } from './menu'
import type { LobbySlot } from '../net/types'
import { createOnlineMenuView } from './online'
import { createScoreboardView } from './scoreboard'
import { createShopView } from './shop'
import { createTitleView } from './title'
import type { LobbyModel, MinimapModel, ScoreModel, ShopModel } from './types'

// v5: hasta 8 filas (&players=N, por defecto 8) con los tripulantes y colores nuevos
const ALL_ROWS = [
  { id: 0, name: 'BANDANA', color: 0x3d8cf0, crew: 'bandana' as const, alive: true, roundsWon: 2, kills: 3, earned: 1150, money: 1750 },
  { id: 1, name: 'SARGENTO', color: 0xe23d3d, crew: 'sarge' as const, alive: false, roundsWon: 1, kills: 1, earned: 420, money: 900 },
  { id: 2, name: 'NOVATO', color: 0xe2c13d, crew: 'rookie' as const, alive: false, roundsWon: 0, kills: 0, earned: 80, money: 300 },
  { id: 3, name: 'DESIERTO', color: 0x3dbe5a, crew: 'desert' as const, alive: true, roundsWon: 1, kills: 2, earned: 640, money: 1210 },
  { id: 4, name: 'COMANDO', color: 0xa65ae0, crew: 'commando' as const, alive: false, roundsWon: 0, kills: 1, earned: 260, money: 540 },
  { id: 5, name: 'TANQUISTA', color: 0xf0903a, crew: 'goggles' as const, alive: true, roundsWon: 0, kills: 0, earned: 150, money: 420 },
  { id: 6, name: 'PILOTO', color: 0x3ad0c8, crew: 'pilot' as const, alive: false, roundsWon: 0, kills: 2, earned: 330, money: 610 },
  { id: 7, name: 'CORONEL', color: 0xe85aa0, crew: 'colonel' as const, alive: false, roundsWon: 0, kills: 0, earned: 0, money: 150 },
]

// Cartel y tienda: &p=N (1..8) elige el jugador de ALL_ROWS; por defecto P5 (Comando, violeta), uno de los nuevos.
function who(): (typeof ALL_ROWS)[number] {
  const p = Number(new URLSearchParams(location.search).get('p')) || 5
  return ALL_ROWS[Math.max(1, Math.min(8, p)) - 1]
}

// v3: la tienda completa. Si SHOP todavía no trae las armas e ítems nuevos (los agrega sim-armas en paralelo),
// se completan acá con precios de prueba, para ver las tres columnas llenas.
const TEST_PRICES: Partial<Record<ShopId, [number, number, number]>> = {
  guided: [450, 1, 3], bouncer: [260, 2, 9], laser: [380, 1, 5], mine: [200, 2, 6], quake: [500, 1, 3], blackhole: [650, 1, 2], acid: [320, 2, 6], wall: [140, 2, 9],
  jetpack: [200, 1, 3], teleport: [400, 1, 2], anchor: [150, 1, 3], deflector: [300, 1, 3],
}
const ITEM_TEST_NAMES: Record<ItemId, string> = { shield: 'Escudo', parachute: 'Paracaídas', fuel: 'Combustible', repair: 'Reparación', tracer: 'Trazador', jetpack: 'Jetpack', teleport: 'Teletransporte', anchor: 'Ancla', deflector: 'Deflector' }
const FULL_SHOP: ShopEntry[] = [
  ...SHOP,
  ...[...WEAPON_ORDER.filter((id) => id !== 'normal'), ...ITEM_ORDER]
    .filter((id) => !SHOP.some((s) => s.id === id) && TEST_PRICES[id])
    .map((id): ShopEntry => {
      const [price, qty, max] = TEST_PRICES[id] ?? [100, 1, 3]
      const item = (ITEM_ORDER as string[]).includes(id)
      return { id, kind: item ? 'item' : 'weapon', name: item ? ITEM_TEST_NAMES[id as ItemId] : WEAPONS[id as WeaponId].name, price, qty, max }
    }),
]

function shopModel(money: number, owned: Record<string, number>): ShopModel {
  const w = who()
  return {
    playerId: w.id,
    name: w.name.charAt(0) + w.name.slice(1).toLowerCase(),
    color: w.color,
    crew: w.crew,
    money,
    round: 2,
    rounds: 3,
    rows: FULL_SHOP.map((s) => ({
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
      // v5: siempre 8 casilleros; &size= decide cuántos están habilitados (Chico 4, Mediano 6, Grande 8)
      slots: [
        // v3: colores elegidos (no por índice) y personalidades de las IA
        { kind: 'human', name: 'Facu', crew: 'bandana', color: 4, owner: 'host', connected: true },
        { kind: 'human', name: 'Sargento', crew: 'sarge', color: 1, owner: 'peer1', connected: true },
        { kind: 'human', name: '', crew: 'rookie', color: 2, owner: null, connected: false },
        { kind: 'ai', name: 'IA', crew: 'desert', color: 3, personality: 'sniper', owner: null, connected: true },
        { kind: 'human', name: 'Coman2', crew: 'commando', color: 0, owner: 'peer2', connected: false },
        { kind: 'ai', name: 'IA', crew: 'goggles', color: 5, owner: null, connected: true },
        { kind: 'off', name: '', crew: 'pilot', color: 6, owner: null, connected: false },
        { kind: 'ai', name: 'IA', crew: 'colonel', color: 7, personality: 'digger', owner: null, connected: true },
      ],
    },
  }
}

export async function mountUiTest(name: string): Promise<boolean> {
  const forced = Number(new URLSearchParams(location.search).get('s'))
  if (forced) (window as unknown as { __uiScale?: number }).__uiScale = forced
  // &touch=1 simula un dispositivo táctil (la clase que pone TouchControls en el juego)
  if (params.has('touch')) document.documentElement.classList.add('touch')
  await loadUiAssets()
  refreshLabels()
  if (name === 'title') createTitleView().show(() => console.log('start'))
  else if (name === 'menu' || name === 'profile') {
    // v5: &players=N (2..8) arma una config de N casilleros (P1 humano, el resto IA, P3 con nombre) en el mapa
    // de &size= (por defecto grande); sin &players usa la config guardada o la de fábrica, como el juego.
    const n = Number(params.get('players'))
    // v3 ?uitest=profile: dos humanos con nombre propio y colores elegidos, e IA con personalidades
    const initial: MatchConfig | null = name === 'profile'
      ? {
          slots: [
            { kind: 'human', name: 'FACU', crew: 'pilot', color: 5 },
            { kind: 'human', name: 'LA ROJA!', crew: 'commando', color: 1 },
            { kind: 'ai', crew: 'colonel', color: 0, personality: 'aggressive' },
            { kind: 'ai', crew: 'goggles', color: 7, personality: 'sniper' },
            { kind: 'ai', crew: 'desert', color: 3, personality: 'digger' },
            { kind: 'ai', crew: 'sarge', color: 6, personality: 'opportunist' },
            { kind: 'ai', crew: 'rookie', color: 2 },
          ],
          rounds: 3,
          difficulty: 'normal',
          biome: 'rotate',
          size: 'large',
        }
      : n
      ? {
          slots: Array.from({ length: Math.max(2, Math.min(8, n)) }, (_, i) => ({ kind: i === 0 ? ('human' as const) : ('ai' as const), crew: CREWS[i], ...(i === 2 ? { name: 'RULO' } : {}) })),
          rounds: 3,
          difficulty: 'normal',
          biome: 'rotate',
          size: (params.get('size') as MapSize) ?? 'large',
        }
      : null
    createMenuView().show(initial, (c) => console.log('play', JSON.stringify(c)))
    // &pick=small (o cualquier data-key de un botón de opción) lo toca después de abrir: prueba achicar el mapa.
    // v2.3: &pick=small,large toca varios en orden (achicar y volver a agrandar), y &pre=teclas manda teclas
    // antes de tocarlos (por ejemplo, vaciar casilleros para probar la compactación con huecos).
    pressKeys('pre')
    for (const pick of (params.get('pick') ?? '').split(',').filter(Boolean)) document.querySelector<HTMLButtonElement>(`#menu-view [data-key="${pick}"]`)?.click()
    pressKeys()
  }
  else if (name === 'banner') {
    const w = who()
    createBannerView().show({ name: w.name, color: w.color, crew: w.crew, round: 2, rounds: 3 }, () => console.log('go'))
  }
  else if (name === 'score' || name === 'final') {
    const n = Math.max(2, Math.min(8, Number(params.get('players')) || 8))
    const model: ScoreModel = { round: 3, rounds: 3, roundWinnerId: 0, final: name === 'final', winnerId: 0, rows: ALL_ROWS.slice(0, n) }
    createScoreboardView().show(model, () => console.log('continue'), () => console.log('menu'))
  } else if (name === 'shop') {
    let money = 1250
    const owned: Record<string, number> = { heavy: 2, shield: 1 }
    const view = createShopView()
    const change = (id: ShopId, dir: number) => {
      const s = FULL_SHOP.find((e) => e.id === id)
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
    // v2.3: el minimapa usa los mismos N tanques de las placas; &view=start|end corre la vista a una punta
    const nTanks = Math.max(2, Math.min(8, Number(params.get('players')) || 2))
    // &turn=ai le da el turno a P2; &turn=N (v2.3), a PN (si existe)
    const turnRaw = params.get('turn')
    const turnN = turnRaw === 'ai' ? 2 : Math.max(1, Math.min(nTanks, Number(turnRaw) || 1))
    const minimap = size in MAP_SIZES && size !== 'small' ? fakeMinimap(size, nTanks, turnN - 1, params.get('view')) : null
    // v2 muerte súbita: &sd=N muestra "MUERTE SÚBITA EN N" (calmLeft = N); &sd=lava la muestra activa
    // con la banda de lava en el minimapa, 80 px de mundo sobre el fondo. &status=TEXTO prueba la convivencia.
    const sdParam = params.get('sd')
    const suddenDeath = sdParam == null ? null : sdParam === 'lava' ? { active: true, calmLeft: 0 } : { active: false, calmLeft: Number(sdParam) || 0 }
    if (minimap && suddenDeath?.active) minimap.lava = MAP_SIZES[size].h - 80
    // HUD C: &players=N (2..8) arma N tanques (placas apiladas arriba a la derecha); &turn=ai le da el turno
    // al rival (el tablero muestra sus datos y los controles quedan inactivos); &fine=1 prueba las décimas.
    // v5: los 8 tripulantes y colores del contrato
    const crews = CREWS
    const names = ['Bandana', 'Sargento', 'Novato', 'Desierto', 'Comando', 'Tanquista', 'Piloto', 'Coronel']
    const colors = TANK_COLORS
    const nPlayers = Math.max(2, Math.min(8, Number(params.get('players')) || 2))
    const aiTurn = turnN !== 1
    const turn = turnN
    const side = (n: number) => ({ name: names[n - 1], tag: `P${n}`, color: colors[n - 1], crew: crews[n - 1], hp: [80, 100, 45, 20, 60, 0, 100, 35][n - 1], alive: n !== 6, active: n === turn, you: n === 1 })
    const fineAim = params.has('fine')
    const model: Parameters<Hud['update']>[0] = {
      human: side(1),
      rival: side(2),
      others: Array.from({ length: nPlayers - 2 }, (_, i) => side(i + 3)),
      angle: fineAim ? 135.5 : aiTurn ? 140 : 45,
      power: fineAim ? 100 : 60,
      weapon: 'heavy',
      ammo: 2,
      wind: Number(params.get('wind') ?? 4),
      status: params.get('status') ?? (aiTurn ? `${names[turn - 1].toUpperCase()} PIENSA` : ''),
      showAim: !aiTurn,
      ammoAll: { normal: 99, heavy: 2, dirt: 3, cluster: 0, napalm: 2, digger: 2, roller: 2, nuke: 1, guided: 1, bouncer: 2, laser: 0, mine: 2, quake: 1, blackhole: 1, acid: 2, wall: 2 },
      fuel: aiTurn ? 1 : 0.7,
      showBar: !aiTurn,
      extras: {
        round: 2,
        rounds: 3,
        money: 1250,
        items,
        shield: aiTurn ? 0 : 25,
        tracer: true,
        net: params.has('net')
          ? { role: 'host', code: 'TANK-4F7K', peers: [{ name: 'Sargento', connected: true, ping: 48 }, { name: 'Novato', connected: false, ping: null }], turnLeft: Number(params.get('net')) || 27, waiting: 'ESPERANDO A SARGENTO…' }
          : null,
        minimap,
        suddenDeath,
        // v3: &guide=S muestra la barra de guiado con S segundos de GUIDE_TIME; &aim=jetpack|teleport, la ayuda de destino
        guide: params.has('guide') ? { left: Number(params.get('guide')) || 0, total: GUIDE_TIME } : null,
        aimItem: params.get('aim') === 'jetpack' || params.get('aim') === 'teleport' ? (params.get('aim') as 'jetpack' | 'teleport') : null,
      },
    }
    // v3: &weapon=<WeaponId> elige el arma del tablero (por defecto la pesada)
    const wp = params.get('weapon') as WeaponId | null
    if (wp && wp in model.ammoAll) {
      model.weapon = wp
      model.ammo = model.ammoAll[wp]
    }
    // el flujo llama a update en cada frame; acá también, para ver el titileo del turno
    const tick = () => {
      hud.update(model)
      requestAnimationFrame(tick)
    }
    tick()
    // #hud no recibe eventos (pointer-events: none, como en el juego): se escucha en la ventana
    window.addEventListener('pointerdown', (e) => {
      console.log('minimapAt', JSON.stringify(hud.minimapAt(e.clientX, e.clientY)))
      console.log('controlAt', JSON.stringify(hud.controlAt(e.clientX, e.clientY)))
    })
  } else if (name === 'online') {
    const view = createOnlineMenuView()
    const handlers = { host: () => console.log('host'), join: (c: string) => { console.log('join', c); view.error('SALA NO ENCONTRADA') }, back: () => console.log('back') }
    view.show(handlers, params.get('join') ?? undefined)
  } else if (name === 'lobby') {
    const view = createLobbyView()
    const model = lobbyModel(params.get('role') === 'client' ? 'client' : 'host')
    const push = (fn: (m: LobbyModel) => void) => {
      fn(model)
      // copia profunda, como el anfitrión (structuredClone): la vista compara el modelo viejo con el nuevo
      view.update({ ...structuredClone(model), canStart: model.lobby.slots.filter((s) => s.kind !== 'off').length >= 2 })
    }
    view.show(structuredClone(model), {
      claim: (i) => push((m) => { m.lobby.slots[i] = { ...m.lobby.slots[i], owner: 'me', name: 'Yo', connected: true }; m.mySlot = i }),
      release: () => push((m) => { if (m.mySlot != null) m.lobby.slots[m.mySlot] = { ...m.lobby.slots[m.mySlot], owner: null, name: '' }; m.mySlot = null }),
      setSlot: (i, kind) => push((m) => { m.lobby.slots[i] = { ...m.lobby.slots[i], kind, owner: kind === 'human' ? null : null } }),
      setOption: (key, v) => push((m) => {
        (m.lobby as unknown as Record<string, unknown>)[key] = v
        // v2.3: al cambiar el mapa, la misma compactación que hace el anfitrión (compactSlots)
        if (key === 'size') {
          const mine = m.mySlot != null ? m.lobby.slots[m.mySlot] : null
          const limit = MAX_PLAYERS_BY_SIZE[v as MapSize] ?? MAX_PLAYERS_BY_SIZE.small
          m.lobby.slots = compactSlots(m.lobby.slots, limit, (s) => s.kind !== 'off', (crew): LobbySlot => ({ kind: 'off', name: '', crew, owner: null, connected: false })).slots
          const at = mine ? m.lobby.slots.indexOf(mine) : -1
          m.mySlot = at >= 0 ? at : null
        }
      }),
      start: () => console.log('start'),
      leave: () => console.log('leave'),
    })
    // v3: el perfil propio y la personalidad de las IA (lo que haría el anfitrión al recibir 'profile')
    view.onProfile((p) => push((m) => {
      console.log('profile', JSON.stringify(p))
      if (m.mySlot != null) m.lobby.slots[m.mySlot] = { ...m.lobby.slots[m.mySlot], name: p.name, crew: p.crew, color: p.color }
    }))
    view.onPersonality((i, pers) => push((m) => {
      console.log('personality', i, pers)
      m.lobby.slots[i] = { ...m.lobby.slots[i], personality: pers ?? undefined }
    }))
    pressKeys()
  } else return false
  return true
}

// &keys=ArrowUp,ArrowRight,Enter… manda esas teclas (por code) al abrir la vista: prueba la navegación con teclado.
function pressKeys(param = 'keys'): void {
  for (const code of (params.get(param) ?? '').split(',').filter(Boolean)) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true }))
  }
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

// v2.3: los tanques son los mismos de las placas (n, el del turno y P6 muerto) repartidos a lo ancho, con la
// vista al centro: quedan tanques fuera de vista a los dos lados. view: 'start' | 'end' corre la vista a una
// punta para que todos los de afuera caigan del mismo lado (prueba de flechas apiladas o agrupadas).
function fakeMinimap(size: MapSize, n: number, current: number, viewAt: string | null): MinimapModel {
  const { w, h } = MAP_SIZES[size]
  const terrain = fakeTerrain(w, h)
  const floor = (x: number) => {
    let y = 0
    while (y < h - 1 && terrain.front[y * w + x] === 0) y++
    return y
  }
  const k = w / 2400
  const colors = TANK_COLORS
  // P1 (el humano) cae en la vista del centro; el resto se reparte a los dos lados
  const all = [1300, 830, 1205, 2290, 130, 1955, 470, 2130]
  const xs = all.slice(0, n).map((x) => Math.round(x * k))
  const vx = viewAt === 'start' ? 0 : viewAt === 'end' ? w - 800 : Math.round(1060 * k)
  const view = { x: vx, y: 0, w: 800, h: 450 }
  const tanks = xs.map((x, id) => ({ id, x, y: floor(x), color: colors[id], alive: id !== 5, current: id === current }))
  return {
    terrain,
    terrainVersion: 1,
    view,
    tanks,
    projectiles: [{ x: view.x + 640, y: 92 }],
    lastImpacts: [{ playerId: 2, x: Math.round(1878 * k), y: floor(Math.round(1878 * k)), color: colors[2] }],
  }
}
