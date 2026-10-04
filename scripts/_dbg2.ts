import { cloneState, createMatch } from '../src/sim'
import { quakeTerrain, pullTerrain } from '../src/sim/terrain-fx'
import { collapseAfterShot } from '../src/sim/physics'
import { resolveShot } from '../src/sim/weapons'
for (let rep = 0; rep < 3; rep++) for (const size of ['small', 'medium', 'large'] as const) {
  const s0 = createMatch({ slots: [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty: 'normal', biome: 'forest', seed: 703, size })
  for (const x of [200, 400, 600]) {
    const s = cloneState(s0)
    let y = 0
    while (s.terrain.front[y * s.terrain.w + x] === 0) y++
    let t0 = performance.now()
    const q = quakeTerrain(s.terrain, x, y, 70, true)
    const tq = performance.now() - t0
    t0 = performance.now()
    collapseAfterShot(s, [], 0, false)
    const tc = performance.now() - t0
    const s2 = cloneState(s0)
    t0 = performance.now()
    pullTerrain(s2.terrain, x, y, 80, true)
    const tp = performance.now() - t0
    const s3 = cloneState(s0)
    const p = s3.players[0]
    p.angle = 60
    p.power = 50
    t0 = performance.now()
    resolveShot(s3, p, 'quake')
    const tr = performance.now() - t0
    console.log(size, x, 'quake', tq.toFixed(1), 'cells', q.cells, 'patches', q.patches.length, 'collapse', tc.toFixed(1), 'pull', tp.toFixed(1), 'resolve', tr.toFixed(1))
  }
}
