# Tanks

Artillería por turnos en el browser: las reglas de Scorched Earth con la estética de Broforce. Un humano contra 1 a 3 IAs. Después, la misma simulación en un servidor para multijugador online.

Este archivo es la definición del proyecto. Si una decisión de acá cambia, se actualiza acá antes de codear el desvío.

## Objetivo

Scorched Earth: tanques sobre terreno irregular, ángulo y potencia, viento, trayectorias balísticas, terreno deformable, armas con explosiones distintas, tanques que se mueven.

Broforce: pixel art moderno, personajes con personalidad, explosiones exageradas, destrucción visual del escenario, terreno con textura (no bloques planos).

**Referencia visual aprobada:** `preview/look-test-1080.png`, generada por `scripts/lookdev/look-test.mjs`. El juego tiene que verse así. Es la vara para todas las capturas de QA.

## Decisiones cerradas

- Cliente: TypeScript + Vite. Render: PixiJS. Física propia, determinista, timestep fijo. Sin motor de cuerpos rígidos.
- **Resolución lógica de pantalla 800×450**, escalada con nearest-neighbor al tamaño de la ventana. Hasta v1 el mundo medía lo mismo que la pantalla; desde v2 el mundo es variable (ver v2) y la pantalla es una cámara sobre él.
- **Terreno por pixel con materiales** (`Terrain.front` y `Terrain.back`, `Uint8Array` de 800×450). `front` colisiona. `back` es lo que había detrás y se dibuja oscuro donde `front` es aire. Esa es la pared de fondo de Broforce.
- Materiales: tierra, piedra, ladrillo, madera, tabla, viga, poste, metal, roca madre. Cada uno con dureza; ver `MATERIALS`.
- **Tanque de 28×20** con tripulante de 12×12 asomado por la escotilla. Cada jugador tiene color y tripulante propios.
- **`POWER_SCALE` 4.03**, gravedad 220: potencia 100 cruza el mapa. En v2 los dos se derivan del ancho del mapa para que esto siga valiendo. Si el proyectil sale por arriba, se muestra una flecha en el borde.
- Biomas: bosque con niebla (el de la referencia), jungla, atardecer industrial.
- Máximo 4 jugadores (8 desde v2). Arte propio generado por código (`scripts/paint-assets.mjs`); sin assets de terceros.
- Sangre: no. Chispas, humo, escombros y fuego.
- El online no se construye ahora, pero no puede exigir reescribir las reglas.

## Reglas

- Vida 100. Gana el último tanque en pie; si no queda ninguno, empate. (V5: la lava no mata al último en pie; ver V5.)
- Viento nuevo por vuelta (v2.2: cambia cuando todos los vivos dispararon una vez; antes, cada turno), visible antes de apuntar, con aviso "Cambia el viento". Rango -10 a 10.
- Ángulo 0 a 180: 0 es horizontal a la derecha, 90 arriba y 180 horizontal a la izquierda. Potencia 0 a 100.
- El tanque se apoya en el terreno. Si el piso desaparece, cae y recibe daño de caída. Si la tierra lo tapa, aplasta.
- Un tiro puede dañar al que dispara. Los barriles explotan en cadena.
- La IA usa la misma física, en una copia del estado, y le mete error según la dificultad.
- F6: combustible por turno (`fuelFor(width)`). v2.2: el tanque sube escalones de hasta `MAX_CLIMB` = 10 px y pendientes de hasta ~75° (`SLIDE_SLOPE` 3,75); subir gasta más (1 + `CLIMB_FUEL` 0,6 por unidad de pendiente por paso). Por encima de 75° resbala.

### Armas

Valores finales de `WEAPONS` (F9). Balance medido con `npm run sim-check` (IA normal contra IA normal, 20 partidas): 11.1 tiros por partida de 2 tanques, 20.6 con 4.

| # | Arma | Radio | Daño | Munición | Efecto |
|---|---|---|---|---|---|
| 1 | Normal | 14 | 22 | 99 | explosión `fire` |
| 2 | Pesada | 26 | 36 | 2 | `bigfire` |
| 3 | Tierra | 18 | 20 | 3 | agrega tierra (`build`); daña a medio radio |
| 4 | Racimo | 10 | 12 c/u | 2 | se parte en 5 bombitas en el apogeo (vuelos con `startT`) |
| 5 | Napalm | 16 | 14 + 18 de fuego | 2 | el fuego corre 40 px por la superficie, quema lo inflamable (front a AIR, back queda) y daña a los tanques adentro; eventos `burn` |
| 6 | Excavadora | 9 | 10 | 2 | cava un túnel de 80 px en la dirección del vuelo; atraviesa todo salvo roca madre |
| 7 | Rodadora | 16 | 30 | 2 | al tocar el piso rueda cuesta abajo (segundo vuelo con `startT`) hasta frenar, chocar una pared o un tanque |
| 8 | Nuke | 60 | 55 | 1 | `nuke` |

La IA: error normal ±7° y ±8 de potencia (V5; antes ±6° y ±7). Si no tiene tiro, prueba moverse (`ShotPlan.move`, pixels con signo; la sesión manda esos comandos `move` antes de apuntar). Tapada y sin tiro, usa la excavadora. Elige el arma verificando con la simulación completa y con un costo por munición especial.

### Rondas y tienda (F10)

Valores de `SHOP`, `EARN`, `START_MONEY` (600), `SHIELD_HP` (30) y `REPAIR_HP` (25). Cada jugador arranca con el kit de `WEAPONS.ammo`; la munición y los ítems se conservan entre rondas (la normal vuelve a 99). Vender devuelve el 100% de lo pagado (v2.2; antes 50%). La plata nunca queda negativa.

| Artículo | Precio | Paquete | Máx |
|---|---|---|---|
| Pesada | 250 | 2 | 9 |
| Tierra | 120 | 3 | 9 |
| Racimo | 300 | 2 | 9 |
| Napalm | 280 | 2 | 9 |
| Excavadora | 150 | 2 | 9 |
| Rodadora | 220 | 2 | 9 |
| Nuke | 900 | 1 | 2 |
| Escudo (absorbe 30) | 350 | 1 | 3 |
| Paracaídas | 120 | 1 | 3 |
| Combustible (+60) | 80 | 1 | 5 |
| Reparación (+25) | 250 | 1 | 3 |
| Trazador | 150 | 1 | 5 |

Plata por ronda: 4 por punto de daño a otros (escudo incluido), 300 por kill, 150 por sobrevivir, 400 por ganar la ronda, −4 por punto de autodaño. Campeón: más rondas ganadas, después kills, después plata; empate total sin campeón. Mapa de cada ronda con `roundSeed(seed, ronda)` (la ronda 1 da el mismo mapa que antes); bioma `rotate` = bosque → jungla → industrial, `random` derivado de la seed.

La IA compra al entrar a la tienda (`aiShop`, pesos por dificultad; la difícil junta para la nuke) y usa reparación y escudo con umbrales de vida por dificultad (`chooseItems`; `ShotPlan.items` se aplica con `useItem` antes de moverse).

Balance medido con `npm run sim-check -- --balance` (30 partidas de 3 rondas, 3-4 IA normal): compran algo en 203/210 visitas, gasto medio 845 por visita, ganancia media 741 por ronda, 26.6 tiros por ronda (21.0 / 27.6 / 31.2 por ronda), el ganador de una ronda repite en 21/60 y el que entra con más plata gana 22/60 (sin bola de nieve).

### Controles

| Tecla | Acción |
|---|---|
| Izquierda / Derecha | Sube / baja el ángulo |
| Arriba / Abajo | Sube / baja la potencia |
| A / D (mantener) | Mueve el tanque gastando combustible (barra COMB en el HUD) |
| 1 a 8 o click en el selector | Elige arma (orden de `WeaponId`; sin munición queda gris) |
| Espacio | Disparar |
| Shift (mantener) | Ajuste fino: ángulo y potencia a 1/5 de velocidad |
| M | Silencia / activa el sonido |
| Q / F / R / T | Ítems: escudo, combustible, reparación, trazador (solo en tu turno; el paracaídas es pasivo) |
| P | Pausa |
| Z / X | Mueve la cámara a la izquierda / derecha (mapas Mediano y Grande) |
| C | Recentra la cámara en el tanque del turno |
| Esc | En la tabla, vuelve al menú |

Cámara (v2): mouse contra el borde o arrastrando el mundo (botón del medio, o el izquierdo fuera del tanque, la barra y el minimapa); click/toque en el minimapa centra, arrastrarlo mueve la vista, doble click/toque recentra; stick derecho panea y R3 recentra; en táctil, dos dedos y el botón ◎.

Gamepad: stick o cruz = ángulo y potencia, gatillos o bumpers = mover, A dispara, X/Y arma anterior/siguiente, B primer ítem usable (escudo, reparación, combustible, trazador), Start pausa. En las pantallas: A elige/compra, B atrás/vende, Start LISTO/JUGAR.

