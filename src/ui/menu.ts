// Menú de partida: 8 casilleros (humano / IA / vacío, nombre, tripulante), rondas, dificultad, bioma y tamaño del mapa.
// v5: los casilleros van en dos columnas de 4 (P1–P4 a la izquierda, P5–P8 a la derecha). Los que pasan el máximo
// del mapa elegido (MAX_PLAYERS_BY_SIZE: Chico 4, Mediano 6, Grande 8) se ven bloqueados con "SOLO MAPA …".
// v2.3: al achicar el mapa los ocupados se compactan hacia arriba conservando su configuración (compactSlots).
import { CREWS, MAP_SIZE_ORDER, MAX_PLAYERS, MAX_PLAYERS_BY_SIZE, TANK_COLORS, type Biome, type CrewId, type Difficulty, type MapSize, type MatchConfig, type PlayerKind, type SlotConfig } from '../sim/types'
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

// Casilleros por columna: los 8 se reparten en dos columnas de SLOT_ROWS.
const SLOT_ROWS = MAX_PLAYERS / 2
// Columnas de cursor dentro de un casillero (la columna absoluta suma 3 por cada columna de casilleros).
const C_KIND = 0
const C_CREW = 1
const C_NAME = 2

// Filas navegables: 0-3 filas de casilleros, 4 rondas, 5 dificultad, 6 bioma, 7 mapa, 8 jugar.
const ROW_ROUNDS = SLOT_ROWS
const ROW_DIFF = SLOT_ROWS + 1
const ROW_BIOME = SLOT_ROWS + 2
const ROW_SIZE = SLOT_ROWS + 3
const ROW_PLAY = SLOT_ROWS + 4
const ROW_COUNT = SLOT_ROWS + 5

// El tamaño de mapa más chico que admite el casillero i (para el cartel de los bloqueados).
function sizeFor(i: number): MapSize | null {
  return MAP_SIZE_ORDER.find((z) => i < MAX_PLAYERS_BY_SIZE[z]) ?? null
}

// v2.3: regla común para achicar el mapa (menú local y sala online). Si algún casillero ocupado quedó en una
// posición >= limit, los ocupados se corren hacia arriba en su orden, conservando todo lo suyo (humano/IA,
// nombre, tripulante y, en la sala, dueño); los primeros `limit` se quedan y el resto se descarta desde el
// final. Detrás de los que quedan van los vacíos que había (con su tripulante) y después los descartados
// convertidos en vacíos con su mismo tripulante, así el largo de la lista no cambia. Si ningún ocupado
// quedó afuera no se toca nada (los huecos se respetan: el número y el color salen del orden de los
// ocupados, así que la partida es la misma). Devuelve la lista nueva y los descartados, en orden.
export function compactSlots<T extends { crew: CrewId }>(slots: readonly T[], limit: number, used: (s: T) => boolean, empty: (crew: CrewId) => T): { slots: T[]; dropped: T[] } {
  if (!slots.some((s, i) => i >= limit && used(s))) return { slots: [...slots], dropped: [] }
  const occ = slots.filter(used)
  const kept = occ.slice(0, limit)
  const dropped = occ.slice(limit)
  const holes = slots.filter((s) => !used(s))
  return { slots: [...kept, ...holes, ...dropped.map((s) => empty(s.crew))], dropped }
}

// Un casillero vacío cuyo tripulante ya usa un ocupado (u otro vacío anterior) toma el primero libre: así,
// al ocuparlo no repite el de otro. Los ocupados y los vacíos sin choque no se tocan.
function freeCrews(slots: Slot[]): void {
  const taken = new Set(slots.filter((s) => s.kind !== 'empty').map((s) => s.crew))
  for (const s of slots) {
    if (s.kind !== 'empty') continue
    if (taken.has(s.crew)) s.crew = CREWS.find((c) => !taken.has(c)) ?? s.crew
    taken.add(s.crew)
  }
}

// En táctil (html.touch) cada ajuste muestra solo el valor elegido y tocarlo pasa al siguiente.
function isTouch(): boolean {
  return document.documentElement.classList.contains('touch')
}

export function createMenuView(root?: HTMLElement): MenuView & { onOnline(cb: () => void): void } {
  return new MenuScreen(root ?? screenRoot('menu-view'))
}

interface SlotEls {
  root: HTMLElement
  kind: HTMLElement
  crew: HTMLElement
  name: HTMLElement
  num: HTMLElement
  portrait: HTMLCanvasElement
  kindLabel: HTMLCanvasElement
  nameLabel: HTMLCanvasElement
  numLabel: HTMLCanvasElement
}

