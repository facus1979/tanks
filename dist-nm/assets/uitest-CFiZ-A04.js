import { l as loadUiAssets, r as refreshLabels, c as createTitleView, C as CREWS, a as createMenuView, b as createBannerView, d as createScoreboardView, e as createShopView, H as Hud, I as ITEM_ORDER, M as MAP_SIZES, f as createOnlineMenuView, g as createLobbyView, S as SHOP, T as TANK_COLORS, D as DIRT, h as compactSlots, i as MAX_PLAYERS_BY_SIZE, j as STONE, B as BRICK, W as WOOD, k as BEDROCK } from "./index-Df2tDxAk.js";
const ALL_ROWS = [
  { id: 0, name: "BANDANA", color: 4033776, crew: "bandana", alive: true, roundsWon: 2, kills: 3, earned: 1150, money: 1750 },
  { id: 1, name: "SARGENTO", color: 14826813, crew: "sarge", alive: false, roundsWon: 1, kills: 1, earned: 420, money: 900 },
  { id: 2, name: "NOVATO", color: 14860605, crew: "rookie", alive: false, roundsWon: 0, kills: 0, earned: 80, money: 300 },
  { id: 3, name: "DESIERTO", color: 4046426, crew: "desert", alive: true, roundsWon: 1, kills: 2, earned: 640, money: 1210 },
  { id: 4, name: "COMANDO", color: 10902240, crew: "commando", alive: false, roundsWon: 0, kills: 1, earned: 260, money: 540 },
  { id: 5, name: "TANQUISTA", color: 15765562, crew: "goggles", alive: true, roundsWon: 0, kills: 0, earned: 150, money: 420 },
  { id: 6, name: "PILOTO", color: 3854536, crew: "pilot", alive: false, roundsWon: 0, kills: 2, earned: 330, money: 610 },
  { id: 7, name: "CORONEL", color: 15227552, crew: "colonel", alive: false, roundsWon: 0, kills: 0, earned: 0, money: 150 }
];
function who() {
  const p = Number(new URLSearchParams(location.search).get("p")) || 5;
  return ALL_ROWS[Math.max(1, Math.min(8, p)) - 1];
}
function shopModel(money, owned) {
  const w = who();
  return {
    playerId: w.id,
    name: w.name.charAt(0) + w.name.slice(1).toLowerCase(),
    color: w.color,
    crew: w.crew,
    money,
    round: 2,
    rounds: 3,
    rows: SHOP.map((s) => ({
      ...s,
      owned: owned[s.id] ?? 0,
      canBuy: money >= s.price && (owned[s.id] ?? 0) + s.qty <= s.max,
      canSell: (owned[s.id] ?? 0) >= s.qty
    }))
  };
}
const params = new URLSearchParams(location.search);
function lobbyModel(role) {
  const host = role === "host";
  return {
    role,
    link: "http://localhost:5173/?join=TANK-4F7K",
    mySlot: host ? 0 : null,
    status: "ESPERANDO JUGADORES",
    canStart: false,
    lobby: {
      code: "TANK-4F7K",
      rounds: 3,
      difficulty: "normal",
      biome: "rotate",
      turnSeconds: 45,
      // sin &size= el lobby no trae size (como un anfitrión anterior a v2): se ve CHICO
      ...params.get("size") ? { size: params.get("size") } : {},
      // v5: siempre 8 casilleros; &size= decide cuántos están habilitados (Chico 4, Mediano 6, Grande 8)
      slots: [
        { kind: "human", name: "Facu", crew: "bandana", owner: "host", connected: true },
        { kind: "human", name: "Sargento", crew: "sarge", owner: "peer1", connected: true },
        { kind: "human", name: "", crew: "rookie", owner: null, connected: false },
        { kind: "ai", name: "IA", crew: "desert", owner: null, connected: true },
        { kind: "human", name: "Coman2", crew: "commando", owner: "peer2", connected: false },
        { kind: "ai", name: "IA", crew: "goggles", owner: null, connected: true },
        { kind: "off", name: "", crew: "pilot", owner: null, connected: false },
        { kind: "ai", name: "IA", crew: "colonel", owner: null, connected: true }
      ]
    }
  };
}
async function mountUiTest(name) {
  const forced = Number(new URLSearchParams(location.search).get("s"));
  if (forced) window.__uiScale = forced;
  if (params.has("touch")) document.documentElement.classList.add("touch");
  await loadUiAssets();
  refreshLabels();
  if (name === "title") createTitleView().show(() => console.log("start"));
  else if (name === "menu") {
    const n = Number(params.get("players"));
    const initial = n ? {
      slots: Array.from({ length: Math.max(2, Math.min(8, n)) }, (_, i) => ({ kind: i === 0 ? "human" : "ai", crew: CREWS[i], ...i === 2 ? { name: "RULO" } : {} })),
      rounds: 3,
      difficulty: "normal",
      biome: "rotate",
      size: params.get("size") ?? "large"
    } : null;
    createMenuView().show(initial, (c) => console.log("play", JSON.stringify(c)));
    pressKeys("pre");
    for (const pick of (params.get("pick") ?? "").split(",").filter(Boolean)) document.querySelector(`#menu-view [data-key="${pick}"]`)?.click();
    pressKeys();
  } else if (name === "banner") {
    const w = who();
    createBannerView().show({ name: w.name, color: w.color, crew: w.crew, round: 2, rounds: 3 }, () => console.log("go"));
  } else if (name === "score" || name === "final") {
    const n = Math.max(2, Math.min(8, Number(params.get("players")) || 8));
    const model = { round: 3, rounds: 3, roundWinnerId: 0, final: name === "final", winnerId: 0, rows: ALL_ROWS.slice(0, n) };
    createScoreboardView().show(model, () => console.log("continue"), () => console.log("menu"));
  } else if (name === "shop") {
    let money = 1250;
    const owned = { heavy: 2, shield: 1 };
    const view = createShopView();
    const change = (id, dir) => {
      const s = SHOP.find((e) => e.id === id);
      if (!s) return;
      money -= s.price * dir;
      owned[id] = (owned[id] ?? 0) + s.qty * dir;
      view.update(shopModel(money, owned));
    };
    view.show(shopModel(money, owned), { buy: (id) => change(id, 1), sell: (id) => change(id, -1), ready: () => console.log("ready") });
  } else if (name === "hud") {
    document.body.style.background = "#2a3a34";
    const root = document.createElement("div");
    root.id = "hud";
    root.style.cssText = "position:fixed;z-index:20";
    document.body.append(root);
    const hud = new Hud(root);
    const items = Object.fromEntries(ITEM_ORDER.map((id, i) => [id, i % 3]));
    const k = Math.max(1, Math.floor(Math.min(innerWidth / 800, innerHeight / 450)));
    hud.place({ x: Math.round((innerWidth - 800 * k) / 2), y: Math.round((innerHeight - 450 * k) / 2), w: 800 * k, h: 450 * k });
    const size = params.get("size") ?? "large";
    const nTanks = Math.max(2, Math.min(8, Number(params.get("players")) || 2));
    const turnRaw = params.get("turn");
    const turnN = turnRaw === "ai" ? 2 : Math.max(1, Math.min(nTanks, Number(turnRaw) || 1));
    const minimap = size in MAP_SIZES && size !== "small" ? fakeMinimap(size, nTanks, turnN - 1, params.get("view")) : null;
    const sdParam = params.get("sd");
    const suddenDeath = sdParam == null ? null : sdParam === "lava" ? { active: true, calmLeft: 0 } : { active: false, calmLeft: Number(sdParam) || 0 };
    if (minimap && suddenDeath?.active) minimap.lava = MAP_SIZES[size].h - 80;
    const crews = CREWS;
    const names = ["Bandana", "Sargento", "Novato", "Desierto", "Comando", "Tanquista", "Piloto", "Coronel"];
    const colors = TANK_COLORS;
    const nPlayers = Math.max(2, Math.min(8, Number(params.get("players")) || 2));
    const aiTurn = turnN !== 1;
    const turn = turnN;
    const side = (n) => ({ name: names[n - 1], tag: `P${n}`, color: colors[n - 1], crew: crews[n - 1], hp: [80, 100, 45, 20, 60, 0, 100, 35][n - 1], alive: n !== 6, active: n === turn, you: n === 1 });
    const fineAim = params.has("fine");
    const model = {
      human: side(1),
      rival: side(2),
      others: Array.from({ length: nPlayers - 2 }, (_, i) => side(i + 3)),
      angle: fineAim ? 135.5 : aiTurn ? 140 : 45,
      power: fineAim ? 100 : 60,
      weapon: "heavy",
      ammo: 2,
      wind: Number(params.get("wind") ?? 4),
      status: params.get("status") ?? (aiTurn ? `${names[turn - 1].toUpperCase()} PIENSA` : ""),
      showAim: !aiTurn,
      ammoAll: { normal: 99, heavy: 2, dirt: 3, cluster: 0, napalm: 2, digger: 2, roller: 2, nuke: 1, guided: 1, bouncer: 2, laser: 0, mine: 2, quake: 1, blackhole: 1, acid: 2, wall: 2 },
      fuel: aiTurn ? 1 : 0.7,
      showBar: !aiTurn,
      extras: {
        round: 2,
        rounds: 3,
        money: 1250,
        items,
        shield: aiTurn ? 0 : 25,
        tracer: true,
        net: params.has("net") ? { role: "host", code: "TANK-4F7K", peers: [{ name: "Sargento", connected: true, ping: 48 }, { name: "Novato", connected: false, ping: null }], turnLeft: Number(params.get("net")) || 27, waiting: "ESPERANDO A SARGENTO…" } : null,
        minimap,
        suddenDeath
      }
    };
    const tick = () => {
      hud.update(model);
      requestAnimationFrame(tick);
    };
    tick();
    window.addEventListener("pointerdown", (e) => {
      console.log("minimapAt", JSON.stringify(hud.minimapAt(e.clientX, e.clientY)));
      console.log("controlAt", JSON.stringify(hud.controlAt(e.clientX, e.clientY)));
    });
  } else if (name === "online") {
    const view = createOnlineMenuView();
    const handlers = { host: () => console.log("host"), join: (c) => {
      console.log("join", c);
      view.error("SALA NO ENCONTRADA");
    }, back: () => console.log("back") };
    view.show(handlers, params.get("join") ?? void 0);
  } else if (name === "lobby") {
    const view = createLobbyView();
    const model = lobbyModel(params.get("role") === "client" ? "client" : "host");
    const push = (fn) => {
      fn(model);
      view.update({ ...structuredClone(model), canStart: model.lobby.slots.filter((s) => s.kind !== "off").length >= 2 });
    };
    view.show(structuredClone(model), {
      claim: (i) => push((m) => {
        m.lobby.slots[i] = { ...m.lobby.slots[i], owner: "me", name: "Yo", connected: true };
        m.mySlot = i;
      }),
      release: () => push((m) => {
        if (m.mySlot != null) m.lobby.slots[m.mySlot] = { ...m.lobby.slots[m.mySlot], owner: null, name: "" };
        m.mySlot = null;
      }),
      setSlot: (i, kind) => push((m) => {
        m.lobby.slots[i] = { ...m.lobby.slots[i], kind, owner: kind === "human" ? null : null };
      }),
      setOption: (key, v) => push((m) => {
        m.lobby[key] = v;
        if (key === "size") {
          const mine = m.mySlot != null ? m.lobby.slots[m.mySlot] : null;
          const limit = MAX_PLAYERS_BY_SIZE[v] ?? MAX_PLAYERS_BY_SIZE.small;
          m.lobby.slots = compactSlots(m.lobby.slots, limit, (s) => s.kind !== "off", (crew) => ({ kind: "off", name: "", crew, owner: null, connected: false })).slots;
          const at = mine ? m.lobby.slots.indexOf(mine) : -1;
          m.mySlot = at >= 0 ? at : null;
        }
      }),
      start: () => console.log("start"),
      leave: () => console.log("leave")
    });
    pressKeys();
  } else return false;
  return true;
}
function pressKeys(param = "keys") {
  for (const code of (params.get(param) ?? "").split(",").filter(Boolean)) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true }));
  }
}
const q = new URLSearchParams(location.search).get("uitest");
if (q) void mountUiTest(q);
function fakeTerrain(w, h) {
  const front = new Uint8Array(w * h);
  const g = (x, c, s) => Math.exp(-(((x - c) / s) ** 2));
  const k = w / 2400;
  const surf = (x) => {
    const u = x / k;
    let y = 362 + Math.sin(u / 37) * 6 + Math.sin(u / 11) * 2;
    y -= 225 * g(u, 790, 95) + 70 * g(u, 900, 40);
    if (u < 250) y = 330;
    if (u >= 1150 && u < 1470) y = 300;
    y -= 70 * g(u, 1960, 60) + 45 * g(u, 2130, 45);
    y += 40 * g(u, 466, 70) + 34 * g(u, 1683, 52);
    return Math.round(Math.max(110, Math.min(h - 30, y)));
  };
  const fill = (x0, y0, x1, y1, m) => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) front[y * w + x] = m;
  };
  for (let x = 0; x < w; x++) fill(x, surf(x), x, h - 1, DIRT);
  fill(10, 330, Math.round(249 * k), 343, STONE);
  const mesa = (u) => Math.round(u * k);
  fill(mesa(1150), 300, mesa(1470) - 1, 307, STONE);
  fill(mesa(1240), 308, mesa(1240) + 150, 368, BRICK);
  fill(mesa(1240) + 10, 318, mesa(1240) + 140, 356, 0);
  fill(mesa(1360), 218, mesa(1360) + 58, 299, WOOD);
  fill(mesa(760) - 60, 380, mesa(760) + 60, 400, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - mesa(1878), y - (surf(mesa(1878)) + 3));
    if (d < 14 && front[y * w + x] === DIRT) front[y * w + x] = 0;
  }
  fill(0, h - 6, w - 1, h - 1, BEDROCK);
  return { w, h, front, back: new Uint8Array(w * h) };
}
function fakeMinimap(size, n, current, viewAt) {
  const { w, h } = MAP_SIZES[size];
  const terrain = fakeTerrain(w, h);
  const floor = (x) => {
    let y = 0;
    while (y < h - 1 && terrain.front[y * w + x] === 0) y++;
    return y;
  };
  const k = w / 2400;
  const colors = TANK_COLORS;
  const all = [1300, 830, 1205, 2290, 130, 1955, 470, 2130];
  const xs = all.slice(0, n).map((x) => Math.round(x * k));
  const vx = viewAt === "start" ? 0 : viewAt === "end" ? w - 800 : Math.round(1060 * k);
  const view = { x: vx, y: 0, w: 800, h: 450 };
  const tanks = xs.map((x, id) => ({ id, x, y: floor(x), color: colors[id], alive: id !== 5, current: id === current }));
  return {
    terrain,
    terrainVersion: 1,
    view,
    tanks,
    projectiles: [{ x: view.x + 640, y: 92 }],
    lastImpacts: [{ playerId: 2, x: Math.round(1878 * k), y: floor(Math.round(1878 * k)), color: colors[2] }]
  };
}
export {
  mountUiTest
};