QA: `?play=<seed>&humans=N&bots=N&rounds=N` (con `&biome=` opcional) entra directo a una partida; `&aisync=1` corre la IA en el hilo principal en vez del worker. `?uitest=title|menu|banner|score|final|shop|hud` muestra cada vista con modelos falsos (`&s=2` fuerza la escala de UI).

## Arquitectura

La simulación no conoce a Pixi, al DOM ni a la red. El renderer no decide daño, viento ni de quién es el turno.

```
src/sim        estado + comando → estado nuevo. Puro, determinista, testeable.
src/game       sesión local: playback de los tiros, turno de la IA, modo demo
src/render     Pixi. Dibuja terreno, tanques, efectos. Solo escucha eventos.
src/input      teclado
src/ui         menú y HUD en HTML
src/audio      efectos
scripts/       paint-assets.mjs (arte), sim-check.ts (pruebas de sim), screenshot.mjs (QA)
```

**Contratos**, que no se cambian sin actualizar este archivo:

- `src/sim/types.ts`: estado, comandos, eventos, materiales y constantes. Coordenadas con **y hacia abajo**.
- `src/render/manifest.ts`: forma de `public/assets/manifest.json`, que genera `paint-assets.mjs` y consume el renderer. `tank.treadFrames`: una tira de 4 frames 28×6 por color (orden de `bodies`), va sobre las últimas 6 filas del cuerpo; el frame f+1 es el tanque 1 px más adelante.
- `src/render/types.ts`: `RenderFrame` que arma la sesión en cada frame. `matchId` cambia en cada `Session.start`; el renderer limpia cráteres, restos y partículas cuando cambia. `weapon` es el arma del tiro en curso (del estado antes de disparar; `null` sin tiro): el renderer elige con ella el sprite del proyectil y detecta la rodadora.
- `src/sim/index.ts` exporta como mínimo: `createMatch`, `applyCommand`, `chooseShot`, `groundAt(terrain, x, halfW, fromY?)` (la y del piso bajo esa franja; con `fromY` busca hacia abajo desde esa fila, sin él desde el cielo), `fly`, `muzzle(x, ground, angle, tilt?)` (con `tankTilt(terrain, x, y)`: el casco se apoya inclinado sobre la pendiente hasta `MAX_TILT` = 75° y el tiro sale de la boca del cañón inclinado; el render dibuja con la misma función), `PATH_DT`, `isSolid(terrain, x, y)`, más todo lo de `types.ts`.
- Eventos: `impact` trae `source?: 'shot' | 'barrel'` (explosión en cadena de un barril). `damage`, `death`, `fall`, `prop` y `burn` traen un `t?` opcional; sin `t`, la sesión los ubica con el impacto anterior de la lista. `fire` devuelve `flights` (en F1 uno solo, `startT` 0) y `fly` devuelve también `time`.
- Utilería en sim (`Prop.w/h`): barril 10×12, caja 12×12, escalera 8×h (se dibuja repitiendo `ladderTile` 8×4), foco 5×7 colgado del techo (`y` es la primera fila de aire), bandera 20×36 con el mástil en `x..x+1` y la tela a la derecha, manga 2×28 (solo el mástil; la manga la dibuja el renderer según el viento). Los sprites del manifiesto pueden ser más grandes (bandera 22×38 con el mástil en la columna 1, manga 33×30 con el mástil en la columna 16 y el suelo en la última fila).

Comandos, y nada más, modifican la partida: `aim`, `selectWeapon`, `move`, `fire`. El resultado de `fire` trae los vuelos (`flights`) para animar y los eventos con su tiempo `t`. El estado autoritativo ya está resuelto cuando el proyectil "sale". La animación es presentación.

Para no romper el online más adelante:

- RNG con seed guardada en el estado. Nada de `Date.now()` ni `Math.random()` dentro de `sim`.
- El estado se puede clonar y serializar. Las grillas viajan como bytes.

### Modo demo (QA visual)

`?demo=<seed>` arranca sola una partida de 1 ronda en el bosque con 4 IAs (P1 con la pestaña VOS, sin extras de ronda/plata en el HUD) y hace que P1 dispare un tiro fijo. El render se congela en el pico de la explosión. `?demo=<seed>&biome=jungle` cambia el bioma y `&freeze=0` no congela. `&weapon=<WeaponId>` hace que el tiro fijo de P1 use esa arma (QA de racimo, napalm, excavadora, rodadora y nuke). `?fxtest=<WeaponId>` (solo render) dibuja explosiones y proyectiles con el estilo de esa arma sin cambiar el terreno. `node scripts/screenshot.mjs "demo=1" preview/game-demo.png` saca la captura a 1920×1080 para comparar contra `preview/look-test-1080.png`.

### Dueños de archivos (trabajo en paralelo)

| Área | Archivos |
|---|---|
| sim | `src/sim/**` (salvo cambios de contrato), `scripts/sim-check.ts` |
| arte | `scripts/paint-assets.mjs`, `scripts/lookdev/**`, `public/assets/**` |
| render | `src/render/**` (salvo `manifest.ts`) |
| vistas | `index.html`, `src/style.css`, `src/ui/**` (salvo `src/ui/types.ts`) |
| flujo | `src/main.ts`, `src/game/**`, `src/input/**`, `src/audio/**` |
| publicación | `.github/**`, `README.md`, `vite.config.ts` |
| red | `src/net/**` (salvo `src/net/types.ts`), `scripts/net-test.mjs`, dependencias en `package.json` |

Contratos extra: `src/ui/types.ts` (vistas ↔ flujo: título, menú, tienda, tabla, cartel de hot-seat, extras del HUD).

## Roadmap

Las fases F1 a F4 forman la primera muestra, que tiene que parecerse a la referencia aprobada.

- **F1 Terreno por pixel (sim).** Grilla de materiales, generación procedural por bioma (plataformas de piedra, búnker de ladrillo, torre de madera, cuevas), colisión, deformación con dureza, apoyo, caída y aplastamiento, utilería con barriles en cadena, IA sobre la grilla.
  - Estado: hecha. `sim-check` 11087/11087 OK en los tres biomas.
- **F2 Render del terreno.** Texturas por material, bordes, pared de fondo con oclusión, chamuscado, pasto y raíces.
  - Estado: hecha. Materiales, bordes, pared de fondo, chamuscado y pasto/raíces a la par de `look-test.png`.
- **F3 Ambientación.** Fondos por capas con niebla por bioma, utilería (escaleras, focos, banderas, manga de viento).
  - Estado: hecha. Bosque, jungla e industrial con capas, niebla y utilería.
- **F4 Explosiones.** Racimo de fuego con núcleo blanco, humo, escombros del material, chispas, luz, sacudón, flash y hit-stop. Una firma visual por `BlastStyle`.
  - Estado: hecha. Firma por `BlastStyle`, tope de 300 partículas y polvo de suelo claro en fire/bigfire.
- **F5 Personajes.** Tanques con tripulante, retroceso al disparar, tanque destruido en llamas, globos "!" y "?".
  - Estado: hecha. Tripulante, retroceso, restos en llamas y globos "!"/"?".
- **F6 Movimiento.** A/D con combustible, pendientes, caída.
  - Estado: hecha. A/D con combustible, pendientes y caída.
- **F7 Arsenal.** Racimo, napalm, excavadora, rodadora y nuke, con su efecto de terreno y su explosión.
  - Estado: hecha. Racimo, napalm, excavadora, rodadora y nuke con terreno y explosión propios.
- **F8 HUD al estilo Broforce.** Retratos, fuente pixel, munición en íconos, manga de viento.
  - Estado: hecha. Placas con retrato, "Pn" y pestaña VOS, placas compactas para 3–4 tanques, munición y viento.
- **F9 Feel, audio y balance.** Sonido por arma y material, partidas de 8 a 15 tiros, IA ajustada.
  - Estado: hecha, con el ajuste fino pendiente de oído. Sonido por arma y por material dominante del debris; 11.1 tiros por partida con 2 tanques y 20.6 con 4.
  - Rendimiento (2026-09-28, Chrome headless, GPU Intel D3D11, build de producción, rAF 20 s en tiempo real): `?demo=5&freeze=0` frame medio 16.7–16.8 ms, p95 16.8 ms, picos sueltos de 50–67 ms (turno de IA / inicio de explosión); `?fxtest=nuke` frame medio 16.7 ms, p95 16.8 ms. Antes del arreglo el demo daba 17.4–17.5 ms de media: `Raster.light()` se comía ~29% del CPU y ahora usa la caída tabulada por radio y recorta cada fila a su cuerda.