export class MenuScreen implements MenuView {
  private slots: Slot[] = []
  // Casilleros descartados al achicar el mapa (en orden): si se vuelve a agrandar en esta misma pantalla, vuelven.
  private parked: Slot[] = []
  private notice = ''
  private rounds = 3
  private difficulty: Difficulty = 'normal'
  private biome: BiomeChoice = 'rotate'
  private size: MapSize = DEFAULT_CONFIG.size ?? 'medium'
  private row = 0
  private col = 0
  private slotCol = 0 // última columna usada en las filas de casilleros
  private editing = false
  private onPlay: (config: MatchConfig) => void = () => {}
  private unbind: (() => void) | null = null
  private playBtn!: HTMLButtonElement
  private onlineBtn!: HTMLButtonElement
  private onOnlineCb: () => void = () => {}
  private msg!: HTMLElement
  private slotEls: SlotEls[] = []
  private optionEls: { rounds: HTMLButtonElement[]; diff: HTMLButtonElement[]; biome: HTMLButtonElement[]; size: HTMLButtonElement[] } = { rounds: [], diff: [], biome: [], size: [] }
  private msgLabel!: HTMLCanvasElement
  private capLabel!: HTMLCanvasElement

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
    // una config de antes de v5 trae hasta 4 casilleros: el resto queda vacío
    this.slots = Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const s = config.slots[i]
      return { kind: s ? s.kind : 'empty', name: s?.name ?? '', crew: s?.crew ?? CREWS[i] }
    })
    this.rounds = ROUNDS.includes(config.rounds) ? config.rounds : 3
    this.difficulty = config.difficulty
    this.biome = config.biome ?? 'rotate'
    // una config guardada antes de v2 no trae size: arranca en el tamaño por defecto
    this.size = config.size && MAP_SIZE_ORDER.includes(config.size) ? config.size : (DEFAULT_CONFIG.size ?? 'medium')
    this.parked = []
    this.notice = ''
    this.fitSize(true)
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
      .filter((s, i) => s.kind !== 'empty' && !this.locked(i))
      .map((s) => {
        const out: SlotConfig = { kind: s.kind as PlayerKind, crew: s.crew }
        if (s.name.trim()) out.name = s.name.trim()
        return out
      })
    return { slots, rounds: this.rounds, difficulty: this.difficulty, biome: this.biome, size: this.size }
  }

  private limit(): number {
    return MAX_PLAYERS_BY_SIZE[this.size] ?? MAX_PLAYERS
  }

  private locked(i: number): boolean {
    return i >= this.limit()
  }

  private occupied(): number {
    return this.slots.filter((s, i) => s.kind !== 'empty' && !this.locked(i)).length
  }

  private setSize(size: MapSize): void {
    if (size === this.size) return
    this.size = size
    this.fitSize(false)
  }

  // Ajusta los casilleros al máximo del mapa (v2.3, la misma regla que el anfitrión online en src/net/host.ts):
  // si algún ocupado queda afuera, se compactan (ver compactSlots) y los que no entran se descartan desde el
  // final, con un aviso. Extra del menú local: los descartados se recuerdan mientras dure esta pantalla y, si
  // se vuelve a agrandar el mapa, entran de nuevo en orden en los primeros casilleros vacíos habilitados
  // (con su tripulante, o con uno libre si ya lo tomó otro). Tocar el tipo de un casillero los olvida.
  private fitSize(silent: boolean): void {
    const limit = this.limit()
    const { slots, dropped } = compactSlots(this.slots, limit, (s) => s.kind !== 'empty', (crew): Slot => ({ kind: 'empty', name: '', crew }))
    this.slots = slots
    this.parked = [...dropped, ...this.parked]
    // recupera los descartados antes, en orden, si ahora entran
    while (this.parked.length) {
      const i = this.slots.findIndex((s, k) => k < limit && s.kind === 'empty')
      if (i < 0) break
      const back = this.parked.shift() as Slot
      const taken = new Set(this.slots.filter((o) => o.kind !== 'empty').map((o) => o.crew))
      const crew = taken.has(back.crew) ? (CREWS.find((c) => !taken.has(c)) ?? back.crew) : back.crew
      this.slots[i] = { ...back, crew }
    }
    freeCrews(this.slots)
    if (silent) return
    const n = dropped.length
    this.notice = n > 0 ? `${n === 1 ? '1 CASILLERO QUEDO AFUERA' : `${n} CASILLEROS QUEDARON AFUERA`}: ${SIZE_NAMES[this.size]} ADMITE ${limit}` : ''
    if (this.editing && this.row < SLOT_ROWS && this.locked(this.curSlot())) this.editing = false
  }

  // Casillero bajo el cursor (solo tiene sentido en las filas de casilleros).
  private curSlot(): number {
    return this.row + (this.col >= 3 ? SLOT_ROWS : 0)
  }

  // Columnas de cursor disponibles en una fila de casilleros: se saltean los bloqueados y el nombre de los vacíos.
  private cellsOf(row: number): number[] {
    const out: number[] = []
    for (let side = 0; side < 2; side++) {
      const i = row + side * SLOT_ROWS
      if (this.locked(i)) continue
      out.push(side * 3 + C_KIND, side * 3 + C_CREW)
      if (this.slots[i].kind !== 'empty') out.push(side * 3 + C_NAME)
    }
    return out
  }

  // Lleva el cursor a la celda válida más cercana de su fila.
  private clampCol(): void {
    if (this.row === ROW_PLAY) this.col = Math.max(0, Math.min(1, this.col))
    else if (this.row >= SLOT_ROWS) this.col = 0
    else {
      const cells = this.cellsOf(this.row)
      if (!cells.includes(this.col)) this.col = cells.reduce((best, c) => (Math.abs(c - this.col) < Math.abs(best - this.col) ? c : best), cells[0] ?? 0)
    }
  }

  // ---------- vista ----------

  private build(): void {
    this.slotEls = []
    const frame = el('div', 'frame menu-frame')
    const title = el('div', 'title')
    title.append(label('NUEVA PARTIDA', 0xffd23a, 2, 'title'))

    const slotsBox = el('div', 'slots slots8')
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
      const base = i >= SLOT_ROWS ? 3 : 0
      const r = i % SLOT_ROWS
      kind.addEventListener('click', () => this.pick(r, base + C_KIND))
      crew.addEventListener('click', () => this.pick(r, base + C_CREW))
      name.addEventListener('click', () => this.pick(r, base + C_NAME))
      row.append(num, kind, crew, name)
      slotsBox.append(row)
      this.slotEls.push({ root: row, kind, crew, name, num, portrait: port, kindLabel, nameLabel, numLabel })
    })

    const opts = el('div', 'rows')
    opts.append(
      this.optionRow('RONDAS', ROUNDS.map((n) => ({ key: String(n), text: String(n) })), (k) => (this.rounds = Number(k)), (this.optionEls.rounds = []), ROW_ROUNDS),
      this.optionRow('DIFICULTAD', DIFFICULTIES.map((d) => ({ key: d.id, text: d.name })), (k) => (this.difficulty = k as Difficulty), (this.optionEls.diff = []), ROW_DIFF),
      this.optionRow('BIOMA', BIOME_CHOICES.map((b) => ({ key: b.id, text: b.name })), (k) => (this.biome = k as BiomeChoice), (this.optionEls.biome = []), ROW_BIOME),
      this.optionRow('MAPA', SIZE_CHOICES.map((z) => ({ key: z.id, text: z.name })), (k) => this.setSize(k as MapSize), (this.optionEls.size = []), ROW_SIZE),
    )
    // al lado de "MAPA", cuántos jugadores entran en el tamaño elegido
    this.capLabel = label('', 0x9a8e80)
    opts.lastElementChild?.querySelector('.row-name')?.append(this.capLabel)

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

  private optionRow(name: string, options: { key: string; text: string }[], set: (key: string) => void, store: HTMLButtonElement[], rowIndex: number): HTMLElement {
    const row = el('div', 'row')
    const head = el('div', 'row-name')
    head.append(label(name, 0xc4a574))
    const group = el('div', 'seg')
    options.forEach((o, k) => {
      const b = button(o.text, () => {
        this.row = rowIndex
        // táctil: solo se ve el valor elegido; tocarlo pasa al siguiente
        if (isTouch() && b.classList.contains('on')) set(options[(k + 1) % options.length].key)
        else set(o.key)
        this.sync()
      })
      b.dataset.key = o.key
      store.push(b)
      group.append(b)
    })
    row.append(head, group)
    return row
  }

  // Repinta todo lo que depende del modelo y del cursor.
  private sync(): void {
    let n = 0
    const sel = (i: number, c: number) => this.row === i % SLOT_ROWS && this.col === (i >= SLOT_ROWS ? 3 : 0) + c
    this.slots.forEach((s, i) => {
      const e = this.slotEls[i]
      const locked = this.locked(i)
      const empty = s.kind === 'empty' || locked
      const color = empty ? 0x4a4440 : (TANK_COLORS[n] ?? 0xffffff)
      if (!empty) n++
      e.root.classList.toggle('empty', empty && !locked)
      e.root.classList.toggle('locked', locked)
      if (locked) {
        // bloqueado por el tamaño del mapa: dice desde qué mapa se puede usar
        const need = sizeFor(i)
        setLabel(e.kindLabel, '-', 0x6a625a)
        setLabel(e.numLabel, '-', 0x4a4440)
        setPortrait(e.portrait, s.crew, 0x3a3430)
        setLabel(e.nameLabel, need ? `SOLO MAPA ${SIZE_NAMES[need]}${need === 'large' ? '' : '+'}` : '', 0x7a7068)
      } else {
        setLabel(e.kindLabel, KIND_NAMES[s.kind], s.kind === 'human' ? 0xffd23a : s.kind === 'ai' ? 0x9ad0ff : 0x8a8078)
        setLabel(e.numLabel, empty ? '-' : `P${n}`, color)
        setPortrait(e.portrait, s.crew, color)
        const shown = s.name || CREW_NAMES[s.crew]
        const cursor = this.editing && this.curSlot() === i && this.col % 3 === C_NAME ? '_' : ''
        setLabel(e.nameLabel, empty ? '' : shown.toUpperCase() + cursor, s.name || cursor ? 0xffffff : 0x9a8e80)
      }
      e.kind.classList.toggle('sel', sel(i, C_KIND))
      e.crew.classList.toggle('sel', sel(i, C_CREW))
      e.name.classList.toggle('sel', sel(i, C_NAME))
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
    setLabel(this.capLabel, `HASTA ${this.limit()}`)
    const ok = this.occupied() >= 2
    this.playBtn.classList.toggle('dis', !ok)
    this.playBtn.classList.toggle('sel', this.row === ROW_PLAY && this.col !== 1)
    this.onlineBtn.classList.toggle('sel', this.row === ROW_PLAY && this.col === 1)
    // el aviso de casilleros vaciados es informativo (amarillo); el mínimo de jugadores, un error (rojo)
    if (!ok) setLabel(this.msgLabel, 'MINIMO 2 JUGADORES', 0xff8a6a)
    else setLabel(this.msgLabel, this.notice, 0xffd27a)
  }

  // ---------- entrada ----------

  private pick(row: number, col: number): void {
    this.row = row
    this.col = col
    this.activate()
  }

  private activate(): void {
    if (this.row < SLOT_ROWS) {
      const i = this.curSlot()
      if (this.locked(i)) return this.sync()
      const s = this.slots[i]
      const c = this.col % 3
      if (c === C_KIND) {
        s.kind = KIND_CYCLE[(KIND_CYCLE.indexOf(s.kind) + 1) % KIND_CYCLE.length]
        this.editing = false
        this.notice = ''
        this.parked = []
      } else if (c === C_CREW) this.cycleCrew(i, 1)
      else if (s.kind !== 'empty') this.editing = !this.editing
      this.clampCol()
    } else if (this.row === ROW_PLAY) {
      if (this.col === 1) this.online()
      else this.play()
    }
    this.sync()
  }

  // Salta los tripulantes que ya usa otro casillero ocupado, si alcanza.
  private cycleCrew(i: number, dir: number): void {
    const s = this.slots[i]
    const taken = new Set(this.slots.filter((o, j) => j !== i && o.kind !== 'empty' && !this.locked(j)).map((o) => o.crew))
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
    if (nav === 'up' || nav === 'down') {
      // se recuerda la columna de casilleros al pasar por las opciones, para volver al mismo casillero
      if (this.row < SLOT_ROWS) this.slotCol = this.col
      this.row = (this.row + (nav === 'up' ? ROW_COUNT - 1 : 1)) % ROW_COUNT
      this.col = this.row < SLOT_ROWS ? this.slotCol : 0
    } else if (nav === 'ok') return this.activate()
    else {
      const dir = nav === 'left' ? -1 : 1
      if (this.row < SLOT_ROWS) {
        const cells = this.cellsOf(this.row)
        const at = cells.indexOf(this.col)
        this.col = cells[Math.max(0, Math.min(cells.length - 1, (at < 0 ? 0 : at) + dir))] ?? 0
      } else if (this.row === ROW_PLAY) this.col = Math.max(0, Math.min(1, this.col + dir))
      else if (this.row === ROW_ROUNDS) this.rounds = ROUNDS[(ROUNDS.indexOf(this.rounds) + dir + ROUNDS.length) % ROUNDS.length]
      else if (this.row === ROW_DIFF) {
        const i = DIFFICULTIES.findIndex((d) => d.id === this.difficulty)
        this.difficulty = DIFFICULTIES[(i + dir + DIFFICULTIES.length) % DIFFICULTIES.length].id
      } else if (this.row === ROW_BIOME) {
        const i = BIOME_CHOICES.findIndex((b) => b.id === this.biome)
        this.biome = BIOME_CHOICES[(i + dir + BIOME_CHOICES.length) % BIOME_CHOICES.length].id
      } else if (this.row === ROW_SIZE) {
        const i = SIZE_CHOICES.findIndex((z) => z.id === this.size)
        this.setSize(SIZE_CHOICES[(i + dir + SIZE_CHOICES.length) % SIZE_CHOICES.length].id)
      }
    }
    this.clampCol()
    this.sync()
  }

  // Edición del nombre y atajos de letras.
  private rawKey(e: KeyboardEvent): boolean {
    if (!this.editing || this.row >= SLOT_ROWS) return false
    const s = this.slots[this.curSlot()]
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
