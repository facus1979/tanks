// Menú de partida: 4 casilleros (humano / IA / vacío, nombre, tripulante), rondas, dificultad, bioma y tamaño del mapa.
import { CREWS, MAP_SIZE_ORDER, TANK_COLORS, type Biome, type CrewId, type Difficulty, type MapSize, type MatchConfig, type PlayerKind, type SlotConfig } from '../sim/types'
import { DEFAULT_CONFIG, type MenuView } from './types'
import { bindNav, button, el, label, portrait, screenRoot, setLabel, setPortrait, type Nav } from './kit'

export { refreshLabels, uiScale } from './kit'

type SlotKind = PlayerKind | 'empty'
interface Slot {
  kind: SlotKind
  name: string
  crew: CrewId
}
type BiomeChoice = Biome | 'random' | 'rotate'

const ROUNDS = [1, 3, 5, 10]
const DIFFICULTIES: { id: Difficulty; name: string }[] = [
  { id: 'easy', name: 'FACIL' },
  { id: 'normal', name: 'NORMAL' },
  { id: 'hard', name: 'DIFICIL' },
]
const BIOME_CHOICES: { id: BiomeChoice; name: string }[] = [
  { id: 'forest', name: 'BOSQUE' },
  { id: 'jungle', name: 'JUNGLA' },
  { id: 'industrial', name: 'INDUSTRIAL' },
  { id: 'random', name: 'AL AZAR' },
  { id: 'rotate', name: 'ROTATIVO' },
]
// v2: Chico 800 (una pantalla), Mediano 1600 y Grande 2400 de ancho
export const SIZE_NAMES: Record<MapSize, string> = { small: 'CHICO', medium: 'MEDIANO', large: 'GRANDE' }
const SIZE_CHOICES: { id: MapSize; name: string }[] = MAP_SIZE_ORDER.map((id) => ({ id, name: SIZE_NAMES[id] }))
const KIND_NAMES: Record<SlotKind, string> = { human: 'HUMANO', ai: 'IA', empty: 'VACIO' }
const KIND_CYCLE: SlotKind[] = ['human', 'ai', 'empty']
const CREW_NAMES: Record<CrewId, string> = {
  bandana: 'BANDANA',
  sarge: 'SARGENTO',
  rookie: 'NOVATO',
  desert: 'DESIERTO',
  commando: 'COMANDO',
  goggles: 'TANQUISTA',
  pilot: 'PILOTO',
  colonel: 'CORONEL',
}
const NAME_MAX = 10
const STORE = 'tanks.menu2'

// Filas navegables: 0-3 casilleros (columnas kind/crew/name), 4 rondas, 5 dificultad, 6 bioma, 7 mapa, 8 jugar.
const ROW_ROUNDS = 4
const ROW_DIFF = 5
const ROW_BIOME = 6
const ROW_SIZE = 7
const ROW_PLAY = 8
const ROW_COUNT = 9

export function createMenuView(root?: HTMLElement): MenuView & { onOnline(cb: () => void): void } {
  return new MenuScreen(root ?? screenRoot('menu-view'))
}

export class MenuScreen implements MenuView {
  private slots: Slot[] = []
  private rounds = 3
  private difficulty: Difficulty = 'normal'
  private biome: BiomeChoice = 'rotate'
  private size: MapSize = DEFAULT_CONFIG.size ?? 'medium'
  private row = 0
  private col = 0
  private editing = false
  private onPlay: (config: MatchConfig) => void = () => {}
  private unbind: (() => void) | null = null
  private playBtn!: HTMLButtonElement
  private onlineBtn!: HTMLButtonElement
  private onOnlineCb: () => void = () => {}
  private msg!: HTMLElement
  private slotEls: { root: HTMLElement; kind: HTMLElement; crew: HTMLElement; name: HTMLElement; num: HTMLElement; portrait: HTMLCanvasElement; kindLabel: HTMLCanvasElement; nameLabel: HTMLCanvasElement; numLabel: HTMLCanvasElement }[] = []
  private optionEls: { rounds: HTMLButtonElement[]; diff: HTMLButtonElement[]; biome: HTMLButtonElement[]; size: HTMLButtonElement[] } = { rounds: [], diff: [], biome: [], size: [] }
  private msgLabel!: HTMLCanvasElement

