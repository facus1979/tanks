// Sala online: código y link, 4 casilleros con retrato, ajustes de partida (anfitrión) y empezar / salir.
import { CREWS, MAP_SIZE_ORDER, TANK_COLORS, type CrewId } from '../sim/types'
import type { LobbySlot } from '../net/types'
import { bindNav, el, label, portrait, screenRoot, setLabel, setPortrait, type Nav } from './kit'
import { SIZE_NAMES } from './menu'
import type { LobbyModel, LobbyView } from './types'

type Handlers = Parameters<LobbyView['show']>[1]
type SlotKind = 'human' | 'ai' | 'off'
type OptionKey = 'rounds' | 'difficulty' | 'biome' | 'size' | 'turnSeconds'

const KIND_CYCLE: SlotKind[] = ['human', 'ai', 'off']
const KIND_NAMES: Record<SlotKind, string> = { human: 'HUMANO', ai: 'IA', off: 'VACIO' }
const CREW_NAMES: Record<CrewId, string> = { bandana: 'BANDANA', sarge: 'SARGENTO', rookie: 'NOVATO', desert: 'DESIERTO' }

// fallback: el valor que se muestra si el lobby no trae la clave (un anfitrión anterior a v2 no manda size)
const OPTIONS: { key: OptionKey; name: string; values: { v: number | string; text: string }[]; fallback?: number | string }[] = [
  { key: 'rounds', name: 'RONDAS', values: [1, 3, 5, 10].map((n) => ({ v: n, text: String(n) })) },
  {
    key: 'difficulty',
    name: 'DIFICULTAD',
    values: [
      { v: 'easy', text: 'FACIL' },
      { v: 'normal', text: 'NORMAL' },
      { v: 'hard', text: 'DIFICIL' },
    ],
  },
  {
    key: 'biome',
    name: 'BIOMA',
    values: [
      { v: 'forest', text: 'BOSQUE' },
      { v: 'jungle', text: 'JUNGLA' },
      { v: 'industrial', text: 'INDUSTRIAL' },
      { v: 'random', text: 'AL AZAR' },
      { v: 'rotate', text: 'ROTATIVO' },
    ],
  },
  { key: 'size', name: 'MAPA', values: MAP_SIZE_ORDER.map((id) => ({ v: id, text: SIZE_NAMES[id] })), fallback: 'small' },
  {
    key: 'turnSeconds',
    name: 'TIEMPO TURNO',
    values: [
      { v: 0, text: 'SIN LIMITE' },
      { v: 30, text: '30 S' },
      { v: 45, text: '45 S' },
      { v: 60, text: '60 S' },
    ],
  },
]

function optionValue(m: LobbyModel, i: number): number | string | undefined {
  const o = OPTIONS[i]
  return m.lobby[o.key] ?? o.fallback
}

export function createLobbyView(root?: HTMLElement): LobbyView {
  return new LobbyScreen(root ?? screenRoot('lobby-view'))
}

interface SlotEls {
  root: HTMLElement
  kind: HTMLElement
  kindLabel: HTMLCanvasElement
  portrait: HTMLCanvasElement
  numLabel: HTMLCanvasElement
  nameLabel: HTMLCanvasElement
  ownerLabel: HTMLCanvasElement
  dot: HTMLElement
}

// Filas navegables (anfitrión): casilleros, ajustes, copiar, empezar, salir. El cliente: casilleros, copiar, salir.
type Row = { t: 'slot'; i: number } | { t: 'opt'; i: number } | { t: 'copy' } | { t: 'start' } | { t: 'leave' }

function pxButton(text: string, onClick: () => void, extra = ''): { btn: HTMLButtonElement; text: HTMLCanvasElement } {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `px-btn ${extra}`.trim()
  const text_ = label(text)
  btn.append(text_)
  btn.addEventListener('click', onClick)
  return { btn, text: text_ }
}

class LobbyScreen implements LobbyView {
  private model: LobbyModel | null = null
  private handlers: Handlers | null = null
  private unbind: (() => void) | null = null
  private cursor = 0
  private slotEls: SlotEls[] = []
  private optEls: { btn: HTMLButtonElement; value: HTMLCanvasElement }[] = []
  private codeLabel!: HTMLCanvasElement
  private statusLabel!: HTMLCanvasElement
  private copyBtn!: HTMLButtonElement
  private copyLabel!: HTMLCanvasElement
  private startBtn!: HTMLButtonElement
  private leaveBtn!: HTMLButtonElement
  private optBox!: HTMLElement
  private linkBox!: HTMLElement
  private linkInput!: HTMLInputElement
  private copiedTimer = 0

  constructor(private root: HTMLElement) {
    this.root.classList.add('solid')
  }

  show(model: LobbyModel, handlers: Handlers): void {
    this.model = model
    this.handlers = handlers
    this.cursor = 0
    this.build()
    this.root.hidden = false
    this.unbind?.()
    this.unbind = bindNav((nav) => this.nav(nav))
    this.sync()
  }

  update(model: LobbyModel): void {
    this.model = model
    if (this.slotEls.length) this.sync()
  }

