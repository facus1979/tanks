// Contrato de la simulación. Lo comparten sim, render, game y ui.
// Coordenadas: x crece a la derecha, y crece hacia ABAJO (igual que la grilla y la pantalla).
// Ángulo: 0 es horizontal a la derecha, 90 arriba, 180 horizontal a la izquierda.

// Tamaño del mapa Chico (el de v1). Desde v2 el mapa de cada partida mide state.width × state.height
// (= terrain.w × terrain.h); la pantalla lógica es VIEW_W × VIEW_H en src/render/types.ts.
export const WORLD_W = 800
export const WORLD_H = 450

// v2: tamaño de mapa por partida (MatchConfig.size). Alto fijo.
export type MapSize = 'small' | 'medium' | 'large'
export const MAP_SIZES: Record<MapSize, { w: number; h: number }> = {
  small: { w: 800, h: 450 },
  medium: { w: 1600, h: 450 },
  large: { w: 2400, h: 450 },
}
export const MAP_SIZE_ORDER: MapSize[] = ['small', 'medium', 'large']

// Física del mapa Chico. Para otros anchos usar physicsFor(width).
export const GRAVITY = 220
export const POWER_SCALE = 4.03
export const WIND_ACCEL = 9

export interface Physics {
  gravity: number
  powerScale: number
  windAccel: number
}

// Física derivada del ancho del mapa (k = width / 800): potencia 100 a 45° cruza el mapa entero
// (alcance ∝ k), el vuelo de punta a punta dura 2,6 s · k^0,25 y la deriva del viento escala con el mapa.
// gravedad 220·√k, POWER_SCALE 4,03·k^0,75, viento 9·√k. Con 800 da exactamente los valores de v1.
export function physicsFor(width: number): Physics {
  const k = width / WORLD_W
  if (k === 1) return { gravity: GRAVITY, powerScale: POWER_SCALE, windAccel: WIND_ACCEL }
  const r = Math.sqrt(k)
  return { gravity: GRAVITY * r, powerScale: POWER_SCALE * k ** 0.75, windAccel: WIND_ACCEL * r }
}
export const SUBSTEP = 1 / 240
export const MAX_FLIGHT = 14

// Geometría del tanque. Tiene que coincidir con public/assets/manifest.json.
// El tanque mira a la derecha si angle <= 90; si no, el sprite se espeja.
export const TANK_W = 28
export const TANK_HALF_W = 14
export const TANK_H = 20 // 14 de casco y torreta + 6 de orugas; el tripulante asoma por arriba
export const PIVOT_X = 5 // desde el centro del tanque hacia donde mira
export const PIVOT_Y = 17 // desde el piso hacia arriba
export const BARREL_LEN = 14 // del pivote a la boca, incluido el freno

export const PLAYER_HP = 100

// v2 muerte súbita: tras SUDDEN_DEATH_CALM tiros seguidos sin daño a ningún tanque, al empezar cada turno
// la lava sube LAVA_RISE px desde el fondo del mapa (GameState.lava = y de su superficie). Un tanque con el
// piso por debajo de la superficie (y > lava) pierde LAVA_DAMAGE al empezar cada turno. Un proyectil que toca
// la lava se derrite: termina el vuelo sin explotar (impacto 'lava'). Una vez que empezó, sigue subiendo
// hasta el fin de la ronda. En V4 la lava pasa a ser material de la grilla; las constantes quedan.
export const SUDDEN_DEATH_CALM = 5
export const LAVA_RISE = 18
export const LAVA_DAMAGE = 20
export const FALL_DAMAGE = 0.45
export const FUEL_PER_TURN = 60 // pixels que puede avanzar por turno (F6), en el mapa Chico
// Pulido v2: combustible por turno según el ancho del mapa (60·√k, k = width/800). Lo usan el turno y el ítem.
export function fuelFor(width: number): number {
  return Math.round(FUEL_PER_TURN * Math.sqrt(width / WORLD_W))
}

// Pulido v2: empuje y deslizamiento. Una explosión empuja a los tanques que alcanza en sentido contrario
// al centro (hasta KNOCKBACK_MAX px, más cuanto más cerca y más fuerte); un tanque cuyo piso queda más
// inclinado que SLIDE_SLOPE (diferencia de altura entre los bordes de las orugas / TANK_W) se desliza cuesta
// abajo hasta quedar estable. Los dos pueden terminar en una caída (al vacío, al agua o al abismo).
// El paracaídas solo se abre (y se gasta) si la caída haría al menos PARACHUTE_MIN_DAMAGE de daño.
export const KNOCKBACK_MAX = 24
export const SLIDE_SLOPE = 0.45
export const PARACHUTE_MIN_DAMAGE = 10
export const MAX_CLIMB = 3 // escalón máximo que sube sin frenarse