- **F10 Rondas, tienda y hot-seat.** Partida de 1/3/5/10 rondas con mapa nuevo, plata por daño/kills/supervivencia, tienda entre rondas (armas, escudo, paracaídas, combustible, reparación, trazador), IA que compra, 2-4 casilleros humano/IA (hot-seat con cartel de turno), tabla entre rondas.
- **F11 Feel II.** Pantalla de título con logo, tripulante eyectado al morir, cámara lenta en el golpe que cierra la ronda, IA en un worker (sin tirones), gamepad.
- **F12 Publicación.** Deploy a GitHub Pages con GitHub Actions, README.
- **F13 Online P2P.** Salas con código y link (`?join=CODIGO`), WebRTC vía PeerJS sin servidor propio; transporte local (BroadcastChannel, `?net=local`) para pruebas. El anfitrión es la autoridad: valida comandos y reparte el log ordenado; los clientes aplican el log sobre su réplica (sim determinista), con hash periódico y snapshot si hay desincronización. Límite de tiempo por turno, desconectado → IA, reconexión con token. Contrato: `src/net/types.ts`. Limitación aceptada: si el anfitrión se va, termina la partida.
  - Estado: hecho. `npm run net-test` pasa con el transporte local (2 humanos + 1 IA, una ronda, réplicas con el mismo hash) y con PeerJS por internet (dos pestañas en la misma PC). Falta probarlo entre dos redes distintas.
- **F14 Controles táctiles (tablet y celular).**
  - Estado: primera versión hecha (`src/input/touch.ts`): apuntar arrastrando, botones en pantalla, aviso para girar el dispositivo, pantalla completa, vibración en tu turno online, campo del código de sala con teclado del sistema. Falta probarlo en dispositivos reales y medir fps en un celular de gama media.
  - Apuntar arrastrando desde el tanque: la dirección del arrastre da el ángulo y el largo da la potencia, con la trayectoria corta como guía. También se puede ajustar fino con botones +/- de ángulo y potencia.
  - Botones en pantalla: disparar, mover ◀ ▶ (mantener), rueda de armas e ítems. Se muestran solo si el dispositivo es táctil (`pointer: coarse`).
  - Pantallas (título, menú, lobby, tienda, tabla) usables con el dedo: objetivos de 44 px o más, sin hover, teclado virtual para el código de sala.
  - Horizontal obligatorio (cartel "girá el dispositivo" en vertical), pantalla completa con un toque y vibración corta en impactos y en tu turno (`navigator.vibrate`).
  - Criterio: una partida completa, incluida la tienda, jugable solo con el dedo en un celular de 6" y en una tablet, a 60 fps en un celular de gama media.
- **Online con servidor** (más adelante, si hace falta): el mismo código del anfitrión corriendo en Node detrás de otro `Transport`.
- **Online**, como antes: servidor autoritativo que corre el mismo `sim`, sin lockstep.

## v2: mundo grande

Decidido el 2026-10-01. Reemplaza a "una sola pantalla, sin cámara" y "máximo 4 jugadores".

### Decisiones

- **Tamaño por partida**, elegido en el menú: Chico 800×450 (el mapa de v1), Mediano 1600×450, Grande 2400×450. Alto fijo. El tamaño viaja en el estado (`terrain.w/h`); `WORLD_W/WORLD_H` dejan de usarse fuera de la pantalla.
- **Alcance**: potencia 100 llega siempre de punta a punta. `POWER_SCALE` y `GRAVITY` se derivan del ancho del mapa de modo que un tiro de lado a lado a 45° dure ~3 s; con 800 dan los valores de v1. `WIND_ACCEL` escala igual. Shift ajusta ángulo y potencia a 1/5 de velocidad.
- **Muerte súbita**: tras 5 tiros seguidos sin daño a tanques, la lava sube 18 px desde el fondo en cada turno y quema 20 por turno a los tanques sumergidos; los proyectiles que la tocan se derriten sin explotar. La lava no da ni quita plata ni cuenta como kill. v2.2 (pedido del usuario): cuando un tanque le pega a otro (el autodaño no cuenta), la cuenta vuelve a 0 aunque la muerte súbita esté activa: la lava se frena donde está, sigue quemando a los hundidos y hacen falta otros 5 tiros sin daño para que vuelva a subir. Se sacó el tope de calma de V5, así que una ronda con mucho daño puede alargarse.
- **Hasta 8 jugadores**: 4 colores y 4 tripulantes nuevos; HUD rediseñado para 5-8 placas. Spawns repartidos a lo ancho.
- **Líquidos que fluyen**: agua y lava son materiales de la grilla. Se asientan con un autómata celular determinista al final de cada `fire`, con tope de iteraciones; los cambios salen como evento para que el render los anime.

### Reglas nuevas

- **Abismo**: tramo sin fondo (`Terrain.pits`). Lo que cae por debajo del mapa en un abismo se pierde: el tanque muere (`death.cause = 'abyss'`, el paracaídas no lo salva), el proyectil sale ('out') y la utilería se destruye. Fuera de los abismos, debajo del mapa sigue siendo roca madre.
- **Agua**: no colisiona. Amortigua caídas (sin daño de caída), frena los proyectiles que entran y reduce a la mitad el radio de las explosiones sumergidas.
- **Lava**: no colisiona. Un tanque que la toca recibe daño por turno, enciende lo inflamable vecino y derrite los proyectiles (no explotan). La tierra (arma Tierra o derrumbe) sobre lava se vuelve piedra; agua y lava en contacto dan piedra.

### Contratos v2

- `src/sim/types.ts`: `MapSize`, `MAP_SIZES`, `MAP_SIZE_ORDER`, `MatchConfig.size`, `GameState.size` (con `width`/`height`), `Physics` y `physicsFor(width)`. `WORLD_W/WORLD_H` quedan como el tamaño del mapa Chico; nada fuera de `sim` los usa como tamaño del mundo.
- `src/render/types.ts`: `VIEW_W/VIEW_H` (pantalla lógica 800×450), `Camera { cx, cy, zoom }`, `RenderFrame.camera`, `GameRenderer.screenToWorld`. La cámara la decide el flujo; el renderer la aplica y suma el sacudón.
- `src/ui/types.ts`: `HudExtras.minimap` (`MinimapModel`, `MinimapTank`), `MinimapInput.minimapAt` (lo implementa `Hud`), `DEFAULT_CONFIG.size` = `'medium'`, `setOption('size')` en el lobby.
- `src/net/types.ts`: `LobbyState.size`.
- QA: `?play=...&size=small|medium|large`, `?demo=...&size=...`.
- V4 (`src/sim/types.ts`): `WATER` (10) y `LAVA` (11) con `MaterialDef.liquid`, `WATER_DRAG`, `WATER_BLAST_SCALE`, `FLOW_MAX_ITERS`, `FLOW_FRAME_ITERS`, `TerrainPatch`, eventos `flow` (parches para animar el asentamiento) y `steam`, `Flight.splashes`, `fall.water`. Los líquidos no tienen textura en el manifiesto: los dibuja el render.
- V3 (`src/sim/types.ts`): `Terrain.pits` (columnas de abismo), `death.cause` (`'abyss' | 'lava'`).
- V2 muerte súbita (`src/sim/types.ts`): `SUDDEN_DEATH_CALM` (5), `LAVA_RISE` (18 px por turno), `LAVA_DAMAGE` (20 por turno), `GameState.calm` y `GameState.lava` (y de la superficie o null), `ImpactKind` `'lava'` (proyectil derretido, sin explosión), eventos `lava` y `calm`, `damage.cause = 'lava'`. `RenderFrame.lava`, `HudExtras.suddenDeath`, `MinimapModel.lava`.

### Fases

