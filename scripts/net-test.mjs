// Prueba e2e del online SIN internet (transporte local = BroadcastChannel entre pestañas).
// Uso: npm run net-test            partida real: anfitrión + cliente con ?autotest=1 hasta el fin
//      npm run net-test -- --players 8   v5: partida Grande con 8 casilleros (2 humanos + 6 IA)
//                                        (también NET_TEST_PLAYERS=8; N de 3 a 8, el mapa más chico que los admite)
//      npm run net-test -- --layer solo la capa de red (src/net) con una sim de juguete
//      npm run net-test -- --snapshot   solo la prueba de snapshot (v2.3): tamaños y tiempos del formato
//                                        comprimido por tamaño de mapa y desync forzado con la sim real
//                                        (también corre antes de los otros modos)
//      NET_TEST_DEBUG=1 ...       además vuelca el texto visible de las dos pestañas en cada lectura
// Levanta vite, abre Chrome headless con --remote-debugging-port y dos pestañas del mismo perfil.
// Lee window.__tanksNet = { role, code, seq, hash, phase } por CDP y verifica que las dos pestañas
// terminan con el mismo seq y hash, en roundover/gameover. Sale con código 1 si falla.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const pageErrors = []
// NET_TEST_TRANSPORT=peer prueba por internet con PeerJS (señalización pública + WebRTC); por defecto 'local'.
const TRANSPORT = process.env.NET_TEST_TRANSPORT === 'peer' ? 'peer' : 'local'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const layer = process.argv.includes('--layer')
const snapOnly = process.argv.includes('--snapshot')
const playersArg = process.argv.indexOf('--players')
const PLAYERS = Number(playersArg >= 0 ? process.argv[playersArg + 1] : process.env.NET_TEST_PLAYERS ?? 0) || 0
if (PLAYERS && (PLAYERS < 3 || PLAYERS > 8)) fail('--players va de 3 a 8')
// la máquina es lenta; con 8 tanques en Grande la ronda dura ~10 min en headless: 25 min por defecto
const TIMEOUT = Number(process.env.NET_TEST_TIMEOUT ?? (PLAYERS > 4 ? 25 : 10) * 60) * 1000
const port = 5250 + Math.floor(Math.random() * 50)
const debugPort = 9300 + Math.floor(Math.random() * 200)
// NET_TEST_URL=https://facus1979.github.io/tanks prueba el sitio publicado (sin levantar vite).
const remote = (process.env.NET_TEST_URL ?? '').replace(/\/+$/, '')
const base = remote || `http://localhost:${port}`

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const chromePath = CHROMES.find((p) => fs.existsSync(p))
if (!chromePath) fail('No encontré Chrome ni Edge')

const t0 = performance.now()
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a)

