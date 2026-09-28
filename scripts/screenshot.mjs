// Captura headless del juego real para comparar contra preview/look-test-1080.png.
// Uso: node scripts/screenshot.mjs [query] [salida] [--small] [--crop x,y,w,h] [--scale n]
//   node scripts/screenshot.mjs "demo=1" preview/game-demo.png            1920×1080 (pesada: usar poco)
//   node scripts/screenshot.mjs "demo=1" preview/qa.png --small            800×450, 1 px = 1 px lógico
//   node scripts/screenshot.mjs "demo=1" preview/qa.png --crop 380,250,160,90 --scale 3
//       recorte en coordenadas lógicas 800×450, ampliado ×3 con nearest (liviano para mirar detalle)
// Levanta vite en modo dev, abre Chrome headless y guarda el PNG.
// La página tiene que soportar ?demo=<seed>: arranca sola una partida, dispara un tiro
// fijo y se congela en el momento de la explosión (ver PROYECTO.md, "Modo demo").
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').match(/^--(crop|scale)$/))
const flag = (name) => process.argv.includes(`--${name}`)
const opt = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const query = positional[0] ?? 'demo=1'
const out = path.resolve(root, positional[1] ?? 'preview/game-demo.png')
const crop = opt('crop')?.split(',').map(Number)
const cropScale = Number(opt('scale') ?? 3)
const small = flag('small') || !!crop
const shotFile = crop ? out.replace(/\.png$/i, '') + '.full.png' : out
const port = 5190 + Math.floor(Math.random() * 50)

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const chrome = CHROMES.find((p) => fs.existsSync(p))
if (!chrome) throw new Error('No encontré Chrome ni Edge')

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))

try {
  await waitFor(`http://localhost:${port}/`, 20000)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const profile = fs.mkdtempSync(path.join(root, 'node_modules/.shot-'))
  await run(chrome, [
    '--headless=new',
    '--disable-gpu-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    small ? '--window-size=800,450' : '--window-size=1920,1080',
    '--virtual-time-budget=12000',
    `--screenshot=${shotFile}`,
    `http://localhost:${port}/?${query}`,
  ])
  fs.rmSync(profile, { recursive: true, force: true })
  if (!fs.existsSync(shotFile)) throw new Error('Chrome no generó la captura')
  if (crop) {
    const [x, y, w, h] = crop
    const py = `from PIL import Image
im = Image.open(r'${shotFile}').convert('RGB')
im.crop((${x}, ${y}, ${x + w}, ${y + h})).resize((${w * cropScale}, ${h * cropScale}), Image.NEAREST).save(r'${out}')`
    await run(process.platform === 'win32' ? 'python' : 'python3', ['-c', py])
    fs.rmSync(shotFile, { force: true })
  }
  console.log(`captura: ${path.relative(root, out)}`)
} catch (err) {
  console.error(log)
  throw err
} finally {
  vite.kill()
}

async function waitFor(url, ms) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`vite no respondió en ${url}`)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('Chrome tardó demasiado'))
    }, 60000)
    p.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    p.on('error', reject)
  })
}