- **V1 Mundo variable y cámara.** Tamaño en el estado y en el menú; cámara que sigue al tanque activo y al proyectil (se aleja en vuelos largos) y vuelve; paneo libre (mouse al borde, arrastre, Z / X, stick derecho, dos dedos); minimapa (ver abajo); indicadores de enemigos fuera de pantalla; fondos con parallax. Render del terreno en trozos, solo lo visible o lo que cambió; efectos en buffer de pantalla. Criterio: el mapa Grande a 60 fps con el mismo presupuesto que v1.
  - **Minimapa**: franja arriba al centro del HUD con el mapa entero a escala 1/10 (160×45 en Mediano, 240×45 en Grande; no aparece en Chico, que no scrollea). Muestra la silueta del terreno (se actualiza con cada deformación), agua y lava con su color, los tanques como puntos de su color (el del turno titila, los muertos como ×), el proyectil en vuelo y la marca del último impacto de cada jugador, y el viewport como un rectángulo.
  - Click o toque en el minimapa centra la cámara ahí; arrastrar el rectángulo mueve el viewport. Con gamepad, el stick derecho mueve el viewport y se ve en el minimapa.
  - Mientras apuntás, la cámara se queda donde la dejaste (para mirar al objetivo mientras ajustás); `C`, doble toque en el minimapa o el botón de recentrar la devuelven a tu tanque. Al disparar sigue al proyectil; al terminar el tiro vuelve al tanque del turno siguiente.
  - Estado: hecha (2026-10-01), repartida en cuatro agentes (sim, render, vistas, flujo) sobre el contrato v2 e integrada en la rama `v2-mundo`.
    - sim: `generate(biome, rng, count, width, height)` arma el mapa con tramos de `TRAMO_W` = 800 (Chico = 1 tramo, byte a byte igual que v1; Mediano 2, Grande 3, empalmados meseta→plataforma); spawns repartidos a lo ancho (válidos hasta 8). `fly` y la rodadora usan `physicsFor(terrain.w)`. IA: error de puntería dividido por k, búsqueda más fina en mapas anchos, `skylineOf` + `FlyOptions.skyline` para saltear vuelo por encima del terreno. `sim-check` 31645/31645 OK; tiros por partida con 2 / 4 tanques: Chico 11.1 / 20.6, Mediano 12.7 / 31.3, Grande 14.6 / 31.2; alcance de potencia 100 a 45° en llano: 796/800, 1501/1600, 2239/2400 (2.8 / 3.1 / 3.5 s); IA peor caso 71 / 85 / 84 ms.
    - render: terreno en trozos de 256 px con culling y repintado por trozo; partículas y luces en buffers de pantalla (808×458) con coordenadas de mundo; focos como sprites aditivos; parallax por capa (cielo 0,04 a 0,7), repitiendo cada capa con su copia espejada. CPU de `render()` en Chrome headless: Chico 5,5 ms medio (base 5,9), Grande paneando 3,2 ms. Chico idéntico pixel a pixel a v1.
    - vistas: `src/ui/minimap.ts` (minimapa y flechas), fila MAPA en menú y lobby, `?uitest=hud&size=`.
    - flujo: `src/game/camera.ts` (amortiguado crítico: 0,45 s al tanque, 0,2 s al proyectil, 0,55 s el zoom; zoom del tiro `min(1, 640/ancho del vuelo, 450/(alto − apogeo + 30))`, mínimo 0,5), `src/input/mouse.ts`, paneo y recentrar en gamepad y táctil, último impacto por jugador, `&size=` en `?play=` y `?demo=`.
    - Pendientes: cerrados. El pino de `forest-4` y las simetrías de los fondos se resolvieron en V3 y v2.3 (capas periódicas); las partidas largas de 4 tanques, con la muerte súbita (V2); el snapshot pesado, en v2.3 (formato `TK` v2); el acuerdo de nombres de agua y lava se aplicó en V4. El pilar con dintel de la jungla, con el generador por tramos de V3, va solo contra el borde del mapa (`seg.first` en `gen.ts`), no en cada empalme.
- **V2 Alcance y balance de distancias.** Física derivada del ancho, ajuste fino, IA que apunta a cualquier distancia y decide moverse, muerte súbita. `sim-check` por tamaño.
  - Estado: hecha (2026-10-01), en cuatro agentes sobre el contrato de muerte súbita, integrada en `v2-mundo`.
    - sim: `endTurn` cierra el turno (fire, pase sin munición, muerte al moverse). Orden: eventos del tiro → `calm` → `lava` → daño/escudo/muerte de la lava (con `t` = fin del tiro + `LAVA_DELAY` 0,4 s) → `turn`/`wind` o `roundover`. El escudo cuenta como daño para la calma; una vez empezada, la calma queda fija. La lava aparece en `height − LAVA_RISE`. `FlyOptions.lava`, `lavaRisk` en la IA (se aleja hacia arriba, no tira a la lava, gasta munición especial). `sim-check` 31752/31752; tiros por partida 2 / 4 tanques: Chico 10,6 / 18,9, Mediano 9,9 / 25,1, Grande 12,4 / 21,1 (máximo de Grande con 4: 77 → 28). Ronda sin disparos: termina por la lava en 16 turnos.
    - render: `src/render/pixi/lava.ts`: franja animada de 16 filas a 30 Hz más dos texturas profundas que fluyen, resplandor aditivo, tinte cálido con la lava alta, olas y goterones al subir, chispas y humo en tanques quemados, chisporroteo al derretirse un proyectil (desaparece a < 26 px de la superficie sin `impact`). Cuesta ~0,23 ms de CPU de `render()` en Grande.
    - vistas: aviso "MUERTE SÚBITA EN N" (N ≤ 3) y cartel titilante cuando está activa; banda de lava en el minimapa; `?uitest=hud&sd=N|lava`.
    - flujo: ajuste fino (Shift, L3/Select, toque corto de 0,2 en táctil; el tiro humano sale con un decimal y el HUD muestra décimas), lava animada en 0,8 s, sonidos `lavaRise`, `melt`, `lavaBurn`, `suddenDeath` y vibración, `?play=...&calm=N`.
    - Pendientes: cerrados. El combustible por ancho se aplicó en el pulido (`fuelFor(width)`); las vetas de la lava, en v2.3; el napalm bajo la lava, en v2.4.
- **V3 Geografía por tramos.** El generador arma el mapa como secuencia de tramos por bioma: montaña, valle, meseta, abismo, lago, pozo de lava, más búnker/torre/cuevas.
  - Alcance (2026-10-01): Chico sigue idéntico a v1 (referencia de look y tests); la geografía nueva va en Mediano y Grande. Lago y pozo de lava quedan como cuencas secas registradas por el generador; V4 las llena. Arte: capas de fondo repetibles a lo ancho (sin elementos cortados en los bordes).
  - Estado: hecha (2026-10-02), en cuatro agentes (sim, render, flujo, arte), integrada en `v2-mundo`.
    - sim: tramos de ancho variable con pesos por bioma (`SEG_WEIGHT`): plataforma, valle, cerro, montaña (cima y 110–150, uno o dos picos, rocas, a veces cueva), meseta (búnker, torre o ambos; siempre al menos una, nunca dos a menos de 800 px), colinas con ruinas, abismo (60–130 px), lago y pozo de lava (100–200 × 30–60, secos; `Generated.basins` para V4). Bosque: montañas y lagos; jungla: abismos, ruinas y lagos; industrial: pozos de lava con labios de chapa, pozos de mina con castillete. Abismo: `isSolid`/`columnGround`/`groundAt`/`tankFloor` respetan `pits`; caer da `fall` con `to = h + 60` (`ABYSS_DROP`) y `death` con `cause: 'abyss'` (hp 0, y >= h); tirado por un tiro ajeno es kill (cobra el daño previo) y cuenta como tiro con daño para la calma; el paracaídas no salva ni se gasta; proyectiles 'out'; utilería `prop` destruida con su x/y. `pits` en snapshot (`tp`) y hash; `cloneTerrain` lo copia. IA: frena 24 px antes del abismo (`abyssAhead`), busca romper el saliente bajo un rival (`ledgesOf`, `dropsInto`), `ERROR_SCALE_EXP` 1,15. `sim-check` 29022/29022: tiros 2 / 4 tanques Chico 10,6 / 18,9, Mediano 10,4 / 18,1, Grande 15,8 / 20,6 (con 20 partidas: 10,9 / 21,6 y 14,0 / 21,9); IA tira al rival al abismo 4/6 y pasa la montaña 6/6; peor caso 80 ms. Chico byte a byte igual (300 seeds × 3 biomas × 1–8 jugadores). `scripts/lookdev/v3-maps.mjs` → `preview/v3-maps.png`.
    - arte: capas de fondo de los tres biomas repetibles con el esquema copia/espejo: lo que toca un borde entra entero o queda centrado en él (`edgeSafe`, `pineHalfW` en `pixel.mjs`, `palmFit` en `biomes.mjs`); el pino gigante de `forest-4` centrado en x = 800. `scripts/lookdev/v3-bg-strip.mjs` arma la tira de verificación de 2400 px. Propuesta pendiente (cambia el manifiesto): repetición sin espejo por capa (`repeat: 'mirror' | 'wrap'`) o capas cercanas de 1600 px.
    - render: `src/render/pixi/abyss.ts` (`PitMap`): pared de fondo de tierra hasta abajo con rocas y raíces, niebla del bioma que se pierde a negro en 8 pasos con Bayer, borde suavizado 18 px; integrado al pintado por trozos. `AbyssFalls`: el tanque cae girando y se oscurece, destello lejano y columna de humo, tripulante que se pierde, utilería que cae con su sprite. Chico idéntico byte a byte.
    - flujo: caída animada hasta `h + TANK_H + 30` (muerte al final de la caída), cámara que acompaña si el que cae es el del turno o estaba en pantalla, `ABYSS_HOLD` 1,5 s mirando el fondo y `ABYSS_TAIL` 1,7 s de espera del turno; sonidos `abyssFall`, `abyssThud`, `edgeWarn`; tope en el borde solo para el humano ("Abismo! Apreta otra vez"; soltar y volver a apretar cae).
    - Pendientes: cerrados. El balance de Grande con 2 tanques, con la medición de 20 partidas (v2.4); las muertes por abismo, el globo "!" y la cámara lenta de la caída, en v2.3.