export const ANGLE_SPEED = 70
export const POWER_SPEED = 45

// ---------- materiales ----------

export const AIR = 0
export const DIRT = 1
export const STONE = 2
export const BRICK = 3
export const WOOD = 4 // tablones oscuros verticales
export const SLAT = 5 // tablas claras horizontales (cabinas)
export const BEAM = 6 // vigas horizontales
export const POST = 7 // postes verticales
export const METAL = 8 // chapa; muy dura
export const BEDROCK = 9 // fondo del mapa; indestructible
// v4: líquidos. Van en front pero NO colisionan (isSolid los trata como aire para tanques, proyectiles y
// apoyo); fluyen con un autómata celular determinista. No tienen textura en el manifiesto: los dibuja el render.
export const WATER = 10
export const LAVA = 11

export type Material = number

export interface MaterialDef {
  id: Material
  name: string
  // Fracción del radio de la explosión que llega a romperlo. 1 = se rompe todo el radio.
  toughness: number
  flammable: boolean
  liquid?: boolean // v4: agua y lava
}

export const MATERIALS: MaterialDef[] = [
  { id: AIR, name: 'aire', toughness: 1, flammable: false },
  { id: DIRT, name: 'tierra', toughness: 1, flammable: false },
  { id: STONE, name: 'piedra', toughness: 0.7, flammable: false },
  { id: BRICK, name: 'ladrillo', toughness: 0.8, flammable: false },
  { id: WOOD, name: 'madera', toughness: 1, flammable: true },
  { id: SLAT, name: 'tabla', toughness: 1, flammable: true },
  { id: BEAM, name: 'viga', toughness: 0.9, flammable: true },
  { id: POST, name: 'poste', toughness: 0.9, flammable: true },
  { id: METAL, name: 'metal', toughness: 0.35, flammable: false },
  { id: BEDROCK, name: 'roca madre', toughness: 0, flammable: false },
  // v4. Los nombres 'agua' y 'lava' los usa el minimapa para elegir color. Las explosiones no los rompen.
  { id: WATER, name: 'agua', toughness: 0, flammable: false, liquid: true },
  { id: LAVA, name: 'lava', toughness: 0, flammable: false, liquid: true },
]

// v4 reglas de líquidos (ver PROYECTO.md, v2 "Reglas nuevas"):
// - Agua: un tanque que cae al agua no recibe daño de caída. Un proyectil dentro del agua pierde velocidad
//   (multiplica la velocidad por WATER_DRAG por segundo). Una explosión con centro sumergido usa
//   radius * WATER_BLAST_SCALE para el terreno y el daño.
// - Lava (material): un tanque con alguna celda de lava bajo o dentro de su caja recibe LAVA_DAMAGE al empezar
//   cada turno (damage.cause 'lava'); el proyectil que la toca se derrite (impacto 'lava'); enciende lo
//   inflamable que toca al fluir.
// - Tierra (arma Tierra o derrumbe) que cae sobre lava → piedra. Agua que toca lava → piedra (evento 'steam').
// - Pulido v2: el proyectil de Tierra no se derrite en la lava: construye y lo que cae sobre lava es piedra.
//   Napalm sobre agua → la superficie alcanzada se vuelve piedra flotante (puente o isla), con 'steam'.
// - Flujo: al final de cada fire que cambió el terreno, hasta FLOW_MAX_ITERS iteraciones; cada FLOW_FRAME_ITERS
//   se emite un parche para animar (evento 'flow').
export const WATER_DRAG = 0.25
export const WATER_BLAST_SCALE = 0.5
export const FLOW_MAX_ITERS = 400
export const FLOW_FRAME_ITERS = 8

// Rectángulo de grilla que cambió (front y back completos de ese rectángulo, fila por fila).
export interface TerrainPatch {
  x: number
  y: number
  w: number
  h: number
  front: Uint8Array
  back: Uint8Array
}

// Grilla por pixel. front es lo sólido (colisiona). back es lo que había detrás
// (se dibuja oscuro donde front es AIR: la "pared de fondo" de Broforce). back no colisiona.
export interface Terrain {
  w: number
  h: number
  front: Uint8Array
  back: Uint8Array
  // v3: columnas de abismo (1 = sin fondo). Ahí no hay roca madre y debajo del mapa no es sólido:
  // lo que cae por debajo de h en esas columnas se pierde (tanque muerto, proyectil 'out', utilería
  // destruida). Ausente o todo 0 = como v1. Viaja en snapshots y hash.
  pits?: Uint8Array
}

