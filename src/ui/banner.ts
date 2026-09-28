// Cartel de hot-seat: "TURNO DE <NOMBRE>" con retrato y color del jugador.
import { bindNav, el, label, portrait, screenRoot } from './kit'
import type { BannerModel, BannerView } from './types'

export function createBannerView(root?: HTMLElement): BannerView {
  return new BannerScreen(root ?? screenRoot('banner-view', 'dim'))
}

class BannerScreen implements BannerView {
  private unbind: (() => void) | null = null
  private blink = 0

  constructor(private root: HTMLElement) {
    this.root.classList.add('dim')
  }

  show(model: BannerModel, onGo: () => void): void {
    const frame = el('div', 'frame banner-frame player')
    frame.style.setProperty('--pc', `#${(model.color & 0xffffff).toString(16).padStart(6, '0')}`)
    frame.style.boxShadow = `0 0 0 var(--px) #${(model.color & 0xffffff).toString(16).padStart(6, '0')}, 0 0 0 calc(var(--px) * 2) var(--out), calc(var(--px) * 4) calc(var(--px) * 4) 0 calc(var(--px) * 2) #000a`
    const round = el('div', 'subtitle')
    round.append(label(`RONDA ${model.round} DE ${model.rounds}`, 0xc4a574))
    const turn = el('div', 'title')
    turn.append(label('TURNO DE', 0xffffff, 2))
    const name = el('div', 'title')
    name.append(label(model.name.toUpperCase(), model.color, 3, 'title'))
    const face = el('div', 'crews')
    face.append(portrait(model.crew, model.color, 3))
    const go = el('div', 'hint')
    const goLabel = label('ESPACIO PARA SEGUIR', 0xffd23a)
    go.append(goLabel)
    frame.append(round, turn, name, face, go)
    this.root.replaceChildren(frame)
    this.root.hidden = false
    clearInterval(this.blink)
    this.blink = window.setInterval(() => {
      goLabel.style.visibility = goLabel.style.visibility === 'hidden' ? 'visible' : 'hidden'
    }, 500)
    this.unbind?.()
    let done = false
    const fire = () => {
      if (done) return
      done = true
      onGo()
    }
    this.unbind = bindNav((nav) => {
      if (nav === 'ok' || nav === 'start') fire()
    })
    this.root.onpointerdown = fire
  }

  hide(): void {
    clearInterval(this.blink)
    this.unbind?.()
    this.unbind = null
    this.root.onpointerdown = null
    this.root.hidden = true
  }
}
