import { applyCommand, chooseShot, createMatch, ITEM_ORDER, WEAPON_ORDER, type Difficulty, type GameState, type MapSize } from '../src/sim'
function aiTurn(state: GameState, difficulty: Difficulty) {
  const p = state.players[state.current]
  const t0 = performance.now()
  const plan = chooseShot(state, difficulty)
  const ms = performance.now() - t0
  for (const item of plan.items ?? []) state = applyCommand(state, { type: 'useItem', playerId: p.id, item, target: item === 'jetpack' || item === 'teleport' ? plan.target : undefined }).state
  for (let i = 0; i < Math.abs(plan.move ?? 0); i++) state = applyCommand(state, { type: 'move', playerId: p.id, dir: (plan.move ?? 0) > 0 ? 1 : -1 }).state
  state = applyCommand(state, { type: 'selectWeapon', playerId: p.id, weapon: plan.weapon }).state
  state = applyCommand(state, { type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power }).state
  let r = applyCommand(state, { type: 'fire', playerId: p.id })
  for (let i = 0; i < 60 && r.state.phase === 'guiding'; i += 2) r = applyCommand(r.state, { type: 'steer', playerId: p.id, dirs: [plan.steer?.[i] ?? 0, plan.steer?.[i + 1] ?? 0] })
  return { state: r.state, ms, plan, before: state }
}
for (const [difficulty, size, n] of [['normal', 'small', 3], ['hard', 'small', 2], ['normal', 'medium', 4], ['hard', 'large', 4]] as [Difficulty, MapSize, number][]) {
  for (let seed = 1; seed <= 3; seed++) {
    let s = createMatch({ slots: new Array(n).fill(0).map(() => ({ kind: 'ai' as const })), rounds: 1, difficulty, biome: 'forest', seed: 700 + seed, size })
    for (const p of s.players) {
      for (const id of WEAPON_ORDER) if (id !== 'normal') p.ammo[id] = 2
      for (const id of ITEM_ORDER) p.items[id] = 1
    }
    for (let turn = 0; turn < 60 && s.phase === 'aiming'; turn++) {
      const pre = s
      const r = aiTurn(s, difficulty)
      if (r.ms > 250) {
        const a = pre.players[pre.current]
        console.log(size, seed, turn, r.ms.toFixed(0), JSON.stringify({ ...r.plan, steer: r.plan.steer?.length }), 'lava', pre.lava, 'hz', pre.hazards.length, 'ammo', Object.entries(a.ammo).filter(([, v]) => v > 0).map(([k]) => k).join(','))
        // reperfilado: mismo estado sin ítems
        const q = { ...pre, players: pre.players.map((p) => ({ ...p, items: { ...p.items, jetpack: 0, teleport: 0 } })) }
        const t0 = performance.now()
        chooseShot(q, difficulty)
        console.log('  sin saltos', (performance.now() - t0).toFixed(0))
      }
      s = r.state
    }
  }
}
