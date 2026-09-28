// Prueba e2e del online SIN internet (transporte local = BroadcastChannel entre pestañas).
// Uso: npm run net-test            partida real: anfitrión + cliente con ?autotest=1 hasta el fin
//      npm run net-test -- --layer solo la capa de red (src/net) con una sim de juguete
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
const TIMEOUT = Number(process.env.NET_TEST_TIMEOUT ?? 10 * 60) * 1000 // la máquina es lenta
const port = 5250 + Math.floor(Math.random() * 50)
const debugPort = 9300 + Math.floor(Math.random() * 200)
const base = `http://localhost:${port}`

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

  if (layer) await layerTest()
  else await gameTest()
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
  const a = await openTab(`${base}/?net=${TRANSPORT}&host=1&autotest=1`, 'A')
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

  const END = ['roundover', 'gameover']
  let last = ''
  let stable = 0
  await waitFor(
    async () => {
      const [sa, sb] = await Promise.all([readNet(a), readNet(b)])
      const line = `A ${fmt(sa)} | B ${fmt(sb)}`
      if (line !== last) log(line)
      last = line
      const done = sa && sb && END.includes(sa.phase) && END.includes(sb.phase) && sa.seq === sb.seq && sa.hash === sb.hash
      stable = done ? stable + 1 : 0
      return stable >= 3 ? true : null // 3 lecturas iguales seguidas: nada más en vuelo
    },
    TIMEOUT,
    () => `No terminaron sincronizados. Último estado: ${last}${errors()}`,
    2000,
  )
  const s = await readNet(a)
  log(`OK: las dos pestañas terminaron en ${s.phase}, seq ${s.seq}, hash ${s.hash}`)
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
      }, { name: 'Beto' })
      window.__room = room
      await room.join(${JSON.stringify(roomCode)})
    })()`,
  )
  await waitFor(async () => (await evaluate(b, 'window.__room.mySlot')) === 1 || null, 20000, () => 'B no tomó el casillero 1')
  log('B en el casillero 1')
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
  const tab = { sessionId, name }
  cdp.listen(sessionId, (method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails
      pageErrors.push(`${name}: ${d.exception?.description ?? d.text}`)
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
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