  hide(): void {
    this.unbind?.()
    this.unbind = null
    clearTimeout(this.copiedTimer)
    this.root.hidden = true
  }

  // ---------- vista ----------

  private build(): void {
    this.slotEls = []
    this.optEls = []
    const frame = el('div', 'frame lobby-frame')

    const head = el('div', 'lobby-head')
    const tag = el('div', 'lobby-tag')
    tag.append(label('CODIGO DE SALA', 0xc4a574))
    this.codeLabel = label('', 0xffd23a, 2, 'title')
    tag.append(this.codeLabel)
    const copy = pxButton('COPIAR LINK', () => this.copy())
    this.copyBtn = copy.btn
    this.copyLabel = copy.text
    head.append(tag, this.copyBtn)

    this.linkBox = el('div', 'link-box')
    this.linkBox.hidden = true
    this.linkInput = document.createElement('input')
    this.linkInput.className = 'link-input'
    this.linkInput.readOnly = true
    this.linkBox.append(this.linkInput)

    const body = el('div', 'lobby-body')
    const slotsBox = el('div', 'slots')
    for (let i = 0; i < 4; i++) slotsBox.append(this.buildSlot(i))
    this.optBox = el('div', 'lobby-opts')
    OPTIONS.forEach((o, i) => {
      const row = el('div', 'opt')
      const b = pxButton('', () => this.pickOption(i))
      row.append(label(o.name, 0xc4a574), b.btn)
      this.optBox.append(row)
      this.optEls.push({ btn: b.btn, value: b.text })
    })
    body.append(slotsBox, this.optBox)

    this.statusLabel = label('', 0xffffff)
    const status = el('div', 'msg')
    status.append(this.statusLabel)

    const actions = el('div', 'actions')
    this.startBtn = pxButton('EMPEZAR', () => this.start(), 'play').btn
    this.leaveBtn = pxButton('SALIR', () => this.handlers?.leave()).btn
    actions.append(this.startBtn, this.leaveBtn)

    frame.append(head, this.linkBox, body, status, actions)
    this.root.replaceChildren(frame)
  }

  private buildSlot(i: number): HTMLElement {
    const row = el('div', 'slot lobby-slot')
    const num = el('div', 'num')
    const numLabel = label(`P${i + 1}`, TANK_COLORS[i] ?? 0xffffff)
    num.append(numLabel)
    const crew = el('div', 'cell crew')
    const port = portrait(CREWS[i], TANK_COLORS[i] ?? 0xffffff, 1)
    crew.append(port)
    const who = el('div', 'who')
    const nameLabel = label('')
    const ownerLabel = label('', 0x9a8e80)
    who.append(nameLabel, ownerLabel)
    const dot = el('div', 'dot')
    const kind = el('div', 'cell kind')
    const kindLabel = label('')
    kind.append(kindLabel)
    kind.addEventListener('click', () => {
      this.cursor = i
      this.pickSlot(i)
      this.sync()
    })
    row.append(num, crew, who, dot, kind)
    this.slotEls.push({ root: row, kind, kindLabel, portrait: port, numLabel, nameLabel, ownerLabel, dot })
    return row
  }

  private isHost(): boolean {
    return this.model?.role === 'host'
  }

  private owner(slot: LobbySlot, i: number): { text: string; color: number } {
    const m = this.model
    if (slot.kind === 'off') return { text: '', color: 0x6a625a }
    if (slot.kind === 'ai') return { text: 'IA', color: 0x9ad0ff }
    if (m && m.mySlot === i) return { text: 'VOS', color: 0xffd23a }
    if (slot.owner === 'host') return { text: m?.role === 'host' ? 'VOS' : 'ANFITRION', color: 0xffd23a }
    if (slot.owner == null) return { text: 'LIBRE', color: 0x8a8078 }
    return { text: (slot.name || 'JUGADOR').toUpperCase(), color: 0xffffff }
  }

