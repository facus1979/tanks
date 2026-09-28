// Utilidades de red sin dependencias: código de sala, token de reconexión, compresión de snapshots.

// Sin I, L, O, 0 ni 1 (se confunden al dictarlos).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_PREFIX = 'TANK-'
const ROOM_RE = /^TANK-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

export function makeRoomCode(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += ROOM_ALPHABET[b % ROOM_ALPHABET.length]
  return ROOM_PREFIX + s
}

// Acepta "tank-4f7k", "4F7K", " TANK 4F7K ". Devuelve null si no es un código válido.
export function normalizeCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s_]/g, '')
  s = s.replace(/^TANK-?/, '')
  const code = ROOM_PREFIX + s
  return ROOM_RE.test(code) ? code : null
}

export function isRoomCode(code: string): boolean {
  return ROOM_RE.test(code)
}

// Link para compartir la sala (…/?join=TANK-XXXX), conservando ?net=local si está.
export function roomLink(code: string): string {
  const url = new URL(location.href)
  const net = url.searchParams.get('net')
  url.search = ''
  url.hash = ''
  if (net) url.searchParams.set('net', net)
  url.searchParams.set('join', code)
  return url.toString()
}

// Token de reconexión: sobrevive a un F5 de la pestaña, no se comparte entre pestañas.
const TOKEN_KEY = 'tanks-net-token'
let memToken: string | null = null

export function reconnectToken(): string {
  try {
    const t = sessionStorage.getItem(TOKEN_KEY)
    if (t) return t
  } catch {}
  memToken ??= randomId(16)
  try {
    sessionStorage.setItem(TOKEN_KEY, memToken)
  } catch {}
  return memToken
}

export function randomId(n = 8): string {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]
  return s
}

// ---------- compresión: deflate-raw → base64 ----------

const enc = new TextEncoder()
const dec = new TextDecoder()

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

export async function compress(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return toBase64(await pipe(bytes, new CompressionStream('deflate-raw')))
}

export async function decompress(b64: string): Promise<Uint8Array> {
  return pipe(fromBase64(b64), new DecompressionStream('deflate-raw'))
}

export async function decompressText(b64: string): Promise<string> {
  return dec.decode(await decompress(b64))
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