let vite, chrome, profile, cdp
let code = 1
try {
  if (!remote) {
    vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let viteLog = ''
    vite.stdout.on('data', (d) => (viteLog += d))
    vite.stderr.on('data', (d) => (viteLog += d))
    await waitFor(async () => (await fetch(base + '/')).ok, 30000, () => 'vite no respondió\n' + viteLog)
    log('vite listo en', base)
    // calentar vite: que transforme y optimice dependencias (peerjs, pixi) antes de abrir pestañas
    for (const u of ['/src/main.ts', '/src/net/index.ts', '/src/net/peer.ts', '/src/net/local.ts', '/src/net/host.ts', '/src/net/client.ts'])
      await fetch(base + u).catch(() => {})
    await sleep(4000)
  } else log('probando el sitio publicado', base)

  profile = fs.mkdtempSync(path.join(root, 'node_modules/.net-test-'))
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu-sandbox',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=800,450',
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      // las dos pestañas tienen que correr a la par aunque ninguna tenga el foco
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const version = await waitFor(
    async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(),
    180000,
    () => 'Chrome no abrió el puerto de depuración',
  )
  log('Chrome listo')
  cdp = await connect(version.webSocketDebuggerUrl)

  // v2.3: la prueba de snapshot (sim real, formato comprimido) corre en todos los modos; --snapshot la corre sola
  await snapshotTest()
  if (layer) await layerTest()
  else if (!snapOnly) await gameTest()
  code = 0
} catch (err) {
  console.error('\nFALLÓ:', err instanceof Error ? err.message : err)
} finally {
  try {
    cdp?.close()
  } catch {}
  chrome?.kill()
  vite?.kill()
  await sleep(500)
  try {
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {} // Chrome puede seguir cerrando; el perfil queda en node_modules/.net-test-*
  process.exit(code)
}

// ---------- partida real ----------

async function gameTest() {
  const extra = PLAYERS ? `&players=${PLAYERS}` : ''
  if (PLAYERS) log(`modo ${PLAYERS} casilleros: 2 humanos + ${PLAYERS - 2} IA`)
  const a = await openTab(`${base}/?net=${TRANSPORT}&host=1&autotest=1${extra}`, 'A')
  const hostState = await waitFor(
    async () => {
      const s = await readNet(a)
      return s?.code ? s : null
    },
    180000,
    () => 'La pestaña A no publicó window.__tanksNet.code (¿el flujo implementa ?host=1&autotest=1?)',
  )
  log('sala abierta:', hostState.code)
  const b = await openTab(`${base}/?net=${TRANSPORT}&join=${encodeURIComponent(hostState.code)}&autotest=1`, 'B')
  // En esta máquina la primera carga de B a veces tarda tanto (las dos pestañas comparten proceso)
  // que el join local vence a los 5 s y B queda en el menú sin __tanksNet: se recarga hasta 2 veces.
  for (let tries = 0; ; tries++) {
    const ok = await waitFor(async () => (await readNet(b)) || null, 120000, 'sin __tanksNet').catch(() => null)
    if (ok) break
    if (tries >= 2) throw new Error(`La pestaña B no se unió a la sala (sin __tanksNet)${errors()}`)
    log('pestaña B sin __tanksNet: recargo')
    await cdp.send('Page.reload', {}, b.sessionId)
    await sleep(3000)
  }

  const END = ['roundover', 'gameover']
  let last = ''
  let stable = 0
  await waitFor(
    async () => {
      const [sa, sb] = await Promise.all([readNet(a), readNet(b)])
      const line = `A ${fmt(sa)} | B ${fmt(sb)}`
      if (line !== last) log(line)
      last = line
      if (process.env.NET_TEST_DEBUG) {
        const t = performance.now()
        const txt = `document.readyState + ' ' + (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`
        const [da, db] = [await evaluate(a, txt), await evaluate(b, txt)]
        log('DBG', `${(performance.now() - t).toFixed(0)}ms`, 'A:', da, '| B:', db)
      }
      const done = sa && sb && END.includes(sa.phase) && END.includes(sb.phase) && sa.seq === sb.seq && sa.hash === sb.hash
      stable = done ? stable + 1 : 0
      return stable >= 3 ? true : null // 3 lecturas iguales seguidas: nada más en vuelo
    },
    TIMEOUT,
    () => `No terminaron sincronizados. Último estado: ${last}${errors()}`,
    2000,
  )
  const s = await readNet(a)
  // que la partida haya sido realmente de N tanques (y en el tamaño esperado)
  const info = await evaluate(a, 'window.__tanksNet ? JSON.parse(JSON.stringify(window.__tanksNet)) : null')
  if (PLAYERS && info.players !== PLAYERS) throw new Error(`La partida tuvo ${info.players} tanques en vez de ${PLAYERS}`)
  log(`OK: las dos pestañas terminaron en ${s.phase}, seq ${s.seq}, hash ${s.hash} (${info.players} tanques, ${info.size})`)
}

function fmt(s) {
  return s ? `${s.role ?? '?'} ${s.phase} seq=${s.seq} hash=${s.hash}` : '(sin __tanksNet)'
}

async function readNet(tab) {
  return evaluate(tab, 'window.__tanksNet ? JSON.parse(JSON.stringify(window.__tanksNet)) : null')
}

// ---------- solo la capa de red, con una sim de juguete ----------

async function layerTest() {
  // Una página cualquiera del mismo origen alcanza para importar src/net por vite.
  const a = await openTab(`${base}/src/net/types.ts`, 'A')
  const b = await openTab(`${base}/src/net/types.ts`, 'B')
  // Un import que falla una vez (vite reoptimizando dependencias) queda cacheado en la página: recargar.
  for (const tab of [a, b]) {
    await waitFor(
      async () => {
        const r = await evaluate(tab, `import('/src/net/index.ts').then(() => 'ok', (e) => String(e))`)
        if (r === 'ok') return true
        log(`pestaña ${tab.name}: ${r}; recargo`)
        await cdp.send('Page.reload', {}, tab.sessionId)
        await sleep(3000)
        return null
      },
      180000,
      () => `La pestaña ${tab.name} no pudo importar src/net`,
      1000,
    )
  }
  const toy = `
    window.__toy = { sum: 0 }
    window.__apply = (c) => {
      if (c.type !== 'aim' && c.type !== 'fire' && c.type !== 'setKind') return false
      window.__toy.sum = (Math.imul(window.__toy.sum, 31) + (c.playerId + 1) * 7 + (c.angle ?? 3)) >>> 0
      return true
    }
    window.__log = []`
  const roomCode = await evaluate(
    a,
    `(async () => {
      ${toy}
      const net = await import('/src/net/index.ts')
      const room = new net.HostRoom(net.createTransport('local'), {
        apply: window.__apply,
        hash: () => window.__toy.sum,
        snapshot: () => JSON.stringify(window.__toy),
        onPeerLeft: (p) => window.__log.push('left:' + p.slot),
        onPeerBack: (p) => window.__log.push('back:' + p.slot),
      }, { name: 'Ana', hashEvery: 4 })
      window.__room = room
      return room.open()
    })()`,
  )
  log('sala de juguete:', roomCode)
  await evaluate(
    b,
    `(async () => {
      ${toy}
      const net = await import('/src/net/index.ts')
      const room = new net.ClientRoom(net.createTransport('local'), {
        apply: window.__apply,
        hash: () => window.__toy.sum,
        onStart: (config, info) => window.__log.push('start:' + info.myPlayerId + ':' + config.slots.length),
        onSnapshot: (seq, data) => { window.__toy = JSON.parse(new TextDecoder().decode(data)); window.__log.push('snap:' + seq) },
        onDesync: (seq) => window.__log.push('desync:' + seq),
        onAimLive: (id, angle) => window.__log.push('aim:' + id + ':' + angle),
        onReject: (reason) => window.__log.push('reject:' + reason),
      }, { name: 'Beto' })
      window.__room = room
      await room.join(${JSON.stringify(roomCode)})
    })()`,
  )
  await waitFor(async () => (await evaluate(b, 'window.__room.mySlot')) === 1 || null, 20000, () => 'B no tomó el casillero 1')
  log('B en el casillero 1')

  // v5: 8 casilleros, solo se ocupan los que admite el tamaño; al achicar se reacomodan o se liberan
  const fit = await evaluate(
    a,
    `(() => {
      const r = window.__room, k = () => r.lobby.slots.map((s) => s.kind === 'off' ? '-' : s.kind[0]).join('')
      const out = [r.lobby.slots.length]
      r.setOption('size', 'small'); r.setSlot(5, 'ai'); out.push(k())        // Chico: el 5 no se puede
      r.setOption('size', 'large'); for (const i of [4, 5, 6, 7]) r.setSlot(i, 'ai'); out.push(k())
      r.setOption('size', 'medium'); out.push(k())                           // 6 y 7 pasan al 2 y 3
      r.setOption('size', 'small'); out.push(k())                            // ya no hay libres: se van
      for (let i = 2; i < 8; i++) r.setSlot(i, 'off')
      return out.join(' ')
    })()`,
  )
  if (fit !== '8 hh------ hh--aaaa hhaaaa-- hhaa----') throw new Error('límite por tamaño: ' + fit)
  if ((await evaluate(b, 'window.__room.mySlot')) !== 1) throw new Error('B perdió su casillero al cambiar el tamaño')
  log('límite de casilleros por tamaño OK:', fit)

  // v2.3: al achicar se compacta conservando la configuración. Cada casillero se muestra como
  // tipo + dueño (H anfitrión, B el cliente, . nadie); los tripulantes se comparan aparte.
  const crewsAt = `(r) => r.lobby.slots.map((s) => (s.kind === 'off' ? '-' : s.kind[0] + (s.owner === 'host' ? 'H' : s.owner ? 'B' : '.'))).join(' ')`
  const keep = await evaluate(
    a,
    `(() => {
      const r = window.__room, show = ${crewsAt}, crews = () => r.lobby.slots.map((s) => s.crew).join(',')
      const c0 = crews()
      r.setOption('size', 'large'); for (const i of [4, 5, 6, 7]) r.setSlot(i, 'ai')
      r.setOption('size', 'medium')
      const names = r.lobby.slots.slice(2, 6).map((s) => s.name).join(',')
      const crewsMid = crews()
      r.setOption('size', 'small')
      return { c0, crewsMid, crewsEnd: crews(), names, kinds: r.lobby.slots.map((s) => s.kind[0]).join(''), b: r.lobby.slots[1].owner !== null }
    })()`,
  )
  // los 4 IA de 4..7 suben a 2..5 llevándose su tripulante (y su nombre = el del tripulante)
  const c = keep.c0.split(',')
  const wantMid = [c[0], c[1], c[4], c[5], c[6], c[7], c[2], c[3]].join(',')
  if (keep.crewsMid !== wantMid || keep.crewsEnd !== wantMid || keep.kinds !== 'hhaaoooo' || !keep.b)
    throw new Error('compactación: ' + JSON.stringify(keep) + ' esperaba ' + wantMid)
  // B en el último casillero de Grande: al pasar a Mediano no entra, se le avisa y queda espectador
  await evaluate(a, `(() => { const r = window.__room; for (let i = 2; i < 8; i++) r.setSlot(i, 'off'); r.setOption('size', 'large'); for (let i = 2; i < 7; i++) r.setSlot(i, 'ai'); r.setSlot(7, 'human') })()`)
  await evaluate(b, `window.__log = []; window.__room.claim(7)`)
  await waitFor(async () => (await evaluate(b, 'window.__room.mySlot')) === 7 || null, 20000, () => 'B no tomó el casillero 7')
  await evaluate(a, `window.__room.setOption('size', 'medium')`)
  await waitFor(async () => ((await evaluate(b, 'window.__room.mySlot')) === null && (await evaluate(b, 'window.__log.some((l) => l.startsWith("reject:"))'))) || null, 20000, async () => 'B no quedó espectador con aviso: ' + (await evaluate(b, 'JSON.stringify([window.__room.mySlot, window.__log])')))
  const drop = await evaluate(a, `(${crewsAt})(window.__room)`)
  // ocupados: anfitrión, humano libre (el 1 que soltó B), IA 2..6, B → quedan los 6 primeros
  if (drop !== 'hH h. a. a. a. a. - -') throw new Error('descarte desde el final: ' + drop)
  // vuelve a tomar el casillero 1 (humano libre) y se deja todo como antes: Chico, 2 humanos
  await evaluate(b, `window.__room.claim(1)`)
  await waitFor(async () => (await evaluate(b, 'window.__room.mySlot')) === 1 || null, 20000, () => 'B no volvió al casillero 1')
  await evaluate(a, `(() => { const r = window.__room; for (let i = 2; i < 8; i++) r.setSlot(i, 'off'); r.setOption('size', 'small') })()`)
  log('compactación al achicar OK:', drop)
  const started = await evaluate(
    a,
    `(() => { const r = window.__room; r.setSlot(2, 'ai'); if (!r.canStart()) return 'no puede empezar'; const s = r.start(42); return s.config.slots.length })()`,
  )
  if (started !== 3) throw new Error('start: ' + started)
  await waitFor(async () => (await evaluate(b, 'window.__log.includes("start:1:3")')) || null, 20000, () => 'B no recibió start')

  // comandos de los dos lados, con un aim pendiente que entra antes del fire
  await evaluate(a, `window.__room.dispatch({ type: 'aim', playerId: 0, angle: 50, power: 60 }); window.__room.dispatch({ type: 'fire', playerId: 0 })`)
  await evaluate(b, `window.__room.aimLive(1, 120, 70); window.__room.input({ type: 'fire', playerId: 1 })`)
  await evaluate(b, `window.__room.input({ type: 'fire', playerId: 0 })`) // ajeno: el anfitrión lo rechaza
  await sync(a, b, 4, 'primer tramo')
  const log1 = await evaluate(b, 'window.__log.join(" ")')
  if (!log1.includes('aim:0:50')) throw new Error('B no vio el aimLive del anfitrión: ' + log1)

  // desincronización forzada: el hash del seq 8 no coincide → snapshot
  await evaluate(b, `window.__toy.sum = 12345`)
  await evaluate(a, `for (let i = 0; i < 4; i++) window.__room.dispatch({ type: 'fire', playerId: 0 })`)
  await sync(a, b, 8, 'tras desync')
  const log2 = await evaluate(b, 'window.__log.join(" ")')
  if (!log2.includes('desync:8') || !log2.includes('snap:')) throw new Error('No hubo snapshot tras el desync: ' + log2)
  log('desync detectado y corregido con snapshot')

  // reconexión: B recarga el room con el mismo token (sessionStorage)
  await evaluate(b, `window.__room.close()`)
  await waitFor(async () => (await evaluate(a, 'window.__log.includes("left:1")')) || null, 20000, () => 'A no vio irse a B')
  await evaluate(a, `window.__room.dispatch({ type: 'setKind', playerId: 1, kind: 'ai' }); window.__room.dispatch({ type: 'fire', playerId: 0 })`)
  await evaluate(
    b,
    `(async () => {
      window.__log = []
      const net = await import('/src/net/index.ts')
      const room = new net.ClientRoom(net.createTransport('local'), {
        apply: window.__apply,
        hash: () => window.__toy.sum,
        onStart: (config, info) => window.__log.push('start:' + info.myPlayerId + ':' + info.seq),
        onSnapshot: (seq, data) => { window.__toy = JSON.parse(new TextDecoder().decode(data)); window.__log.push('snap:' + seq) },
      }, { name: 'Beto' })
      window.__room = room
      await room.join(${JSON.stringify(roomCode)})
    })()`,
  )
  await waitFor(async () => (await evaluate(a, 'window.__log.includes("back:1")')) || null, 20000, () => 'A no vio volver a B')
  await evaluate(a, `window.__room.dispatch({ type: 'setKind', playerId: 1, kind: 'human' })`)
  await evaluate(b, `window.__room.input({ type: 'fire', playerId: 1 })`)
  await sync(a, b, 12, 'tras reconectar')
  const log3 = await evaluate(b, 'window.__log.join(" ")')
  if (!log3.includes('start:1:10') || !log3.includes('snap:10')) throw new Error('La reconexión no trajo start + snapshot: ' + log3)
  log('reconexión con token OK')
  log('OK: capa de red')
}

// ---------- snapshot con la sim real (v2.3: formato comprimido) ----------

// Código común de las pestañas: importa la sim y juega turnos de IA como sim-check.
const SIM_HELPERS = `
  const sim = await import('/src/sim/index.ts')
  const aiTurn = (s, send) => {
    const p = s.players[s.current]
    const plan = sim.chooseShot(s, 'normal')
    const cmds = [...(plan.items ?? []).map((item) => ({ type: 'useItem', playerId: p.id, item }))]
    for (let i = 0; i < Math.abs(plan.move ?? 0); i++) cmds.push({ type: 'move', playerId: p.id, dir: plan.move > 0 ? 1 : -1 })
    cmds.push({ type: 'selectWeapon', playerId: p.id, weapon: plan.weapon }, { type: 'aim', playerId: p.id, angle: plan.angle, power: plan.power }, { type: 'fire', playerId: p.id })
    for (const c of cmds) {
      if (s.phase !== 'aiming' || s.players[s.current].id !== p.id) break
      s = send(c)
    }
    return s
  }`

async function snapshotTest() {
  const a = await openTab(`${base}/src/net/types.ts`, 'SA')
  const b = await openTab(`${base}/src/net/types.ts`, 'SB')
  for (const tab of [a, b]) {
    await waitFor(
      async () => {
        const r = await evaluate(tab, `Promise.all([import('/src/net/index.ts'), import('/src/sim/index.ts')]).then(() => 'ok', (e) => String(e))`)
        if (r === 'ok') return true
        log(`pestaña ${tab.name}: ${r}; recargo`)
        await cdp.send('Page.reload', {}, tab.sessionId)
        await sleep(3000)
        return null
      },
      180000,
      () => `La pestaña ${tab.name} no pudo importar src/net y src/sim`,
      1000,
    )
  }

  // 1) tamaños y tiempos a mitad de partida (12 tiros de IA; bosque y jungla tienen lagos, el
  // industrial pozos de lava): v1 crudo (calculado), v2, v2 + deflate + base64 (lo que viaja).
  const sizes = await evaluate(
    a,
    `(async () => {
      ${SIM_HELPERS}
      const util = await import('/src/net/util.ts')
      const out = []
      for (const [size, n] of [['small', 4], ['medium', 6], ['large', 8]]) for (const biome of ['forest', 'jungle', 'industrial']) {
        let s = sim.createMatch({ slots: Array.from({ length: n }, () => ({ kind: 'ai' })), rounds: 1, difficulty: 'normal', biome, seed: 7, size })
        for (let i = 0; i < 12 && s.phase === 'aiming'; i++) s = aiTurn(s, (c) => (s = sim.applyCommand(s, c).state))
        const { terrain, ...rest } = s
        const head = new TextEncoder().encode(JSON.stringify({ ...rest, tw: terrain.w, th: terrain.h, ...(terrain.pits ? { tp: 1 } : {}) }))
        const v1 = 4 + head.length + terrain.front.length * 2 + (terrain.pits ? terrain.pits.length : 0)
        // v1 a mano, para verificar que decodeState sigue leyéndolo
        const old = new Uint8Array(v1)
        new DataView(old.buffer).setUint32(0, head.length, true)
        old.set(head, 4); old.set(terrain.front, 4 + head.length); old.set(terrain.back, 4 + head.length + terrain.front.length)
        if (terrain.pits) old.set(terrain.pits, 4 + head.length + 2 * terrain.front.length)
        const h = sim.hashState(s)
        if (sim.hashState(sim.decodeState(old)) !== h) return 'v1 no decodifica igual: ' + size + '/' + biome
        let bytes
        for (let i = 0; i < 3; i++) bytes = sim.encodeState(s) // calentar
        let t = performance.now()
        for (let i = 0; i < 5; i++) bytes = sim.encodeState(s)
        const enc = (performance.now() - t) / 5
        let back
        for (let i = 0; i < 3; i++) back = sim.decodeState(bytes)
        t = performance.now()
        for (let i = 0; i < 5; i++) back = sim.decodeState(bytes)
        const dec = (performance.now() - t) / 5
        if (bytes[0] !== 0x54 || bytes[1] !== 0x4b || bytes[2] !== 2) return 'sin cabecera TK 2: ' + size
        if (sim.hashState(back) !== h) return 'v2 no decodifica igual: ' + size + '/' + biome
        const wire = (await util.compress(bytes)).length
        let liquid = 0
        for (const m of terrain.front) if (m === sim.WATER || m === sim.LAVA) liquid++
        out.push({ size, biome, n, turn: s.turn, v1, v2: bytes.length, wire, enc: +enc.toFixed(2), dec: +dec.toFixed(2), liquid })
      }
      return out
    })()`,
  )
  if (typeof sizes === 'string') throw new Error('snapshot: ' + sizes)
  for (const r of sizes)
    log(
      `snapshot ${r.size.padEnd(6)} ${r.biome.padEnd(10)} ${r.n} tanques, turno ${String(r.turn).padStart(2)}, líquido ${String(r.liquid).padStart(6)} px:` +
        ` v1 ${(r.v1 / 1024).toFixed(0)} KB → v2 ${(r.v2 / 1024).toFixed(1)} KB (deflate+base64 ${(r.wire / 1024).toFixed(1)} KB);` +
        ` encode ${r.enc} ms, decode ${r.dec} ms`,
    )
  const big = sizes.filter((r) => r.size === 'large')
  if (big.some((r) => r.v2 >= 150 * 1024)) throw new Error('snapshot de Grande ≥ 150 KB')
  if (!big.some((r) => r.liquid > 0)) throw new Error('los estados de Grande no tienen líquidos')
  const slow = sizes.filter((r) => r.enc >= 30 || r.dec >= 30)
  if (slow.length) log('AVISO: encode/decode ≥ 30 ms en', slow.map((r) => `${r.size}/${r.biome}`).join(', '))

  // 2) e2e: sala con la sim real (anfitrión + 7 IA en Grande, B espectador). B se desincroniza
  // a propósito (le rompemos terreno y viento) y el snapshot comprimido lo tiene que dejar igual.
  const code2 = await evaluate(
    a,
    `(async () => {
      ${SIM_HELPERS}
      const net = await import('/src/net/index.ts')
      const S = (window.__S = { st: null })
      const room = new net.HostRoom(net.createTransport('local'), {
        apply: (c) => { const r = sim.applyCommand(S.st, c); if (r.state === S.st && !r.events.length) return false; S.st = r.state; return true },
        hash: () => sim.hashState(S.st),
        snapshot: () => sim.encodeState(S.st),
      }, { name: 'Ana', hashEvery: 2 })
      window.__room2 = room
      window.__play = (turns) => { for (let i = 0; i < turns && S.st.phase === 'aiming'; i++) aiTurn(S.st, (c) => (room.dispatch(c), S.st)) }
      const code = await room.open()
      room.setOption('size', 'large')
      for (let i = 1; i < 8; i++) room.setSlot(i, 'ai')
      return code
    })()`,
  )
  await evaluate(
    b,
    `(async () => {
      const sim = await import('/src/sim/index.ts')
      const net = await import('/src/net/index.ts')
      const S = (window.__S = { st: null, snaps: [], desync: 0 })
      const room = new net.ClientRoom(net.createTransport('local'), {
        apply: (c) => { S.st = sim.applyCommand(S.st, c).state },
        hash: () => sim.hashState(S.st),
        onStart: (config, info) => { if (info.seq === 0) S.st = sim.createMatch(config) },
        onSnapshot: (seq, data) => { S.st = sim.decodeState(data); S.snaps.push({ seq, bytes: data.length, head: [...data.subarray(0, 3)].join(',') }) },
        onDesync: () => S.desync++,
      }, { name: 'Beto' })
      window.__room2 = room
      await room.join(${JSON.stringify(code2)})
    })()`,
  )
  await waitFor(async () => (await evaluate(b, 'window.__room2.lobby !== null')) || null, 20000, () => 'SB no entró a la sala')
  // start reparte la config; la partida del anfitrión se crea en el mismo paso (antes de cualquier comando)
  await evaluate(a, `(async () => { const sim = await import('/src/sim/index.ts'); const s = window.__room2.start(42); window.__S.st = sim.createMatch(s.config) })()`)
  await waitFor(async () => (await evaluate(b, 'window.__S.st !== null')) || null, 20000, () => 'SB no recibió start')
  const state = (tab) => evaluate(tab, `(async () => { const sim = await import('/src/sim/index.ts'); return { seq: window.__room2.seq, hash: sim.hashState(window.__S.st) } })()`)
  const same = async (what) => {
    await waitFor(
      async () => {
        const [sa, sb] = await Promise.all([state(a), state(b)])
        return sa.seq > 0 && sa.seq === sb.seq && sa.hash === sb.hash ? true : null
      },
      30000,
      async () => `${what}: A ${JSON.stringify(await state(a))} B ${JSON.stringify(await state(b))}${errors()}`,
    )
    log(`snapshot e2e, ${what}: seq ${(await state(a)).seq} con el mismo hash`)
  }
  await evaluate(a, 'window.__play(4)')
  await same('4 tiros')
  await evaluate(b, `(() => { const S = window.__S; S.st.terrain.front.fill(0, 50000, 90000); S.st = { ...S.st, wind: S.st.wind + 3 } })()`)
  await evaluate(a, 'window.__play(3)')
  await same('tras la desincronización')
  const snaps = await evaluate(b, 'JSON.parse(JSON.stringify({ snaps: window.__S.snaps, desync: window.__S.desync }))')
  if (!snaps.desync || !snaps.snaps.length) throw new Error('No hubo desync + snapshot: ' + JSON.stringify(snaps))
  if (snaps.snaps.some((s) => s.head !== '84,75,2')) throw new Error('El snapshot no vino en formato v2: ' + JSON.stringify(snaps))
  log(`snapshot e2e OK: ${snaps.snaps.length} snapshot(s) de ${snaps.snaps.map((s) => (s.bytes / 1024).toFixed(1) + ' KB').join(', ')} (8 tanques, Grande)`)
  await evaluate(a, 'window.__room2.close()')
  await evaluate(b, 'window.__room2.close()')
  for (const tab of [a, b]) await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
}

async function sync(a, b, seq, what) {
  await waitFor(
    async () => {
      const [ra, rb] = await Promise.all([
        evaluate(a, '({ seq: window.__room.seq, sum: window.__toy.sum })'),
        evaluate(b, '({ seq: window.__room.seq, sum: window.__toy.sum })'),
      ])
      return ra.seq === seq && rb.seq === seq && ra.sum === rb.sum ? true : null
    },
    20000,
    async () =>
      `${what}: A ${JSON.stringify(await evaluate(a, '({ seq: window.__room.seq, sum: window.__toy.sum })'))} B ${JSON.stringify(
        await evaluate(b, '({ seq: window.__room.seq, sum: window.__toy.sum, log: window.__log })'),
      )}${errors()}`,
  )
  log(`${what}: seq ${seq} igual en las dos`)
}

// ---------- CDP ----------

function errors() {
  return pageErrors.length ? '\nErrores de las páginas:\n  ' + pageErrors.slice(-10).join('\n  ') : ''
}

async function openTab(url, name) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const tab = { sessionId, name, targetId }
  cdp.listen(sessionId, (method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails
      pageErrors.push(`${name}: ${d.exception?.description ?? d.text}`)
    } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
      pageErrors.push(`${name}: ${params.args.map((x) => x.value ?? x.description ?? '').join(' ')}`)
    }
  })
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url }, sessionId)
  log(`pestaña ${name}: ${url}`)
  const origin = new URL(url).origin
  await waitFor(
    async () => (await evaluate(tab, `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`)) || null,
    120000,
    () => `La pestaña ${name} no cargó`,
  )
  return tab
}

async function evaluate(tab, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, tab.sessionId)
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error(`${tab.name}: ${d.exception?.description ?? d.text}`)
  }
  return r.result.value
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    const listeners = new Map()
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const msg = { id: ++id, method, params }
            if (sessionId) msg.sessionId = sessionId
            pending.set(msg.id, { res, rej, method })
            ws.send(JSON.stringify(msg))
          })
        },
        listen(sessionId, cb) {
          listeners.set(sessionId, cb)
        },
        close() {
          ws.close()
        },
      })
    ws.onerror = () => reject(new Error('No pude conectar a Chrome por CDP'))
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
        else p.res(msg.result)
      } else if (msg.method && msg.sessionId) listeners.get(msg.sessionId)?.(msg.method, msg.params)
    }
  })
}

// ---------- utilidades ----------

async function waitFor(check, ms, message, every = 500) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    try {
      const v = await check()
      if (v) return v
    } catch (err) {
      if (err instanceof Error && /^[AB]: /.test(err.message)) throw err
    }
    await sleep(every)
  }
  throw new Error(typeof message === 'function' ? await message() : message)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}
