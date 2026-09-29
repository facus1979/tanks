// Menú online: crear sala, unirse con código (o pegando el link) y volver.
import { bindNav, button, el, label, screenRoot, setLabel, type Nav } from './kit'
import type { OnlineMenuView } from './types'
import { isTouchDevice } from '../input/touch'

// Acepta el link completo (?join=TANK-4F7K) o el código suelto y lo normaliza a TANK-XXXX.
export function normalizeCode(raw: string): string {
  let s = raw.trim()
  const m = /[?&]join=([^&#\s]+)/i.exec(s)
  if (m) s = decodeURIComponent(m[1])
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.startsWith('TANK')) s = s.slice(4)
  return s ? `TANK-${s.slice(0, 4)}` : ''
}

const CODE_LEN = 'TANK-XXXX'.length

export function createOnlineMenuView(root?: HTMLElement): OnlineMenuView {
  return new OnlineScreen(root ?? screenRoot('online-view'))
}

// Filas navegables: 0 crear, 1 campo del código, 2 unirse, 3 volver.
class OnlineScreen implements OnlineMenuView {
  private row = 0
  private text = ''
  private unbind: (() => void) | null = null
  private handlers: { host: () => void; join: (code: string) => void; back: () => void } | null = null
  private hostBtn!: HTMLButtonElement
  private joinBtn!: HTMLButtonElement
  private backBtn!: HTMLButtonElement
  private field!: HTMLElement
  private fieldLabel!: HTMLCanvasElement
  private input: HTMLInputElement | null = null
  private msgLabel!: HTMLCanvasElement
  private blink = 0
  private caret = true
  private onPaste = (e: ClipboardEvent) => {
    if (this.root.hidden) return
    const t = e.clipboardData?.getData('text')
    if (!t) return
    e.preventDefault()
    this.text = normalizeCode(t)
    this.row = 1
    this.sync()
  }

  constructor(private root: HTMLElement) {
    this.root.classList.add('solid')
  }

  show(handlers: { host: () => void; join: (code: string) => void; back: () => void }, prefill?: string): void {
    this.handlers = handlers
    this.text = prefill ? normalizeCode(prefill) : ''
    this.row = this.text ? 2 : 0
    this.build()
    this.root.hidden = false
    this.unbind?.()
    this.unbind = bindNav(
      (nav) => this.nav(nav),
      (e) => this.rawKey(e),
    )
    document.addEventListener('paste', this.onPaste)
    clearInterval(this.blink)
    this.blink = window.setInterval(() => {
      this.caret = !this.caret
      if (this.row === 1) this.sync()
    }, 500)
  }

  hide(): void {
    this.unbind?.()
    this.unbind = null
    document.removeEventListener('paste', this.onPaste)
    clearInterval(this.blink)
    this.root.hidden = true
  }

  error(message: string): void {
    if (this.msgLabel) setLabel(this.msgLabel, message.toUpperCase(), 0xff8a6a)
  }

  private build(): void {
    const frame = el('div', 'frame online-frame')
    const title = el('div', 'title')
    title.append(label('JUGAR ONLINE', 0xffd23a, 2, 'title'))
    this.hostBtn = button('CREAR SALA', () => this.pick(0), 'play')
    const sep = el('div', 'hint-line')
    sep.append(label('O UNIRSE A UNA SALA', 0xc4a574))
    this.field = el('div', 'cell code-field')
    this.fieldLabel = label('')
    this.field.append(this.fieldLabel)
    this.field.addEventListener('click', () => {
      this.row = 1
      this.sync()
    })
    if (isTouchDevice()) {
      // En táctil el campo tiene un input real encima (invisible) para que aparezca el teclado del sistema.
      const input = document.createElement('input')
      input.className = 'code-input'
      input.setAttribute('inputmode', 'text')
      input.setAttribute('autocapitalize', 'characters')
      input.setAttribute('autocomplete', 'off')
      input.spellcheck = false
      input.value = this.text
      input.addEventListener('focus', () => {
        this.row = 1
        this.sync()
      })
      input.addEventListener('input', () => {
        this.text = normalizeCode(input.value)
        this.sync()
      })
      this.field.append(input)
      this.input = input
    }
    this.joinBtn = button('UNIRSE', () => this.pick(2))
    const join = el('div', 'actions')
    join.append(this.field, this.joinBtn)
    this.msgLabel = label('', 0xff8a6a)
    const msg = el('div', 'msg')
    msg.append(this.msgLabel)
    this.backBtn = button('VOLVER', () => this.pick(3))
    const hint = el('div', 'hint')
    const hl = el('div', 'hint-line')
    hl.append(label('ESCRIBI O PEGA EL CODIGO O EL LINK', 0x9a8e80))
    hint.append(hl)
    frame.append(title, this.hostBtn, sep, join, msg, this.backBtn, hint)
    this.root.replaceChildren(frame)
    this.sync()
  }

  private sync(): void {
    const shown = this.text || (this.row === 1 ? '' : 'TANK-XXXX')
    const cursor = this.row === 1 && this.caret && this.text.length < CODE_LEN ? '-' : ''
    setLabel(this.fieldLabel, shown + cursor, this.text ? 0xffffff : 0x6a625a)
    this.hostBtn.classList.toggle('sel', this.row === 0)
    this.field.classList.toggle('sel', this.row === 1)
    this.joinBtn.classList.toggle('sel', this.row === 2)
    this.joinBtn.classList.toggle('dis', normalizeCode(this.text).length < CODE_LEN)
    this.backBtn.classList.toggle('sel', this.row === 3)
  }

  private pick(row: number): void {
    this.row = row
    this.activate()
  }

  private activate(): void {
    if (!this.handlers) return
    if (this.row === 0) this.handlers.host()
    else if (this.row === 1 || this.row === 2) {
      const code = normalizeCode(this.text)
      if (code.length < CODE_LEN) {
        this.error('CODIGO INCOMPLETO')
        this.sync()
        return
      }
      setLabel(this.msgLabel, '')
      this.handlers.join(code)
    } else this.handlers.back()
  }

  private nav(nav: Nav): void {
    if (nav === 'back') return this.handlers?.back()
    if (nav === 'up') this.row = (this.row + 3) % 4
    else if (nav === 'down') this.row = (this.row + 1) % 4
    else if (nav === 'ok' || nav === 'start') return this.activate()
    this.sync()
  }

  // En el campo del código las letras son texto.
  private rawKey(e: KeyboardEvent): boolean {
    // Con el input táctil enfocado, las letras las escribe el propio input; Enter confirma.
    if (this.input && e.target === this.input) {
      if (e.key !== 'Enter') return false
      this.activate()
      return true
    }
    if (this.row !== 1) return false
    if (e.key === 'Backspace') this.text = this.text.slice(0, -1)
    else if (e.key.length === 1 && /[a-zA-Z0-9-]/.test(e.key) && this.text.length < CODE_LEN) this.text += e.key.toUpperCase()
    else return false
    this.sync()
    return true
  }
}
