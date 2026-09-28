// IA fuera del hilo principal: recibe el estado serializado y devuelve el plan del tiro.
import { chooseShot } from '../sim'
import type { ShotPlan } from '../sim'
import type { Difficulty, GameState } from '../sim/types'
import { seededRandom } from './demo'

export interface AiRequest {
  id: number
  state: GameState
  difficulty: Difficulty
  seed: number
}

export interface AiResponse {
  id: number
  plan: ShotPlan | null
  error?: string
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null
  postMessage(message: AiResponse): void
}

scope.onmessage = (e) => {
  const { id, state, difficulty, seed } = e.data
  try {
    const plan = chooseShot(state, difficulty, seededRandom(seed))
    scope.postMessage({ id, plan })
  } catch (err) {
    scope.postMessage({ id, plan: null, error: String(err) })
  }
}
