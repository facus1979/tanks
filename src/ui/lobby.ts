// Sala online: código y link, 8 casilleros con retrato (dos columnas de 4), ajustes de partida (anfitrión) y empezar / salir.
// v5: los casilleros que pasan MAX_PLAYERS_BY_SIZE[lobby.size] se ven bloqueados con "SOLO MAPA …" y no se pueden
// tomar ni configurar (el anfitrión, en src/net, tampoco deja ocuparlos).
// v2.3: al achicar el mapa el anfitrión compacta los casilleros con la misma regla que el menú local
// (compactSlots en ./menu); esta vista solo muestra lo que llega y el cursor sigue al mismo elemento.
// v3 perfil: cada casillero muestra su color de tanque (LobbySlot.color) y su nombre. En el casillero propio
// (mySlot) se editan tripulante, color y nombre (teclado, o teclado del sistema en táctil): la vista avisa con
// onProfile({ name, crew, color }) y el flujo/red manda el mensaje 'profile'. El anfitrión elige la personalidad
// de cada IA (onPersonality). Los tripulantes y colores que ya usa otro casillero se saltean; el anfitrión valida.
import { CREWS, MAP_SIZE_ORDER, MAX_PLAYERS, MAX_PLAYERS_BY_SIZE, NAME_MAX, TANK_COLORS, type CrewId, type MapSize, type Personality } from '../sim/types'
import type { LobbySlot } from '../net/types'
import { bindNav, el, label, portrait, screenRoot, setLabel, setPortrait, type Nav } from './kit'
import { CREW_NAMES, cleanName, nameInput, nextColor, nextCrew, nextPersonality, personalityName, setSwatch, swatch } from './profile'
import { isTouchDevice } from '../input/touch'
import { SIZE_NAMES } from './menu'
import type { LobbyModel, LobbyView } from './types'

type Handlers = Parameters<LobbyView['show']>[1]
type SlotKind = 'human' | 'ai' | 'off'
type OptionKey = 'rounds' | 'difficulty' | 'biome' | 'size' | 'turnSeconds'

const KIND_CYCLE: SlotKind[] = ['human', 'ai', 'off']
const KIND_NAMES: Record<SlotKind, string> = { human: 'HUMANO', ai: 'IA', off: 'VACIO' }

// v3: perfil propio que la vista pide cambiar (el flujo lo manda como mensaje 'profile').
export interface LobbyProfile {
  name: string
  crew: CrewId
  color: number // índice en TANK_COLORS
}
// v3: lo que la sala expone además de LobbyView (sin tocar src/ui/types.ts).
export interface LobbyProfileHooks {
  onProfile(cb: (profile: LobbyProfile) => void): void // casillero propio: nombre, tripulante o color
  onPersonality(cb: (slot: number, personality: Personality | null) => void): void // anfitrión, IA; null = al azar
}

// Celdas navegables dentro de un casillero (izquierda/derecha): tripulante, color, nombre/personalidad, tipo.
type Cell = 'crew' | 'color' | 'name' | 'kind'

// Color de un casillero: el elegido o, si el lobby no lo trae (anfitrión anterior a v3), el de su índice.
function slotColor(slot: LobbySlot | undefined, i: number): number {
  const c = slot?.color
  return c != null && c >= 0 && c < TANK_COLORS.length ? c : i % TANK_COLORS.length
}

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

// Casilleros por columna en la grilla de dos columnas.
const SLOT_ROWS = MAX_PLAYERS / 2

// El tamaño de mapa más chico que admite el casillero i (para el cartel de los bloqueados).
function sizeFor(i: number): MapSize | null {
  return MAP_SIZE_ORDER.find((z) => i < MAX_PLAYERS_BY_SIZE[z]) ?? null
}

function optionValue(m: LobbyModel, i: number): number | string | undefined {
  const o = OPTIONS[i]
  return m.lobby[o.key] ?? o.fallback
}

export function createLobbyView(root?: HTMLElement): LobbyView & LobbyProfileHooks {
  return new LobbyScreen(root ?? screenRoot('lobby-view'))
}