  constructor(private root: HTMLElement) {
    this.root.classList.add('solid')
  }

  show(initial: MatchConfig | null, onPlay: (config: MatchConfig) => void): void {
    this.onPlay = onPlay
    this.load(initial ?? this.saved() ?? DEFAULT_CONFIG)
    this.row = ROW_PLAY
    this.col = 0
    this.editing = false
    this.build()
    this.root.hidden = false
    this.unbind?.()
    this.unbind = bindNav(
      (nav) => this.nav(nav),
      (e) => this.rawKey(e),
    )
  }

  hide(): void {
    this.unbind?.()
    this.unbind = null
    this.root.hidden = true
  }

  // ---------- modelo ----------

  private load(config: MatchConfig): void {
    this.slots = [0, 1, 2, 3].map((i) => {
      const s = config.slots[i]
      return { kind: s ? s.kind : 'empty', name: s?.name ?? '', crew: s?.crew ?? CREWS[i] }
    })
    this.rounds = ROUNDS.includes(config.rounds) ? config.rounds : 3
    this.difficulty = config.difficulty
    this.biome = config.biome ?? 'rotate'
    // una config guardada antes de v2 no trae size: arranca en el tamaño por defecto
    this.size = config.size && MAP_SIZE_ORDER.includes(config.size) ? config.size : (DEFAULT_CONFIG.size ?? 'medium')
  }

