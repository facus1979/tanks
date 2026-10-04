import { applyCommand, chooseShot, cloneState, createMatch, DIRT, AIR, METAL, WEAPON_ORDER, ITEM_ORDER, type GameState, type WeaponId } from '../src/sim'
import { fillRect } from '../src/sim/terrain'
function flat(): GameState {
  const s = cloneState(createMatch({ slots: [{ kind: 'ai' }, { kind: 'ai' }], rounds: 1, difficulty: 'normal', biome: 'forest', seed: 4 }))
  s.terrain.front.fill(AIR)
  s.terrain.back.fill(AIR)
  fillRect(s.terrain, 0, 300, 799, 449, DIRT, 'both')
  s.props = []
  s.players[0].x = 200
  s.players[1].x = 600
  for (const p of s.players) {
    p.y = 300
    for (const id of WEAPON_ORDER) p.ammo[id] = 5
    for (const id of ITEM_ORDER) p.items[id] = 0
  }
  s.current = 0
  s.wind = 0
  return s
}
function shoot(s: GameState, weapon: WeaponId, angle: number, power: number) {
  s = applyCommand(s, { type: 'selectWeapon', playerId: 0, weapon }).state
  s = applyCommand(s, { type: 'aim', playerId: 0, angle, power }).state
  return applyCommand(s, { type: 'fire', playerId: 0 })
}
// terremoto sobre la loma
const s = flat()
s.players[1].x = 520
for (let x = 420; x < 500; x++) fillRect(s.terrain, x, 300 - Math.min(80, (x - 420) * 2), x, 299, DIRT, 'both')
for (const pw of [40, 45, 50, 55]) {
  const r = shoot(s, 'quake', 45, pw)
  const imp = r.events.find((e) => e.type === 'impact')
  let moved = 0
  for (let i = 0; i < s.terrain.front.length; i++) if (s.terrain.front[i] !== r.state.terrain.front[i]) moved++
  console.log('quake', pw, imp && 'x' in imp ? [Math.round(imp.x), Math.round(imp.y)] : null, 'moved', moved, r.events.map((e) => e.type + (e.type === 'slide' ? ':' + e.cause : '')).join(','))
}
// ácido vs búnker
const a = flat()
for (const id of WEAPON_ORDER) a.players[0].ammo[id] = id === 'normal' ? 99 : id === 'acid' ? 3 : 0
fillRect(a.terrain, 576, 262, 624, 268, METAL, 'both')
fillRect(a.terrain, 576, 262, 580, 299, METAL, 'both')
fillRect(a.terrain, 620, 262, 624, 299, METAL, 'both')
const plan = chooseShot(a, 'hard')
console.log('plan', plan)
const ra = shoot(a, 'acid', plan.angle, plan.power)
console.log('acid as plan', ra.events.filter((e) => e.type === 'damage' || e.type === 'hazard' || e.type === 'impact').map((e) => JSON.stringify(e).slice(0, 120)))