  // Repinta todo lo que depende del modelo y del cursor.
  private sync(): void {
    const m = this.model
    if (!m) return
    const host = this.isHost()
    const rows = this.rows()
    if (this.cursor >= rows.length) this.cursor = rows.length - 1
    const cur = rows[this.cursor]
    setLabel(this.codeLabel, m.lobby.code)
    setLabel(this.statusLabel, m.status.toUpperCase(), /error|no |fall|perd|cerr/i.test(m.status) ? 0xff8a6a : 0xffe27a)
    m.lobby.slots.slice(0, 4).forEach((slot, i) => {
      const e = this.slotEls[i]
      const off = slot.kind === 'off'
      const color = off ? 0x4a4440 : (TANK_COLORS[i] ?? 0xffffff)
      const own = this.owner(slot, i)
      e.root.classList.toggle('empty', off)
      e.root.classList.toggle('mine', m.mySlot === i)
      setLabel(e.numLabel, `P${i + 1}`, color)
      setPortrait(e.portrait, slot.crew, color)
      const same = !slot.name || slot.name.toUpperCase() === own.text
      setLabel(e.nameLabel, off ? '' : (same ? CREW_NAMES[slot.crew] : slot.name.toUpperCase()), 0xffffff)
      setLabel(e.ownerLabel, own.text, own.color)
      const remote = slot.kind === 'human' && slot.owner != null
      e.dot.className = `dot${remote ? (slot.connected ? ' on' : ' bad') : ''}`
      const free = slot.kind === 'human' && slot.owner == null
      let kindText = KIND_NAMES[slot.kind]
      if (!host) kindText = m.mySlot === i ? 'SOLTAR' : free ? 'TOMAR' : KIND_NAMES[slot.kind]
      setLabel(e.kindLabel, kindText, slot.kind === 'human' ? 0xffd23a : slot.kind === 'ai' ? 0x9ad0ff : 0x8a8078)
      e.kind.classList.toggle('sel', cur?.t === 'slot' && cur.i === i)
    })
    this.optBox.classList.toggle('ro', !host)
    OPTIONS.forEach((o, i) => {
      const val = optionValue(m, i)
      const v = o.values.find((x) => x.v === val)
      const e = this.optEls[i]
      setLabel(e.value, v ? v.text : String(val).toUpperCase(), host ? 0xffffff : 0xc8bca8)
      e.btn.classList.toggle('sel', cur?.t === 'opt' && cur.i === i)
    })
    this.startBtn.hidden = !host
    this.startBtn.classList.toggle('dis', !m.canStart)
    this.startBtn.classList.toggle('sel', cur?.t === 'start')
    this.copyBtn.classList.toggle('sel', cur?.t === 'copy')
    this.leaveBtn.classList.toggle('sel', cur?.t === 'leave')
  }

  // ---------- acciones ----------

  private rows(): Row[] {
    const out: Row[] = [0, 1, 2, 3].map((i) => ({ t: 'slot', i }))
    if (this.isHost()) OPTIONS.forEach((_, i) => out.push({ t: 'opt', i }))
    out.push({ t: 'copy' })
    if (this.isHost()) out.push({ t: 'start' })
    out.push({ t: 'leave' })
    return out
  }

  private pickSlot(i: number): void {
    const m = this.model
    const h = this.handlers
    if (!m || !h) return
    const slot = m.lobby.slots[i]
    if (!slot) return
    if (this.isHost()) {
      if (slot.owner === 'host') return
      h.setSlot(i, KIND_CYCLE[(KIND_CYCLE.indexOf(slot.kind as SlotKind) + 1) % KIND_CYCLE.length])
    } else if (m.mySlot === i) h.release()
    else if (slot.kind === 'human' && slot.owner == null) h.claim(i)
  }

  private pickOption(i: number, dir = 1): void {
    const m = this.model
    if (!m || !this.isHost() || !this.handlers) return
    const o = OPTIONS[i]
    const at = o.values.findIndex((x) => x.v === optionValue(m, i))
    const next = o.values[(at + dir + o.values.length) % o.values.length]
    this.handlers.setOption(o.key, next.v)
  }

  private start(): void {
    if (this.isHost() && this.model?.canStart) this.handlers?.start()
  }

  private copy(): void {
    const link = this.model?.link ?? ''
    const done = (ok: boolean) => {
      if (ok) {
        this.linkBox.hidden = true
        setLabel(this.copyLabel, 'COPIADO!', 0x9ae06a)
      } else {
        // sin portapapeles: muestra el link seleccionado para copiarlo a mano
        this.linkInput.value = link
        this.linkBox.hidden = false
        this.linkInput.focus()
        this.linkInput.select()
        setLabel(this.copyLabel, 'COPIA CON CTRL+C', 0xffd23a)
      }
      clearTimeout(this.copiedTimer)
      this.copiedTimer = window.setTimeout(() => setLabel(this.copyLabel, 'COPIAR LINK', 0xffffff), 2000)
    }
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = link
      ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0'
      document.body.append(ta)
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      ta.remove()
      done(ok)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => done(true), fallback)
    else fallback()
  }

  private activate(): void {
    const cur = this.rows()[this.cursor]
    if (!cur) return
    if (cur.t === 'slot') this.pickSlot(cur.i)
    else if (cur.t === 'opt') this.pickOption(cur.i)
    else if (cur.t === 'copy') this.copy()
    else if (cur.t === 'start') this.start()
    else this.handlers?.leave()
  }

  private nav(nav: Nav): void {
    const rows = this.rows()
    if (nav === 'back') return this.handlers?.leave()
    if (nav === 'start') return this.start()
    if (nav === 'up') this.cursor = (this.cursor + rows.length - 1) % rows.length
    else if (nav === 'down') this.cursor = (this.cursor + 1) % rows.length
    else if (nav === 'ok') return this.activate()
    else {
      const cur = rows[this.cursor]
      const dir = nav === 'left' ? -1 : 1
      if (cur.t === 'opt') this.pickOption(cur.i, dir)
      else if (cur.t === 'slot' && this.isHost()) this.pickSlot(cur.i)
    }
    this.sync()
  }
}