  private saved(): MatchConfig | null {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as MatchConfig | null
      if (raw && Array.isArray(raw.slots) && raw.slots.length >= 2) return raw
    } catch {
      // sin storage
    }
    return null
  }

  private config(): MatchConfig {
    const slots: SlotConfig[] = this.slots
      .filter((s) => s.kind !== 'empty')
      .map((s) => {
        const out: SlotConfig = { kind: s.kind as PlayerKind, crew: s.crew }
        if (s.name.trim()) out.name = s.name.trim()
        return out
      })
    return { slots, rounds: this.rounds, difficulty: this.difficulty, biome: this.biome, size: this.size }
  }

  private occupied(): number {
    return this.slots.filter((s) => s.kind !== 'empty').length
  }

  // ---------- vista ----------

  private build(): void {
    this.slotEls = []
    const frame = el('div', 'frame')
    const title = el('div', 'title')
    title.append(label('NUEVA PARTIDA', 0xffd23a, 2, 'title'))

    const slotsBox = el('div', 'slots')
    this.slots.forEach((slot, i) => {
      const row = el('div', 'slot')
      const num = el('div', 'num')
      const numLabel = label(`P${i + 1}`, TANK_COLORS[i] ?? 0xffffff)
      num.append(numLabel)
      const kind = el('div', 'cell kind')
      const kindLabel = label(KIND_NAMES[slot.kind])
      kind.append(kindLabel)
      const crew = el('div', 'cell crew')
      const port = portrait(slot.crew, TANK_COLORS[i] ?? 0xffffff, 1)
      crew.append(port)
      const name = el('div', 'cell name')
      const nameLabel = label('')
      name.append(nameLabel)
      kind.addEventListener('click', () => this.pick(i, 0, true))
      crew.addEventListener('click', () => this.pick(i, 1, true))
      name.addEventListener('click', () => this.pick(i, 2, true))
      row.append(num, kind, crew, name)
      slotsBox.append(row)
      this.slotEls.push({ root: row, kind, crew, name, num, portrait: port, kindLabel, nameLabel, numLabel })
    })

    const opts = el('div', 'rows')
    opts.append(
      this.optionRow('RONDAS', ROUNDS.map((n) => ({ key: String(n), text: String(n) })), () => String(this.rounds), (k) => (this.rounds = Number(k)), this.optionEls.rounds = [], ROW_ROUNDS),
      this.optionRow('DIFICULTAD', DIFFICULTIES.map((d) => ({ key: d.id, text: d.name })), () => this.difficulty, (k) => (this.difficulty = k as Difficulty), this.optionEls.diff = [], ROW_DIFF),
      this.optionRow('BIOMA', BIOME_CHOICES.map((b) => ({ key: b.id, text: b.name })), () => this.biome, (k) => (this.biome = k as BiomeChoice), this.optionEls.biome = [], ROW_BIOME),
      this.optionRow('MAPA', SIZE_CHOICES.map((z) => ({ key: z.id, text: z.name })), () => this.size, (k) => (this.size = k as MapSize), this.optionEls.size = [], ROW_SIZE),
    )

    this.msgLabel = label('', 0xff8a6a)
    this.msg = el('div', 'msg')
    this.msg.append(this.msgLabel)
    this.playBtn = button('JUGAR', () => this.play(), 'play')
    this.onlineBtn = button('ONLINE', () => this.online(), 'play online')
    const go = el('div', 'actions')
    go.append(this.playBtn, this.onlineBtn)
    const hint = el('div', 'hint')
    const hl = el('div', 'hint-line')
    hl.append(label('FLECHAS MOVER   ESPACIO ELEGIR   ESC SALIR DEL NOMBRE', 0x9a8e80))
    hint.append(hl)
    frame.append(title, slotsBox, opts, this.msg, go, hint)
    this.root.replaceChildren(frame)
    this.sync()
  }

  private optionRow(
    name: string,
    options: { key: string; text: string }[],
    get: () => string,
    set: (key: string) => void,
    store: HTMLButtonElement[],
    rowIndex: number,
  ): HTMLElement {
    const row = el('div', 'row')
    const head = el('div', 'row-name')
    head.append(label(name, 0xc4a574))
    const group = el('div', 'seg')
    for (const o of options) {
      const b = button(o.text, () => {
        this.row = rowIndex
        set(o.key)
        this.sync()
      })
      b.dataset.key = o.key
      store.push(b)
      group.append(b)
    }
    void get
    row.append(head, group)
    return row
  }

  // Repinta todo lo que depende del modelo y del cursor.
  private sync(): void {
    let n = 0
    this.slots.forEach((s, i) => {
      const e = this.slotEls[i]
      const empty = s.kind === 'empty'
      const color = empty ? 0x4a4440 : (TANK_COLORS[n] ?? 0xffffff)
      if (!empty) n++
      e.root.classList.toggle('empty', empty)
      setLabel(e.kindLabel, KIND_NAMES[s.kind], s.kind === 'human' ? 0xffd23a : s.kind === 'ai' ? 0x9ad0ff : 0x8a8078)
      setLabel(e.numLabel, empty ? '-' : `P${n}`, color)
      setPortrait(e.portrait, s.crew, color)
      const shown = s.name || CREW_NAMES[s.crew]
      const cursor = this.editing && this.row === i && this.col === 2 ? '_' : ''
      setLabel(e.nameLabel, empty ? '' : shown.toUpperCase() + cursor, s.name || cursor ? 0xffffff : 0x9a8e80)
      e.kind.classList.toggle('sel', this.row === i && this.col === 0)
      e.crew.classList.toggle('sel', this.row === i && this.col === 1)
      e.name.classList.toggle('sel', this.row === i && this.col === 2)
    })
    const mark = (list: HTMLButtonElement[], value: string, row: number) => {
      for (const b of list) {
        b.classList.toggle('on', b.dataset.key === value)
        b.classList.toggle('sel', this.row === row && b.dataset.key === value)
      }
    }
    mark(this.optionEls.rounds, String(this.rounds), ROW_ROUNDS)
    mark(this.optionEls.diff, this.difficulty, ROW_DIFF)
    mark(this.optionEls.biome, this.biome, ROW_BIOME)
    mark(this.optionEls.size, this.size, ROW_SIZE)
    const ok = this.occupied() >= 2
    this.playBtn.classList.toggle('dis', !ok)
    this.playBtn.classList.toggle('sel', this.row === ROW_PLAY && this.col !== 1)
    this.onlineBtn.classList.toggle('sel', this.row === ROW_PLAY && this.col === 1)
    setLabel(this.msgLabel, ok ? '' : 'MINIMO 2 JUGADORES')
  }

  // ---------- entrada ----------

  private pick(row: number, col: number, activate: boolean): void {
    this.row = row
    this.col = col
    if (activate) this.activate()
    else this.sync()
  }

  private activate(): void {
    if (this.row < 4) {
      const s = this.slots[this.row]
      if (this.col === 0) {
        s.kind = KIND_CYCLE[(KIND_CYCLE.indexOf(s.kind) + 1) % KIND_CYCLE.length]
        this.editing = false
      } else if (this.col === 1) this.cycleCrew(this.row, 1)
      else if (s.kind !== 'empty') this.editing = !this.editing
    } else if (this.row === ROW_PLAY) {
      if (this.col === 1) this.online()
      else this.play()
    }
    this.sync()
  }

  // Salta los tripulantes que ya usa otro casillero ocupado, si alcanza.
  private cycleCrew(i: number, dir: number): void {
    const s = this.slots[i]
    const taken = new Set(this.slots.filter((o, j) => j !== i && o.kind !== 'empty').map((o) => o.crew))
    let idx = CREWS.indexOf(s.crew)
    for (let k = 0; k < CREWS.length; k++) {
      idx = (idx + dir + CREWS.length) % CREWS.length
      if (!taken.has(CREWS[idx])) break
    }
    s.crew = CREWS[idx]
  }

  private nav(nav: Nav): void {
    if (this.editing) {
      if (nav === 'ok' || nav === 'back') this.editing = false
      this.sync()
      return
    }
    if (nav === 'back') return
    if (nav === 'start') return this.play()
    if (nav === 'up') this.row = (this.row + ROW_COUNT - 1) % ROW_COUNT
    else if (nav === 'down') this.row = (this.row + 1) % ROW_COUNT
    else if (nav === 'ok') return this.activate()
    else {
      const dir = nav === 'left' ? -1 : 1
      if (this.row < 4) this.col = Math.max(0, Math.min(2, this.col + dir))
      else if (this.row === ROW_PLAY) this.col = Math.max(0, Math.min(1, this.col + dir))
      else if (this.row === ROW_ROUNDS) this.rounds = ROUNDS[(ROUNDS.indexOf(this.rounds) + dir + ROUNDS.length) % ROUNDS.length]
      else if (this.row === ROW_DIFF) {
        const i = DIFFICULTIES.findIndex((d) => d.id === this.difficulty)
        this.difficulty = DIFFICULTIES[(i + dir + DIFFICULTIES.length) % DIFFICULTIES.length].id
      } else if (this.row === ROW_BIOME) {
        const i = BIOME_CHOICES.findIndex((b) => b.id === this.biome)
        this.biome = BIOME_CHOICES[(i + dir + BIOME_CHOICES.length) % BIOME_CHOICES.length].id
      } else if (this.row === ROW_SIZE) {
        const i = SIZE_CHOICES.findIndex((z) => z.id === this.size)
        this.size = SIZE_CHOICES[(i + dir + SIZE_CHOICES.length) % SIZE_CHOICES.length].id
      }
    }
    if (this.row < 4 && this.slots[this.row].kind === 'empty' && this.col === 2) this.col = 1
    if (this.row >= 4) this.col = this.row === ROW_PLAY ? Math.min(this.col, 1) : 0
    this.sync()
  }

  // Edición del nombre y atajos de letras.
  private rawKey(e: KeyboardEvent): boolean {
    if (!this.editing) return false
    const s = this.slots[this.row]
    if (!s) return false
    if (e.key === 'Enter' || e.key === 'Escape') {
      this.editing = false
    } else if (e.key === 'Backspace') s.name = s.name.slice(0, -1)
    else if (e.key.length === 1 && /[a-zA-Z0-9 ]/.test(e.key) && s.name.length < NAME_MAX) s.name += e.key.toUpperCase()
    else return true
    this.sync()
    return true
  }

  onOnline(cb: () => void): void {
    this.onOnlineCb = cb
  }

  private online(): void {
    this.onOnlineCb()
  }

  private play(): void {
    if (this.occupied() < 2) {
      this.sync()
      return
    }
    const config = this.config()
    try {
      localStorage.setItem(STORE, JSON.stringify(config))
    } catch {
      // ignorado
    }
    this.onPlay(config)
  }
}
