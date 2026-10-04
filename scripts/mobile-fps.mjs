// QA (v2.4): fps aproximados en un celular de gama media, emulado en Chrome headless.
// Uso: npm run build && node scripts/mobile-fps.mjs ["play=1&size=large&bots=3"] [--cpu 4] [--seconds 15]
// Emula una pantalla táctil horizontal de 6" (844×390, dpr 2) y frena la CPU del renderer (--cpu, por
// defecto 4: más o menos un celular de gama media contra esta PC). Sirve el build de producción con
// `vite preview`, deja correr la partida y mide los intervalos de requestAnimationFrame.
// --gpu usa la GPU real (ANGLE D3D11, como la medición de F9); sin --gpu va por SwiftShader (GPU por
// software en la CPU), que domina el tiempo de frame y no se frena con --cpu. En los dos casos el número
// es una aproximación: no reemplaza probar en un celular real.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const query = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) ?? 'play=1&size=large&bots=3'
const CPU = opt('cpu', 4)
const SECONDS = opt('seconds', 15)
const port = 5300 + Math.floor(Math.random() * 50)
const debugPort = 9400 + Math.floor(Math.random() * 50)

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const chromePath = CHROMES.find((p) => fs.existsSync(p))
if (!chromePath) throw new Error('No encontré Chrome ni Edge')
if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('Falta el build: corré npm run build')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const v = await check()
      if (v) return v
    } catch {}
    await sleep(300)
  }
  throw new Error(what)
}

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
})
const profile = fs.mkdtempSync(path.join(root, 'node_modules/.mobile-fps-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu-sandbox',
    ...(args.includes('--gpu') ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--window-size=844,390',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
let code = 1
try {
  const base = `http://localhost:${port}`
  await waitFor(async () => (await fetch(base + '/')).ok, 30000, 'vite preview no respondió')
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(), 60000, 'Chrome no abrió CDP')
  const cdp = await connect(version.webSocketDebuggerUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => cdp.send(m, p, sessionId)
  await s('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } })
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await s('Emulation.setCPUThrottlingRate', { rate: CPU })
  await s('Page.enable', {})
  await s('Page.navigate', { url: `${base}/?${query}` })
  // que cargue y arranque la partida (assets, generación del mapa, primer turno)
  await sleep(10000)
  const r = await s('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((res) => {
      const dts = []; let last = performance.now(); const end = last + ${SECONDS * 1000}
      const touch = matchMedia('(pointer: coarse)').matches
      const tick = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else res({ dts, touch }) }
      requestAnimationFrame(tick)
    })`,
  })
  const { dts, touch } = r.result.value
  dts.sort((a, b) => a - b)
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length
  const p = (q) => dts[Math.min(dts.length - 1, Math.floor(q * dts.length))]
  const over = dts.filter((d) => d > 33.4).length
  console.log(`?${query}  CPU ×${CPU}  ${args.includes('--gpu') ? 'GPU real' : 'SwiftShader'}  táctil=${touch}  ${dts.length} frames en ${SECONDS} s`)
  console.log(`fps medio ${(1000 / mean).toFixed(1)}  frame medio ${mean.toFixed(1)} ms  p50 ${p(0.5).toFixed(1)}  p95 ${p(0.95).toFixed(1)}  máx ${dts[dts.length - 1].toFixed(0)} ms  frames > 33 ms: ${over}`)
  cdp.close()
  code = 0
} catch (err) {
  console.error('FALLÓ:', err instanceof Error ? err.message : err)
} finally {
  chrome.kill()
  vite.kill()
  await sleep(500)
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {}
  process.exit(code)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
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
        close: () => ws.close(),
      })
    ws.onerror = () => reject(new Error('No pude conectar a Chrome por CDP'))
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      const p = msg.id && pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
      else p.res(msg.result)
    }
  })
}
