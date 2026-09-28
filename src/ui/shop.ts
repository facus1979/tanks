// Tienda entre rondas: una pantalla por humano. Armas a la izquierda, ítems a la derecha.
// Teclado: flechas, espacio/enter compra, backspace vende, L listo. Gamepad: cruz, A compra, B vende, Start listo.
import type { ShopId } from '../sim/types'
import { bindNav, button, el, icon, label, portrait, screenRoot, type Nav } from './kit'
import type { ShopModel, ShopRow, ShopView } from './types'

type Handlers = { buy: (id: ShopId) => void; sell: (id: ShopId) => void; ready: () => void }

const GOLD = 0xffd23a
const GREY = 0x9a8e80

export function createShopView(root?: HTMLElement): ShopView {
  return new ShopScreen(root ?? screenRoot('shop-view', 'dim'))
}

class ShopScreen implements ShopView {
  private model: ShopModel | null = null
  private handlers: Handlers | null = null
  private selected: ShopId | null = null
  private unbind: (() => void) | null = null
  private flash: { id: ShopId; ok: boolean } | null = null

  constructor(private root: HTMLElement) {
    this.root.classList.add('dim')
  }

  show(model: ShopModel, handlers: Handlers): void {
    this.handlers = handlers
    this.model = model
    this.selected = model.rows[0]?.id ?? null
    this.render()
    this.root.hidden = false
    this.unbind?.()
    this.unbind = bindNav(
      (nav) => this.nav(nav),
      (e) => this.rawKey(e),
    )
  }

  update(model: ShopModel): void {
    this.model = model
    if (!model.rows.some((r) => r.id === this.selected)) this.selected = model.rows[0]?.id ?? null
    this.render()
  }

  hide(): void {
    this.unbind?.()
    this.unbind = null
    this.handlers = null
    this.root.hidden = true
  }

  // ---------- entrada ----------

  private rawKey(e: KeyboardEvent): boolean {
    if (e.code === 'Backspace') {
      if (!e.repeat) this.sell()
      return true
    }
    if (e.code === 'KeyL') {
      if (!e.repeat) this.handlers?.ready()
      return true
    }
    if (e.code === 'Escape') return true
    return false
  }

  private nav(nav: Nav): void {
    const rows = this.model?.rows ?? []
    if (rows.length === 0) return
    const i = Math.max(0, rows.findIndex((r) => r.id === this.selected))
    const split = rows.findIndex((r) => r.kind === 'item')
    let next = i
    if (nav === 'up') next = (i + rows.length - 1) % rows.length
    else if (nav === 'down') next = (i + 1) % rows.length
    else if (nav === 'left' || nav === 'right') {
      if (split > 0) {
        const inItems = i >= split
        if (nav === 'left' && inItems) next = Math.min(split - 1, i - split)
        else if (nav === 'right' && !inItems) next = Math.min(rows.length - 1, split + i)
      }
    } else if (nav === 'ok') return this.buy()
    else if (nav === 'back') return this.sell()
    else if (nav === 'start') return this.handlers?.ready()
    this.selected = rows[next].id
    this.render()
  }

  private buy(): void {
    const row = this.row()
    if (!row || !this.handlers) return
    this.flash = { id: row.id, ok: row.canBuy }
    if (row.canBuy) this.handlers.buy(row.id)
    else this.render()
  }

  private sell(): void {
    const row = this.row()
    if (!row || !this.handlers) return
    this.flash = { id: row.id, ok: row.canSell }
    if (row.canSell) this.handlers.sell(row.id)
    else this.render()
  }

  private row(): ShopRow | undefined {
    return this.model?.rows.find((r) => r.id === this.selected)
  }

  // ---------- vista ----------

  private render(): void {
    const model = this.model
    if (!model) return
    const small = window.innerWidth <= 900 || window.innerHeight <= 520
    const frame = el('div', 'frame')
    frame.style.width = 'min(100%, calc(var(--px) * 300))'

    const head = el('div', 'shop-head')
    const who = el('div', 'who')
    const stack = el('div', 'stack')
    stack.append(label(model.name.toUpperCase(), model.color, small ? 1 : 2), label(`TIENDA   RONDA ${model.round} DE ${model.rounds}`, 0xc4a574))
    who.append(portrait(model.crew, model.color, small ? 1 : 2), stack)
    const cash = el('div', 'cash')
    cash.append(label('PLATA', GREY), label(`$${model.money}`, GOLD, small ? 2 : 3))
    head.append(who, cash)

    const cols = el('div', 'shop')
    const weapons = el('div', 'shop-col')
    const items = el('div', 'shop-col')
    weapons.append(this.colHead('ARMAS'))
    items.append(this.colHead('ITEMS'))
    for (const r of model.rows) (r.kind === 'weapon' ? weapons : items).append(this.rowEl(r, model.money))
    cols.append(weapons, items)

    const actions = el('div', 'actions')
    const ready = button('LISTO', () => this.handlers?.ready(), 'play')
    actions.append(ready)
    const hint = el('div', 'hint')
    hint.append(label('FLECHAS MOVER   ESPACIO COMPRA   BORRAR VENDE   L LISTO', GREY))

    frame.append(head, cols, actions, hint)
    this.root.replaceChildren(frame)
    this.root.querySelector('.prow.sel')?.scrollIntoView({ block: 'nearest' })
  }

  private colHead(text: string): HTMLElement {
    const head = el('div', 'colhead')
    head.append(label(text, 0xc4a574), label('TENES / MAX', GREY))
    return head
  }

  private rowEl(r: ShopRow, money: number): HTMLElement {
    const node = el('div', `prow${r.id === this.selected ? ' sel' : ''}${r.canBuy ? '' : ' off'}`)
    node.addEventListener('click', () => {
      this.selected = r.id
      this.render()
    })
    const flash = this.flash?.id === r.id ? this.flash : null
    if (flash) node.style.background = flash.ok ? '#2a4a22' : '#5a2020'

    const info = el('div', 'grow')
    info.append(label(r.name.toUpperCase(), 0xffffff), label(`${r.qty > 1 ? `X${r.qty}  ` : ''}$${r.price}`, r.price <= money ? GOLD : 0xd0362c))
    const price = el('div', 'price')
    price.append(label(`${r.owned}/${r.max}`, r.owned >= r.max ? 0xff8a6a : 0xc4a574))
    const buy = button('+', () => {
      this.selected = r.id
      this.buy()
    })
    buy.classList.toggle('dis', !r.canBuy)
    const sell = button('-', () => {
      this.selected = r.id
      this.sell()
    })
    sell.classList.toggle('dis', !r.canSell)
    node.append(icon(r.id, 2), info, price, sell, buy)
    return node
  }
}