- **V4 Agua y lava.** Materiales, flujo, reglas, texturas y animación (superficie, burbujas, vapor al enfriarse), sonido.
  - Alcance (2026-10-02): el generador llena con agua o lava las cuencas de V3 (`Generated.basins`); Chico sigue sin líquidos (idéntico a v1). La lava de muerte súbita (`GameState.lava`) sigue siendo una banda aparte. Las explosiones no destruyen líquidos: al romper el borde de una cuenca, el líquido corre.
  - Estado: hecha (2026-10-02), en tres agentes (sim, render, flujo), integrada en `v2-mundo`.
    - sim: `src/sim/flow.ts` (`flowLiquids`, `applyPatch`, `liquidVolume`): cola activa de abajo hacia arriba; por celda, reacciones con los 4 vecinos (agua + lava → la lava se hace piedra y el agua se evapora; la lava quema lo inflamable vecino), caída (agua 3, lava 2 por iteración), diagonal y escurrido hacia la caída más cercana (alcance 48 / 20). Determinista, idempotente, el volumen no crece (lo que cae a un abismo se pierde). Parches: `patches[0]` es el estado previo al flujo del rectángulo total; luego uno cada `FLOW_FRAME_ITERS`; `t` = fin del tiro + 0,15 s, `dt` 1/30. Si a las 400 iteraciones animadas no asentó, hasta 800 más sin animar al último parche. Cuencas llenas al generar (inundación desde `level`); Chico byte a byte igual. `build` sobre lava = piedra; sobre agua pone tierra y el agua sube por la columna. Tanques: agua sin daño de caída ni paracaídas (`fall.water` con ≥ 3·TANK_W celdas de agua en la caja); lava en la caja = `LAVA_DAMAGE` al empezar el turno (una sola vez con la banda). Proyectiles: arrastre `WATER_DRAG^dt`, `Flight.splashes`, la lava derrite, explosión sumergida (centro o 4 vecinas de agua) × `WATER_BLAST_SCALE` salvo el impacto directo; napalm no quema sumergido. Cajas en lava se queman, barriles se hunden sin explotar. IA: no entra a la lava, sale si está adentro (`poolRisk`), rompe el borde de un pozo de lava hacia un rival (6/6 en la prueba). `sim-check` 31706/31706; tiros 2 / 4: Chico 10,6 / 18,9, Mediano 10,4 / 18,1, Grande 15,8 / 20,4; flujo por `fire` medio 1,5 ms (Mediano) y 2,4 ms (Grande), al romper cuencas 17 ms medio y hasta ~66 ms; IA peor caso 154 ms.
    - render: `src/render/pixi/liquids.ts`: cuerpo de líquidos en una tercera capa de trozos (encima de los tanques, que se ven teñidos), agua translúcida con el look del lookdev, lava material con las tablas de `lava.ts`, `LiquidView` anima solo la superficie visible a 30 Hz, resplandor por pozo, terreno cocido junto a la lava; diff de grilla con `Int32Array` y acotado al rectángulo del flujo. Efectos: salpicadura y ondas, burbujas, explosión sumergida sin fuego con géiser, vapor, espuma/chispas en el frente del flujo. CPU de `render()` en Grande: 0,75 → 1,03 ms con líquidos quietos, 2,4 ms medio durante un flujo.
    - flujo: aplica cada parche en su `t`, los daños posteriores van al fin del flujo + 0,25 s, el turno espera el flujo; cámara `watch` sobre flujos de ≥ 300 celdas a la vista o cerca (zoom ≥ 0,5); sonidos `splash`, `boomUnder`, `steam`, `flow` (agua o lava), `plunge`.
    - Pendientes: cerrados en v2.3 y v2.4 (vetas de la lava, derrumbe de tierra en la sim, `Impact.water` y salpicaduras en `RenderFrame`).
- **V5 Hasta 8 jugadores.** Arte, HUD, lobby local y online.
  - Decidido (2026-10-02): Chico hasta 4, Mediano hasta 6, Grande hasta 8 (`MAX_PLAYERS_BY_SIZE`); el ritmo de la IA no cambia. Tripulantes nuevos: Comando (boina negra), Tanquista (casco de cuero y antiparras), Piloto (casco y pelo recogido), Coronel (bigote blanco). Colores nuevos: violeta, naranja, turquesa y rosa. Contrato: `CrewId`/`CREWS` de 8, `MAX_PLAYERS`, `MAX_PLAYERS_BY_SIZE`, `TANK_COLORS` de 8 (`src/sim/types.ts`), `tank.bodies`/`barrels` de 8 en el manifiesto, `LobbyState.slots` siempre de 8.
  - arte (2026-10-02): cuatro tripulantes nuevos en `scripts/lookdev/characters.mjs` (sprite 12×12 y retrato 32×32): Comando (boina negra ladeada con escudo, franja de camuflaje sobre los ojos y rayas en las mejillas, mandíbula cuadrada), Tanquista (casco de cuero acolchado con orejeras, antiparras redondas de bronce en la frente, cuello de corderito), Piloto (casco blanco con franja roja y visor ahumado levantado, trenza rubia sobre el hombro) y Coronel (gorra de plato con banda roja, escudo y laureles, cejas y bigote de morsa blancos, condecoraciones). Cuatro cascos nuevos en `HULLS` (`pixel.mjs`), uno distinto por color para que los 8 se reconozcan de lejos: invierno bajo el violeta, marino bajo el naranja, óxido bajo el turquesa y carbón bajo el rosa; `STRIPES` de 8 con el claro igual a `TANK_COLORS` (`paint-assets` lo verifica). `public/assets` con 8 cuerpos, cañones, tiras de orugas y tripulantes; lo anterior queda igual byte a byte. Hoja: `node scripts/lookdev/v5-crews.mjs` → `preview/v5-crews.png` (y `v5-crews-1x.png` a ×2).
  - vistas (`src/ui`): menú con 8 casilleros en dos columnas de 4 (P1–P4 | P5–P8); los que pasan `MAX_PLAYERS_BY_SIZE` del mapa elegido se ven rayados con "SOLO MAPA MEDIANO+ / GRANDE" y el cursor los saltea. Al achicar el mapa (v2.3, igual en el menú y en la sala): si algún ocupado queda afuera, los ocupados se compactan hacia arriba conservando su configuración y los que no entran se descartan desde el final (`compactSlots` en `menu.ts`, `fitSlots` en `host.ts`); no vuelven al agrandar. Aviso "2 CASILLEROS QUEDARON AFUERA: CHICO ADMITE 4". En la sala, el anfitrión nunca se descarta y un remoto sin lugar queda de espectador con un aviso. Al lado de MAPA dice "HASTA N". Las configs guardadas de 4 casilleros cargan igual. Sala online: 8 casilleros en dos columnas con el mismo bloqueo según `lobby.size` (sin size, Chico); número y color siguen el orden de los ocupados, como en el menú. Táctil (`html.touch`): celdas de 44 px, en el menú cada ajuste muestra solo el valor elegido y tocarlo pasa al siguiente (los 4 en una fila); en la sala los ajustes bajan a una fila de 5. Tabla: con más de 4 filas pasa a compacta (retratos de 12, campeón en franja horizontal). Cartel, tienda y HUD C andan con los colores y tripulantes nuevos (retrato de respaldo hasta que lleguen los del área arte). `?uitest=`: `menu&players=N&size=&pick=small`, `lobby&size=`, `score`/`final` con 8 filas (`&players=`), `banner`/`shop` con `&p=N` (por defecto P5), `hud&players=8&net=8`, y en todos `&touch=1` y `&keys=ArrowUp,Enter…`.
  - sim (2026-10-02):
    - Spawns: con más de 4 tanques la separación buscada es `SPAWN_GAP_CROWD` = 120 px (más que el alcance de cualquier explosión entre dos tanques: ningún tiro de arranque pega a dos). En 300 mapas por caso (Mediano 6, Grande 8): separación mínima 120, mediana ~183, todos con lugar bueno (sin cimas, estructuras, abismos ni cuencas); el hueco más grande entre vecinos es 1,4× el espacio parejo de mediana y 2,34× en el peor caso (lago + abismo seguidos). Chico y Mediano/Grande con 2-4 jugadores, byte a byte iguales (hash fijo en `sim-check`). `spawnStats` mide de qué nivel de la búsqueda sale cada spawn.
    - IA: había un sesgo de posición: entre tiros con el mismo puntaje (impacto directo) la búsqueda se quedaba con el de menor ángulo, que hacia la izquierda es un globo vertical; la punta izquierda ganaba 2 de cada 3 rondas en todos los tamaños. Ahora desempata por el tiro más plano hacia los dos lados (`flatTie`) y se queda con la mejor posición al moverse (no la primera). Prioridad de blancos (`priorities`): cercanía (+0,15), rival entero (+0,3 · vida) y líder de rondas (+0,1); matar suma 40 puntos de daño (`KILL_BONUS`) también en la estimación. Error de la normal ±7° / ±8 para recuperar el ritmo de antes. Tope de flujos simulados por turno en Grande 4 (antes 8): IA difícil con 8 en Grande, peor caso ~150-190 ms (la versión anterior en los mismos estados, ~270).
    - Reglas: tope de calma `calmLockTurn` = máx(30, 4 · tanques): desde ese turno el daño no reinicia la calma (con 2-4 tanques casi nunca llega; con 8 corta las rondas de hasta 60 tiros). La lava quema del más hundido al menos hundido y no mata al último en pie (gana el que aguantó más; empate solo si está igual de hundido y con la misma vida que el último que murió): con 8 tanques 1 de cada 4 rondas terminaba en empate. Economía, orden de turnos y ronda inicial no cambian (plata media por ronda: 4 tanques ~610-690, 8 tanques ~560-580).
    - `sim-check` 38308/38308. Tiros por partida (10-20 partidas): 2 / 4 tanques Chico 10,7 / 17,7, Mediano 10,5 / 21,0, Grande 11,5 / 20,6; Mediano 6: 27,7 (máx 38); Grande 8: 34,1 (máx 41). Con 40 rondas: Mediano 6 29,1 (máx 42), Grande 8 34,6 (máx 42), empates 0; con 3 rondas y tienda, Grande 8 38,6 tiros por ronda y el ganador repartido entre posiciones e ids. Muerte súbita: Mediano 6 en ~70% de las rondas, Grande 8 en ~95%.
    - Pendientes: cerrados. El recorte a 4 casilleros ya no existía desde V5 (`MAX_PLAYERS_BY_SIZE`) y `SUDDEN_DEATH_CALM - calm` es correcto; la ventaja del jugador 0 se resolvió en v2.3 con el sorteo de spawns y de primer turno.

