// Efectos sintetizados con Web Audio. No hay archivos de sonido.
import { BEAM, BEDROCK, BRICK, DIRT, METAL, POST, SLAT, STONE, WOOD } from '../sim/types'
import type { BlastStyle, Material, WeaponId } from '../sim/types'

// Familia de sonido del material que más se rompió en un impacto.
export type MaterialVoice = 'dirt' | 'stone' | 'metal' | 'wood' | 'brick'

const VOICE: Partial<Record<number, MaterialVoice>> = {
  [DIRT]: 'dirt',
  [STONE]: 'stone',
  [BEDROCK]: 'stone',
  [METAL]: 'metal',
  [WOOD]: 'wood',
  [SLAT]: 'wood',
  [BEAM]: 'wood',
  [POST]: 'wood',
  [BRICK]: 'brick',
}

// Material dominante de event.debris y cuánto se rompió en total (pixels). Con menos de 4 pixels
// (o sin debris: barril, muerte) vuelve 'brick', que es el timbre neutro, y no suma capa.
export function dominantVoice(debris: Partial<Record<Material, number>> | undefined): { voice: MaterialVoice; amount: number } {
  const sums: Partial<Record<MaterialVoice, number>> = {}
  let total = 0
  for (const [key, n] of Object.entries(debris ?? {})) {
    const v = VOICE[Number(key)]
    if (!v || !n) continue
    sums[v] = (sums[v] ?? 0) + n
    total += n
  }
  if (total < 4) return { voice: 'brick', amount: total }
  let voice: MaterialVoice = 'dirt'
  let best = 0
  for (const [v, n] of Object.entries(sums) as [MaterialVoice, number][]) {
    if (n > best) {
      best = n
      voice = v
    }
  }
  return { voice, amount: total }
}

