import { createTerrain, fillRect } from '../src/sim/terrain'
import { quakeTerrain } from '../src/sim/terrain-fx'
import { DIRT } from '../src/sim'
const t = createTerrain(800, 450)
fillRect(t, 0, 300, 799, 449, DIRT, 'both')
for (let x = 420; x < 500; x++) fillRect(t, x, 300 - Math.min(80, (x - 420) * 2), x, 299, DIRT, 'both')
const before = t.front.slice()
const q = quakeTerrain(t, 436, 271, 70, true)
let moved = 0
for (let i = 0; i < before.length; i++) if (before[i] !== t.front[i]) moved++
console.log(q.cells, moved, q.patches.length)
