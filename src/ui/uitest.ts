// Página de prueba de las vistas: ?uitest=title|menu|banner|score|final|shop|hud con modelos falsos.
// index.html la carga solo si la query trae uitest; main.ts puede llamar mountUiTest(name) si prefiere.
import { ITEM_ORDER, SHOP, type ShopId } from '../sim/types'
import { loadUiAssets } from './assets'
import { Hud } from './hud'
import { refreshLabels } from './kit'
import { createBannerView } from './banner'
import { createMenuView } from './menu'
import { createScoreboardView } from './scoreboard'
import { createShopView } from './shop'
import { createTitleView } from './title'
import type { ScoreModel, ShopModel } from './types'

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
    hud.place({ x: 0, y: 0, w: 800, h: 450 } as never)
    const side = (n: number, name: string, color: number, crew: 'bandana' | 'sarge') => ({ name, tag: `P${n}`, color, crew, hp: 80, alive: true, active: n === 1, you: n === 1 })
    hud.update({
      human: side(1, 'Bandana', 0x3d8cf0, 'bandana'),
      rival: side(2, 'Sargento', 0xe23d3d, 'sarge'),
      others: [],
      angle: 45,
      power: 60,
      weapon: 'heavy',
      ammo: 2,
      wind: 4,
      status: '',
      showAim: true,
      ammoAll: { normal: 99, heavy: 2, dirt: 3, cluster: 0, napalm: 2, digger: 2, roller: 2, nuke: 1 },
      fuel: 0.7,
      showBar: true,
      extras: { round: 2, rounds: 3, money: 1250, items, shield: 25, tracer: true },
    })
  } else return false
  return true
}

const q = new URLSearchParams(location.search).get('uitest')
if (q) void mountUiTest(q)