interface SlotEls {
  root: HTMLElement
  kind: HTMLElement
  kindLabel: HTMLCanvasElement
  crew: HTMLElement
  color: HTMLElement
  swatch: HTMLElement
  who: HTMLElement
  input: HTMLInputElement | null
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

class LobbyScreen implements LobbyView, LobbyProfileHooks {
  private model: LobbyModel | null = null
  private handlers: Handlers | null = null
  private unbind: (() => void) | null = null
  private cursor = 0
  private cell: Cell = 'kind' // celda dentro del casillero bajo el cursor
  private editing = false // escribiendo el nombre propio con el teclado
  private draft: string | null = null // nombre propio mientras se edita (el modelo llega después)
  private profileCb: (p: LobbyProfile) => void = () => {}
  private personalityCb: (slot: number, p: Personality | null) => void = () => {}
  private side = 0 // columna de casilleros en la que estuvo el cursor por última vez
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
    this.cell = 'kind'
    this.editing = false
    this.draft = null
    this.build()
    this.root.hidden = false
    this.unbind?.()
    this.unbind = bindNav(
      (nav) => this.nav(nav),
      (e) => this.rawKey(e),
    )
    this.sync()
  }

  onProfile(cb: (profile: LobbyProfile) => void): void {
    this.profileCb = cb
  }

  onPersonality(cb: (slot: number, personality: Personality | null) => void): void {
    this.personalityCb = cb
  }

  update(model: LobbyModel): void {
    // el cursor sigue al mismo elemento aunque cambie cuántos casilleros quedan habilitados (al cambiar el mapa)
    const key = (r: Row | undefined) => (r ? `${r.t}:${'i' in r ? r.i : ''}` : '')
    const was = key(this.rows()[this.cursor])
    this.model = model
    const now = this.rows().findIndex((r) => key(r) === was)
    if (now >= 0) this.cursor = now
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
    const slotsBox = el('div', 'slots slots8')
    for (let i = 0; i < MAX_PLAYERS; i++) slotsBox.append(this.buildSlot(i))
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
    const color = el('div', 'cell color')
    const sw = swatch()
    color.append(sw)
    const who = el('div', 'who')
    const nameLabel = label('')
    const ownerLabel = label('', 0x9a8e80)
    who.append(nameLabel, ownerLabel)
    const dot = el('div', 'dot')
    // v3: tocar tripulante, color o nombre del casillero propio los cambia; el nombre de una IA (anfitrión),
    // su personalidad
    const pickCell = (c: Cell) => {
      if (this.locked(i)) return
      const at = this.rows().findIndex((r) => r.t === 'slot' && r.i === i)
      if (at < 0) return
      this.cursor = at
      if (!this.cellsOf(i).includes(c)) return this.sync()
      this.cell = c
      this.activateCell(i, c)
      this.sync()
    }
    crew.addEventListener('click', () => pickCell('crew'))
    color.addEventListener('click', () => pickCell('color'))
    who.addEventListener('click', () => {
      if (this.slotEls[i]?.input && !this.slotEls[i].input?.hidden) return // lo atiende el campo táctil
      pickCell('name')
    })
    let input: HTMLInputElement | null = null
    if (isTouchDevice()) {
      input = nameInput(
        () => {
          const at = this.rows().findIndex((r) => r.t === 'slot' && r.i === i)
          if (at >= 0) this.cursor = at
          this.cell = 'name'
          this.editing = true
          this.draft = this.myName()
          this.sync()
        },
        (text) => {
          this.draft = text
          this.sendProfile({ name: text })
          this.sync()
        },
        () => this.stopEditing(),
      )
      who.classList.add('has-input')
      who.append(input)
    }
    const kind = el('div', 'cell kind')
    const kindLabel = label('')
    kind.append(kindLabel)
    kind.addEventListener('click', () => {
      if (this.locked(i)) return
      const at = this.rows().findIndex((r) => r.t === 'slot' && r.i === i)
      if (at >= 0) this.cursor = at
      this.pickSlot(i)
      this.sync()
    })
    row.append(num, crew, color, who, dot, kind)
    this.slotEls.push({ root: row, kind, kindLabel, crew, color, swatch: sw, who, input, portrait: port, numLabel, nameLabel, ownerLabel, dot })
    return row
  }