export type Biome = 'forest' | 'jungle' | 'industrial'
export const BIOMES: Biome[] = ['forest', 'jungle', 'industrial']

// ---------- utilería ----------

// barrel explota en cadena; crate se rompe; el resto es decorativo y cae o desaparece
// si se queda sin apoyo.
export type PropKind = 'barrel' | 'crate' | 'ladder' | 'lamp' | 'flag' | 'windsock'

export interface Prop {
  id: number
  kind: PropKind
  x: number // esquina superior izquierda
  y: number
  w: number
  h: number
  alive: boolean
}

// ---------- armas ----------

export type WeaponId = 'normal' | 'heavy' | 'dirt' | 'cluster' | 'napalm' | 'digger' | 'roller' | 'nuke'

// Estilo visual de la explosión. El renderer elige el efecto por este campo, nunca por el id.
export type BlastStyle = 'fire' | 'bigfire' | 'dirt' | 'napalm' | 'dig' | 'nuke'

export interface WeaponDef {
  id: WeaponId
  name: string
  radius: number
  damage: number
  terrain: 'destroy' | 'build' | 'dig'
  blast: BlastStyle
  ammo: number
  // cluster: se parte en N al llegar al apogeo. roller: rueda cuesta abajo hasta frenar.
  split?: number
  rolls?: boolean
  burn?: number // napalm: segundos de fuego que quema madera y daña por turno
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  normal: { id: 'normal', name: 'Normal', radius: 14, damage: 22, terrain: 'destroy', blast: 'fire', ammo: 99 },
  heavy: { id: 'heavy', name: 'Pesada', radius: 26, damage: 36, terrain: 'destroy', blast: 'bigfire', ammo: 2 },
  dirt: { id: 'dirt', name: 'Tierra', radius: 18, damage: 20, terrain: 'build', blast: 'dirt', ammo: 3 },
  cluster: { id: 'cluster', name: 'Racimo', radius: 10, damage: 12, terrain: 'destroy', blast: 'fire', ammo: 2, split: 5 },
  napalm: { id: 'napalm', name: 'Napalm', radius: 16, damage: 14, terrain: 'destroy', blast: 'napalm', ammo: 2, burn: 3 },
  digger: { id: 'digger', name: 'Excavadora', radius: 9, damage: 10, terrain: 'dig', blast: 'dig', ammo: 2 },
  roller: { id: 'roller', name: 'Rodadora', radius: 16, damage: 30, terrain: 'destroy', blast: 'fire', ammo: 2, rolls: true },
  nuke: { id: 'nuke', name: 'Nuke', radius: 60, damage: 55, terrain: 'destroy', blast: 'nuke', ammo: 1 },
}

// Orden de la barra de armas (teclas 1 a 8).
export const WEAPON_ORDER: WeaponId[] = ['normal', 'heavy', 'dirt', 'cluster', 'napalm', 'digger', 'roller', 'nuke']

// ---------- jugadores y estado ----------

export type PlayerKind = 'human' | 'ai'
export type Difficulty = 'easy' | 'normal' | 'hard'
// aiming: se juega la ronda. roundover: terminó la ronda, se muestra la tabla.
// shop: tienda entre rondas. gameover: terminó la partida (todas las rondas).
export type Phase = 'aiming' | 'roundover' | 'shop' | 'gameover'

// Tripulantes con cara propia. El renderer mapea crew -> sprite y retrato.
export type CrewId = 'bandana' | 'sarge' | 'rookie' | 'desert'
export const CREWS: CrewId[] = ['bandana', 'sarge', 'rookie', 'desert']

// ---------- tienda e ítems ----------

// shield: absorbe SHIELD_HP de daño hasta agotarse (se activa con useItem).
// parachute: pasivo; anula el próximo daño de caída de al menos PARACHUTE_MIN_DAMAGE y se consume.
// fuel: suma fuelFor(width) al combustible del turno (useItem).
// repair: cura REPAIR_HP (useItem, no gasta el turno).
// tracer: el próximo tiro muestra la trayectoria completa al apuntar (useItem).
export type ItemId = 'shield' | 'parachute' | 'fuel' | 'repair' | 'tracer'
export const ITEM_ORDER: ItemId[] = ['shield', 'parachute', 'fuel', 'repair', 'tracer']
export const SHIELD_HP = 30
export const REPAIR_HP = 25

