// Tabla entre rondas y pantalla final con el campeón.
import { bindNav, button, el, label, portrait, screenRoot, type Nav } from './kit'
import type { ScoreModel, ScoreRow, ScoreboardView } from './types'

export function createScoreboardView(root?: HTMLElement): ScoreboardView {
  return new ScoreboardScreen(root ?? screenRoot('score-view', 'dim'))
}

const GOLD = 0xffd23a
const GREY = 0x9a8e80

class ScoreboardScreen implements ScoreboardView {
  private unbind: (() => void) | null = null

  constructor(private root: HTMLElement) {
    this.root.classList.add('dim')
  }

  show(model: ScoreModel, onContinue: () => void, onMenu: () => void): void {
    const frame = el('div', 'frame')
    const title = el('div', 'title')
    const winner = model.rows.find((r) => r.id === model.winnerId) ?? null
    if (model.final) {
      title.append(label('FIN DE LA PARTIDA', GOLD, 2, 'title'))
    } else {
      title.append(label(`RONDA ${model.round} DE ${model.rounds}`, GOLD, 2, 'title'))
    }
    frame.append(title)

    if (model.final) {
      const champ = el('div', 'winner')
      if (winner) {
        champ.append(label('CAMPEON', GOLD, 1), portrait(winner.crew, winner.color, 2), label(winner.name.toUpperCase(), winner.color, 2))
      } else {
        champ.append(label('EMPATE', GOLD, 3))
      }
      frame.append(champ)
    } else {
      const rw = model.rows.find((r) => r.id === model.roundWinnerId)
      const line = el('div', 'subtitle')
      line.append(label(rw ? `GANA LA RONDA ${rw.name.toUpperCase()}` : 'RONDA EMPATADA', rw ? rw.color : GREY, 1))
      frame.append(line)
    }

    frame.append(this.table(model, model.final ? model.winnerId : model.roundWinnerId))

    const actions = el('div', 'actions')
    const cont = button(model.final ? 'REVANCHA' : 'CONTINUAR', () => onContinue(), 'play')
    const menu = button('MENU', () => onMenu())
    actions.append(cont, menu)
    frame.append(actions)
    this.root.replaceChildren(frame)
    this.root.hidden = false

    const buttons = [cont, menu]
    let focus = 0
    const paint = () => buttons.forEach((b, i) => b.classList.toggle('sel', i === focus))
    paint()
    this.unbind?.()
    this.unbind = bindNav((nav: Nav) => {
      if (nav === 'left' || nav === 'right' || nav === 'up' || nav === 'down') {
        focus = 1 - focus
        paint()
      } else if (nav === 'ok') (focus === 0 ? onContinue : onMenu)()
      else if (nav === 'start') onContinue()
      else if (nav === 'back') onMenu()
    })
  }

  hide(): void {
    this.unbind?.()
    this.unbind = null
    this.root.hidden = true
  }

  private table(model: ScoreModel, highlight: number | null): HTMLElement {
    const grid = el('div', 'score-table')
    grid.style.gridTemplateColumns = 'auto 1fr auto auto auto auto auto'
    const head = el('div', 'score-row head')
    const heads = ['', 'JUGADOR', 'VIVO', 'RONDAS', 'KILLS', 'GANO', 'PLATA']
    heads.forEach((h, i) => {
      const cell = el('div', i >= 2 ? 'num-r' : '')
      cell.append(label(h, 0xc4a574))
      head.append(cell)
    })
    grid.append(head)
    const rows = [...model.rows].sort((a, b) => (b.id === highlight ? 1 : 0) - (a.id === highlight ? 1 : 0) || b.roundsWon - a.roundsWon || b.money - a.money)
    for (const r of rows) grid.append(this.row(r, r.id === highlight))
    return grid
  }

  private row(r: ScoreRow, win: boolean): HTMLElement {
    const row = el('div', `score-row${win ? ' win' : ''}${r.alive ? '' : ' dead'}`)
    const face = el('div', '')
    face.append(portrait(r.crew, r.color, 1))
    const name = el('div', '')
    name.append(label((win ? '* ' : '') + r.name.toUpperCase(), win ? GOLD : r.color))
    const cell = (text: string, color = 0xffffff) => {
      const c = el('div', 'num-r')
      c.append(label(text, color))
      return c
    }
    row.append(
      face,
      name,
      cell(r.alive ? 'SI' : 'NO', r.alive ? 0x7ae06a : 0xd0362c),
      cell(String(r.roundsWon)),
      cell(String(r.kills)),
      cell(`+$${r.earned}`, r.earned > 0 ? 0x7ae06a : GREY),
      cell(`$${r.money}`, GOLD),
    )
    return row
  }
}
