// v3 (rendimiento): calidad automática de los efectos.
// Mide el intervalo real entre frames (performance.now) con un promedio móvil. Si pasa de SLOW_MS durante
// SLOW_HOLD segundos baja a 'low' (menos partículas, sin luces tenues, sin estelas de escombros); si vuelve a
// quedar debajo de FAST_MS durante FAST_HOLD segundos sube a 'high'. Las ventanas son largas y asimétricas
// para que no oscile: bajar es rápido (una explosión pesada), subir es lento.
// QA: ?quality=low|high la fija.
export type Quality = 'high' | 'low'

const SLOW_MS = 20
const FAST_MS = 15
const SLOW_HOLD = 1.5
const FAST_HOLD = 5

const forced = ((): Quality | null => {
  const q = new URLSearchParams(location.search).get('quality')
  return q === 'low' || q === 'high' ? q : null
})()

export class QualityGovernor {
  level: Quality = forced ?? 'high'
  readonly forced = forced
  avg = 1000 / 60 // ms por frame, promedio móvil
  private last = -1
  private slow = 0 // segundos seguidos por encima de SLOW_MS
  private fast = 0 // segundos seguidos por debajo de FAST_MS
  changes = 0 // cambios de nivel (contador de QA)

  // Llamar una vez por frame. Devuelve el nivel a usar.
  sample(now = performance.now()): Quality {
    const last = this.last
    this.last = now
    if (last < 0) return this.level
    const dt = now - last
    // pestaña oculta, carga del mapa o un tirón suelto: no cuenta
    if (dt > 250 || dt <= 0) return this.level
    this.avg += (Math.min(dt, 100) - this.avg) * 0.08
    const s = dt / 1000
    if (this.avg > SLOW_MS) {
      this.slow += s
      this.fast = 0
    } else if (this.avg < FAST_MS) {
      this.fast += s
      this.slow = 0
    } else {
      this.slow = 0
      this.fast = 0
    }
    if (this.forced) return this.level
    if (this.level === 'high' && this.slow >= SLOW_HOLD) {
      this.level = 'low'
      this.slow = 0
      this.changes++
    } else if (this.level === 'low' && this.fast >= FAST_HOLD) {
      this.level = 'high'
      this.fast = 0
      this.changes++
    }
    return this.level
  }
}