export type ShopId = WeaponId | ItemId

export interface ShopEntry {
  id: ShopId
  kind: 'weapon' | 'item'
  name: string
  price: number // por paquete
  qty: number // unidades por paquete
  max: number // tope de unidades en inventario
}

// Los precios y cantidades los balancea sim; los demás solo leen esta tabla.
export const SHOP: ShopEntry[] = [
  { id: 'heavy', kind: 'weapon', name: 'Pesada', price: 250, qty: 2, max: 9 },
  { id: 'dirt', kind: 'weapon', name: 'Tierra', price: 120, qty: 3, max: 9 },
  { id: 'cluster', kind: 'weapon', name: 'Racimo', price: 300, qty: 2, max: 9 },
  { id: 'napalm', kind: 'weapon', name: 'Napalm', price: 280, qty: 2, max: 9 },
  { id: 'digger', kind: 'weapon', name: 'Excavadora', price: 150, qty: 2, max: 9 },
  { id: 'roller', kind: 'weapon', name: 'Rodadora', price: 220, qty: 2, max: 9 },
  { id: 'nuke', kind: 'weapon', name: 'Nuke', price: 900, qty: 1, max: 2 },
  { id: 'shield', kind: 'item', name: 'Escudo', price: 350, qty: 1, max: 3 },
  { id: 'parachute', kind: 'item', name: 'Paracaídas', price: 120, qty: 1, max: 3 },
  { id: 'fuel', kind: 'item', name: 'Combustible', price: 80, qty: 1, max: 5 },
  { id: 'repair', kind: 'item', name: 'Reparación', price: 250, qty: 1, max: 3 },
  { id: 'tracer', kind: 'item', name: 'Trazador', price: 150, qty: 1, max: 5 },
]

// Plata que se gana en la ronda. La reparte sim al cerrar la ronda.
export const START_MONEY = 600
export const EARN = { perDamage: 4, kill: 300, survive: 150, roundWin: 400, selfDamage: -4 }

// ---------- partida ----------

export interface SlotConfig {
  kind: PlayerKind
  name?: string // si falta, sim usa el nombre del tripulante
  crew?: CrewId // si falta, sim asigna por índice
}

export interface MatchConfig {
  slots: SlotConfig[] // 2 a 4 casilleros ocupados; hot-seat = varios 'human'
  rounds: number // 1, 3, 5 o 10
  difficulty: Difficulty
  biome?: Biome | 'random' | 'rotate' // fijo, al azar por ronda, o rotando forest→jungle→industrial
  seed?: number
  size?: MapSize // v2; sin size, 'small'
}

export interface Player {
  id: number
  name: string
  kind: PlayerKind
  color: number // color del jugador: franja, banderín, marco del HUD
  crew: CrewId
  x: number // centro del tanque
  y: number // piso bajo el tanque (y de la primera fila sólida)
  hp: number
  angle: number
  power: number
  fuel: number
  weapon: WeaponId
  ammo: Record<WeaponId, number> // se conserva entre rondas (lo comprado)
  alive: boolean
  money: number
  items: Record<ItemId, number> // inventario, se conserva entre rondas
  shield: number // HP de escudo activo; 0 = sin escudo. Se pierde al terminar la ronda
  tracer: boolean // el próximo tiro muestra la trayectoria completa
  roundsWon: number
  kills: number // en toda la partida
  ready: boolean // en la tienda: terminó de comprar
}

export interface GameState {
  seed: number
  rng: number
  size: MapSize
  width: number // = MAP_SIZES[size].w = terrain.w
  height: number
  biome: Biome
  terrain: Terrain
  props: Prop[]
  wind: number
  players: Player[]
  current: number
  phase: Phase
  winnerId: number | null // ganador de la PARTIDA (en gameover)
  roundWinnerId: number | null // ganador de la última ronda (en roundover/shop)
  turn: number
  round: number // 1..rounds
  rounds: number
  difficulty: Difficulty
  biomeMode: Biome | 'random' | 'rotate'
  earnings: Record<number, number> // plata ganada en la última ronda, por id de jugador
  calm: number // v2: tiros seguidos sin daño a ningún tanque en la ronda
  lava: number | null // v2: y de la superficie de la lava de muerte súbita; null = todavía no apareció
}

