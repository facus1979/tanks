// Cliente del worker de la IA. Si el worker no arranca o falla, calcula en el hilo principal.
import { chooseShot } from '../sim'
import type { ShotPlan } from '../sim'
import type { Difficulty, GameState } from '../sim/types'
import type { AiRequest, AiResponse } from './ai.worker'
import { seededRandom } from './demo'

const TIMEOUT = 6000

interface Pending {
  resolve: (plan: ShotPlan) => void
  fallback: () => ShotPlan
  timer: number
}

export class AiClient {
  private worker: Worker | null = null
  private failed = false
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor() {
    try {
      this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<AiResponse>) => this.receive(e.data)
      this.worker.onerror = (e) => {
        console.warn('Worker de IA caído, sigo en el hilo principal', e.message)
        this.fail()
      }
    } catch (err) {
      console.warn('Sin worker de IA', err)
      this.worker = null
      this.failed = true
    }
  }

  get available(): boolean {
    return !!this.worker && !this.failed
  }

  // Síncrono: mismo resultado que el worker con la misma seed.
  chooseNow(state: GameState, difficulty: Difficulty, seed: number): ShotPlan {
    return chooseShot(state, difficulty, seededRandom(seed))
  }

  choose(state: GameState, difficulty: Difficulty, seed: number): Promise<ShotPlan> {
    const fallback = () => this.chooseNow(state, difficulty, seed)
    if (!this.available || !this.worker) return Promise.resolve().then(fallback)
    const id = this.nextId++
    return new Promise<ShotPlan>((resolve) => {
      const timer = window.setTimeout(() => {
        if (!this.pending.delete(id)) return
        console.warn('La IA del worker tardó demasiado, sigo en el hilo principal')
        resolve(fallback())
      }, TIMEOUT)
      this.pending.set(id, { resolve, fallback, timer })
      try {
        const msg: AiRequest = { id, state, difficulty, seed }
        this.worker!.postMessage(msg)
      } catch (err) {
        console.warn('No pude mandar el estado al worker', err)
        this.fail()
      }
    })
  }

  private receive(msg: AiResponse): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    window.clearTimeout(p.timer)
    if (msg.plan) p.resolve(msg.plan)
    else {
      if (msg.error) console.error(msg.error)
      p.resolve(p.fallback())
    }
  }

  private fail(): void {
    this.failed = true
    this.worker?.terminate()
    this.worker = null
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) {
      window.clearTimeout(p.timer)
      p.resolve(p.fallback())
    }
  }
}