  // Bloqueado: pasa el máximo del tamaño de mapa (sin size, Chico) o el lobby no lo trae (anfitrión anterior a v5).
  private locked(i: number): boolean {
    const lobby = this.model?.lobby
    if (!lobby || !lobby.slots[i]) return true
    const size = lobby.size && lobby.size in MAX_PLAYERS_BY_SIZE ? lobby.size : 'small'
    return i >= MAX_PLAYERS_BY_SIZE[size]
  }

  private isHost(): boolean {
    return this.model?.role === 'host'
  }

  private owner(slot: LobbySlot, i: number): { text: string; color: number } {
    const m = this.model
    if (slot.kind === 'off') return { text: '', color: 0x6a625a }
    if (slot.kind === 'ai') return { text: personalityName(slot.personality), color: 0x9ad0ff } // v3: el tipo ya dice IA
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
    let n = 0
    this.slotEls.forEach((e, i) => {
      const slot = m.lobby.slots[i]
      const locked = this.locked(i)
      e.root.classList.toggle('locked', locked)
      const here = !locked && cur?.t === 'slot' && cur.i === i
      e.kind.classList.toggle('sel', here && this.cell === 'kind')
      e.crew.classList.toggle('sel', here && this.cell === 'crew')
      e.color.classList.toggle('sel', here && this.cell === 'color')
      e.who.classList.toggle('sel', here && this.cell === 'name')
      const mine = !locked && !!slot && m.mySlot === i && slot.kind === 'human'
      e.root.classList.toggle('editable', mine)
      if (e.input) {
        e.input.hidden = !mine
        if (document.activeElement !== e.input) e.input.value = this.draft ?? slot?.name ?? ''
      }
      if (locked || !slot) {
        // bloqueado por el tamaño del mapa: dice desde qué mapa se puede usar
        const need = sizeFor(i)
        e.root.classList.remove('empty', 'mine')
        setLabel(e.numLabel, '-', 0x4a4440)
        setPortrait(e.portrait, slot?.crew ?? CREWS[i], 0x3a3430)
        setSwatch(e.swatch, null)
        setLabel(e.nameLabel, need ? `SOLO MAPA` : '', 0x7a7068)
        setLabel(e.ownerLabel, need ? `${SIZE_NAMES[need]}${need === 'large' ? '' : '+'}` : '', 0x7a7068)
        e.dot.className = 'dot'
        setLabel(e.kindLabel, '-', 0x6a625a)
        return
      }
      const off = slot.kind === 'off'
      // el número sigue el orden de los ocupados (como en la sim); v3: el color es el elegido
      const color = off ? 0x4a4440 : (TANK_COLORS[slotColor(slot, i)] ?? 0xffffff)
      setSwatch(e.swatch, off ? null : color)
      if (!off) n++
      const own = this.owner(slot, i)
      e.root.classList.toggle('empty', off)
      e.root.classList.toggle('mine', m.mySlot === i)
      setLabel(e.numLabel, off ? '-' : `P${n}`, color)
      setPortrait(e.portrait, slot.crew, color)
      const same = !slot.name || slot.name.toUpperCase() === own.text
      if (m.mySlot === i && slot.kind === 'human') {
        // propio: el borrador mientras se escribe, con cursor
        const name = this.editing ? (this.draft ?? '') : slot.name
        const caret = this.editing ? '-' : '' // la fuente no tiene '_'
        setLabel(e.nameLabel, (name ? name.toUpperCase() : this.editing ? '' : CREW_NAMES[slot.crew]) + caret, name || caret ? 0xffffff : 0x9a8e80)
      } else setLabel(e.nameLabel, off ? '' : slot.kind === 'ai' ? CREW_NAMES[slot.crew] : same ? CREW_NAMES[slot.crew] : slot.name.toUpperCase(), 0xffffff)
      setLabel(e.ownerLabel, own.text, own.color)
      const remote = slot.kind === 'human' && slot.owner != null
      e.dot.className = `dot${remote ? (slot.connected ? ' on' : ' bad') : ''}`
      const free = slot.kind === 'human' && slot.owner == null
      let kindText = KIND_NAMES[slot.kind]
      if (!host) kindText = m.mySlot === i ? 'SOLTAR' : free ? 'TOMAR' : KIND_NAMES[slot.kind]
      setLabel(e.kindLabel, kindText, slot.kind === 'human' ? 0xffd23a : slot.kind === 'ai' ? 0x9ad0ff : 0x8a8078)
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
    const out: Row[] = []
    for (let i = 0; i < MAX_PLAYERS; i++) if (!this.locked(i)) out.push({ t: 'slot', i })
    if (this.isHost()) OPTIONS.forEach((_, i) => out.push({ t: 'opt', i }))
    out.push({ t: 'copy' })
    if (this.isHost()) out.push({ t: 'start' })
    out.push({ t: 'leave' })
    return out
  }

  // ---------- v3: perfil ----------

  // Celdas de un casillero que se pueden elegir con izquierda/derecha.
  private cellsOf(i: number): Cell[] {
    const slot = this.model?.lobby.slots[i]
    if (!slot || this.locked(i)) return ['kind']
    if (this.model?.mySlot === i && slot.kind === 'human') return ['crew', 'color', 'name', 'kind']
    if (this.isHost() && slot.kind === 'ai') return ['name', 'kind']
    return ['kind']
  }

  private mine(): LobbySlot | null {
    const m = this.model
    return m && m.mySlot != null ? (m.lobby.slots[m.mySlot] ?? null) : null
  }

  private myName(): string {
    return cleanName(this.mine()?.name ?? '')
  }

  // Pide el perfil propio con los cambios dados (el resto, como está en el lobby).
  private sendProfile(change: Partial<LobbyProfile>): void {
    const m = this.model
    const slot = this.mine()
    if (!m || !slot || m.mySlot == null) return
    this.profileCb({ name: this.draft ?? slot.name, crew: slot.crew, color: slotColor(slot, m.mySlot), ...change })
  }

  // Otros casilleros ocupados (sus tripulantes y colores no se pueden repetir).
  private others(): LobbySlot[] {
    const m = this.model
    if (!m) return []
    return m.lobby.slots.filter((s, j) => j !== m.mySlot && s.kind !== 'off' && !this.locked(j))
  }

  private activateCell(i: number, c: Cell): void {
    const m = this.model
    const slot = m?.lobby.slots[i]
    if (!m || !slot) return
    if (c === 'kind') return this.pickSlot(i)
    if (c === 'name' && slot.kind === 'ai') {
      if (this.isHost()) this.personalityCb(i, nextPersonality(slot.personality))
      return
    }
    if (m.mySlot !== i) return
    if (c === 'crew') this.sendProfile({ crew: nextCrew(slot.crew, new Set(this.others().map((o) => o.crew))) })
    else if (c === 'color') {
      const taken = new Set(this.others().map((o) => slotColor(o, m.lobby.slots.indexOf(o))))
      this.sendProfile({ color: nextColor(slotColor(slot, i), taken) })
    } else if (c === 'name') {
      const input = this.slotEls[i]?.input
      if (input && !input.hidden) input.focus()
      else if (this.editing) this.stopEditing()
      else {
        this.editing = true
        this.draft = this.myName()
      }
    }
  }

  private stopEditing(): void {
    if (!this.editing) return
    this.editing = false
    if (this.draft != null) this.sendProfile({ name: this.draft.trim() })
    this.draft = null
    this.sync()
  }

  // Escritura del nombre propio con el teclado.
  private rawKey(e: KeyboardEvent): boolean {
    if (!this.editing) return false
    const d = this.draft ?? ''
    if (e.key === 'Enter' || e.key === 'Escape') {
      this.stopEditing()
      return true
    }
    let next = d
    if (e.key === 'Backspace') next = d.slice(0, -1)
    else if (e.key === ' ') next = d.length > 0 && !d.endsWith(' ') ? d + ' ' : d
    else if (e.key.length === 1 && cleanName(e.key) !== '') next = cleanName(d + e.key)
    else return true // flechas y demás no mueven el cursor mientras se escribe
    next = next.slice(0, NAME_MAX)
    if (next !== d) {
      this.draft = next
      this.sendProfile({ name: next })
    }
    this.sync()
    return true
  }

  private pickSlot(i: number): void {
    const m = this.model
    const h = this.handlers
    if (!m || !h) return
    const slot = m.lobby.slots[i]
    if (!slot || this.locked(i)) return
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
    if (cur.t === 'slot') this.activateCell(cur.i, this.cellsOf(cur.i).includes(this.cell) ? this.cell : 'kind')
    else if (cur.t === 'opt') this.pickOption(cur.i)
    else if (cur.t === 'copy') this.copy()
    else if (cur.t === 'start') this.start()
    else this.handlers?.leave()
  }

  private nav(nav: Nav): void {
    const rows = this.rows()
    if (nav === 'back') return this.handlers?.leave()
    if (nav === 'start') return this.start()
    const cur = rows[this.cursor]
    const at = (r: (x: Row) => boolean) => rows.findIndex(r)
    const slotAt = (i: number) => at((x) => x.t === 'slot' && x.i === i)
    const firstOther = at((x) => x.t !== 'slot')
    if (nav === 'ok') return this.activate()
    if (cur?.t === 'slot' && (nav === 'left' || nav === 'right')) {
      // v3: primero se recorren las celdas del casillero (tripulante, color, nombre, tipo)
      const cells = this.cellsOf(cur.i)
      const at = Math.max(0, cells.indexOf(this.cell))
      const next = at + (nav === 'left' ? -1 : 1)
      if (next >= 0 && next < cells.length) {
        this.cell = cells[next]
        return this.sync()
      }
    }
    if (cur?.t === 'slot') {
      // grilla de dos columnas: arriba/abajo dentro de la columna, izquierda/derecha cambia de columna
      const side = cur.i >= SLOT_ROWS ? 1 : 0
      const r = cur.i % SLOT_ROWS
      this.side = side
      if (nav === 'down') this.cursor = r < SLOT_ROWS - 1 && slotAt(cur.i + 1) >= 0 ? slotAt(cur.i + 1) : firstOther
      else if (nav === 'up') this.cursor = r > 0 ? slotAt(cur.i - 1) : rows.length - 1
      else {
        const j = slotAt(side ? cur.i - SLOT_ROWS : cur.i + SLOT_ROWS)
        if (j >= 0) this.cursor = j
        // misma fila del otro lado bloqueada: va al último habilitado de esa columna
        else if (!side) {
          for (let k = SLOT_ROWS * 2 - 1; k >= SLOT_ROWS; k--) if (slotAt(k) >= 0 && k - SLOT_ROWS <= r) {
            this.cursor = slotAt(k)
            break
          }
        }
      }
    } else if (nav === 'up' && this.cursor === firstOther) {
      // vuelve al último casillero de la columna en la que estaba
      let k = this.side * SLOT_ROWS + SLOT_ROWS - 1
      while (k > 0 && slotAt(k) < 0) k--
      this.cursor = Math.max(0, slotAt(k))
    } else if (nav === 'up') this.cursor = (this.cursor + rows.length - 1) % rows.length
    else if (nav === 'down') this.cursor = (this.cursor + 1) % rows.length
    else if (cur?.t === 'opt') this.pickOption(cur.i, nav === 'left' ? -1 : 1)
    // al llegar a otro casillero, la celda queda en una válida (el tipo, o la primera si viene de la izquierda)
    const now = this.rows()[this.cursor]
    if (now?.t === 'slot') {
      const cells = this.cellsOf(now.i)
      if (!cells.includes(this.cell)) this.cell = nav === 'right' ? cells[0] : 'kind'
    }
    this.sync()
  }
}