export type Command =
  | { type: 'aim'; playerId: number; angle: number; power: number }
  | { type: 'selectWeapon'; playerId: number; weapon: WeaponId }
  | { type: 'move'; playerId: number; dir: -1 | 1 } // F6: un paso de ~1 px gastando combustible
  | { type: 'fire'; playerId: number }
  | { type: 'useItem'; playerId: number; item: ItemId } // shield, fuel, repair, tracer; en su turno
  | { type: 'nextRound' } // roundover → shop (o gameover si era la última)
  | { type: 'buy'; playerId: number; id: ShopId } // shop: compra un paquete
  | { type: 'sell'; playerId: number; id: ShopId } // shop: devuelve un paquete al 50%
  | { type: 'ready'; playerId: number } // shop: listo. Con todos los humanos listos arranca la ronda
  | { type: 'setKind'; playerId: number; kind: PlayerKind } // online: un desconectado pasa a IA y vuelve a humano
// Las IA compran solas al entrar a la tienda (determinista, con el rng del estado).

export interface Vec2 {
  x: number
  y: number
}

export type ImpactKind = 'terrain' | 'tank' | 'prop' | 'out' | 'lava' // lava: se derritió, sin explosión

export interface Impact {
  kind: ImpactKind
  x: number
  y: number
  tankId?: number
  propId?: number
}

// Un disparo puede tener varios proyectiles (racimo). Cada uno con su camino y su impacto.
export interface Flight {
  path: Vec2[] // un punto cada PATH_DT segundos
  impact: Impact
  startT?: number // segundos desde el disparo en que arranca este tramo (racimo, rodadora)
  splashes?: { x: number; y: number; t: number }[] // v4: dónde y cuándo (desde el inicio del tramo) entró al agua
}

export type GameEvent =
  | {
      type: 'impact'
      x: number
      y: number
      weapon: WeaponId
      blast: BlastStyle
      radius: number
      t: number // segundos desde el disparo; el playback lo dispara en ese momento
      // cuántos pixels de cada material se rompieron: el renderer tira escombros de esos colores
      debris: Partial<Record<Material, number>>
      source?: 'shot' | 'barrel' // 'barrel': explosión en cadena de un barril
    }
  // t opcional: momento de playback. Sin t, el evento va con el impacto anterior de la lista.
  | { type: 'damage'; playerId: number; amount: number; hp: number; t?: number; cause?: 'lava' } // cause: v2, quemado por la lava
  | { type: 'death'; playerId: number; t?: number; cause?: 'abyss' | 'lava' } // cause: v3/v2, sin explosión de restos si es 'abyss'
  | { type: 'fall'; playerId: number; from: number; to: number; parachute?: boolean; t?: number; water?: boolean } // water: v4, cayó al agua (sin daño)
  | { type: 'prop'; propId: number; kind: PropKind; x: number; y: number; destroyed: boolean; t?: number }
  | { type: 'burn'; x: number; y: number; w: number; t?: number } // napalm quemando una franja
  | { type: 'shield'; playerId: number; absorbed: number; left: number; t?: number } // el escudo paró daño
  | { type: 'item'; playerId: number; item: ItemId } // useItem aplicado
  | { type: 'turn'; playerId: number }
  | { type: 'wind'; value: number }
  // Pulido v2: el tanque se corrió por el piso (empuje de una explosión o pendiente). path: piso del tanque cada
  // PATH_DT segundos desde t. Si termina sin piso, después viene un 'fall'.
  | { type: 'slide'; playerId: number; cause: 'blast' | 'slope'; path: Vec2[]; t?: number }
  // v4: los líquidos se asentaron. patches[i] se aplica a la grilla en t + i * dt (el último deja el estado final).
  | { type: 'flow'; t: number; dt: number; patches: TerrainPatch[] }
  | { type: 'steam'; x: number; y: number; n: number; t?: number } // v4: agua y lava hicieron piedra (n celdas)
  | { type: 'lava'; from: number | null; to: number; warn: number } // v2: la lava subió (from null = apareció); warn = tiros sin daño que faltan para la muerte súbita (0 si ya empezó)
  | { type: 'calm'; left: number } // v2: tiros sin daño que faltan para que empiece la muerte súbita (se emite al cambiar, 0 = empezó)
  | { type: 'roundover'; winnerId: number | null; earnings: Record<number, number>; last: boolean }
  | { type: 'round'; round: number; biome: Biome } // arrancó una ronda nueva (mapa nuevo)
  | { type: 'shop' }
  | { type: 'gameover'; winnerId: number | null }
  | { type: 'empty'; playerId: number }

export interface StepResult {
  state: GameState
  events: GameEvent[]
  flights?: Flight[]
}

export const TANK_COLORS = [0x3d8cf0, 0xe23d3d, 0xe2c13d, 0x3dbe5a]