### Pulido v2 (2026-10-02)

Pedido del usuario tras jugar la v2 publicada. Contrato: `fuelFor(width)`, `KNOCKBACK_MAX`, `SLIDE_SLOPE`, `PARACHUTE_MIN_DAMAGE`, evento `slide` (`src/sim/types.ts`); `AIM_PREVIEW_T` y `RenderFrame.aimPreviewShort` (`src/render/types.ts`).

- **Empuje y deslizamiento**: las explosiones empujan a los tanques; un tanque en pendiente fuerte se desliza cuesta abajo. Así se puede caer al vacío, al agua o al abismo.
- **Paracaídas**: solo se abre en caídas que harían al menos `PARACHUTE_MIN_DAMAGE`; en el abismo sigue sin salvar.
- **Combustible**: `fuelFor(width)` = 60·√k por turno.
- **Cruzar líquidos**: el proyectil de Tierra no se derrite en la lava y lo que construye sobre ella es piedra; el napalm sobre agua hace piedra flotante.
- **Guía de apuntado**: sin trazador se ven los puntos del comienzo de la trayectoria (`AIM_PREVIEW_T` segundos); el trazador sigue mostrando la completa.
- **HUD**: tres propuestas del área arte (`scripts/lookdev/hud-proposals.mjs`); el usuario eligió la **C, tablero Broforce**: franja de `HUD_BAR_H` = 62 px abajo a lo ancho con retrato/vida/escudo | ÁNG (número ×3 y dial chico) | POT (número ×3 y barra de 10 segmentos) | VIENTO (número ×3, flechas y manga) | COMB (barra con bidón, ◀ ▶ y %) | las 8 armas; ítems arriba a la izquierda con ronda y plata; rivales arriba a la derecha. De la B se suma un arco fino alrededor del cañón mientras se apunta, sin número. Contrato: `HUD_BAR_H` (`src/render/types.ts`), `HudControl` y `controlAt` (`src/ui/types.ts`, reemplaza a `weaponAt`).
  - Flujo (HUD C): la cámara apoya el piso del mundo sobre el tablero (fila `VIEW_H − HUD_BAR_H` con zoom 1, escalado con zoom < 1) y no recorre en y; se recortan 62 px de cielo de arriba. Chico también: zoom 1 fijo y corrido hacia arriba (un zoom 388/450 para que entre entero daba pixels desparejos y franjas fuera del mundo). El demo congelado (`?demo=`) no tiene tablero y queda como antes. `shotZoom` y el zoom del flujo usan el alto útil; `view()` del minimapa no cuenta lo que tapa el tablero. Controles con `controlAt`: arma = elegir, ítem = usar (como Q/F/R/T), ◀ ▶ = mover mientras se mantiene (como A/D; deslizar entre flechas cambia de lado), todo solo en tu turno; sobre el tablero entero, un control o el minimapa no arrancan el arrastre de cámara, el apuntado táctil ni el paneo contra el borde. Táctil: se quitan los botones ◀ ▶ y ARMA ▶ (los cubre el tablero); POT, ÁNG, ÍTEM y FUEGO quedan apoyados arriba del tablero y pausa / ◎ / ⛶ a la izquierda de los rivales.

- Estado: hecho (2026-10-02), integrado en `v2-pulido`.
  - sim (`src/sim/slide.ts`): empuje = `round(KNOCKBACK_MAX · min(1, golpe / KNOCKBACK_REF))` px (`KNOCKBACK_REF` 36; golpe = daño crudo antes del escudo), en sentido contrario al centro, recorriendo el piso como un `move` sin combustible (2 px por punto del path); la Tierra no empuja. Deslizamiento con pendiente = (piso del borde bajo − piso del borde alto) / `TANK_W` (tope `SLOPE_CAP` 3·`TANK_W`) mayor que `SLIDE_SLOPE` = **2,2** (con 0,45 resbalaba al salir de los pads, que tienen bajadas 2:1), 1 px por punto, tope 160 px; se evalúa tras impactos, flujo, caídas y cada paso de `move` (cuesta arriba no se da el paso). Paracaídas con umbral `PARACHUTE_MIN_DAMAGE` 10. Combustible 60 / 85 / 104. Tierra: `FlyOptions.lavaSolid`, construye en la lava y lo que cae sobre ella es piedra (también en la banda de muerte súbita). Napalm sobre agua: 4 px de piedra (`NAPALM_CRUST`) en cada columna alcanzada, con `steam`. IA: simula el empuje, apunta del lado que tira al rival a un abismo o a la lava (6/6 en la prueba), no se para en pendientes que la hagan resbalar. `sim-check` 31815/31815; tiros 2 / 4 tanques: Chico 9,9 / 18,8, Mediano 11,9 / 21,5, Grande 10,4 / 21,1. Muertes por abismo en el balance: siguen en 0 (los labios y paredes de 30–40 px entre los spawns y los abismos frenan el empuje; para que mate en partidas reales hay que tocar el generador).
  - flujo: guía corta (`aimGuide`, en caché), playback de `slide` encadenado con `fall`, cámara `followSlide`, sonido de raspado. HUD C: el piso del mundo apoya en la fila `VIEW_H − HUD_BAR_H` y la cámara sube hasta 160 px si el objetivo quedaría a menos de 100 px del borde de arriba (cimas altas); en Chico la vista fija se corre 62 px hacia arriba. Controles del tablero con `controlAt` (arma, ítem, mantener ◀ ▶), sin arrastre de mundo sobre el tablero; los botones táctiles que duplica el tablero se sacaron y el resto se apoya arriba del tablero.
  - render: guía de puntos amarillos que se desvanecen, deslizamiento con inclinación, terrones y sacudón por empuje, piedra recién enfriada (basalto con vapor y grietas), arco fino del cañón al apuntar.
  - vistas (`src/ui/hud.ts`, `src/ui/hudkit.ts`): tablero C como la maqueta; rivales arriba a la derecha con el panel de red debajo; estado, muerte súbita y "ESPERANDO A…" en una columna bajo el minimapa; `?uitest=hud` con `&players=`, `&turn=ai`, `&fine=1`, `&wind=`.
  - `vite.config.ts` ignora `.claude/` (worktrees de los agentes): con varios worktrees adentro, vite los recorría y la pestaña cliente de `net-test` no llegaba a conectarse.
  - Pendientes: cerrados en v2.3 y v2.4 (muertes por abismo, caída detrás del tablero, arco del cañón, IA que cruza líquidos con Tierra).

### V5 integrada (2026-10-02)

En la rama `v2-8jugadores` (sale de `v2-pulido`). `sim-check` 38308/38308; `net-test` OK (3 tanques en Mediano; el modo `--players 8` con 2 humanos y 6 IA en Grande pasó en la rama de red). Tiros por partida con IA normal: 2 tanques 10,7 / 10,5 / 11,5, 4 tanques 17,7 / 21,0 / 20,6 (Chico / Mediano / Grande), 6 en Mediano 27,7 (máx 38), 8 en Grande 34,1 (máx 41). Muerte súbita en ~70% (6) y ~95% (8) de las rondas, 0 empates.
- Antes de V5 la IA tenía un sesgo de posición (la punta izquierda ganaba 2 de cada 3 rondas): desempataba por el menor ángulo. Se arregló con un desempate simétrico (`flatTie`); el error de la IA normal subió a ±7° / ±8 para mantener el ritmo.
- Reglas nuevas: tope de calma `máx(30, 4 · tanques)` (desde ese turno el daño no reinicia la calma) y la lava quema primero al más hundido y, a igual altura, al de menos vida, para que no termine en empate cuando quedan pocos.
- Pendientes: cerrados en v2.3 y v2.4 (casilleros unificados, ventaja del jugador 0, HUD con 8, snapshot comprimido, IA sobre la montaña).

