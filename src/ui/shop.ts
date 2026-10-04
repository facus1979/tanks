// Tienda entre rondas: una pantalla por humano.
// v3: 15 armas y 9 ítems en tres columnas (ARMAS: las clásicas; MÁS ARMAS: las de v3; ÍTEMS), filas compactas
// de una línea y, abajo, la ficha del artículo elegido con su descripción de una línea (SHOP_DESC). Lo nuevo de
// v3 lleva "NUEVO". Las filas llegan en el orden de SHOP; acá se ordenan por WEAPON_ORDER / ITEM_ORDER.
// Teclado: flechas (arriba/abajo en la columna, izquierda/derecha entre columnas), espacio/enter compra,
// backspace vende, L listo. Gamepad: cruz, A compra, B vende, Start listo. Mouse/táctil: tocar una fila la
// elige (y muestra su descripción), + compra, − vende.
import { ITEM_ORDER, WEAPON_ORDER, type ItemId, type ShopId, type WeaponId } from '../sim/types'
import { NEW_IN_V3, SHOP_DESC } from './arsenal'
import { bindNav, button, el, icon, label, portrait, screenRoot, type Nav } from './kit'
import type { ShopModel, ShopRow, ShopView } from './types'

type Handlers = { buy: (id: ShopId) => void; sell: (id: ShopId) => void; ready: () => void }

const GOLD = 0xffd23a
const GREY = 0x9a8e80
const BRONZE = 0xc4a574
// Armas con índice menor van en la primera columna (las 8 clásicas de WEAPON_ORDER).
const CLASSIC = 8

export function createShopView(root?: HTMLElement): ShopView {
  return new ShopScreen(root ?? screenRoot('shop-view', 'dim'))
}

// Reparte las filas en columnas (sin columnas vacías), cada una en el orden de la barra / de los ítems.
function columns(rows: ShopRow[]): { title: string; rows: ShopRow[] }[] {
  const w = (r: ShopRow) => WEAPON_ORDER.indexOf(r.id as WeaponId)
  const it = (r: ShopRow) => ITEM_ORDER.indexOf(r.id as ItemId)
  const weapons = rows.filter((r) => r.kind === 'weapon').sort((a, b) => w(a) - w(b))
  const items = rows.filter((r) => r.kind === 'item').sort((a, b) => it(a) - it(b))
  return [
    { title: 'ARMAS', rows: weapons.filter((r) => w(r) < CLASSIC) },
    { title: 'MAS ARMAS', rows: weapons.filter((r) => w(r) >= CLASSIC) },
    { title: 'ITEMS', rows: items },
  ].filter((c) => c.rows.length > 0)
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
    this.selected = columns(model.rows)[0]?.rows[0]?.id ?? null
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
    if (!model.rows.some((r) => r.id === this.selected)) this.selected = columns(model.rows)[0]?.rows[0]?.id ?? null
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
    const cols = columns(this.model?.rows ?? [])
    if (cols.length === 0) return
    let c = cols.findIndex((col) => col.rows.some((r) => r.id === this.selected))
    if (c < 0) c = 0
    let i = Math.max(0, cols[c].rows.findIndex((r) => r.id === this.selected))
    if (nav === 'up') i = (i + cols[c].rows.length - 1) % cols[c].rows.length
    else if (nav === 'down') i = (i + 1) % cols[c].rows.length
    else if (nav === 'left' || nav === 'right') {
      // a la misma altura de la columna vecina (o su última fila), sin dar la vuelta
      const next = c + (nav === 'left' ? -1 : 1)
      if (next < 0 || next >= cols.length) return
      c = next
      i = Math.min(i, cols[c].rows.length - 1)
    } else if (nav === 'ok') return this.buy()
    else if (nav === 'back') return this.sell()
    else if (nav === 'start') return this.handlers?.ready()
    this.selected = cols[c].rows[i].id
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
    const frame = el('div', 'frame shop-frame')

    const head = el('div', 'shop-head')
    const who = el('div', 'who')
    const stack = el('div', 'stack')
    stack.append(label(model.name.toUpperCase(), model.color, small ? 1 : 2), label(`TIENDA   RONDA ${model.round} DE ${model.rounds}`, BRONZE))
    who.append(portrait(model.crew, model.color, small ? 1 : 2), stack)
    const cash = el('div', 'cash')
    cash.append(label('PLATA', GREY), label(`$${model.money}`, GOLD, small ? 2 : 3))
    head.append(who, cash)

    const cols = el('div', 'shop shop3')
    for (const c of columns(model.rows)) {
      const col = el('div', 'shop-col')
      col.append(this.colHead(c.title))
      for (const r of c.rows) col.append(this.rowEl(r, model.money))
      cols.append(col)
    }

    // ficha del elegido: ícono, nombre, NUEVO y la descripción de una línea
    const sel = this.row()
    const detail = el('div', 'shop-detail')
    if (sel) {
      const text = el('div', 'grow')
      const title = el('div', 'line')
      title.append(label(sel.name.toUpperCase(), 0xffffff))
      if (NEW_IN_V3.has(sel.id)) title.append(label('NUEVO', GOLD))
      title.append(label(`${sel.qty > 1 ? `X${sel.qty}  ` : ''}$${sel.price}`, sel.price <= model.money ? GOLD : 0xd0362c))
      text.append(title, label(SHOP_DESC[sel.id] ?? '', 0xc8bca8))
      detail.append(icon(sel.id, small ? 1 : 2), text)
    }

    const actions = el('div', 'actions')
    const ready = button('LISTO', () => this.handlers?.ready(), 'play')
    actions.append(ready)
    const hint = el('div', 'hint')
    hint.append(label('FLECHAS MOVER   ESPACIO COMPRA   BORRAR VENDE   L LISTO', GREY))

    frame.append(head, cols, detail, actions, hint)
    this.root.replaceChildren(frame)
    this.root.querySelector('.prow.sel')?.scrollIntoView({ block: 'nearest' })
  }

  private colHead(text: string): HTMLElement {
    const head = el('div', 'colhead')
    head.append(label(text, BRONZE), label('TENES', GREY))
    return head
  }

  // Fila compacta: ícono, nombre (con un punto dorado si es nuevo) y precio, tenés/máx, − y +.
  private rowEl(r: ShopRow, money: number): HTMLElement {
    const node = el('div', `prow${r.id === this.selected ? ' sel' : ''}${r.canBuy ? '' : ' off'}`)
    node.addEventListener('click', () => {
      this.selected = r.id
      this.render()
    })
    const flash = this.flash?.id === r.id ? this.flash : null
    if (flash) node.style.background = flash.ok ? '#2a4a22' : '#5a2020'

    const info = el('div', 'grow')
    const name = el('div', 'line')
    name.append(label(r.name.toUpperCase(), 0xffffff))
    if (NEW_IN_V3.has(r.id)) name.append(label('*', GOLD))
    info.append(name, label(`${r.qty > 1 ? `X${r.qty} ` : ''}$${r.price}`, r.price <= money ? GOLD : 0xd0362c))
    const price = el('div', 'price')
    price.append(label(`${r.owned}/${r.max}`, r.owned >= r.max ? 0xff8a6a : BRONZE))
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
    // los botones no tienen que disparar además el click de la fila (que re-renderiza)
    for (const b of [buy, sell]) b.addEventListener('click', (e) => e.stopPropagation())
    node.append(icon(r.id, 1), info, price, sell, buy)
    return node
  }
}
