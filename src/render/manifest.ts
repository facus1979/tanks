// Contrato entre scripts/paint-assets.mjs (que genera public/assets/) y el renderer.
// paint-assets escribe public/assets/manifest.json con esta forma exacta.
// Todos los PNG son pixel art a escala 1 (1 pixel de asset = 1 pixel lógico de 800×450).

import type { Biome, CrewId, Material } from '../sim'

export interface Strip {
  file: string // relativo a public/assets/
  cell: { w: number; h: number } // tamaño de cada frame
  frames: number // frames en una sola fila, de izquierda a derecha
}

export interface AssetManifest {
  version: 2

  // Cuerpo del tanque mirando a la derecha: casco + torreta + orugas, TANK_W × TANK_H.
  // Una variante por color de jugador (índice = player.id, en el orden de TANK_COLORS; v5: 8). Franja y banderín ya pintados.
  tank: {
    bodies: string[] // 8 archivos (v5), TANK_W × TANK_H
    wreck: string // tanque destruido, mismo tamaño
    // Cañón por ángulo local (0 = horizontal adelante, 90 = vertical), paso de 5°: 19 frames.
    // Pivote del cañón en (pivot.x, pivot.y) dentro de cada celda.
    barrels: Strip[] // 8 tiras (v5), una por color de casco
    barrelPivot: { x: number; y: number }
    // Desde la esquina superior izquierda del cuerpo: dónde va el pivote del cañón y el tripulante.
    pivotInBody: { x: number; y: number }
    crewInBody: { x: number; y: number } // esquina superior izquierda del sprite del tripulante
    antennaInBody: { x: number; y: number }
    treadFrames?: Strip[] // opcional: orugas animadas para F6
  }

  crews: Record<CrewId, { sprite: string; portrait: string }> // sprite 12×12, retrato 32×32

  // Texturas de material, repetibles en coordenadas de mundo (tile = x % w, y % h).
  // El renderer aplica bordes, sombras y pared de fondo; la textura es solo el relleno.
  materials: Record<Material, { file: string; w: number; h: number }>

  // Fondo por bioma: capas de atrás hacia adelante, WORLD_W × WORLD_H, con alfa.
  // La capa 0 es el cielo (opaca). La última es la más cercana (pinos oscuros, siluetas).
  // v2.3: repeat dice cómo se repite cada capa a lo ancho en mapas Mediano y Grande: 'mirror' (copia,
  // copia espejada, ...; lo de v2) o 'wrap' (la misma capa una al lado de la otra; la capa tiene que ser
  // periódica: el borde derecho empalma con el izquierdo). Sin repeat, 'mirror' para todas.
  backgrounds: Record<Biome, { layers: string[]; fog: number; tint: number; repeat?: ('mirror' | 'wrap')[] }>

  // Paleta del bioma para el renderer: pasto, musgo, borde de tierra, luz ambiente.
  biomePalette: Record<Biome, { grass: number[]; moss: number; rim: number; ambient: number }>

  props: {
    barrel: string // 10×12
    crate: string // 12×12
    ladderTile: string // 8×4, se repite en vertical
    lamp: string
    flag: Strip // bandera flameando
    parachute: string // paracaídas abierto, ~20×16, el tanque cuelga del centro de abajo
    windsock: Strip // 7 frames: viento -10..10 en pasos, el del medio es sin viento
    // v3 (opcionales hasta que el arte los pinte; sin ellos el renderer usa su respaldo)
    loot?: string // caja de botín ~14×12 (cae con el paracaídas de arriba)
    target?: Record<Biome, string> // objetivo pago por bioma (camión, depósito, tanque de combustible), ~32×20
    mine?: Strip // mina clavada, 2 frames (luz apagada / prendida), ~10×6
    missile?: string // misil teledirigido, ~10×4 mirando a la derecha
  }

  ui: {
    bubbleAlert: string // "!"
    bubbleAsk: string // "?"
    tag: string // globo vacío de 11 px de alto para "P1".."P4"; el texto lo pone la fuente
    font: { file: string; glyphW: number; glyphH: number; chars: string } // fuente pixel en una fila
    arrow: string // flecha para proyectil fuera de pantalla
    pip: Strip // ícono de munición/vida: frame 0 lleno, 1 vacío
    weaponIcons: Strip // v3: 16 frames de 12×12 en el orden de WEAPON_ORDER de types.ts
    itemIcons: Strip // v3: 9 frames de 12×12 en el orden de ITEM_ORDER de types.ts
    logo: string // logo del título en pixel art, ~320×96
  }
}