### v2.2 (2026-10-03)

Sugerencias del usuario: el "−" de la tienda devuelve el 100%; la muerte súbita se frena y reinicia su cuenta cuando un tanque le pega a otro (sin tope); escalones de 10 px y pendientes hasta 75° con más gasto al subir; viento por vuelta con aviso en el HUD. `SLOPE_CAP` pasó a 6·`TANK_W` para que un tanque colgando de un borde siga resbalando con el umbral nuevo. `sim-check` 38311/38311. Balance con IA normal: 6 en Mediano 39,0 tiros (máx 53), 8 en Grande 44,9 (máx 55), contra 27,7 / 34,1 con el tope; los topes del chequeo subieron a 44 / 60 y 50 / 66.

## v2.3: pendientes de v2 (2026-10-03)

Rama `v2.3-pendientes`. Seis agentes en paralelo (sim, red, render, vistas, flujo, arte).

- **Abismo que mata**: el generador deja cornisas y labios finos junto a los abismos, el empuje de las explosiones puede tirar tanques al abismo y la IA lo aprovecha. Criterio: en el balance de mapas con abismo hay muertes por abismo (al menos 1 de cada 20 muertes).
- **Ventaja del jugador 0**: el primer turno de cada ronda se sortea con la seed y los spawns se mezclan incluyendo al jugador 0 (no nace siempre en la punta). Criterio: con 6 jugadores en Mediano a 1 ronda ninguna posición gana más del 30%.
- **IA y líquidos**: la IA usa el arma Tierra para hacer un puente sobre agua o lava cuando le corta el camino hacia un tiro.
- **Red**: snapshot comprimido (grillas con RLE o similar, formato versionado). Criterio: < 150 KB con 8 tanques en Grande; `net-test` OK.
- **Presentación**: la cámara de la caída al abismo tiene en cuenta el tablero inferior; arco del cañón visible sobre cielo claro; sin vetas verticales marcadas en la lava honda; globo "!" con `RenderFrame.alerts` (tope en el borde del abismo); HUD con 8 tanques sin amontonar flechas y placas en el costado derecho.
- **Menú**: al achicar el mapa, el menú local y la sala online hacen lo mismo con los casilleros que no entran (se compactan conservando la configuración de los que quedan).
- **Fondos**: capas periódicas con `repeat: 'wrap'` en el manifiesto (contrato en `src/render/manifest.ts`), sin espejo en las uniones.
- Estado (2026-10-03): integrada en `v2.3-pendientes`. `sim-check` 38380/38380 (IA peor caso 70 ms), `net-test` OK con 3 tanques en Mediano y 8 en Grande.
  - red: snapshot `TK` versión 2 (grillas con RLE por filas, varint) que lee también la v1; Chico 4 tanques 6,5–7,2 KB, Mediano 6 tanques 9,9–11,8 KB, Grande 8 tanques 13,9–19,9 KB (antes 706 / 1412 / 2116 KB), encode ≤ 2,1 ms; `hashState` sin cambios. `net-test --snapshot` fuerza una desincronización y la repara con el formato nuevo. El aviso de rechazo del anfitrión se ve en la sala.
  - arte y render: capas 1–4 de los tres biomas periódicas con `repeat: 'wrap'`, el cielo en `'mirror'` (`WrapCanvas` en `pixel.mjs`, tira `scripts/lookdev/v23-bg-strip.mjs`); `look-test-1080.png` idéntica. Con 'wrap' un hito se repite cada 800 px de capa (con zoom 0,5 pueden verse dos). Arco del cañón con contorno y tramo barrido opaco; lava honda con moteado 2D sin vetas (banda y material); globos "!"/"?" con aparición con rebote; destello y humo del abismo 28 px más arriba.
  - flujo: la cámara de la caída usa el tiempo en que el render pierde de vista al tanque (`abyssLostAt`, copia `RENDER_ABYSS_*` del render: si cambia la física de `AbyssFalls` hay que actualizarlas), `ABYSS_HOLD` 1,8 s y `ABYSS_TAIL` 2,0 s; "!" en `alerts` 1,2 s al frenar en el borde; cámara lenta desde que empieza la caída (tope 3,2 s reales). `RIVALS_W` táctil 110.
  - vistas: con 5–8 tanques, placas compactas en dos columnas espejadas (hasta 4 por lado); flechas de borde que se apilan bajo las placas, se agrupan ("P5+2") si no entran y priorizan al del turno.
  - Pendientes: cerrados en v2.4 (spawns de humanos lejos de las cornisas, sonido en cámara lenta). Revisión visual de cornisas, puentes y tope del borde: ver v2.4.
- Contratos v2.3: `BackgroundDef.repeat` (`'mirror' | 'wrap'` por capa) en el manifiesto, `RenderFrame.alerts` (ids con globo "!").
- sim (2026-10-03), sin cambios de contrato:
  - **Abismo** (Mediano y Grande; Chico igual byte a byte): los labios del abismo están socavados (abajo es más ancho que la boca), así que el que pasa el borde cae al vacío en vez de engancharse en la pared. En el 80% de los abismos uno o los dos labios son una **cornisa**: costra de tierra de 6–9 px (`CORNICE_CRUST`) y 30–56 px de largo (`CORNICE_LEN`; el socavón puede meterse hasta `CORNICE_SPILL` = 16 px bajo el tramo vecino) con el techo del socavón en arco; el resto, labio de 20 px de costra socavado 18 px. 25% de los abismos (40% en la jungla) tienen un **puente** fino de labio a labio (piedra 6 px en la jungla, vigas 4 px en industrial, tierra 7 px en el bosque). Los postes del castillete industrial pasan a la pared de fondo (eran una pared al borde de la boca). Los parámetros salen de `p.seed` (sin sortear con el rng): los mapas sin abismo no cambian. `Generated.mouth` (columnas de la boca) y `Generated.ledges` (cornisas y puentes) para chequeos y QA.
  - **Spawns**: `SPAWN_PIT_GAP` se mide hasta la boca y baja de 40 a 14; puede nacer sobre una cornisa si tiene costra bajo todo el pad y piso parejo (`CORNICE_SPAWN_FLAT`; nunca sobre un puente ni sobre una cornisa que no lo sostiene). Hay un lugar preferido a cada lado de cada boca (`spreadSpawns` lo elige si cae en su ventana): casi siempre hay alguien a un empujón del vacío.
  - **Empuje** (todos los tamaños): `KNOCKBACK_REF` 36 → 22 (un impacto directo de la normal ya empuja los 24 px del tope) y el impacto directo empuja en el sentido en que venía el proyectil (antes, desde el punto del impacto: un tiro de frente al que tiene el abismo a la espalda lo tira). **Vuelco** (`tipDir`, solo sobre abismo): un tanque con el centro sobre columnas de abismo sin piso a 2 px y apoyado de un solo lado se desliza hacia el vacío y cae (antes hacía equilibrio sobre 3 columnas).
  - **IA**: `brinksOf` y la atracción al peligro (`hazardMask`) miran la boca a la altura del tanque (una cornisa o un puente bajo los pies no cuentan como abismo). Prioridad de blancos: +0,15 si la IA es el rival más cercano de ese tanque y +0,12 si es el de una punta (antes las puntas tenían un solo vecino que les tirara y ganaban ~37% con 6 en Mediano). **Puente de Tierra** (normal y difícil): sin tiro desde ningún lado y con lava de la grilla entre ella y su rival más cercano, camina hasta la orilla y tira Tierra a la lava (se vuelve piedra); con el puente tendido lo cruza. En la prueba (pozo de 200 px) cruza en 10–11 turnos con 6–7 tiros de Tierra. Agua: no (no hace daño y se vadea).
  - **Sorteo**: con la seed de cada ronda (rng aparte, `ORDER_SALT`) se mezcla quién nace en cada lugar (jugador 0 incluido) y quién abre la ronda (antes el jugador 0 nacía en una punta y la ronda r la abría el jugador (r − 1) % n). En Chico cambia quién nace dónde y quién empieza; el terreno no.
  - `sim-check` 38380/38380. Balance con abismo (Mediano y Grande, 4 y 6 tanques, 60 partidas): 24 de 241 muertes por abismo (10,0%), 31,5 tiros por partida; la IA tendió 5 tramos de puente y cruzó 4 veces. 6 en Mediano, 60 partidas: ganador por posición 4/9/9/16/10/12 (máx. 27%), gana el que abre 15/60. Tiros por partida 2 / 4 tanques: Chico 10,6 / 16,9, Mediano 14,9 / 25,9, Grande 10,8 / 26,4; Mediano 6: 33,6 (máx. 55); Grande 8: 37,0 (máx. 46). Empuje en mapas generados: 14 de 16 tanques nacidos al borde caen con un impacto directo desde el otro lado. IA peor caso 69 ms.

