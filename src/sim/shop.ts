// Tienda entre rondas: validación de compra/venta y compras de la IA.
import { Rng, hashSeed } from './rng'
import { SHOP, WEAPONS, type Difficulty, type ItemId, type Player, type ShopEntry, type ShopId, type WeaponId } from './types'

export const SELL_RATE = 0.5

export function shopEntry(id: ShopId): ShopEntry | undefined {
  return SHOP.find((e) => e.id === id)
}

// Unidades que tiene el jugador de ese artículo.
export function owned(player: Player, id: ShopId): number {
  if (id in WEAPONS) return player.ammo[id as WeaponId] ?? 0
  return player.items[id as ItemId] ?? 0
}

function setOwned(player: Player, id: ShopId, n: number): void {
  if (id in WEAPONS) player.ammo[id as WeaponId] = n
  else player.items[id as ItemId] = n
}

export function canBuy(player: Player, entry: ShopEntry): boolean {
  return player.money >= entry.price && owned(player, entry.id) + entry.qty <= entry.max
}

export function canSell(player: Player, entry: ShopEntry): boolean {
  return owned(player, entry.id) > 0
}

// Lo que devuelve vender un paquete (o lo que quede de él).
export function sellPrice(player: Player, entry: ShopEntry): number {
  const n = Math.min(entry.qty, owned(player, entry.id))
  return Math.floor((entry.price * SELL_RATE * n) / entry.qty)
}

// Mutan el jugador (ya clonado). Devuelven false si no se pudo.
export function buyEntry(player: Player, entry: ShopEntry): boolean {
  if (!canBuy(player, entry)) return false
  player.money -= entry.price
  setOwned(player, entry.id, owned(player, entry.id) + entry.qty)
  return true
}

export function sellEntry(player: Player, entry: ShopEntry): boolean {
  if (!canSell(player, entry)) return false
  const n = Math.min(entry.qty, owned(player, entry.id))
  player.money += sellPrice(player, entry)
  setOwned(player, entry.id, owned(player, entry.id) - n)
  return true
}

// Peso de cada artículo para la IA y cuántas unidades quiere tener como máximo.
const WANT: Record<Difficulty, Partial<Record<ShopId, [number, number]>>> = {
  easy: { heavy: [3, 4], cluster: [2, 4], napalm: [2, 4], roller: [2, 4], dirt: [1, 3], nuke: [1, 1], shield: [2, 1], repair: [2, 1], parachute: [1, 1], fuel: [1, 1], tracer: [1, 1] },
  normal: { heavy: [4, 6], cluster: [2, 4], napalm: [3, 4], roller: [3, 4], digger: [1, 2], nuke: [2, 1], shield: [3, 2], repair: [3, 2], parachute: [2, 1] },
  hard: { heavy: [5, 6], cluster: [2, 4], napalm: [3, 4], roller: [3, 4], digger: [1, 2], nuke: [4, 2], shield: [4, 2], repair: [4, 2], parachute: [2, 1] },
}
const STOP: Record<Difficulty, number> = { easy: 0.3, normal: 0.12, hard: 0.05 }

// Compras de la IA, deterministas por (seed, ronda, jugador). Muta el jugador.
export function aiShop(player: Player, difficulty: Difficulty, seed: number, round: number): ShopId[] {
  const rng = new Rng(hashSeed(seed ^ Math.imul(round + 1, 0x85ebca6b) ^ Math.imul(player.id + 1, 0xc2b2ae35)))
  const want = WANT[difficulty]
  const bought: ShopId[] = []
  // la difícil junta para la nuke si le alcanza
  const nuke = shopEntry('nuke')
  if (difficulty === 'hard' && nuke && canBuy(player, nuke) && owned(player, 'nuke') === 0) {
    buyEntry(player, nuke)
    bought.push('nuke')
  }
  for (let n = 0; n < 12; n++) {
    const options: [ShopEntry, number][] = []
    for (const e of SHOP) {
      const w = want[e.id]
      if (!w || !canBuy(player, e) || owned(player, e.id) >= w[1]) continue
      options.push([e, w[0]])
    }
    if (options.length === 0) break
    if (bought.length > 0 && rng.chance(STOP[difficulty])) break
    let roll = rng.next() * options.reduce((a, o) => a + o[1], 0)
    let pick = options[0][0]
    for (const [e, w] of options) {
      roll -= w
      if (roll < 0) {
        pick = e
        break
      }
    }
    buyEntry(player, pick)
    bought.push(pick.id)
  }
  return bought
}
