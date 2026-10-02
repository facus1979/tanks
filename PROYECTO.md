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

- Vida 100. Gana el último tanque en pie; si no queda ninguno, empate.
- Viento nuevo cada turno, visible antes de apuntar. Rango -10 a 10.
- Ángulo 0 a 180: 0 es horizontal a la derecha, 90 arriba y 180 horizontal a la izquierda. Potencia 0 a 100.
- El tanque se apoya en el terreno. Si el piso desaparece, cae y recibe daño de caída. Si la tierra lo tapa, aplasta.
- Un tiro puede dañar al que dispara. Los barriles explotan en cadena.
- La IA usa la misma física, en una copia del estado, y le mete error según la dificultad.
- F6: combustible por turno (`FUEL_PER_TURN`). El tanque sube escalones de hasta `MAX_CLIMB`.

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

La IA: error normal ±6° y ±7 de potencia. Si no tiene tiro, prueba moverse (`ShotPlan.move`, pixels con signo; la sesión manda esos comandos `move` antes de apuntar). Tapada y sin tiro, usa la excavadora. Elige el arma verificando con la simulación completa y con un costo por munición especial.

### Rondas y tienda (F10)

Valores de `SHOP`, `EARN`, `START_MONEY` (600), `SHIELD_HP` (30) y `REPAIR_HP` (25). Cada jugador arranca con el kit de `WEAPONS.ammo`; la munición y los ítems se conservan entre rondas (la normal vuelve a 99). Vender devuelve el 50%. La plata nunca queda negativa.

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
- `src/sim/index.ts` exporta como mínimo: `createMatch`, `applyCommand`, `chooseShot`, `groundAt(terrain, x, halfW, fromY?)` (la y del piso bajo esa franja; con `fromY` busca hacia abajo desde esa fila, sin él desde el cielo), `fly`, `muzzle`, `PATH_DT`, `isSolid(terrain, x, y)`, más todo lo de `types.ts`.
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
- **Muerte súbita**: tras 5 tiros seguidos sin daño a tanques, la lava sube 18 px desde el fondo en cada turno y quema 20 por turno a los tanques sumergidos; los proyectiles que la tocan se derriten sin explotar. La lava no da ni quita plata ni cuenta como kill. Toda ronda termina.
- **Hasta 8 jugadores**: 4 colores y 4 tripulantes nuevos; HUD rediseñado para 5-8 placas. Spawns repartidos a lo ancho.
- **Líquidos que fluyen**: agua y lava son materiales de la grilla. Se asientan con un autómata celular determinista al final de cada `fire`, con tope de iteraciones; los cambios salen como evento para que el render los anime.

### Reglas nuevas

- **Abismo**: tramo sin fondo. Lo que cae por debajo del mapa en un abismo muere (el paracaídas lo evita si se abre antes). Fuera de los abismos, debajo del mapa sigue siendo roca madre.
- **Agua**: no colisiona. Amortigua caídas (sin daño de caída), frena los proyectiles que entran y reduce a la mitad el radio de las explosiones sumergidas.
- **Lava**: no colisiona. Un tanque que la toca recibe daño por turno, enciende lo inflamable vecino y derrite los proyectiles (no explotan). La tierra (arma Tierra o derrumbe) sobre lava se vuelve piedra; agua y lava en contacto dan piedra.

### Contratos v2

- `src/sim/types.ts`: `MapSize`, `MAP_SIZES`, `MAP_SIZE_ORDER`, `MatchConfig.size`, `GameState.size` (con `width`/`height`), `Physics` y `physicsFor(width)`. `WORLD_W/WORLD_H` quedan como el tamaño del mapa Chico; nada fuera de `sim` los usa como tamaño del mundo.
- `src/render/types.ts`: `VIEW_W/VIEW_H` (pantalla lógica 800×450), `Camera { cx, cy, zoom }`, `RenderFrame.camera`, `GameRenderer.screenToWorld`. La cámara la decide el flujo; el renderer la aplica y suma el sacudón.
- `src/ui/types.ts`: `HudExtras.minimap` (`MinimapModel`, `MinimapTank`), `MinimapInput.minimapAt` (lo implementa `Hud`), `DEFAULT_CONFIG.size` = `'medium'`, `setOption('size')` en el lobby.
- `src/net/types.ts`: `LobbyState.size`.
- QA: `?play=...&size=small|medium|large`, `?demo=...&size=...`.
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
    - Pendientes: el fondo `forest-4` tiene un pino cortado en el borde derecho que al repetirse espejado se ve doble en la unión (arte: capas repetibles a lo ancho); el pilar con dintel de la jungla queda pegado a cada empalme; las partidas de 4 tanques en Mediano/Grande duran 1,5× (V2); el snapshot de red pesa 705 KB en Chico y ~3× en Grande (comprimir la grilla si el online se resiente). Acuerdo para V4: el minimapa reconoce agua y lava por `MATERIALS[].name` = `'agua'` y `'lava'`.
- **V2 Alcance y balance de distancias.** Física derivada del ancho, ajuste fino, IA que apunta a cualquier distancia y decide moverse, muerte súbita. `sim-check` por tamaño.
- **V3 Geografía por tramos.** El generador arma el mapa como secuencia de tramos por bioma: montaña, valle, meseta, abismo, lago, pozo de lava, más búnker/torre/cuevas.
- **V4 Agua y lava.** Materiales, flujo, reglas, texturas y animación (superficie, burbujas, vapor al enfriarse), sonido.
- **V5 Hasta 8 jugadores.** Arte, HUD, lobby local y online.

## Cómo se agrega algo

- Arma nueva: un registro en `WEAPONS` y, si el efecto es nuevo, un modo de terreno en `sim` y un `BlastStyle` en el renderer.
- Material nuevo: una constante y una entrada en `MATERIALS`, su textura en `paint-assets` y su entrada en el manifiesto.
- Efecto nuevo: el sim emite un evento y Pixi lo dibuja.