## v2.4: cierre de pendientes (2026-10-03)

Rama `v2.4-cierre`. Tres agentes en paralelo (sim, flujo, render); contrato, documentación y QA del integrador.

- Spawns: los humanos nunca nacen sobre una cornisa al borde de un abismo (las IA sí).
- `sim-check`: el balance de Mediano y Grande se mide con 20 partidas (menos ruido en los topes que bloquean el deploy).
- Sonido: los efectos se estiran con la cámara lenta.
- Napalm que cae debajo de la lava: no quema (la lava ya lo cubre) y no atraviesa la banda.
- IA: tiro por encima de una montaña alta con margen (al menos 5/6 en la prueba).
- Derrumbe: los terrones sueltos que deja una explosión (tierra o piedra sin apoyo) caen y se asientan; tierra que cae sobre lava → piedra. Los salientes unidos al terreno (cornisas, techos de cuevas) no se caen. Evento `collapse`, daño `cause: 'collapse'` si aplasta un tanque.
- Contrato: `Impact.water` (explosión sumergida exacta) y `RenderFrame.splashes` (salpicaduras en su momento exacto).
- Globo "!" (`RenderFrame.alerts`) también en: sin munición, sin combustible, cambio de viento fuerte, inicio de la muerte súbita y tanque en lava al empezar su turno.
- Estado (2026-10-04): integrada en `v2.4-cierre`. `sim-check` 38407/38407 (2 min 36 s, IA peor caso 70 ms), `net-test` OK (snapshot de 8 tanques en Grande: 15,8 KB).
  - sim: humanos a ≥ 40 px de cualquier columna de abismo (se cambian de lugar con una IA después del sorteo; con un solo humano el mapa no cambia); napalm que no arranca ni corre bajo la lava; morteros de la IA (6/6 sobre la montaña); derrumbe en `src/sim/collapse.ts` (cae lo que no está unido a roca madre, estructuras, fondo o > 4000 celdas de terreno; por columnas; tierra sobre lava → piedra; aplasta 1 cada 10 celdas desde 24, tope 40; 0,10 ms medio por `fire` en Grande); `water` en `Flight.impact` y en el evento `impact`. Balance: 2 tanques en Mediano y Grande con 40 partidas, 4 tanques con 20 y tope 30. Tiros 2 / 4: Chico 10,6 / 17,3, Mediano 11,6 / 26,2, Grande 9,8 / 24,3.
  - flujo: sonidos estirados y más graves en cámara lenta (cada efecto con su reloj); `collapse` aplicado como `flow`; `RenderFrame.splashes`; "!" por munición, combustible, viento ≥ 6, muerte súbita y lava al empezar el turno, con pitido.
  - render: `src/render/pixi/collapse.ts` (polvo, piedritas, nube al asentarse, sacudón desde ~300 celdas, aplastado); salpicaduras por `splashes`; explosión sumergida por `water`.
  - QA: `?relay=1` / `NET_TEST_RELAY=1` (relay TURN forzado) y `npm run mobile-fps` (celular emulado: táctil 844×390, CPU frenada, `--gpu`, `--profile`).
  - Hallazgos (van a v3): el relay TURN público (Open Relay con credenciales fijas) ya no conecta; el deploy ya lee `TURN_URLS`, `TURN_USER` y `TURN_PASS` de los secrets (ver README). En el celular emulado (CPU ×4, GPU real) el juego va a 57–60 fps sin acción pero baja a ~30 fps con explosiones en todos los tamaños (Chico 34, Grande 29); el perfil marca `Raster.light` (16% del CPU) y el dibujo en canvas (`fillRect`, `putImageData`, `drawImage`, ~13%).
- Contratos v2.4: `Impact.water`, evento `collapse`, `damage.cause` `'collapse'`, `RenderFrame.splashes`.
- sim (2026-10-03), sin cambios de contrato salvo `water?` en el evento `impact` (pedido del integrador):
  - **Spawns humanos**: `humanSafe` (gen.ts): ninguna columna de abismo (incluye socavones y cornisas) a menos de `HUMAN_PIT_GAP` = 40 px de la caja. `generate(..., safe)` recibe cuántos humanos hay; `spreadSpawns` elige como siempre y solo cuando los lugares seguros que faltan igualan a los que quedan por elegir, los restringe a seguros (el rng se consume igual: con lugares seguros de sobra el mapa es idéntico; 48/48 mapas iguales con 1 humano, cambian 18/48 con todos humanos). `Generated.safe` marca cada spawn; `setupRound` sortea como v2.3 y después cambia a cada humano de lugar inseguro con una IA de lugar seguro (sorteada con el mismo rng, después del que abre la ronda: no cambia quién abre). Chico no cambia (30/30 con y sin humanos). 288 humanos en 96 partidas: 0 al borde; 22 IA al borde.
  - **Napalm bajo la lava**: el fuego no arranca ni corre por debajo de la banda de muerte súbita ni en celdas con lava de la grilla encima, y no quema lo inflamable bajo la banda.
  - **IA sobre la montaña**: morteros (`mortar`: si la grilla gruesa no ve ningún impacto directo, bisección de la potencia para 20 ángulos altos hacia el rival más cercano) y centrado del impacto directo (`center`: lleva el tiro al medio de la ventana de potencia y ángulo que pega; la difícil siempre, la normal y la fácil solo cuando la grilla no vio impactos directos; se confirma con la simulación completa para no perder un tiro que sirve por otra cosa, como romperle el puente). Prueba: 6/6 (antes 4/6). Centrar siempre con la normal desparejaba el reparto por posición con 6 en Mediano (19/60).
  - **Derrumbe** (`src/sim/collapse.ts`, `collapseAfterShot` en physics.ts; lo usan fire y la IA): tras cada fire se miran los componentes de tierra/piedra (8 vecinos, a través de cualquier sólido) que tocan el rectángulo sucio del tiro; está apoyado el que toca roca madre, una estructura, la última fila fuera de un abismo, piedra que flota sobre un líquido (costra del napalm, tierra que cayó a la lava) o pasa de `COLLAPSE_BUDGET` = 4000 celdas (así cornisas, techos de cueva y puentes unidos al terreno nunca caen y la búsqueda es barata). Lo suelto cae por columnas (1 a 4 px por iteración, de abajo hacia arriba), se hunde en el agua cambiando de lugar con ella (después corre el flujo), la tierra que toca la lava de la grilla se vuelve piedra y queda flotando, la que pasa la banda de muerte súbita se vuelve piedra, lo que sale por un abismo se pierde. Evento `collapse` con `t` = fin de lo que se ve del tiro + 0,1 s, un parche cada 2 iteraciones a 1/30 s (como `flow`; el flujo de líquidos va después). Aplastamiento: las celdas que bajaron 4 px o más y quedaron sobre la caja de un tanque (hasta 12 px por encima) hacen 1 de daño cada 10, desde 24 celdas y con tope 40 (`damage.cause: 'collapse'`, en el fin del derrumbe); después se asientan utilería y tanques. Costo por fire en el balance: 0,07-0,10 ms medio, peor 2,8 ms (Grande).
  - **`Impact.water`** en el vuelo y en el evento `impact` (barriles incluidos) cuando el centro quedó sumergido.
  - `sim-check` 38407/38407 en ~2,6 min (máquina libre; con otros agentes corriendo, 8-15 min y fallan por carga los topes de tiempo de la IA con lava). Balance (tiros por partida, IA normal): Chico 2 / 4: 10,6 / 17,3 (20 partidas); Mediano 11,6 (40) / 26,2 (20); Grande 9,8 (40) / 24,3 (20); Mediano 6: 33,0 (máx. 55, 60 partidas, posiciones 7/7/10/12/8/16); Grande 8: 39,7 (máx. 53). Topes: 2 tanques en Mediano y Grande con 40 partidas (con 20, Grande daba 7,7-11,8 según la tanda y fallaba el piso de 8 por azar); 4 tanques en Mediano y Grande, tope 30 (antes 27: Mediano mide ~26 desde v2.3). Abismo: 26 de 240 muertes (10,8%). IA peor caso 99 ms.

## Cómo se agrega algo

- Arma nueva: un registro en `WEAPONS` y, si el efecto es nuevo, un modo de terreno en `sim` y un `BlastStyle` en el renderer.
- Material nuevo: una constante y una entrada en `MATERIALS`, su textura en `paint-assets` y su entrada en el manifiesto.
- Efecto nuevo: el sim emite un evento y Pixi lo dibuja.