// Cuánto se abre el filtro del cuerpo de la explosión según el material.
const BRIGHT: Record<MaterialVoice, number> = { dirt: 0.55, brick: 1, wood: 1.1, stone: 1.35, metal: 1.55 }

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private windGain: GainNode | null = null
  private windFilter: BiquadFilterNode | null = null
  private muted = false
  private engineGain: GainNode | null = null
  private engineOsc: OscillatorNode | null = null
  private engineOn = false

  // Crea el contexto; tiene que llamarse desde un gesto del usuario.
  unlock(): void {
    try {
      const ctx = this.ac()
      if (ctx.state === 'suspended') void ctx.resume()
      this.startWind()
    } catch {
      // sin Web Audio
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !this.muted
  }

  setMuted(on: boolean): void {
    this.muted = on
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0 : 0.8, this.ctx.currentTime, 0.05)
  }

  toggleMute(): void {
    this.setMuted(!this.muted)
  }

  click(): void {
    if (!this.ready) return
    this.tone({ freq: 1250, to: 900, dur: 0.035, type: 'square', gain: 0.05 })
    this.tone({ freq: 2500, dur: 0.015, type: 'square', gain: 0.02 })
  }

  fire(weapon: WeaponId): void {
    if (!this.ready) return
    const heavy = weapon === 'heavy' || weapon === 'nuke'
    // golpe grave + chasquido de boca + cola de aire
    this.tone({ freq: heavy ? 150 : 180, to: heavy ? 32 : 45, dur: heavy ? 0.32 : 0.22, type: 'sine', gain: heavy ? 0.9 : 0.7 })
    this.tone({ freq: 90, to: 40, dur: 0.12, type: 'triangle', gain: 0.35 })
    this.noise({ dur: 0.09, type: 'bandpass', freq: 1800, to: 500, q: 0.8, gain: 0.45 })
    this.noise({ dur: heavy ? 0.5 : 0.3, type: 'lowpass', freq: 900, to: 150, gain: 0.25, delay: 0.02 })
    if (weapon === 'nuke') this.tone({ freq: 880, to: 440, dur: 0.6, type: 'square', gain: 0.04, delay: 0.05 })
    if (weapon === 'napalm') this.noise({ dur: 0.35, type: 'bandpass', freq: 1400, q: 0.6, gain: 0.2, delay: 0.03 })
    if (weapon === 'roller') this.tone({ freq: 60, to: 50, dur: 0.3, type: 'sawtooth', gain: 0.06, delay: 0.05 })
  }

  // Una bomba del racimo: explosión corta y seca, con altura que varía para que no suenen iguales.
  bomblet(radius = 10, debris?: Partial<Record<Material, number>>): void {
    if (!this.ready) return
    const j = 0.85 + Math.random() * 0.3
    const m = dominantVoice(debris)
    this.tone({ freq: 140 * j, to: 45, dur: 0.22, type: 'sine', gain: 0.55 })
    this.noise({ dur: 0.28 + radius / 100, type: 'lowpass', freq: 3200 * j * BRIGHT[m.voice], to: 260, gain: 0.5 })
    this.noise({ dur: 0.05, type: 'highpass', freq: 3500, gain: m.voice === 'dirt' ? 0.08 : 0.18 })
    this.material(m.voice, m.amount, 0.5)
  }

  // Fuego de napalm: crepitar de chasquidos sobre un soplido.
  burn(width = 20): void {
    if (!this.ready) return
    const k = Math.max(0.5, Math.min(1.5, width / 30))
    this.noise({ dur: 1.4 * k, type: 'bandpass', freq: 900, to: 500, q: 0.5, gain: 0.22, attack: 0.15 })
    const pops = Math.round(8 * k)
    for (let i = 0; i < pops; i++) {
      this.noise({ dur: 0.02 + Math.random() * 0.02, type: 'highpass', freq: 1800 + Math.random() * 2500, gain: 0.1 + Math.random() * 0.12, delay: Math.random() * 1.3 * k })
    }
  }

  // Motor del tanque: se prende mientras se mueve y se apaga con una rampa corta.
  engine(on: boolean): void {
    if (on === this.engineOn) return
    this.engineOn = on
    if (!this.ctx || this.ctx.state !== 'running') return
    const ctx = this.ctx
    if (!this.engineGain) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 48
      const lfo = ctx.createOscillator()
      const lfoGain = ctx.createGain()
      lfo.frequency.value = 11
      lfoGain.gain.value = 9
      lfo.connect(lfoGain).connect(osc.frequency)
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 420
      const gain = ctx.createGain()
      gain.gain.value = 0
      osc.connect(filter).connect(gain).connect(this.out())
      osc.start()
      lfo.start()
      this.engineGain = gain
      this.engineOsc = osc
    }
    const now = ctx.currentTime
    this.engineGain.gain.setTargetAtTime(on ? 0.13 : 0, now, on ? 0.04 : 0.1)
    this.engineOsc?.frequency.setTargetAtTime(on ? 62 : 48, now, 0.15)
    if (on) this.noise({ dur: 0.18, type: 'bandpass', freq: 260, q: 1.2, gain: 0.12 })
  }

  // debris: el de event.impact. El material dominante cambia el brillo del estallido y suma su capa.
  boom(blast: BlastStyle, radius = 14, debris?: Partial<Record<Material, number>>): void {
    if (!this.ready) return
    const k = Math.max(0.6, Math.min(1.6, radius / 16))
    const m = dominantVoice(debris)
    const b = BRIGHT[m.voice]
    const soft = m.voice === 'dirt'
    switch (blast) {
      case 'fire':
        this.tone({ freq: soft ? 78 : 90, to: 30, dur: 0.45 * k, type: 'sine', gain: soft ? 0.9 : 0.8 })
        this.noise({ dur: 0.6 * k, type: 'lowpass', freq: 2400 * b, to: 180, gain: 0.7 })
        this.noise({ dur: 0.12, type: 'highpass', freq: 3000, gain: soft ? 0.06 : 0.15 })
        break
      case 'bigfire':
        this.tone({ freq: soft ? 60 : 70, to: 22, dur: 0.9, type: 'sine', gain: 1 })
        this.noise({ dur: 0.9, type: 'lowpass', freq: 3000 * b, to: 160, gain: 0.85 })
        this.noise({ dur: 1.8, type: 'lowpass', freq: 160, to: 60, gain: 0.7, attack: 0.08 })
        this.noise({ dur: 0.15, type: 'highpass', freq: 2500, gain: soft ? 0.08 : 0.2 })
        break
      case 'dirt':
        this.tone({ freq: 95, to: 45, dur: 0.2, type: 'sine', gain: 0.6 })
        this.noise({ dur: 0.35, type: 'lowpass', freq: 520, to: 140, gain: 0.6 })
        this.noise({ dur: 0.5, type: 'bandpass', freq: 380, q: 0.6, gain: 0.18, delay: 0.08 })
        break
      case 'napalm':
        this.tone({ freq: 80, to: 35, dur: 0.35, type: 'sine', gain: 0.6 })
        this.noise({ dur: 1.1, type: 'bandpass', freq: 700, to: 1800, q: 0.7, gain: 0.45, attack: 0.05 })
        for (let i = 0; i < 6; i++) this.noise({ dur: 0.03, type: 'highpass', freq: 2200, gain: 0.12, delay: 0.1 + i * 0.13 })
        break
      case 'dig':
        // taladro: zumbido áspero con golpeteo que baja mientras perfora
        this.tone({ freq: 55, to: 40, dur: 0.25, type: 'sine', gain: 0.4 })
        this.tone({ freq: 190, to: 120, dur: 1.1, type: 'sawtooth', gain: 0.1 })
        this.tone({ freq: 380, to: 250, dur: 1.1, type: 'square', gain: 0.035 })
        for (let i = 0; i < 12; i++) this.noise({ dur: 0.05, type: 'bandpass', freq: 900 - i * 40, q: 2, gain: 0.3, delay: i * 0.085 })
        break
      case 'nuke':
        this.noise({ dur: 0.25, type: 'highpass', freq: 1500, gain: 0.4 })
        this.tone({ freq: 60, to: 18, dur: 3.2, type: 'sine', gain: 1 })
        this.noise({ dur: 3.6, type: 'lowpass', freq: 3500, to: 70, gain: 0.9 })
        this.noise({ dur: 4.2, type: 'lowpass', freq: 120, to: 40, gain: 0.8, attack: 0.4, delay: 0.2 })
        this.noise({ dur: 5.5, type: 'lowpass', freq: 70, to: 30, gain: 0.7, attack: 1.2, delay: 1 })
        this.tone({ freq: 34, to: 22, dur: 5, type: 'triangle', gain: 0.5, delay: 0.6 })
        break
    }
    // la de tierra agrega terreno (no rompe nada audible); el taladro pesa menos que un estallido
    if (blast !== 'dirt') this.material(m.voice, m.amount, blast === 'dig' ? 0.6 : blast === 'nuke' ? 1.3 : k)
  }

  // Capa del material roto: tierra sorda, piedra y metal agudos con chasquido, madera crujiente,
  // ladrillo en el medio. amount: pixels rotos (escala el volumen); k: tamaño del estallido.
  private material(voice: MaterialVoice, amount: number, k: number): void {
    if (amount < 4) return
    const v = Math.max(0.35, Math.min(1, Math.sqrt(amount / 250))) * Math.max(0.5, Math.min(1.3, k))
    const r = Math.random
    switch (voice) {
      case 'dirt':
        // golpe sordo y terrones que caen
        this.tone({ freq: 62, to: 34, dur: 0.3, type: 'sine', gain: 0.45 * v })
        this.noise({ dur: 0.45, type: 'lowpass', freq: 380, to: 90, gain: 0.45 * v, delay: 0.02 })
        for (let i = 0; i < 5; i++) this.noise({ dur: 0.06, type: 'lowpass', freq: 500 + r() * 300, gain: 0.12 * v, delay: 0.18 + r() * 0.45 })
        break
      case 'stone':
        // chasquido seco y cascotes duros
        this.noise({ dur: 0.035, type: 'highpass', freq: 4200, gain: 0.4 * v })
        this.noise({ dur: 0.12, type: 'bandpass', freq: 2600, to: 1400, q: 1.5, gain: 0.3 * v })
        for (let i = 0; i < 9; i++) {
          this.noise({ dur: 0.02 + r() * 0.02, type: 'bandpass', freq: 2200 + r() * 2600, q: 4, gain: (0.1 + r() * 0.12) * v, delay: 0.08 + r() * 0.6 })
        }
        break
      case 'metal':
        // chasquido y chapa que vibra: parciales inarmónicos que decaen
        this.noise({ dur: 0.03, type: 'highpass', freq: 5000, gain: 0.45 * v })
        this.tone({ freq: 523, to: 505, dur: 0.7, type: 'triangle', gain: 0.07 * v })
        this.tone({ freq: 1307, to: 1270, dur: 0.5, type: 'triangle', gain: 0.045 * v })
        this.tone({ freq: 2141, to: 2090, dur: 0.35, type: 'sine', gain: 0.03 * v })
        for (let i = 0; i < 5; i++) this.tone({ freq: 1800 + r() * 1800, dur: 0.05, type: 'square', gain: 0.015 * v, delay: 0.12 + r() * 0.5 })
        break
      case 'wood':
        // crujido: astillas en ráfaga con resonancia media y un quiebre grave
        this.tone({ freq: 240, to: 110, dur: 0.14, type: 'sawtooth', gain: 0.07 * v })
        this.noise({ dur: 0.3, type: 'bandpass', freq: 1100, to: 600, q: 2.5, gain: 0.28 * v })
        for (let i = 0; i < 14; i++) {
          this.noise({ dur: 0.012 + r() * 0.02, type: 'bandpass', freq: 700 + r() * 1400, q: 5, gain: (0.12 + r() * 0.12) * v, delay: r() * 0.35 })
        }
        break
      case 'brick':
        // entre tierra y piedra: golpe medio y cascotes menos brillantes
        this.noise({ dur: 0.05, type: 'highpass', freq: 2600, gain: 0.25 * v })
        this.noise({ dur: 0.3, type: 'bandpass', freq: 1200, to: 500, q: 1.1, gain: 0.3 * v })
        for (let i = 0; i < 7; i++) {
          this.noise({ dur: 0.03 + r() * 0.02, type: 'bandpass', freq: 1300 + r() * 1300, q: 3, gain: (0.1 + r() * 0.1) * v, delay: 0.06 + r() * 0.5 })
        }
        break
    }
  }

  barrel(): void {
    if (!this.ready) return
    this.boom('fire', 18)
    this.tone({ freq: 330, to: 300, dur: 0.35, type: 'square', gain: 0.07, delay: 0.01 })
    this.tone({ freq: 495, to: 470, dur: 0.28, type: 'square', gain: 0.05, delay: 0.01 })
  }

  fall(distance: number): void {
    if (!this.ready) return
    const k = Math.max(0.3, Math.min(1, distance / 40))
    this.tone({ freq: 110, to: 38, dur: 0.22, type: 'sine', gain: 0.7 * k })
    this.noise({ dur: 0.18, type: 'lowpass', freq: 400, to: 120, gain: 0.5 * k })
    this.tone({ freq: 210, to: 190, dur: 0.12, type: 'square', gain: 0.04 * k, delay: 0.02 })
  }

  death(): void {
    if (!this.ready) return
    this.boom('bigfire', 26)
    this.tone({ freq: 260, to: 200, dur: 0.5, type: 'square', gain: 0.05, delay: 0.05 })
  }

  empty(): void {
    if (!this.ready) return
    this.tone({ freq: 180, to: 120, dur: 0.12, type: 'square', gain: 0.06 })
  }

  // Caja registradora: dos campanitas y el cajón.
  buy(): void {
    if (!this.ready) return
    this.tone({ freq: 1568, dur: 0.12, type: 'square', gain: 0.05 })
    this.tone({ freq: 2093, dur: 0.22, type: 'square', gain: 0.05, delay: 0.07 })
    this.noise({ dur: 0.08, type: 'bandpass', freq: 3200, q: 2, gain: 0.12, delay: 0.02 })
  }

  sell(): void {
    if (!this.ready) return
    this.tone({ freq: 1320, to: 880, dur: 0.1, type: 'square', gain: 0.045 })
    this.tone({ freq: 990, to: 660, dur: 0.14, type: 'square', gain: 0.04, delay: 0.08 })
  }

  // Escudo encendiéndose: barrido ascendente con zumbido.
  shieldOn(): void {
    if (!this.ready) return
    this.tone({ freq: 220, to: 880, dur: 0.45, type: 'sawtooth', gain: 0.05 })
    this.tone({ freq: 440, to: 1760, dur: 0.4, type: 'sine', gain: 0.08, delay: 0.03 })
    this.noise({ dur: 0.5, type: 'bandpass', freq: 1200, to: 3000, q: 3, gain: 0.08 })
  }

  // Golpe contra el escudo: chasquido eléctrico. left: cuánto escudo queda.
  shieldHit(left: number): void {
    if (!this.ready) return
    const broke = left <= 0
    this.noise({ dur: 0.05, type: 'highpass', freq: 4000, gain: 0.3 })
    this.tone({ freq: broke ? 900 : 1400, to: broke ? 120 : 700, dur: broke ? 0.5 : 0.25, type: 'square', gain: 0.06 })
    this.tone({ freq: 60, to: 40, dur: 0.18, type: 'sine', gain: 0.4 })
    if (broke) this.noise({ dur: 0.4, type: 'bandpass', freq: 2500, to: 600, q: 1.5, gain: 0.2, delay: 0.05 })
  }

  // Paracaídas abriéndose: tela que se infla.
  parachute(): void {
    if (!this.ready) return
    this.noise({ dur: 0.25, type: 'bandpass', freq: 500, to: 1400, q: 0.8, gain: 0.35, attack: 0.03 })
    this.noise({ dur: 0.12, type: 'lowpass', freq: 300, gain: 0.3, delay: 0.2 })
    this.tone({ freq: 120, to: 80, dur: 0.12, type: 'sine', gain: 0.3, delay: 0.2 })
  }

  // Cartel de turno en hot-seat: corneta corta.
  banner(): void {
    if (!this.ready) return
    this.tone({ freq: 523, dur: 0.1, type: 'square', gain: 0.06 })
    this.tone({ freq: 659, dur: 0.1, type: 'square', gain: 0.06, delay: 0.1 })
    this.tone({ freq: 784, dur: 0.22, type: 'square', gain: 0.07, delay: 0.2 })
  }

  // Fin de ronda: redoble y golpe.
  roundEnd(): void {
    if (!this.ready) return
    for (let i = 0; i < 8; i++) this.noise({ dur: 0.04, type: 'bandpass', freq: 1800, q: 1.2, gain: 0.12 + i * 0.02, delay: i * 0.06 })
    this.tone({ freq: 98, to: 49, dur: 0.6, type: 'sine', gain: 0.7, delay: 0.5 })
    this.tone({ freq: 392, dur: 0.5, type: 'square', gain: 0.05, delay: 0.5 })
    this.tone({ freq: 523, dur: 0.5, type: 'square', gain: 0.04, delay: 0.5 })
  }

  // Fanfarria del campeón.
  champion(): void {
    if (!this.ready) return
    const notes: [number, number, number][] = [
      [523, 0, 0.14],
      [523, 0.15, 0.14],
      [523, 0.3, 0.14],
      [659, 0.45, 0.4],
      [587, 0.9, 0.14],
      [659, 1.05, 0.14],
      [784, 1.2, 0.8],
    ]
    for (const [f, d, dur] of notes) {
      this.tone({ freq: f, dur, type: 'square', gain: 0.07, delay: d })
      this.tone({ freq: f / 2, dur, type: 'triangle', gain: 0.1, delay: d })
    }
    this.tone({ freq: 1047, dur: 0.8, type: 'square', gain: 0.03, delay: 1.2 })
    this.noise({ dur: 1.2, type: 'highpass', freq: 5000, gain: 0.05, attack: 0.3, delay: 1.2 })
  }

  // Viento ambiente suave: ruido filtrado cuyo volumen sigue a |viento|.
  setWind(value: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return
    const s = Math.min(1, Math.abs(value) / 10)
    const now = this.ctx.currentTime
    this.windGain.gain.setTargetAtTime(0.012 + s * 0.05, now, 0.6)
    this.windFilter.frequency.setTargetAtTime(280 + s * 520, now, 0.6)
  }

  // ---------- síntesis ----------

  private ac(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      const comp = this.ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.ratio.value = 4
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.8
      this.master.connect(comp).connect(this.ctx.destination)
    }
    return this.ctx
  }

  private out(): AudioNode {
    return this.master ?? this.ac().destination
  }

  private noiseBuffer(): AudioBuffer {
    const ctx = this.ac()
    if (!this.noiseBuf) {
      const length = ctx.sampleRate * 2
      this.noiseBuf = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = this.noiseBuf.getChannelData(0)
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    }
    return this.noiseBuf
  }

  private startWind(): void {
    if (this.windGain) return
    const ctx = this.ac()
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer()
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 380
    filter.Q.value = 0.9
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.frequency.value = 0.13
    lfoGain.gain.value = 140
    lfo.connect(lfoGain).connect(filter.frequency)
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(filter).connect(gain).connect(this.out())
    src.start()
    lfo.start()
    this.windGain = gain
    this.windFilter = filter
  }

  private tone(o: { freq: number; to?: number; dur: number; type: OscillatorType; gain: number; delay?: number }): void {
    const ctx = this.ac()
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    const amp = ctx.createGain()
    osc.type = o.type
    osc.frequency.setValueAtTime(o.freq, t0)
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur)
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.005)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur)
    osc.connect(amp).connect(this.out())
    osc.start(t0)
    osc.stop(t0 + o.dur + 0.02)
  }

  private noise(o: {
    dur: number
    type: BiquadFilterType
    freq: number
    to?: number
    q?: number
    gain: number
    attack?: number
    delay?: number
  }): void {
    const ctx = this.ac()
    const t0 = ctx.currentTime + (o.delay ?? 0)
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer()
    const filter = ctx.createBiquadFilter()
    filter.type = o.type
    filter.frequency.setValueAtTime(o.freq, t0)
    if (o.to) filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + o.dur)
    if (o.q) filter.Q.value = o.q
    const amp = ctx.createGain()
    const attack = o.attack ?? 0.004
    amp.gain.setValueAtTime(0.0001, t0)
    amp.gain.exponentialRampToValueAtTime(o.gain, t0 + attack)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.01, o.dur))
    src.connect(filter).connect(amp).connect(this.out())
    src.start(t0, Math.random() * 1.5)
    src.stop(t0 + o.dur + 0.05)
  }
}
