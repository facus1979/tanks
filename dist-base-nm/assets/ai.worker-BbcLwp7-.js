(function() {
  "use strict";
  const WORLD_W = 800;
  const WORLD_H = 450;
  const GRAVITY = 220;
  const POWER_SCALE = 4.03;
  const WIND_ACCEL = 9;
  function physicsFor(width) {
    const k = width / WORLD_W;
    if (k === 1) return { gravity: GRAVITY, powerScale: POWER_SCALE, windAccel: WIND_ACCEL };
    const r = Math.sqrt(k);
    return { gravity: GRAVITY * r, powerScale: POWER_SCALE * k ** 0.75, windAccel: WIND_ACCEL * r };
  }
  const SUBSTEP = 1 / 240;
  const MAX_FLIGHT = 14;
  const TANK_W = 28;
  const TANK_HALF_W = 14;
  const TANK_H = 20;
  const PIVOT_X = 5;
  const PIVOT_Y = 17;
  const BARREL_LEN = 14;
  const PLAYER_HP = 100;
  const SUDDEN_DEATH_CALM = 5;
  const LAVA_RISE = 18;
  const LAVA_DAMAGE = 20;
  const FALL_DAMAGE = 0.45;
  const FUEL_PER_TURN = 60;
  function fuelFor(width) {
    return Math.round(FUEL_PER_TURN * Math.sqrt(width / WORLD_W));
  }
  const KNOCKBACK_MAX = 24;
  const SLIDE_SLOPE = 3.75;
  const PARACHUTE_MIN_DAMAGE = 10;
  const MAX_CLIMB = 10;
  const AIR = 0;
  const DIRT = 1;
  const STONE = 2;
  const BRICK = 3;
  const WOOD = 4;
  const SLAT = 5;
  const BEAM = 6;
  const POST = 7;
  const METAL = 8;
  const BEDROCK = 9;
  const WATER = 10;
  const LAVA = 11;
  const SNOW = 12;
  const ICE = 13;
  const MATERIALS = [
    { id: AIR, name: "aire", toughness: 1, flammable: false },
    { id: DIRT, name: "tierra", toughness: 1, flammable: false },
    { id: STONE, name: "piedra", toughness: 0.7, flammable: false },
    { id: BRICK, name: "ladrillo", toughness: 0.8, flammable: false },
    { id: WOOD, name: "madera", toughness: 1, flammable: true },
    { id: SLAT, name: "tabla", toughness: 1, flammable: true },
    { id: BEAM, name: "viga", toughness: 0.9, flammable: true },
    { id: POST, name: "poste", toughness: 0.9, flammable: true },
    { id: METAL, name: "metal", toughness: 0.35, flammable: false },
    { id: BEDROCK, name: "roca madre", toughness: 0, flammable: false },
    // v4. Los nombres 'agua' y 'lava' los usa el minimapa para elegir color. Las explosiones no los rompen.
    { id: WATER, name: "agua", toughness: 0, flammable: false, liquid: true },
    { id: LAVA, name: "lava", toughness: 0, flammable: false, liquid: true },
    // v3 nieve. Los valores finos los balancea sim.
    { id: SNOW, name: "nieve", toughness: 1, flammable: false },
    { id: ICE, name: "hielo", toughness: 0.8, flammable: false }
  ];
  const WATER_DRAG = 0.25;
  const WATER_BLAST_SCALE = 0.5;
  const FLOW_MAX_ITERS = 400;
  const FLOW_FRAME_ITERS = 8;
  const BIOMES = ["forest", "jungle", "industrial", "snow"];
  const WEAPONS = {
    normal: { id: "normal", name: "Normal", radius: 14, damage: 22, terrain: "destroy", blast: "fire", ammo: 99 },
    heavy: { id: "heavy", name: "Pesada", radius: 26, damage: 36, terrain: "destroy", blast: "bigfire", ammo: 2 },
    dirt: { id: "dirt", name: "Tierra", radius: 18, damage: 20, terrain: "build", blast: "dirt", ammo: 3 },
    cluster: { id: "cluster", name: "Racimo", radius: 10, damage: 12, terrain: "destroy", blast: "fire", ammo: 2, split: 5 },
    napalm: { id: "napalm", name: "Napalm", radius: 16, damage: 14, terrain: "destroy", blast: "napalm", ammo: 2, burn: 3 },
    digger: { id: "digger", name: "Excavadora", radius: 9, damage: 10, terrain: "dig", blast: "dig", ammo: 2 },
    roller: { id: "roller", name: "Rodadora", radius: 16, damage: 30, terrain: "destroy", blast: "fire", ammo: 2, rolls: true },
    nuke: { id: "nuke", name: "Nuke", radius: 60, damage: 55, terrain: "destroy", blast: "nuke", ammo: 1 },
    // v3: valores iniciales; el área sim los balancea. ammo 0 = solo se consiguen en la tienda.
    guided: { id: "guided", name: "Teledirigido", radius: 16, damage: 30, terrain: "destroy", blast: "fire", ammo: 0, guided: true },
    bouncer: { id: "bouncer", name: "Rebotadora", radius: 10, damage: 14, terrain: "destroy", blast: "spark", ammo: 0, bounces: 3 },
    laser: { id: "laser", name: "Láser", radius: 4, damage: 30, terrain: "destroy", blast: "laser", ammo: 0, beam: true },
    mine: { id: "mine", name: "Mina", radius: 18, damage: 35, terrain: "destroy", blast: "spark", ammo: 0, mine: true },
    quake: { id: "quake", name: "Terremoto", radius: 70, damage: 10, terrain: "none", blast: "quake", ammo: 0, quake: 70 },
    blackhole: { id: "blackhole", name: "Agujero negro", radius: 12, damage: 8, terrain: "destroy", blast: "blackhole", ammo: 0, pull: 80 },
    acid: { id: "acid", name: "Ácido", radius: 18, damage: 16, terrain: "destroy", blast: "acid", ammo: 0, acid: 2, hard: true },
    wall: { id: "wall", name: "Muro", radius: 30, damage: 0, terrain: "wall", blast: "wall", ammo: 0 }
  };
  const WEAPON_ORDER = [
    "normal",
    "heavy",
    "dirt",
    "cluster",
    "napalm",
    "digger",
    "roller",
    "nuke",
    "guided",
    "bouncer",
    "laser",
    "mine",
    "quake",
    "blackhole",
    "acid",
    "wall"
  ];
  const SHIELD_HP = 30;
  const REPAIR_HP = 25;
  const SHOP = [
    { id: "heavy", kind: "weapon", name: "Pesada", price: 250, qty: 2, max: 9 },
    { id: "dirt", kind: "weapon", name: "Tierra", price: 120, qty: 3, max: 9 },
    { id: "cluster", kind: "weapon", name: "Racimo", price: 300, qty: 2, max: 9 },
    { id: "napalm", kind: "weapon", name: "Napalm", price: 280, qty: 2, max: 9 },
    { id: "digger", kind: "weapon", name: "Excavadora", price: 150, qty: 2, max: 9 },
    { id: "roller", kind: "weapon", name: "Rodadora", price: 220, qty: 2, max: 9 },
    { id: "nuke", kind: "weapon", name: "Nuke", price: 900, qty: 1, max: 2 },
    { id: "shield", kind: "item", name: "Escudo", price: 350, qty: 1, max: 3 },
    { id: "parachute", kind: "item", name: "Paracaídas", price: 120, qty: 1, max: 3 },
    { id: "fuel", kind: "item", name: "Combustible", price: 80, qty: 1, max: 5 },
    { id: "repair", kind: "item", name: "Reparación", price: 250, qty: 1, max: 3 },
    { id: "tracer", kind: "item", name: "Trazador", price: 150, qty: 1, max: 5 }
  ];
  const EARN = { perDamage: 4, kill: 300, survive: 150, roundWin: 400, selfDamage: -4 };
  function hashSeed(n) {
    let x = n | 0;
    x = Math.imul(x ^ x >>> 16, 2146121005);
    x = Math.imul(x ^ x >>> 15, 2221713035);
    return (x ^ x >>> 16) >>> 0;
  }
  function nextRng(state) {
    let t = state + 1831565813 >>> 0;
    const next = t;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    const value = ((t ^ t >>> 14) >>> 0) / 4294967296;
    return { value, state: next };
  }
  function range(state, min, max) {
    const roll2 = nextRng(state);
    return { value: min + roll2.value * (max - min), state: roll2.state };
  }
  function irange(state, min, max) {
    const roll2 = range(state, min, max + 1);
    return { value: Math.min(max, Math.floor(roll2.value)), state: roll2.state };
  }
  class Rng {
    constructor(state) {
      this.state = state;
    }
    state;
    next() {
      const r = nextRng(this.state);
      this.state = r.state;
      return r.value;
    }
    range(min, max) {
      return min + this.next() * (max - min);
    }
    int(min, max) {
      return Math.min(max, Math.floor(this.range(min, max + 1)));
    }
    chance(p) {
      return this.next() < p;
    }
  }
  function hash2(x, y, s = 0) {
    let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967296;
  }
  function noise1(x, scale, s) {
    const t = x / scale;
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    return hash2(i, 0, s) * (1 - u) + hash2(i + 1, 0, s) * u;
  }
  const SOLID = new Uint8Array(256);
  const LIQUID = new Uint8Array(256);
  for (let m = 1; m < 256; m++) {
    if (MATERIALS[m]?.liquid) LIQUID[m] = 1;
    else SOLID[m] = 1;
  }
  function createTerrain(w = WORLD_W, h = WORLD_H) {
    return { w, h, front: new Uint8Array(w * h), back: new Uint8Array(w * h) };
  }
  function cloneTerrain(t) {
    const c = { w: t.w, h: t.h, front: t.front.slice(), back: t.back.slice() };
    if (t.pits) c.pits = t.pits.slice();
    return c;
  }
  const dirtyOf = /* @__PURE__ */ new WeakMap();
  function markDirty(t, x0, y0, x1, y1) {
    const ax = Math.max(0, Math.floor(Math.min(x0, x1)));
    const bx = Math.min(t.w - 1, Math.ceil(Math.max(x0, x1)));
    const ay = Math.max(0, Math.floor(Math.min(y0, y1)));
    const by = Math.min(t.h - 1, Math.ceil(Math.max(y0, y1)));
    if (ax > bx || ay > by) return;
    const r = dirtyOf.get(t);
    if (!r) dirtyOf.set(t, { x0: ax, y0: ay, x1: bx, y1: by });
    else {
      r.x0 = Math.min(r.x0, ax);
      r.y0 = Math.min(r.y0, ay);
      r.x1 = Math.max(r.x1, bx);
      r.y1 = Math.max(r.y1, by);
    }
  }
  function peekDirty(t) {
    const r = dirtyOf.get(t);
    return r ? { ...r } : null;
  }
  function takeDirty(t) {
    const r = dirtyOf.get(t) ?? null;
    dirtyOf.delete(t);
    return r;
  }
  function isPit(terrain, ix) {
    return terrain.pits !== void 0 && ix >= 0 && ix < terrain.w && terrain.pits[ix] === 1;
  }
  function isSolid(terrain, x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= terrain.w || iy < 0) return false;
    if (iy >= terrain.h) return !isPit(terrain, ix);
    return SOLID[terrain.front[iy * terrain.w + ix]] === 1;
  }
  function liquidAt(terrain, x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= terrain.w || iy < 0 || iy >= terrain.h) return AIR;
    const m = terrain.front[iy * terrain.w + ix];
    return LIQUID[m] ? m : AIR;
  }
  function hasLiquid(terrain, m, x0, y0, x1, y1) {
    const ax = Math.max(0, Math.floor(x0));
    const bx = Math.min(terrain.w, Math.ceil(x1));
    const ay = Math.max(0, Math.floor(y0));
    const by = Math.min(terrain.h, Math.ceil(y1));
    const { w, front: front2 } = terrain;
    for (let y = ay; y < by; y++) {
      const row = y * w;
      for (let x = ax; x < bx; x++) if (front2[row + x] === m) return true;
    }
    return false;
  }
  function columnGround(terrain, x, fromY = 0) {
    const ix = Math.floor(x);
    if (ix < 0 || ix >= terrain.w) return terrain.h;
    const { w, front: front2 } = terrain;
    for (let y = Math.max(0, Math.floor(fromY)); y < terrain.h; y++) {
      if (SOLID[front2[y * w + ix]]) return y;
    }
    return terrain.h;
  }
  function columnTop(terrain, x, fromY = 0) {
    const ix = Math.floor(x);
    if (ix < 0 || ix >= terrain.w) return terrain.h;
    const { w, front: front2 } = terrain;
    for (let y = Math.max(0, Math.floor(fromY)); y < terrain.h; y++) {
      if (front2[y * w + ix] !== AIR) return y;
    }
    return terrain.h;
  }
  function fillRect(terrain, x0, y0, x1, y1, m, layer = "front") {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(terrain.w - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(terrain.h - 1, Math.max(y0, y1));
    for (let y = ay; y <= by; y++) {
      const row = y * terrain.w;
      for (let x = ax; x <= bx; x++) {
        if (layer !== "back") terrain.front[row + x] = m;
        if (layer !== "front") terrain.back[row + x] = m;
      }
    }
  }
  function deform(terrain, cx, cy, radius, mode, stoneFrom = Infinity) {
    const debris = {};
    const { w, h, front: front2, back } = terrain;
    const r = Math.ceil(radius) + 2;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    if (x0 > x1 || y0 > y1) return debris;
    markDirty(terrain, x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    let displaced = null;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + (hash2(x, y, 91) - 0.5) * 1.6;
        const i = y * w + x;
        const m = front2[i];
        if (mode === "build") {
          if (d > radius) continue;
          if (m === AIR || m === WATER) {
            front2[i] = y >= stoneFrom ? STONE : DIRT;
            if (back[i] === AIR) back[i] = DIRT;
            if (m === WATER) {
              if (!displaced) displaced = [];
              displaced.push(i);
            }
          } else if (m === LAVA) {
            front2[i] = STONE;
            if (back[i] === AIR) back[i] = DIRT;
          }
          continue;
        }
        if (m === AIR || LIQUID[m]) continue;
        const tough = mode === "dig" ? m === BEDROCK ? 0 : 1 : MATERIALS[m]?.toughness ?? 1;
        if (tough <= 0 || d > radius * tough) continue;
        front2[i] = AIR;
        debris[m] = (debris[m] ?? 0) + 1;
      }
    }
    if (displaced) {
      let top = y0;
      for (const i of displaced) {
        const x = i % w;
        let y = (i - x) / w - 1;
        while (y >= 0 && front2[y * w + x] !== AIR) y--;
        if (y < 0) continue;
        front2[y * w + x] = WATER;
        if (y < top) top = y;
      }
      markDirty(terrain, x0 - 1, top - 1, x1 + 1, y0);
    }
    return debris;
  }
  function solidRunUp(terrain, x, y, max) {
    let n = 0;
    for (let yy = y - 1; yy >= 0 && n < max; yy--) {
      if (!isSolid(terrain, x, yy)) break;
      n++;
    }
    return n;
  }
  const MAX_TILT = 75 * Math.PI / 180;
  const TILT_REACH = Math.ceil((TANK_W - 1) * Math.tan(MAX_TILT)) + 2;
  function tankTilt(t, x, floor) {
    const x0 = Math.round(x) - TANK_W / 2;
    const fy = Math.round(floor);
    const g = [];
    for (let i = 0; i < TANK_W; i++) {
      let y = fy + TILT_REACH;
      for (let yy = fy - 2; yy < fy + TILT_REACH; yy++) {
        if (isSolid(t, x0 + i, yy)) {
          y = Math.max(fy, yy);
          break;
        }
      }
      g.push(y);
    }
    const first = g.indexOf(fy);
    const last = g.lastIndexOf(fy);
    if (first < 0) return null;
    const mid = (TANK_W - 1) / 2;
    if (first <= mid && last >= mid) return null;
    let best = MAX_TILT;
    if (last < mid) {
      for (let i = last + 1; i < TANK_W; i++) best = Math.min(best, Math.atan2(g[i] - fy, i - last));
      return best > 0.02 ? { angle: best, x: x0 + last + 1 } : null;
    }
    for (let i = first - 1; i >= 0; i--) best = Math.min(best, Math.atan2(g[i] - fy, first - i));
    return best > 0.02 ? { angle: -best, x: x0 + first } : null;
  }
  const PATH_EVERY = 4;
  const PATH_DT = SUBSTEP * PATH_EVERY;
  const OUT_MARGIN = 40;
  function muzzle(x, ground, angleDeg, tilt) {
    const rad = angleDeg * Math.PI / 180;
    const facing = angleDeg > 90 ? -1 : 1;
    let px = x + facing * PIVOT_X;
    let py = ground - PIVOT_Y;
    if (tilt) {
      const cx = tilt.x;
      const cy = Math.round(ground);
      const dx = Math.round(x) + facing * PIVOT_X - cx;
      const dy = -PIVOT_Y;
      const c = Math.cos(tilt.angle);
      const s = Math.sin(tilt.angle);
      px = cx + dx * c - dy * s;
      py = cy + dx * s + dy * c;
    }
    return { x: px + Math.cos(rad) * BARREL_LEN, y: py - Math.sin(rad) * BARREL_LEN };
  }
  function skylineOf(terrain, players, props = []) {
    const sky = new Int16Array(terrain.w);
    for (let x = 0; x < terrain.w; x++) sky[x] = columnTop(terrain, x);
    const lower = (x0, x1, top) => {
      for (let x = Math.max(0, x0); x <= Math.min(terrain.w - 1, x1); x++) if (top < sky[x]) sky[x] = top;
    };
    for (const p of players) if (p.alive) lower(Math.floor(p.x - TANK_HALF_W), Math.floor(p.x + TANK_HALF_W), Math.floor(p.y - TANK_H));
    for (const p of props) if (p.alive && (p.kind === "barrel" || p.kind === "crate")) lower(Math.floor(p.x), Math.ceil(p.x + p.w), Math.floor(p.y));
    return sky;
  }
  function inTank(p, x, y) {
    return x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y;
  }
  function fly(opts) {
    const { terrain, players, ownerId } = opts;
    const owner = players.find((p) => p.id === ownerId);
    const origin = opts.origin ?? (owner ? muzzle(owner.x, owner.y, opts.angle, tankTilt(terrain, owner.x, owner.y)) : { x: 0, y: 0 });
    const rad = opts.angle * Math.PI / 180;
    const phys = physicsFor(terrain.w);
    const speed = opts.power * phys.powerScale;
    let x = origin.x;
    let y = origin.y;
    let vx = opts.velocity ? opts.velocity.x : Math.cos(rad) * speed;
    let vy = opts.velocity ? opts.velocity.y : -Math.sin(rad) * speed;
    const ax = opts.wind * phys.windAccel;
    const gravity = phys.gravity;
    const path = [{ x, y }];
    const tanks = opts.ignoreTanks ? [] : players.filter((p) => p.alive);
    const solidProps = (opts.props ?? []).filter((p) => p.alive && (p.kind === "barrel" || p.kind === "crate"));
    let armed = !owner || !inTank(owner, x, y);
    let elapsed = 0;
    let n = 0;
    const sky = opts.skyline?.length === terrain.w ? opts.skyline : void 0;
    const lava = opts.lava ?? Infinity;
    let wet = liquidAt(terrain, x, y) === WATER;
    const splashes = [];
    const drag = WATER_DRAG ** SUBSTEP;
    const end = (r) => {
      if (splashes.length > 0) r.splashes = splashes;
      return r;
    };
    if (isSolid(terrain, x, y)) {
      return { path, impact: { kind: "terrain", x, y }, time: 0, vel: { x: vx, y: vy } };
    }
    if (y >= lava || liquidAt(terrain, x, y) === LAVA) {
      return { path, impact: { kind: opts.lavaSolid ? "terrain" : "lava", x, y }, time: 0, vel: { x: vx, y: vy } };
    }
    while (elapsed < MAX_FLIGHT) {
      const px = x;
      const py = y;
      if (wet) {
        vx *= drag;
        vy *= drag;
      }
      vx += ax * SUBSTEP;
      const rising = vy < 0;
      vy += gravity * SUBSTEP;
      x += vx * SUBSTEP;
      y += vy * SUBSTEP;
      elapsed += SUBSTEP;
      n++;
      if (sky && y < lava && clearAbove(sky, terrain, px, py, x, y)) {
        if (owner) armed = true;
        wet = false;
      } else for (let i = 1, steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py))); i <= steps; i++) {
        const f = i / steps;
        const sx = px + (x - px) * f;
        const sy = py + (y - py) * f;
        const t = elapsed - SUBSTEP * (1 - f);
        if (owner && !armed && !inTank(owner, sx, sy)) armed = true;
        const liq = liquidAt(terrain, sx, sy);
        if (sy >= lava || liq === LAVA) {
          path.push({ x: sx, y: sy });
          return end({ path, impact: { kind: opts.lavaSolid ? "terrain" : "lava", x: sx, y: sy }, time: t, vel: { x: vx, y: vy } });
        }
        if (liq === WATER) {
          if (!wet) splashes.push({ x: sx, y: sy, t });
          wet = true;
        } else wet = false;
        const hit = hitAt(terrain, tanks, solidProps, ownerId, armed, sx, sy);
        if (hit) {
          path.push({ x: sx, y: sy });
          return end({ path, impact: hit, time: t, vel: { x: vx, y: vy } });
        }
      }
      if (opts.stopAtApex && rising && vy >= 0) {
        path.push({ x, y });
        return end({ path, impact: { kind: "out", x, y }, time: elapsed, vel: { x: vx, y: vy }, apex: true });
      }
      if (n % PATH_EVERY === 0) path.push({ x, y });
      if (x < -OUT_MARGIN || x > terrain.w + OUT_MARGIN || y > terrain.h + OUT_MARGIN && x >= 0 && x < terrain.w) {
        path.push({ x, y });
        return end({ path, impact: { kind: "out", x, y }, time: elapsed, vel: { x: vx, y: vy } });
      }
    }
    path.push({ x, y });
    return end({ path, impact: { kind: "out", x, y }, time: elapsed, vel: { x: vx, y: vy } });
  }
  function clearAbove(sky, terrain, ax, ay, bx, by) {
    const ymax = Math.max(ay, by);
    if (ymax >= terrain.h) return false;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
    const x1 = Math.min(terrain.w - 1, Math.floor(Math.max(ax, bx)));
    for (let x = x0; x <= x1; x++) if (ymax >= sky[x]) return false;
    return true;
  }
  function hitAt(terrain, tanks, props, ownerId, armed, x, y) {
    for (const p of tanks) {
      if (p.id === ownerId && !armed) continue;
      if (inTank(p, x, y)) return { kind: "tank", x, y, tankId: p.id };
    }
    for (const p of props) {
      if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return { kind: "prop", x, y, propId: p.id };
    }
    if (isSolid(terrain, x, y)) return { kind: "terrain", x, y };
    return null;
  }
  const FALL = new Uint8Array(256);
  const REACH = new Uint8Array(256);
  const SPEED = new Uint8Array(256);
  FALL[WATER] = 3;
  REACH[WATER] = 48;
  SPEED[WATER] = 3;
  FALL[LAVA] = 2;
  REACH[LAVA] = 20;
  SPEED[LAVA] = 1;
  const MAX_REACH = 48;
  const FLAMMABLE = new Uint8Array(256);
  for (const m of MATERIALS) if (m.flammable) FLAMMABLE[m.id] = 1;
  const FLOW_EXTRA_ITERS = 2 * FLOW_MAX_ITERS;
  let queued = new Uint32Array(0);
  let arrived = new Uint32Array(0);
  let touchedAt$1 = new Uint32Array(0);
  let gen$1 = 0;
  function ensure$1(n) {
    if (queued.length >= n) return;
    queued = new Uint32Array(n);
    arrived = new Uint32Array(n);
    touchedAt$1 = new Uint32Array(n);
    gen$1 = 0;
  }
  function nextGen$1() {
    gen$1++;
    if (gen$1 === 4294967295) {
      queued.fill(0);
      arrived.fill(0);
      touchedAt$1.fill(0);
      gen$1 = 1;
    }
    return gen$1;
  }
  class IntList {
    a = new Int32Array(1024);
    n = 0;
    push(v) {
      if (this.n === this.a.length) {
        const b = new Int32Array(this.a.length * 2);
        b.set(this.a);
        this.a = b;
      }
      this.a[this.n++] = v;
    }
  }
  let listA = new IntList();
  let listB = new IntList();
  let sorted = new Int32Array(1024);
  let rowCount = new Int32Array(0);
  function flowLiquids(t, opts) {
    const { w, h, front: front2 } = t;
    const pits = t.pits;
    ensure$1(w * h);
    if (rowCount.length < h + 1) rowCount = new Int32Array(h + 1);
    const maxIters = opts.maxIters ?? FLOW_MAX_ITERS;
    const extra = opts.extraIters ?? FLOW_EXTRA_ITERS;
    const record = opts.record;
    const report = {
      iters: 0,
      settled: true,
      changed: false,
      patches: [],
      steam: [],
      burns: [],
      lost: { water: 0, lava: 0 },
      touched: null,
      moves: 0
    };
    const callGen = nextGen$1();
    const origIdx = [];
    const origVal = [];
    let tx0 = w;
    let ty0 = h;
    let tx1 = -1;
    let ty1 = -1;
    let wx0 = w;
    let wy0 = h;
    let wx1 = -1;
    let wy1 = -1;
    let sx = 0;
    let sy = 0;
    let sn = 0;
    let bx0 = w;
    let bx1 = -1;
    let by = 0;
    let bn = 0;
    const set = (i, m) => {
      if (touchedAt$1[i] !== callGen) {
        touchedAt$1[i] = callGen;
        origIdx.push(i);
        origVal.push(front2[i]);
      }
      front2[i] = m;
      const x = i % w;
      const y = (i - x) / w;
      if (x < wx0) wx0 = x;
      if (x > wx1) wx1 = x;
      if (y < wy0) wy0 = y;
      if (y > wy1) wy1 = y;
    };
    let cur = listA;
    let next = listB;
    cur.n = 0;
    next.n = 0;
    let qGen = nextGen$1();
    let iterStamp = 0;
    const enqueue = (i) => {
      if (queued[i] === qGen) return;
      queued[i] = qGen;
      next.push(i);
    };
    const wake = (x, y) => {
      for (let dy = -1; dy <= 0; dy++) {
        const yy = y + dy;
        if (yy < 0) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx === 0 && dy === 0) continue;
          const k = yy * w + xx;
          if (LIQUID[front2[k]]) enqueue(k);
        }
      }
      scanRow(x, y);
      if (y > 0 && !LIQUID[front2[(y - 1) * w + x]]) scanRow(x, y - 1);
      if (y + 1 < h) {
        for (let dx = -1; dx <= 1; dx += 2) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = (y + 1) * w + xx;
          if (LIQUID[front2[k]]) enqueue(k);
        }
      }
    };
    function scanRow(x, y) {
      const row = y * w;
      for (let s = -1; s <= 1; s += 2) {
        for (let d = 1, xx = x + s; d <= MAX_REACH && xx >= 0 && xx < w; d++, xx += s) {
          const q = front2[row + xx];
          if (LIQUID[q]) {
            if (d <= REACH[q]) enqueue(row + xx);
            break;
          }
          if (q !== AIR) break;
        }
      }
    }
    const sx0 = opts.seed ? Math.max(0, opts.seed.x0 - 1) : 0;
    const sy0 = opts.seed ? Math.max(0, opts.seed.y0 - 1) : 0;
    const sx1 = opts.seed ? Math.min(w - 1, opts.seed.x1 + 1) : w - 1;
    const sy1 = opts.seed ? Math.min(h - 1, opts.seed.y1 + 1) : h - 1;
    if (!opts.seed && front2.byteOffset % 4 === 0) {
      const words = new Uint32Array(front2.buffer, front2.byteOffset, front2.length >> 2);
      for (let k = 0; k < words.length; k++) {
        if ((words[k] & 134744072) === 0) continue;
        for (let i = k << 2, e = i + 4; i < e; i++) {
          const m = front2[i];
          if (!LIQUID[m]) continue;
          const x = i % w;
          if (restless(t, x, (i - x) / w, m)) enqueue(i);
        }
      }
      for (let i = words.length << 2; i < front2.length; i++) {
        const m = front2[i];
        if (!LIQUID[m]) continue;
        const x = i % w;
        if (restless(t, x, (i - x) / w, m)) enqueue(i);
      }
    } else for (let y = sy0; y <= sy1; y++) {
      const row = y * w;
      for (let x = sx0; x <= sx1; x++) {
        const i = row + x;
        const m = front2[i];
        if (!LIQUID[m]) continue;
        if (restless(t, x, y, m)) enqueue(i);
      }
    }
    let iter = 0;
    const limit = maxIters + extra;
    let frame = 0;
    const flushWindow = () => {
      if (wx1 < 0) return;
      frame++;
      if (sn > 0) report.steam.push({ x: sx / sn, y: sy / sn, n: sn, frame });
      if (bn > 0) report.burns.push({ x: bx0, y: Math.round(by / bn), w: bx1 - bx0 + 1, frame });
      sx = sy = sn = 0;
      bx0 = w;
      bx1 = -1;
      by = bn = 0;
      if (wx0 < tx0) tx0 = wx0;
      if (wx1 > tx1) tx1 = wx1;
      if (wy0 < ty0) ty0 = wy0;
      if (wy1 > ty1) ty1 = wy1;
      if (record) report.patches.push(patchOf(t, wx0, wy0, wx1, wy1));
      wx0 = w;
      wy0 = h;
      wx1 = wy1 = -1;
    };
    while (next.n > 0 && iter < limit) {
      const tmp = cur;
      cur = next;
      next = tmp;
      next.n = 0;
      const aGen = qGen;
      iterStamp = aGen;
      qGen = nextGen$1();
      iter++;
      const n = cur.n;
      if (sorted.length < n) sorted = new Int32Array(Math.max(n, sorted.length * 2));
      rowCount.fill(0, 0, h + 1);
      const src = cur.a;
      for (let k = 0; k < n; k++) rowCount[h - 1 - (src[k] / w | 0)]++;
      for (let r = 0, acc = 0; r <= h; r++) {
        const c = rowCount[r];
        rowCount[r] = acc;
        acc += c;
      }
      for (let k = 0; k < n; k++) {
        const v = src[k];
        sorted[rowCount[h - 1 - (v / w | 0)]++] = v;
      }
      for (let k = 0; k < n; k++) {
        const i = sorted[k];
        const m = front2[i];
        if (!LIQUID[m] || arrived[i] === aGen) continue;
        const x = i % w;
        const y = (i - x) / w;
        const other = m === WATER ? LAVA : WATER;
        let reacted = false;
        for (let d = 0; d < 4; d++) {
          const xx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
          const yy = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          const q = front2[j];
          if (q === other) {
            const lavaCell = m === LAVA ? i : j;
            const waterCell = m === LAVA ? j : i;
            set(lavaCell, STONE);
            if (front2[waterCell] === WATER) set(waterCell, AIR);
            const lx = lavaCell % w;
            sx += lx;
            sy += (lavaCell - lx) / w;
            sn++;
            wake(xx, yy);
            wake(x, y);
            reacted = true;
            if (front2[i] !== m) break;
          } else if (m === LAVA && FLAMMABLE[q]) {
            set(j, AIR);
            if (xx < bx0) bx0 = xx;
            if (xx > bx1) bx1 = xx;
            by += yy;
            bn++;
            wake(xx, yy);
            enqueue(i);
            reacted = true;
          }
        }
        if (reacted) {
          report.changed = true;
          continue;
        }
        if (y + 1 >= h) {
          if (pits && pits[x]) {
            set(i, AIR);
            if (m === WATER) report.lost.water++;
            else report.lost.lava++;
            wake(x, y);
            report.changed = true;
          }
          continue;
        }
        if (front2[i + w] === AIR) {
          let ny = y + 1;
          const fall = FALL[m];
          while (ny + 1 < h && ny - y < fall && front2[(ny + 1) * w + x] === AIR) ny++;
          move2(i, ny * w + x, m, x, y);
          continue;
        }
        const pref = x + y + iter & 1 ? 1 : -1;
        let done = false;
        for (let s = pref, tries = 0; tries < 2; tries++, s = -s) {
          const nx = x + s;
          if (nx < 0 || nx >= w) continue;
          if (front2[y * w + nx] === AIR && front2[(y + 1) * w + nx] === AIR) {
            move2(i, (y + 1) * w + nx, m, x, y);
            done = true;
            break;
          }
        }
        if (done) continue;
        const reach = REACH[m];
        const top = y === 0 || front2[i - w] === AIR;
        let bestS = 0;
        let bestD = reach + 1;
        let bestThru = false;
        for (let s = pref, tries = 0; tries < 2; tries++, s = -s) {
          let thru = false;
          for (let d = 1; d <= reach && d < bestD; d++) {
            const nx = x + s * d;
            if (nx < 0 || nx >= w) break;
            const q = front2[y * w + nx];
            if (q !== AIR) {
              if (top && q === m) {
                thru = true;
                continue;
              }
              break;
            }
            const open = y + 1 >= h ? !!(pits && pits[nx]) : front2[(y + 1) * w + nx] === AIR;
            if (open) {
              bestS = s;
              bestD = d;
              bestThru = thru;
              break;
            }
          }
        }
        if (bestS !== 0) {
          if (bestThru) {
            const nx = x + bestS * bestD;
            move2(i, y + 1 < h ? (y + 1) * w + nx : y * w + nx, m, x, y);
            for (let d = 1; d < bestD; d++) {
              const k2 = y * w + x + bestS * d;
              if (front2[k2] === m && (y === 0 || front2[k2 - w] === AIR)) enqueue(k2);
            }
          } else {
            const nx = x + bestS * Math.min(SPEED[m], bestD);
            move2(i, bestD <= SPEED[m] && y + 1 < h ? (y + 1) * w + nx : y * w + nx, m, x, y);
          }
        }
      }
      if (record && iter % FLOW_FRAME_ITERS === 0 && iter <= maxIters) flushWindow();
    }
    flushWindow();
    report.iters = iter;
    report.settled = next.n === 0;
    if (tx1 >= 0) {
      report.touched = { x0: tx0, y0: ty0, x1: tx1, y1: ty1 };
      report.changed = true;
      if (record) {
        const p0 = patchOf(t, tx0, ty0, tx1, ty1);
        const pw = p0.w;
        for (let k = 0; k < origIdx.length; k++) {
          const i = origIdx[k];
          const x = i % w;
          const y = (i - x) / w;
          p0.front[(y - ty0) * pw + (x - tx0)] = origVal[k];
        }
        report.patches.unshift(p0);
      }
    } else report.changed = false;
    return report;
    function move2(i, j, m, x, y) {
      set(i, AIR);
      set(j, m);
      arrived[j] = iterStamp;
      enqueue(j);
      wake(x, y);
      report.moves++;
      report.changed = true;
    }
  }
  function restless(t, x, y, m) {
    const { w, h, front: front2 } = t;
    const other = m === WATER ? LAVA : WATER;
    for (let dy = 0; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy >= h) {
        if (t.pits && t.pits[x]) return true;
        continue;
      }
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || dx === 0 && dy === 0) continue;
        const q = front2[yy * w + xx];
        if (q === AIR || q === other || m === LAVA && FLAMMABLE[q]) return true;
      }
    }
    if (y > 0) {
      const q = front2[(y - 1) * w + x];
      if (q === other || m === LAVA && FLAMMABLE[q]) return true;
    }
    return false;
  }
  function patchOf(t, x0, y0, x1, y1) {
    const pw = x1 - x0 + 1;
    const ph = y1 - y0 + 1;
    const front2 = new Uint8Array(pw * ph);
    const back = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      const src = (y0 + y) * t.w + x0;
      front2.set(t.front.subarray(src, src + pw), y * pw);
      back.set(t.back.subarray(src, src + pw), y * pw);
    }
    return { x: x0, y: y0, w: pw, h: ph, front: front2, back };
  }
  const BEDROCK_ROWS = 3;
  const PROP_SIZE = {
    barrel: { w: 10, h: 12 },
    crate: { w: 12, h: 12 },
    ladder: { w: 8, h: 4 },
    // h real depende del largo
    lamp: { w: 5, h: 7 },
    flag: { w: 20, h: 36 },
    // el mástil está en x; la tela va a la derecha
    windsock: { w: 2, h: 28 },
    // solo el mástil; la manga la dibuja el renderer según el viento
    loot: { w: 14, h: 12 },
    // v3 caja de botín
    target: { w: 32, h: 20 }
    // v3 objetivo pago
  };
  const TRAMO_W = WORLD_W;
  const TRAMO_H = WORLD_H;
  const W = TRAMO_W;
  const H = TRAMO_H;
  const SPAWN_GAP = 80;
  const SPAWN_GAP_CROWD = 120;
  const spawnStats = { levels: [0, 0, 0, 0, 0, 0, 0, 0], brinks: [0, 0, 0] };
  function generate(biome, rng, count, width = WORLD_W, height = WORLD_H, safe = 0) {
    if (width === W && height === H) return single(biome, rng, count);
    return chain(biome, rng, count, width, height, safe);
  }
  const HUMAN_PIT_GAP = 40;
  function humanSafe(t, x) {
    return !nearPit(t, x, TANK_HALF_W + HUMAN_PIT_GAP + 1);
  }
  function buildTramo(biome, rng, L) {
    const t = createTerrain(W, H);
    const surf = [];
    for (let x = 0; x < W; x++) surf[x] = surface(L, biome, x);
    for (let x = 0; x < W; x++) fillRect(t, x, surf[x], x, H - 1, DIRT);
    const specs = [];
    if (biome === "forest") buildForest(t, L, rng, specs);
    else if (biome === "jungle") buildJungle(t, L, rng, specs);
    else buildIndustrial(t, L, rng, specs, surf);
    craters(t, L, rng, surf);
    return { terrain: t, specs };
  }
  function tramoSpecs(L, x0) {
    return [
      { kind: "flag", x: x0 + 20, y: L.platY },
      { kind: "windsock", x: x0 + L.platX1 + 58, y: 0 }
    ];
  }
  function single(biome, rng, count) {
    const L = layout(biome, rng);
    const { terrain: t, specs } = buildTramo(biome, rng, L);
    fillRect(t, 0, H - BEDROCK_ROWS, W - 1, H - 1, BEDROCK, "both");
    const spawnXs = pickSpawns(L, rng, count, biome === "industrial");
    const targets = spawnXs.map((x) => flatten(t, x));
    ramps(t, spawnXs, targets);
    specs.push(...tramoSpecs(L, 0));
    return finish(t, specs, spawnXs, rng);
  }
  function finish(t, specs, spawnXs, rng) {
    const mirror = rng.chance(0.5);
    if (mirror) mirrorTerrain(t);
    const spawns = spawnXs.map((x) => mirror ? t.w - x : x);
    const props = [];
    for (const s of specs) {
      const p = placeProp(t, s, mirror, props.length, spawns);
      if (p) props.push(p);
    }
    return { terrain: t, props, spawns };
  }
  function layout(biome, rng) {
    const platX1 = rng.int(172, 206);
    const platY = rng.int(326, 340);
    const plateauX0 = rng.int(572, 598);
    const py = rng.int(306, 324);
    const bx = Math.min(638, plateauX0 + rng.int(46, 58));
    const towerX = Math.min(724, bx + rng.int(58, 76));
    const hillX = rng.int(385, 445);
    const hillKind = rng.int(0, 2);
    const hillH = biome === "jungle" ? rng.int(92, 112) : biome === "industrial" ? rng.int(68, 88) : rng.int(80, 98);
    const hillW = rng.int(38, 50);
    const base = rng.int(360, 372);
    const v1 = Math.round((platX1 + 50 + hillX - hillW) / 2);
    const v2 = Math.round((hillX + hillW * 0.9 + plateauX0 - 37) / 2);
    return {
      platX1,
      platY,
      plateauX0,
      py,
      bx,
      towerX,
      hillX,
      hillH,
      hillW,
      hillKind,
      base,
      bumpX: v2 + rng.int(-6, 6),
      v1,
      v2,
      caveX: v1 + rng.int(-14, 14),
      caveY: rng.int(394, 408),
      noiseSeed: rng.int(1, 1e5)
    };
  }
  function hill(L, x) {
    const g = (c, w) => Math.exp(-(((x - c) / w) ** 2));
    if (L.hillKind === 1) {
      return L.hillH * Math.max(g(L.hillX - 20, L.hillW * 0.7), 0.85 * g(L.hillX + 24, L.hillW * 0.6));
    }
    if (L.hillKind === 2) {
      return L.hillH * 0.95 * g(L.hillX, L.hillW * 1.1) + 14 * g(L.hillX + L.hillW, 14);
    }
    return L.hillH * g(L.hillX, L.hillW) + 12 * g(L.hillX - 32, 12);
  }
  function surface(L, biome, x) {
    const s = L.noiseSeed;
    const rough = biome === "jungle" ? 22 : 15;
    let v = L.base + (noise1(x, 70, s) - 0.5) * rough + (noise1(x, 17, s + 1) - 0.5) * 5;
    v -= hill(L, x);
    v -= 10 * Math.exp(-(((x - L.bumpX) / 25) ** 2));
    let y = v;
    if (x < L.platX1) y = L.platY;
    else if (x < L.platX1 + 50) y = L.platY + (v - L.platY) * ((x - L.platX1) / 50) + (noise1(x, 6, s + 2) - 0.5) * 3;
    else if (x >= L.plateauX0) y = L.py;
    else if (x >= L.plateauX0 - 37) y = v + (L.py - v) * ((x - (L.plateauX0 - 37)) / 37);
    return Math.round(Math.max(120, Math.min(H - 40, y)));
  }
  function stoneSlab(t, x0, y0, x1, y1, m = STONE) {
    fillRect(t, x0, y0, x1, y1, m);
  }
  function cave(t, cx, cy0, halfW, halfH, seed) {
    let deepest = 0;
    for (let x = cx - halfW - 8; x <= cx + halfW + 8; x++) deepest = Math.max(deepest, columnGround(t, x));
    const cy = Math.min(H - BEDROCK_ROWS - halfH - 8, Math.max(cy0, deepest + halfH + 14));
    for (let y = cy - halfH - 2; y <= cy + halfH + 2; y++) {
      for (let x = cx - halfW - 4; x <= cx + halfW + 4; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H - BEDROCK_ROWS - 2) continue;
        const wob = Math.sin(y / 5 + seed) * 4;
        const ny = (y - cy) / halfH;
        const nx = (x - cx - wob) / halfW;
        const r = 1 - Math.abs(ny) * 0.55 + (hash2(x, y, seed) - 0.5) * 0.12;
        if (Math.abs(ny) < 1 && Math.abs(nx) < r) {
          const i = y * W + x;
          if (t.front[i] === DIRT || t.front[i] === STONE) {
            t.front[i] = AIR;
            if (t.back[i] === AIR) t.back[i] = DIRT;
          }
        }
      }
    }
  }
  function bunker(t, L, wall, floor, specs, rng) {
    const { bx, py } = L;
    fillRect(t, bx, py + 8, bx + 150, py + 68, wall);
    fillRect(t, bx, py + 57, bx + 150, py + 64, floor);
    t.back.set(t.front);
    fillRect(t, bx + 10, py + 18, bx + 140, py + 56, AIR);
    fillRect(t, bx + 22, py, bx + 29, py + 17, AIR);
    fillRect(t, bx + 22, py, bx + 29, py + 17, wall, "back");
    specs.push({ kind: "ladder", x: bx + 22, y: py - 2, h: py + 57 - (py - 2) });
    specs.push({ kind: "lamp", x: bx + 58 + rng.int(-8, 8), y: py + 18 });
    const cx = bx + 98 + rng.int(-12, 0);
    specs.push({ kind: "crate", x: cx, y: py + 45 });
    specs.push({ kind: "crate", x: cx + 12, y: py + 45 });
    if (rng.chance(0.7)) specs.push({ kind: "crate", x: cx + 6, y: py + 33 });
    specs.push({ kind: "barrel", x: bx + 124 + rng.int(-2, 4), y: py + 45 });
  }
  function tower(t, L, cabin, specs) {
    const x = L.towerX;
    const g = L.py;
    for (const px of [x, x + 18, x + 38, x + 55]) fillRect(t, px, g - 40, px + 3, g - 1, POST);
    fillRect(t, x - 12, g - 42, x + 64, g - 38, BEAM);
    fillRect(t, x, g - 30, x + 58, g - 1, WOOD);
    fillRect(t, x, g - 30, x + 58, g - 27, BEAM);
    fillRect(t, x + 24, g - 20, x + 34, g - 1, AIR);
    fillRect(t, x + 24, g - 20, x + 34, g - 1, WOOD, "back");
    fillRect(t, x + 2, g - 82, x + 56, g - 43, cabin);
    fillRect(t, x + 12, g - 72, x + 28, g - 58, AIR);
    fillRect(t, x + 12, g - 72, x + 28, g - 58, WOOD, "back");
    fillRect(t, x - 4, g - 88, x + 62, g - 83, BEAM);
    for (const px of [x + 2, x + 54]) fillRect(t, px, g - 82, px + 2, g - 43, POST);
    specs.push({ kind: "ladder", x: x - 12, y: g - 42, h: 42 });
  }
  function buildForest(t, L, rng, specs) {
    const { platX1, platY, py, plateauX0, hillX } = L;
    stoneSlab(t, 14, platY, platX1 - 1, platY + 13);
    stoneSlab(t, 4, platY, 14, platY + 7);
    const b0 = rng.int(80, 110);
    stoneSlab(t, b0, platY + 14, b0 + 46, platY + 20);
    const b1 = rng.int(24, 50);
    stoneSlab(t, b1, platY + 37, b1 + 25, platY + 43);
    const hs = columnGround(t, hillX);
    stoneSlab(t, hillX - 12, hs + 20, hillX + 6, hs + 26);
    stoneSlab(t, plateauX0, py, W - 1, py + 7);
    bunker(t, L, BRICK, STONE, specs, rng);
    cave(t, L.caveX, L.caveY, 50, 12, 3);
    tower(t, L, SLAT, specs);
    specs.push({ kind: "barrel", x: L.bx + 35, y: py - 12 });
    specs.push({ kind: "crate", x: L.towerX + 64, y: py - 12 });
    specs.push({ kind: "barrel", x: platX1 - 16, y: platY - 12 });
  }
  function buildJungle(t, L, rng, specs) {
    const { platX1, platY, py, plateauX0 } = L;
    for (let x = 14; x < platX1 - 4; ) {
      const w = rng.int(14, 30);
      if (rng.chance(0.75)) stoneSlab(t, x, platY, Math.min(platX1 - 1, x + w - 1), platY + rng.int(5, 9));
      x += w + rng.int(0, 3);
    }
    stoneSlab(t, 4, platY - 26, 11, platY - 1);
    stoneSlab(t, 2, platY - 30, 15, platY - 27);
    const b1 = rng.int(30, 120);
    stoneSlab(t, b1, platY + 30, b1 + 22, platY + 36);
    for (let x = plateauX0; x < W; x += 24) if (rng.chance(0.6)) stoneSlab(t, x, py, Math.min(W - 1, x + 21), py + 5);
    bunker(t, L, STONE, STONE, specs, rng);
    cave(t, L.caveX, L.caveY, 46, 13, 5);
    cave(t, Math.round((L.hillX + L.v2) / 2), L.caveY + rng.int(-4, 10), 30, 9, 11);
    tower(t, L, SLAT, specs);
    specs.push({ kind: "crate", x: L.bx + 35, y: py - 12 });
    specs.push({ kind: "barrel", x: L.towerX + 64, y: py - 12 });
  }
  function buildIndustrial(t, L, rng, specs, surf) {
    const { platX1, platY, py, plateauX0 } = L;
    fillRect(t, 4, platY, platX1 - 1, platY + 16, BRICK);
    fillRect(t, 4, platY, platX1 - 1, platY + 2, METAL);
    fillRect(t, plateauX0, py, W - 1, py + 3, METAL);
    fillRect(t, plateauX0, py + 4, W - 1, py + 7, BRICK);
    bunker(t, L, BRICK, METAL, specs, rng);
    cave(t, L.caveX, L.caveY, 44, 11, 7);
    const sx = L.v1 + rng.int(-4, 8);
    let g = H;
    for (let x = sx; x <= sx + 34; x++) g = Math.min(g, surf[x]);
    for (let x = sx; x <= sx + 34; x++) fillRect(t, x, g, x, surf[x], BRICK, "both");
    fillRect(t, sx, g - 30, sx + 34, g - 1, BRICK);
    fillRect(t, sx - 3, g - 33, sx + 37, g - 31, METAL);
    fillRect(t, sx + 4, g - 26, sx + 30, g - 1, AIR);
    fillRect(t, sx + 4, g - 26, sx + 30, g - 1, BRICK, "back");
    fillRect(t, sx, g - 18, sx + 3, g - 1, AIR);
    fillRect(t, sx, g - 18, sx + 3, g - 1, BRICK, "back");
    specs.push({ kind: "barrel", x: sx + 18, y: g - 12 });
    const cx = L.v2 + rng.int(36, 42);
    const cy = surf[Math.min(W - 1, cx)] - rng.int(58, 70);
    fillRect(t, cx - 20, cy, cx + 20, cy + 3, BEAM);
    for (const px of [cx - 18, cx + 15]) {
      const gy = columnGround(t, px, cy + 4);
      fillRect(t, px, cy + 4, px + 2, gy - 1, POST);
    }
    specs.push({ kind: "barrel", x: cx - 5, y: cy - 12 });
    tower(t, L, METAL, specs);
    specs.push({ kind: "barrel", x: L.bx + 35, y: py - 12 });
  }
  function craters(t, L, rng, surf) {
    const n = rng.int(2, 3);
    for (let k = 0; k < n; k++) {
      const x = rng.int(L.platX1 + 10, L.plateauX0 - 20);
      const r = rng.int(7, 10);
      const cy = surf[x] + rng.int(0, 3);
      for (let y = cy - r - 2; y <= cy + r + 2; y++) {
        for (let xx = x - r - 2; xx <= x + r + 2; xx++) {
          if (xx < 0 || xx >= W || y < 0 || y >= H) continue;
          const d = Math.hypot(xx - x, (y - cy) * 1.1) + (hash2(xx, y, 5) - 0.5) * 2.2;
          const i = y * W + xx;
          if (d < r && t.front[i] === DIRT) {
            t.front[i] = AIR;
            if (t.back[i] === AIR && y >= surf[xx]) t.back[i] = DIRT;
          }
        }
      }
    }
  }
  function pickSpawns(L, rng, count, industrial) {
    const plat = rng.int(60, Math.max(62, L.platX1 - 64));
    const plateau = Math.min(L.plateauX0 + 28, L.bx - 16);
    const middle = [L.hillX + (L.hillKind === 1 ? -20 : 0), L.v1, L.v2];
    let slots;
    if (count <= 1) slots = [plat];
    else if (count === 2) slots = [plat, plateau];
    else if (count === 3) {
      const pool = industrial ? [middle[0], middle[2]] : middle;
      slots = [plat, pool[rng.int(0, pool.length - 1)], plateau];
    } else slots = [plat, middle[0], L.v2, plateau];
    const bots = slots.slice(1);
    for (let i = bots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const tmp = bots[i];
      bots[i] = bots[j];
      bots[j] = tmp;
    }
    return [slots[0], ...bots].slice(0, Math.max(1, count));
  }
  function spreadSpawns(t, slots, rng, count, ok0, loose0, brink = /* @__PURE__ */ new Set(), safeCount = 0, safe = () => true) {
    const n = Math.max(1, count);
    let forced = false;
    const ok = (x) => ok0(x) && (!forced || safe(x));
    const loose = (x) => loose0(x) && (!forced || safe(x));
    const span = t.w / n;
    const taken = [];
    const away = (x, d) => taken.every((q) => Math.abs(q - x) >= d);
    const gap = Math.max(SPAWN_GAP, span * 0.32, n > 4 ? SPAWN_GAP_CROWD : 0);
    for (let i = 0; i < n; i++) {
      const ideal = span * (i + 0.5) + (rng.next() - 0.5) * span * 0.3;
      forced = safeCount - taken.filter(safe).length >= n - i;
      let best = -1;
      let level = 0;
      for (const x of slots) {
        if (!away(x, gap) || Math.abs(x - ideal) > span * 0.34 || !ok(x)) continue;
        const cost = (q) => Math.abs(q - ideal) - (brink.has(q) ? span : 0);
        if (best < 0 || cost(x) < cost(best)) best = x;
      }
      const edge = (x) => i === 0 ? x < span : i === n - 1 && n > 1 ? x > t.w - span : true;
      const tries = [
        (x) => edge(x) && away(x, gap) && ok(x),
        (x) => away(x, gap) && ok(x),
        (x) => away(x, SPAWN_GAP) && ok(x),
        // sin lugar libre a SPAWN_GAP: el más cercano que sirva aunque quede más pegado a otro
        (x) => away(x, 64) && ok(x),
        (x) => away(x, 64) && loose(x)
      ];
      for (let k = 0; best < 0 && k < tries.length; k++) {
        level = k + 1;
        best = scanSpawn(t, ideal, tries[k]) ?? -1;
      }
      if (best < 0) {
        level = 6;
        best = scanSpawn(t, ideal, loose, 1) ?? -1;
      }
      if (best < 0) {
        level = 7;
        best = Math.round(Math.max(40, Math.min(t.w - 40, ideal)));
      }
      spawnStats.levels[level]++;
      taken.push(best);
    }
    taken.sort((a, b) => a - b);
    const bots = taken.slice(1);
    for (let i = bots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const tmp = bots[i];
      bots[i] = bots[j];
      bots[j] = tmp;
    }
    return [taken[0], ...bots];
  }
  function scanSpawn(t, x, ok, step = 6) {
    const x0 = Math.round(x);
    for (let d = 0; d < t.w; d += step) {
      for (const c of d === 0 ? [x0] : [x0 - d, x0 + d]) {
        if (c < 40 || c > t.w - 40) continue;
        if (ok(c)) return c;
      }
    }
    return null;
  }
  const STRUCTURE = /* @__PURE__ */ new Set([BRICK, WOOD, SLAT, BEAM, POST, METAL]);
  function openGround(t, cx, surf) {
    const [x0, x1] = padBounds(cx);
    let top = t.h;
    for (let x = x0; x <= x1; x++) {
      const g = columnGround(t, x);
      if (g < surf[x] - 3) return false;
      top = Math.min(top, g);
    }
    if (top >= t.h - BEDROCK_ROWS - 4) return false;
    for (let x = x0 - 6; x <= x1 + 6; x++) {
      for (let y = Math.max(0, top - TANK_H - 16); y < top; y++) {
        const i = y * t.w + x;
        if (STRUCTURE.has(t.front[i]) || STRUCTURE.has(t.back[i])) return false;
      }
    }
    return true;
  }
  const PAD_RAMP = 80;
  function padBounds(cx) {
    return [cx - TANK_HALF_W - 4, cx + TANK_HALF_W + 3];
  }
  function flatten(t, cx) {
    const [x0, x1] = padBounds(cx);
    const tops = [];
    for (let x = x0; x <= x1; x++) tops.push(columnGround(t, x));
    const sorted2 = tops.slice().sort((a, b) => a - b);
    const target = sorted2[sorted2.length >> 1];
    for (let x = x0; x <= x1; x++) setColumn(t, x, target, target - TANK_H - 10);
    return target;
  }
  const RAMP_LONG = 200;
  function ramps(t, spawnXs, targets, opts = {}) {
    const { stop, long } = opts;
    const reach = long ? RAMP_LONG : PAD_RAMP;
    const pads = spawnXs.map((x) => padBounds(x));
    const near = (x) => {
      let best = -1;
      let bd = Infinity;
      pads.forEach((b, i) => {
        const d = x < b[0] ? b[0] - x : x > b[1] ? x - b[1] : 0;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return bd === 0 ? -2 : best;
    };
    pads.forEach((b, i) => {
      for (const dir of [-1, 1]) {
        let prev = targets[i];
        let blocked = 0;
        for (let d = 1; d <= reach; d++) {
          const x = dir < 0 ? b[0] - d : b[1] + d;
          if (x < 0 || x >= t.w || near(x) !== i || stop?.(x)) break;
          const orig = soilTop(t, x, targets[i]);
          if (orig < 0) {
            if (++blocked > 4) break;
            continue;
          }
          blocked = 0;
          const step = d <= 2 ? 0 : d <= 10 ? 1 : d <= 30 || !long ? 2 : d <= 50 ? 3 : 4;
          const h = Math.max(prev - step, Math.min(prev + step, orig));
          if (h === orig && d > 8) break;
          if (h !== orig) setColumn(t, x, h, Math.min(orig, h));
          prev = h;
        }
      }
    });
  }
  function soilTop(t, x, target) {
    let y = columnGround(t, x);
    while (y < t.h) {
      const m = t.front[y * t.w + x];
      if (m === DIRT || m === STONE || m === BEDROCK) return y;
      if (y >= target - TANK_H - 4) return -1;
      while (y < t.h && t.front[y * t.w + x] !== AIR) y++;
      y = columnGround(t, x, y);
    }
    return -1;
  }
  function setColumn(t, x, top, clearFrom) {
    if (clearFrom < top) fillRect(t, x, clearFrom, x, top - 1, AIR, "both");
    const ground = columnGround(t, x, top);
    if (ground > top) fillRect(t, x, top, x, ground - 1, DIRT, "both");
  }
  function placeProp(t, s, mirror, id, tanks) {
    const size = PROP_SIZE[s.kind];
    const w = size.w;
    const h = s.h ?? size.h;
    let x = s.x;
    if (mirror) x = s.kind === "flag" || s.kind === "windsock" ? t.w - 2 - s.x : t.w - s.x - w;
    let y = s.y;
    if (s.kind === "flag" || s.kind === "windsock") y = columnGround(t, x) - h;
    if (s.ground) {
      let top = t.h;
      for (let xx = x; xx < x + w; xx++) top = Math.min(top, columnGround(t, xx));
      if (top >= t.h - BEDROCK_ROWS) return null;
      y = top - h;
    }
    if (s.kind === "barrel" || s.kind === "crate") {
      for (const tx of tanks) if (x + w > tx - TANK_HALF_W - 2 && x < tx + TANK_HALF_W + 2) return null;
      if (!clear(t, x, y, w, h)) return null;
    }
    if (x < 0 || x + w > t.w) return null;
    const lw = s.kind === "flag" || s.kind === "windsock" ? 2 : w;
    for (let yy = Math.max(0, y); yy < Math.min(t.h, y + h); yy++) for (let xx = x; xx < x + lw; xx++) if (LIQUID[t.front[yy * t.w + xx]]) return null;
    return { id, kind: s.kind, x, y, w, h, alive: true };
  }
  function clear(t, x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (t.front[yy * t.w + xx] !== AIR) return false;
    return true;
  }
  function mirrorTerrain(t) {
    for (const g of [t.front, t.back]) {
      for (let y = 0; y < t.h; y++) {
        const row = y * t.w;
        for (let a = 0, b = t.w - 1; a < b; a++, b--) {
          const tmp = g[row + a];
          g[row + a] = g[row + b];
          g[row + b] = tmp;
        }
      }
    }
  }
  const SEG_W = {
    plat: [150, 210],
    valley: [100, 200],
    hill: [170, 240],
    mountain: [300, 400],
    mesa: [200, 240],
    hills: [240, 330],
    abyss: [140, 210],
    lake: [160, 260],
    lavapit: [160, 250]
  };
  const MESA_W = { full: [290, 340], bunker: [270, 300], tower: [200, 240] };
  const SEG_WEIGHT = {
    forest: { valley: 2, hill: 2, mountain: 3, lake: 2.6, hills: 1.2, mesa: 1, plat: 1, abyss: 0.5 },
    jungle: { valley: 1.4, hill: 1.5, mountain: 1.5, lake: 2, hills: 3, mesa: 1, plat: 1, abyss: 2.6 },
    industrial: { valley: 2, hill: 1, mountain: 0.6, lake: 0.3, hills: 1.5, mesa: 1.6, plat: 1.5, abyss: 2, lavapit: 2.6 },
    snow: { valley: 2, hill: 2, mountain: 3, lake: 2.6, hills: 1.2, mesa: 1, plat: 1, abyss: 0.5 }
    // v3 stub: el área sim arma la nieve
  };
  const MIN_TAIL = 200;
  const LAST_MAX = 340;
  const MESA_SLOPE = 37;
  const SPAWN_PIT_GAP = 14;
  const CORNICE_SPAWN_FLAT = 3;
  const BRINK_SCAN = 30;
  const isHole = (k) => k === "abyss" || k === "lake" || k === "lavapit";
  function pick(rng, opts) {
    let total = 0;
    for (const o of opts) total += o[1];
    let r = rng.next() * total;
    for (const o of opts) {
      r -= o[1];
      if (r < 0) return o[0];
    }
    return opts[opts.length - 1][0];
  }
  function clampN(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function planSegments(biome, rng, width) {
    const per = Math.max(1, Math.floor(width / TRAMO_W));
    const segs = [];
    const count = {};
    const full = [];
    let x = 0;
    let lvl = rng.int(326, 340);
    const push = (kind, w, mesa) => {
      const x0 = x;
      const x1 = Math.min(width, x + w);
      const last = x1 >= width;
      const yOut = isHole(kind) || last ? lvl : clampN(lvl + rng.int(-20, 20), 322, 372);
      segs.push({ kind, x0, x1, yIn: lvl, yOut, first: x0 === 0, last, mesa, p: {} });
      count[kind] = (count[kind] ?? 0) + 1;
      if (mesa === "full") full.push((x0 + x1) / 2);
      x = x1;
      lvl = yOut;
    };
    const fullOk = (c) => full.length < per && full.every((f) => Math.abs(f - c) >= TRAMO_W);
    const fullAt = rng.int(240, width - 620);
    push("plat", rng.int(150, 210));
    while (x < width) {
      const rem = width - x;
      const prev = segs[segs.length - 1].kind;
      if (full.length === 0 && x >= fullAt && rem >= MESA_W.full[0] + MIN_TAIL) {
        push("mesa", Math.min(rng.int(MESA_W.full[0], MESA_W.full[1]), rem - MIN_TAIL), "full");
        continue;
      }
      if (full.length === 0 && rem <= 660) {
        push("mesa", rem < MESA_W.full[0] + MIN_TAIL ? rem : Math.min(rng.int(MESA_W.full[0], MESA_W.full[1]), rem - MIN_TAIL), "full");
        continue;
      }
      if (rem <= LAST_MAX) {
        const opts2 = [["plat", 2], ["hill", 1], ["valley", 1]];
        if (rem >= MESA_W.tower[0] && (count.mesa ?? 0) < per + 1) opts2.push(["mesa", 2]);
        const kind2 = pick(rng, opts2.filter((o) => o[0] !== prev || o[0] === "valley"));
        let mesa2;
        if (kind2 === "mesa") mesa2 = rem >= MESA_W.full[0] && fullOk(x + rem / 2) ? "full" : rem >= MESA_W.bunker[0] && rng.chance(0.5) ? "bunker" : "tower";
        push(kind2, rem, mesa2);
        continue;
      }
      const opts = [];
      for (const [k, wgt] of Object.entries(SEG_WEIGHT[biome])) {
        if (k === prev && k !== "valley") continue;
        if (isHole(k) && (isHole(prev) || (count[k] ?? 0) >= per)) continue;
        if (k === "mesa" && (count[k] ?? 0) >= per) continue;
        if (k === "mountain" && (count[k] ?? 0) >= Math.max(1, per - 1)) continue;
        if (k === "plat" && (count.plat ?? 0) > per) continue;
        opts.push([k, wgt]);
      }
      let kind = pick(rng, opts);
      let mesa;
      let [a, b] = SEG_W[kind];
      if (kind === "mesa") {
        mesa = fullOk(x + 160) && (full.length === 0 || rng.chance(0.6)) ? "full" : rng.chance(0.5) ? "bunker" : "tower";
        [a, b] = MESA_W[mesa];
      }
      let w = rng.int(a, b);
      if (rem - w < MIN_TAIL) {
        if (rem - a >= MIN_TAIL) w = rem - MIN_TAIL;
        else {
          kind = "valley";
          mesa = void 0;
          w = Math.min(SEG_W.valley[1], rem - MIN_TAIL);
        }
      }
      push(kind, w, mesa);
    }
    return segs;
  }
  function params(seg, biome, rng) {
    const { x0, x1 } = seg;
    const w = x1 - x0;
    const p = seg.p;
    switch (seg.kind) {
      case "plat":
        p.px0 = seg.first ? 4 : x0 + 6;
        p.px1 = seg.last ? x1 - 5 : x1 - 46;
        break;
      case "valley":
        p.bump = x0 + w * rng.range(0.3, 0.7);
        p.bumpH = rng.int(0, 12);
        break;
      case "hill":
        p.c = x0 + w * rng.range(0.42, 0.58);
        p.kind = rng.int(0, 2);
        p.h = biome === "jungle" ? rng.int(88, 112) : biome === "industrial" ? rng.int(64, 88) : rng.int(78, 98);
        p.w = rng.int(38, 50);
        break;
      case "mountain": {
        p.c1 = x0 + w * rng.range(0.38, 0.62);
        p.top = rng.int(110, 150);
        p.w1 = w * rng.range(0.15, 0.19);
        p.two = rng.chance(biome === "forest" ? 0.55 : 0.45) ? 1 : 0;
        const side = rng.chance(0.5) ? 1 : -1;
        p.c2 = p.c1 + side * w * rng.range(0.2, 0.27);
        p.k2 = rng.range(0.55, 0.85);
        p.w2 = p.w1 * rng.range(0.55, 0.8);
        p.cave = rng.chance(biome === "forest" ? 0.6 : 0.45) ? 1 : 0;
        p.rocks = rng.int(3, 6);
        break;
      }
      case "mesa": {
        const tx0 = seg.first ? x0 : x0 + MESA_SLOPE;
        const tx1 = seg.last ? x1 - 1 : x1 - 1 - MESA_SLOPE;
        p.tx0 = tx0;
        p.tx1 = tx1;
        p.py = clampN(Math.min(seg.yIn, seg.yOut) - rng.int(28, 50), 282, 330);
        if (seg.mesa === "full") {
          p.bx = tx0 + rng.int(40, 52);
          p.towerX = Math.min(tx1 - 66, p.bx + rng.int(58, 76));
        } else if (seg.mesa === "bunker") {
          p.bx = tx0 + rng.int(40, Math.max(40, tx1 - tx0 - 160));
        } else {
          p.towerX = tx0 + rng.int(46, Math.max(46, tx1 - tx0 - 70));
        }
        break;
      }
      case "hills": {
        const n = w > 290 ? 3 : 2;
        p.n = n;
        for (let i = 0; i < n; i++) {
          p["c" + i] = x0 + w * ((i + 0.5) / n) + rng.int(-12, 12);
          p["h" + i] = rng.int(24, 54);
          p["w" + i] = rng.int(26, 38);
        }
        break;
      }
      case "abyss": {
        const pit = clampN(w - 2 * rng.int(30, 42), 60, 130);
        p.a = x0 + Math.floor((w - pit) / 2) + rng.int(-6, 6);
        p.b = p.a + pit - 1;
        p.seed = rng.int(1, 1e5);
        ledgeParams(seg, biome);
        break;
      }
      case "lake":
      case "lavapit": {
        const bw = clampN(w - 2 * rng.int(28, 40), 100, 200);
        p.b0 = x0 + Math.floor((w - bw) / 2);
        p.b1 = p.b0 + bw;
        p.depth = rng.int(30, 60);
        break;
      }
    }
  }
  const CORNICE_LEN = [30, 56];
  const CORNICE_CRUST = [6, 9];
  const CORNICE_ARCH = 28;
  const CORNICE_SPILL = 16;
  const LIP_UNDERCUT = 18;
  const LIP_CRUST = 20;
  function ledgeParams(seg, biome) {
    const { p, x0, x1 } = seg;
    const roll2 = (k) => hash2(p.seed, k, 20973);
    const r = roll2(1);
    const left = r >= 0.2 && (r < 0.45 || r >= 0.7);
    const right = r >= 0.45;
    const len = (k, room) => Math.max(0, Math.min(Math.round(CORNICE_LEN[0] + roll2(k) * (CORNICE_LEN[1] - CORNICE_LEN[0])), room + CORNICE_SPILL - 9));
    p.cornL = left ? len(2, p.a - x0) : 0;
    p.cornR = right ? len(3, x1 - 1 - p.b) : 0;
    if (p.cornL < 16) p.cornL = 0;
    if (p.cornR < 16) p.cornR = 0;
    p.crust = Math.round(CORNICE_CRUST[0] + roll2(4) * (CORNICE_CRUST[1] - CORNICE_CRUST[0]));
    p.lipL = p.cornL ? 0 : Math.min(LIP_UNDERCUT, Math.max(0, p.a - x0 - 9));
    p.lipR = p.cornR ? 0 : Math.min(LIP_UNDERCUT, Math.max(0, x1 - 1 - p.b - 9));
    p.bridge = roll2(5) < (biome === "jungle" ? 0.4 : 0.25) ? 1 : 0;
    p.bridgeT = biome === "industrial" ? 4 : biome === "jungle" ? 6 : 7;
  }
  function smooth01(u) {
    const v = clampN(u, 0, 1);
    return v * v * (3 - 2 * v);
  }
  const gauss = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
  function segSurface(seg, biome, x, noiseSeed) {
    const { x0, x1, yIn, yOut, p } = seg;
    const w = x1 - x0;
    const u = w > 1 ? (x - x0) / (w - 1) : 0;
    const base = yIn + (yOut - yIn) * smooth01(u);
    const taper = smooth01(Math.min(x - x0, x1 - 1 - x) / 30);
    const rough = biome === "jungle" ? 22 : 15;
    const noise = ((noise1(x, 70, noiseSeed) - 0.5) * rough + (noise1(x, 17, noiseSeed + 1) - 0.5) * 5) * taper;
    switch (seg.kind) {
      case "plat": {
        if (x <= p.px1 + 4 || seg.last) return yIn;
        const f = (x - p.px1 - 4) / Math.max(1, x1 - 1 - p.px1 - 4);
        return yIn + (yOut - yIn) * smooth01(f) + noise * 0.3 * Math.sin(Math.PI * f);
      }
      case "valley":
        return base + noise - p.bumpH * gauss(x, p.bump, 25);
      case "hill": {
        const big = smooth01(Math.min(x - x0, x1 - 1 - x) / 45);
        return base + noise - hillShape(x, p.c, p.h, p.w, p.kind) * big;
      }
      case "mountain": {
        const big = smooth01(Math.min(x - x0, x1 - 1 - x) / (w * 0.22));
        const h1 = yIn + (yOut - yIn) * smooth01((p.c1 - x0) / (w - 1)) - p.top;
        let m = h1 * gauss(x, p.c1, p.w1);
        if (p.two) m = Math.max(m, h1 * p.k2 * gauss(x, p.c2, p.w2));
        m += 18 * gauss(x, p.c1 - (p.c2 - p.c1) * 0.9, p.w1 * 0.8);
        return base + noise - m * big;
      }
      case "mesa": {
        const ny = noise * 0.6;
        if (x < p.tx0) return yIn + ny + (p.py - yIn - ny) * smooth01((x - x0) / Math.max(1, p.tx0 - x0));
        if (x > p.tx1) return p.py + (yOut + ny - p.py) * smooth01((x - p.tx1) / Math.max(1, x1 - 1 - p.tx1));
        return p.py;
      }
      case "hills": {
        const big = smooth01(Math.min(x - x0, x1 - 1 - x) / 40);
        let m = 0;
        for (let i = 0; i < p.n; i++) m = Math.max(m, p["h" + i] * gauss(x, p["c" + i], p["w" + i]));
        return base + noise * 0.8 - m * big;
      }
      case "abyss":
        return base + noise * 0.3;
      case "lake":
      case "lavapit": {
        let y = base + noise * 0.25;
        if (x >= p.b0 && x < p.b1) {
          const half = (p.b1 - p.b0) / 2;
          const v = Math.abs(x + 0.5 - (p.b0 + half)) / half;
          y += p.depth * (1 - v * v * v);
        }
        return y;
      }
    }
  }
  function hillShape(x, c, h, w, kind) {
    if (kind === 1) return h * Math.max(gauss(x, c - 20, w * 0.7), 0.85 * gauss(x, c + 24, w * 0.6));
    if (kind === 2) return h * 0.95 * gauss(x, c, w * 1.1) + 14 * gauss(x, c + w, 14);
    return h * gauss(x, c, w) + 12 * gauss(x, c - 32, 12);
  }
  function chain(biome, rng, count, width, height, safeCount = 0) {
    const segs = planSegments(biome, rng, width);
    for (const seg of segs) params(seg, biome, rng);
    const noiseSeed = rng.int(1, 1e5);
    const t = createTerrain(width, height);
    const surf = new Array(width);
    for (const seg of segs) {
      for (let x = seg.x0; x < seg.x1; x++) surf[x] = Math.round(clampN(segSurface(seg, biome, x, noiseSeed), 100, height - 40));
    }
    for (let x = 0; x < width; x++) fillRect(t, x, surf[x], x, height - 1, DIRT);
    const b = { t, biome, rng, surf, specs: [], slots: [], socks: [], pits: new Uint8Array(width), bowls: [], mouth: new Uint8Array(width), ledges: [], brinks: [] };
    for (const seg of segs) solids(b, seg);
    t.back.set(t.front);
    for (const seg of segs) carve(b, seg);
    for (const seg of segs) front(b, seg);
    for (let x = 0; x < width; x++) if (!b.pits[x]) fillRect(t, x, height - BEDROCK_ROWS, x, height - 1, BEDROCK, "both");
    t.pits = b.pits;
    const basins = [];
    for (const bw of b.bowls) {
      const level = Math.max(columnGround(t, bw.b0 - 1), columnGround(t, bw.b1));
      let x0 = bw.b0;
      let x1 = bw.b1;
      while (x0 < x1 && columnGround(t, x0) <= level) x0++;
      while (x1 > x0 && columnGround(t, x1 - 1) <= level) x1--;
      if (x1 - x0 >= 20) basins.push({ kind: bw.kind, x0, x1, level });
    }
    const ok = (x) => spawnOk(t, b.mouth, x, basins, surf);
    const slots = b.slots.map((x) => Math.round(x)).filter((x) => x >= 40 && x <= width - 40 && ok(x));
    const brinks = /* @__PURE__ */ new Set();
    for (const q of b.brinks) {
      for (let k = 0; k <= BRINK_SCAN; k += 2) {
        const x = q.x + q.dir * k;
        if (x < 40 || x > width - 40 || !ok(x)) continue;
        brinks.add(x);
        slots.push(x);
        break;
      }
    }
    const safe = (x) => humanSafe(t, x);
    const spawnXs = spreadSpawns(t, slots, rng, count, ok, (x) => spawnOk(t, b.mouth, x, basins, null), brinks, safeCount, safe);
    const safeFlags = spawnXs.map(safe);
    spawnStats.brinks[0] += b.brinks.length;
    spawnStats.brinks[1] += brinks.size;
    spawnStats.brinks[2] += spawnXs.filter((x) => brinks.has(x)).length;
    const targets = spawnXs.map((x) => flatten(t, x));
    ramps(t, spawnXs, targets, { stop: (x) => nearCols(b.mouth, x, 3) || basins.some((q) => x >= q.x0 - 2 && x < q.x1 + 2), long: true });
    fillBasins(t, basins);
    for (let w0 = 0; w0 < width; w0 += TRAMO_W) {
      const opts = b.socks.filter((x) => x >= w0 && x < w0 + TRAMO_W && x > 4 && x < width - 6);
      if (opts.length > 0) b.specs.push({ kind: "windsock", x: Math.round(opts[rng.int(0, opts.length - 1)]), y: 0 });
    }
    const mirror = rng.chance(0.5);
    if (mirror) {
      mirrorTerrain(t);
      t.pits.reverse();
      b.mouth.reverse();
    }
    const flipX = (x0, x1) => mirror ? [width - x1, width - x0] : [x0, x1];
    const spawns = spawnXs.map((x) => mirror ? width - x : x);
    const props = [];
    for (const s of b.specs) {
      const p = placeProp(t, s, mirror, props.length, spawns);
      if (p) props.push(p);
    }
    return {
      terrain: t,
      props,
      spawns,
      safe: safeFlags,
      basins: basins.map((q) => {
        const [x0, x1] = flipX(q.x0, q.x1);
        return { ...q, x0, x1 };
      }),
      mouth: b.mouth,
      ledges: b.ledges.map((l) => {
        const [x0, x1] = flipX(l.x0, l.x1);
        return { ...l, x0, x1 };
      }),
      segments: segs.map((s) => {
        const [x0, x1] = flipX(s.x0, s.x1);
        const seg = { kind: s.kind, x0, x1 };
        if (s.p.bx !== void 0) seg.bunker = true;
        if (s.p.towerX !== void 0) seg.tower = true;
        return seg;
      })
    };
  }
  function fillBasins(t, basins) {
    if (basins.length === 0) return;
    let x0 = t.w;
    let x1 = -1;
    let y0 = t.h;
    for (const q of basins) {
      const m = q.kind === "lava" ? LAVA : WATER;
      const stack2 = [];
      for (let x = q.x0; x < q.x1; x++) {
        const i = Math.max(0, q.level) * t.w + x;
        if (t.front[i] === AIR) {
          t.front[i] = m;
          stack2.push(i);
        }
      }
      while (stack2.length > 0) {
        const i = stack2.pop();
        const x = i % t.w;
        const y = (i - x) / t.w;
        for (let d = 0; d < 4; d++) {
          const xx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
          const yy = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
          if (xx < q.x0 || xx >= q.x1 || yy < q.level || yy >= t.h) continue;
          const j = yy * t.w + xx;
          if (t.front[j] !== AIR) continue;
          t.front[j] = m;
          stack2.push(j);
        }
      }
      x0 = Math.min(x0, q.x0);
      x1 = Math.max(x1, q.x1 - 1);
      y0 = Math.min(y0, q.level);
    }
    flowLiquids(t, { seed: { x0, y0, x1, y1: t.h - 1 }, record: false });
  }
  function nearCols(cols, x, d) {
    for (let i = Math.max(0, x - d); i <= Math.min(cols.length - 1, x + d); i++) if (cols[i]) return true;
    return false;
  }
  function nearPit(t, x, d) {
    const pits = t.pits;
    if (!pits) return false;
    for (let i = Math.max(0, x - d); i <= Math.min(t.w - 1, x + d); i++) if (pits[i]) return true;
    return false;
  }
  function spawnOk(t, mouth, x, basins, strict) {
    if (mouth ? nearCols(mouth, x, TANK_HALF_W + SPAWN_PIT_GAP + 1) : nearPit(t, x, TANK_HALF_W + SPAWN_PIT_GAP + 1)) return false;
    if (nearPit(t, x, TANK_HALF_W + 5)) {
      const [x0, x1] = padBounds(x);
      let lo2 = Infinity;
      let hi2 = -Infinity;
      for (let i = x0 - 1; i <= x1 + 1; i++) {
        const g = columnGround(t, i);
        lo2 = Math.min(lo2, g);
        hi2 = Math.max(hi2, g);
      }
      if (hi2 >= t.h || hi2 - lo2 > CORNICE_SPAWN_FLAT) return false;
    }
    for (const q of basins) if (x + TANK_HALF_W + 20 > q.x0 && x - TANK_HALF_W - 20 < q.x1) return false;
    if (!strict) return columnGround(t, x) < t.h - BEDROCK_ROWS - 4;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = x - 24; i <= x + 24; i++) {
      const g = columnGround(t, i);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    if (hi - lo > 26) return false;
    return openGround(t, x, strict);
  }
  function solids(b, seg) {
    const { t, biome, rng, surf, specs } = b;
    const { x0, x1, p } = seg;
    const mid = Math.round((x0 + x1) / 2);
    switch (seg.kind) {
      case "plat": {
        const y = seg.yIn;
        const a = p.px0;
        const z = p.px1;
        if (biome === "forest") {
          stoneSlab(t, a + (seg.first ? 10 : 0), y, z, y + 13);
          if (seg.first) stoneSlab(t, a, y, a + 10, y + 7);
          const s0 = rng.int(a + 20, Math.max(a + 20, z - 60));
          stoneSlab(t, s0, y + 14, s0 + 46, y + 20);
        } else if (biome === "jungle") {
          for (let x = a + (seg.first ? 10 : 0); x < z - 4; ) {
            const w = rng.int(14, 30);
            if (rng.chance(0.75)) stoneSlab(t, x, y, Math.min(z, x + w - 1), y + rng.int(5, 9));
            x += w + rng.int(0, 3);
          }
          if (seg.first) {
            stoneSlab(t, a, y - 26, a + 7, y - 1);
            stoneSlab(t, a - 2, y - 30, a + 11, y - 27);
          }
          const s0 = rng.int(a + 20, Math.max(a + 20, z - 40));
          stoneSlab(t, s0, y + 30, s0 + 22, y + 36);
        } else {
          fillRect(t, a, y, z, y + 16, BRICK);
          fillRect(t, a, y, z, y + 2, METAL);
        }
        specs.push({ kind: "flag", x: seg.first ? 20 : a + 8, y });
        specs.push({ kind: "barrel", x: z - 16, y: y - 12, ground: true });
        const lo = seg.first ? 60 : a + 40;
        const hi = z - 40;
        b.slots.push(hi > lo ? rng.int(lo, hi) : Math.round((a + z) / 2));
        b.socks.push(z - 30);
        break;
      }
      case "valley": {
        b.slots.push(mid + rng.int(-10, 10));
        if (biome !== "industrial") {
          if (rng.chance(0.5)) {
            const sx = rng.int(x0 + 10, Math.max(x0 + 10, x1 - 40));
            stoneSlab(t, sx, surf[sx] + 10, sx + rng.int(16, 26), surf[sx] + 16);
          }
        }
        b.socks.push(x0 + 24);
        break;
      }
      case "hill": {
        const c = Math.round(p.c + (p.kind === 1 ? -20 : 0));
        b.slots.push(c);
        if (biome !== "industrial" || rng.chance(0.4)) {
          const hs = surf[c];
          stoneSlab(t, c - 12, hs + 20, c + 6, hs + 26);
        }
        b.socks.push(x0 + 26);
        break;
      }
      case "mountain": {
        for (let i = 0; i < p.rocks; i++) {
          const rx = rng.int(x0 + 30, x1 - 50);
          const rw = rng.int(14, 26);
          const rh = rng.int(5, 7);
          let lo = 0;
          for (let x = rx; x <= rx + rw; x++) lo = Math.max(lo, surf[x]);
          const steep = Math.abs(surf[rx + rw] - surf[rx]) >= rw * 0.6 && Math.min(surf[rx], surf[rx + rw]) <= Math.min(...surf.slice(rx, rx + rw + 1));
          const ry = rng.chance(0.5) && steep ? lo - rh + rng.int(1, 3) : surf[rx] + rng.int(8, 26);
          stoneSlab(t, rx, ry, rx + rw, ry + rh);
        }
        break;
      }
      case "mesa": {
        const { tx0, tx1, py } = p;
        if (biome === "forest") stoneSlab(t, tx0, py, tx1, py + 7);
        else if (biome === "jungle") {
          for (let x = tx0; x < tx1; x += 24) if (rng.chance(0.6)) stoneSlab(t, x, py, Math.min(tx1, x + 21), py + 5);
        } else {
          fillRect(t, tx0, py, tx1, py + 3, METAL);
          fillRect(t, tx0, py + 4, tx1, py + 7, BRICK);
        }
        if (p.bx !== void 0) {
          const wall = biome === "jungle" ? STONE : BRICK;
          const floor = biome === "industrial" ? METAL : STONE;
          fillRect(t, p.bx, py + 8, p.bx + 150, py + 68, wall);
          fillRect(t, p.bx, py + 57, p.bx + 150, py + 64, floor);
        }
        const before = Math.min(p.bx ?? Infinity, (p.towerX ?? Infinity) - 12);
        const slot = Math.min(tx0 + 28, before - 20);
        if (slot - 20 >= tx0 - (seg.first ? 0 : 10)) b.slots.push(slot);
        if (p.towerX !== void 0 && tx1 - (p.towerX + 64) > 46) b.slots.push(p.towerX + 64 + 24);
        break;
      }
      case "hills": {
        for (let i = 0; i < p.n; i++) b.slots.push(Math.round(p["c" + i]));
        for (let i = 0; i + 1 < p.n; i++) {
          const rx = Math.round((p["c" + i] + p["c" + (i + 1)]) / 2) + rng.int(-6, 6);
          ruin(b, rx);
        }
        if (p.n === 2 || rng.chance(0.5)) ruin(b, Math.round(p.c0) - rng.int(30, 40));
        b.socks.push(Math.round((p.c0 + p.c1) / 2) + 14);
        break;
      }
      case "abyss":
        break;
      case "lake":
      case "lavapit": {
        const lava = seg.kind === "lavapit";
        b.bowls.push({ kind: lava ? "lava" : "water", b0: p.b0, b1: p.b1 });
        if (lava) {
          const lining = biome === "industrial" ? BRICK : STONE;
          for (let x = p.b0 - 2; x < p.b1 + 2; x++) fillRect(t, x, surf[x], x, surf[x] + 3, lining);
          if (biome === "industrial") {
            fillRect(t, p.b0 - 10, surf[p.b0 - 10], p.b0 - 2, surf[p.b0 - 10] + 2, METAL);
            fillRect(t, p.b1 + 1, surf[p.b1 + 1], p.b1 + 9, surf[p.b1 + 1] + 2, METAL);
            specs.push({ kind: "barrel", x: p.b0 - 24, y: 0, ground: true });
            if (rng.chance(0.6)) specs.push({ kind: "barrel", x: p.b1 + 12, y: 0, ground: true });
          }
        } else if (biome === "forest") {
          for (let i = 0; i < 3; i++) {
            const sx = rng.int(p.b0 + 10, p.b1 - 24);
            stoneSlab(t, sx, surf[sx] + 1, sx + rng.int(8, 16), surf[sx] + 4);
          }
        }
        break;
      }
    }
  }
  function ruin(b, x) {
    const { t, biome, rng, surf } = b;
    const w = biome === "jungle" ? 34 : rng.int(16, 26);
    let g = t.h;
    for (let i = x; i <= x + w; i++) g = Math.min(g, surf[i]);
    for (let i = x; i <= x + w; i++) fillRect(t, i, g, i, surf[i] + 2, biome === "industrial" ? BRICK : STONE);
    if (biome === "jungle") {
      const h = rng.int(22, 30);
      stoneSlab(t, x, g - h, x + 7, g - 1);
      if (rng.chance(0.7)) stoneSlab(t, x + w - 7, g - h + rng.int(0, 8), x + w, g - 1);
      if (rng.chance(0.6)) stoneSlab(t, x - 2, g - h - 4, x + w + 2 - rng.int(0, 14), g - h - 1);
    } else if (biome === "forest") {
      let top = g;
      for (let k = rng.int(2, 3); k > 0; k--) {
        const a = x + rng.int(0, 6);
        stoneSlab(t, a, top - 6, a + w - rng.int(4, 10), top - 1);
        top -= 6;
      }
    } else {
      const h = rng.int(18, 30);
      fillRect(t, x, g - h, x + 6, g - 1, BRICK);
      fillRect(t, x + 7, g - h + 8, x + w, g - 1, BRICK);
      fillRect(t, x - 2, g - h - 2, x + 8, g - h - 1, METAL);
    }
  }
  function carve(b, seg) {
    const { t, biome, rng, surf, specs } = b;
    const { x0, x1, p } = seg;
    switch (seg.kind) {
      case "mesa":
        if (p.bx !== void 0) {
          const { bx, py } = p;
          const wall = biome === "jungle" ? STONE : BRICK;
          fillRect(t, bx + 10, py + 18, bx + 140, py + 56, AIR);
          fillRect(t, bx + 22, py, bx + 29, py + 17, AIR);
          fillRect(t, bx + 22, py, bx + 29, py + 17, wall, "back");
          specs.push({ kind: "ladder", x: bx + 22, y: py - 2, h: py + 57 - (py - 2) });
          specs.push({ kind: "lamp", x: bx + 58 + rng.int(-8, 8), y: py + 18 });
          const cx = bx + 98 + rng.int(-12, 0);
          specs.push({ kind: "crate", x: cx, y: py + 45 });
          specs.push({ kind: "crate", x: cx + 12, y: py + 45 });
          if (rng.chance(0.7)) specs.push({ kind: "crate", x: cx + 6, y: py + 33 });
          specs.push({ kind: "barrel", x: bx + 124 + rng.int(-2, 4), y: py + 45 });
        }
        break;
      case "mountain":
        if (p.cave) {
          const cx = Math.round(p.c1 + rng.int(-20, 20));
          const hw = rng.int(28, 46);
          const hh = rng.int(10, 14);
          let deepest = 0;
          for (let x = cx - hw - 8; x <= cx + hw + 8; x++) deepest = Math.max(deepest, surf[x]);
          const cy = Math.min(t.h - BEDROCK_ROWS - hh - 12, Math.max(rng.int(300, 340), deepest + hh + 18));
          if (cy - hh - 4 > deepest + 12) blob(t, cx, cy, hw, hh, rng.int(1, 99));
        }
        break;
      case "valley":
      case "hill":
      case "hills":
        bigCraters(b, x0 + 20, x1 - 20, rng.int(0, 2));
        if (seg.kind === "hill" && rng.chance(0.35)) {
          const cx = Math.round(p.c);
          blob(t, cx, Math.max(surf[cx] + 40, rng.int(380, 400)), rng.int(26, 40), rng.int(8, 11), rng.int(1, 99));
        }
        break;
      case "abyss": {
        const { a, b: z, seed } = p;
        const wob = (y, s) => Math.round((noise1(y, 19, seed + s) - 0.5) * 12 + (noise1(y, 5, seed + s + 7) - 0.5) * 4);
        const yb = t.h - 12;
        const lip = Math.min(surf[a - 12], surf[z + 12]);
        const { cornL, cornR, crust } = p;
        const uL = cornL || p.lipL;
        const uR = cornR || p.lipR;
        const cL = cornL ? crust : LIP_CRUST;
        const cR = cornR ? crust : LIP_CRUST;
        const under = (x, c, f) => surf[x] + c + Math.round(CORNICE_ARCH * f * f);
        for (let y = 0; y < t.h; y++) {
          const yy = Math.min(y, yb);
          const xl = a + wob(yy, 0);
          const xr = z + wob(yy, 3);
          for (let x = xl - uL; x <= xr + uR; x++) {
            if (x < xl && y <= under(x, cL, (xl - x) / uL)) continue;
            if (x > xr && y <= under(x, cR, (x - xr) / uR)) continue;
            const i = y * t.w + x;
            t.front[i] = AIR;
            if (t.back[i] === AIR && y >= lip - 4 - Math.round(noise1(x, 9, seed + 11) * 8)) t.back[i] = DIRT;
          }
        }
        const pa = a + wob(yb, 0) - uL;
        const pz = z + wob(yb, 3) + uR;
        for (let x = pa; x <= pz; x++) b.pits[x] = 1;
        const ma = uL ? a + wob(Math.min(surf[a], yb), 0) : pa;
        const mz = uR ? z + wob(Math.min(surf[z], yb), 3) : pz;
        for (let x = ma; x <= mz; x++) b.mouth[x] = 1;
        b.brinks.push({ x: ma - SPAWN_PIT_GAP - TANK_HALF_W - 2, dir: -1 }, { x: mz + SPAWN_PIT_GAP + TANK_HALF_W + 2, dir: 1 });
        if (cornL) b.ledges.push({ kind: "cornice", x0: pa, x1: ma, thick: crust });
        if (cornR) b.ledges.push({ kind: "cornice", x0: mz + 1, x1: pz + 1, thick: crust });
        if (p.bridge) b.ledges.push({ kind: "bridge", x0: ma, x1: mz + 1, thick: p.bridgeT });
        break;
      }
    }
  }
  function blob(t, cx, cy, halfW, halfH, seed) {
    for (let y = cy - halfH - 2; y <= cy + halfH + 2; y++) {
      for (let x = cx - halfW - 4; x <= cx + halfW + 4; x++) {
        if (x < 0 || x >= t.w || y < 0 || y >= t.h - BEDROCK_ROWS - 2) continue;
        const wob = Math.sin(y / 5 + seed) * 4;
        const ny = (y - cy) / halfH;
        const nx = (x - cx - wob) / halfW;
        const r = 1 - Math.abs(ny) * 0.55 + (hash2(x, y, seed) - 0.5) * 0.12;
        if (Math.abs(ny) < 1 && Math.abs(nx) < r) {
          const i = y * t.w + x;
          if (t.front[i] === DIRT || t.front[i] === STONE) {
            t.front[i] = AIR;
            if (t.back[i] === AIR) t.back[i] = DIRT;
          }
        }
      }
    }
  }
  function bigCraters(b, xa, xb, n) {
    const { t, rng, surf } = b;
    if (xb - xa < 30) return;
    for (let k = 0; k < n; k++) {
      const x = rng.int(xa, xb);
      const r = rng.int(7, 10);
      const cy = surf[x] + rng.int(-2, 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let xx = Math.max(0, x - r - 2); xx <= Math.min(t.w - 1, x + r + 2); xx++) {
        lo = Math.min(lo, surf[xx]);
        hi = Math.max(hi, surf[xx]);
      }
      if (hi - lo > 4) continue;
      for (let y = cy - r - 2; y <= cy + r + 2; y++) {
        for (let xx = x - r - 2; xx <= x + r + 2; xx++) {
          if (xx < 0 || xx >= t.w || y < 0 || y >= t.h) continue;
          const d = Math.hypot(xx - x, (y - cy) * 1.1) + (hash2(xx, y, 5) - 0.5) * 2.2;
          const i = y * t.w + xx;
          if (d < r && t.front[i] === DIRT) {
            t.front[i] = AIR;
            if (t.back[i] === AIR && y >= surf[xx]) t.back[i] = DIRT;
          }
        }
      }
    }
  }
  function front(b, seg) {
    const { t, biome, rng, surf, specs } = b;
    const { x0, x1, p } = seg;
    switch (seg.kind) {
      case "mesa": {
        const { py } = p;
        if (p.towerX !== void 0) tower(t, { towerX: p.towerX, py }, biome === "industrial" ? METAL : SLAT, specs);
        if (p.bx !== void 0) specs.push({ kind: biome === "jungle" ? "crate" : "barrel", x: p.bx + 35, y: py - 12, ground: true });
        if (p.towerX !== void 0) specs.push({ kind: biome === "jungle" ? "barrel" : "crate", x: p.towerX + 64, y: py - 12, ground: true });
        break;
      }
      case "valley":
        if (biome === "industrial") {
          if (rng.chance(0.55) && x1 - x0 >= 80) shed(b, Math.round((x0 + x1) / 2) - 17 + rng.int(-6, 6));
          else beamDeck(b, Math.round((x0 + x1) / 2) + rng.int(-10, 10));
        }
        break;
      case "abyss": {
        const { a, b: z } = p;
        if (biome === "industrial") {
          const gl = surf[a - 8];
          const gr = surf[z + 8];
          const top = Math.min(gl, gr) - rng.int(40, 50);
          fillRect(t, a - 9, top, a - 7, gl - 1, POST, "back");
          fillRect(t, z + 6, top, z + 8, gr - 1, POST, "back");
          fillRect(t, a - 13, top - 4, z + 12, top - 1, BEAM);
          specs.push({ kind: "lamp", x: Math.round((a + z) / 2) - 2, y: top });
          const ly = Math.min(t.h - 20, gl + 24);
          let lx = a - 12;
          while (lx < z && t.front[ly * t.w + lx] !== AIR) lx++;
          specs.push({ kind: "ladder", x: lx, y: gl - 2, h: rng.int(50, 80) });
        } else if (biome === "jungle" && rng.chance(0.5)) {
          stoneSlab(t, a - 16, surf[a - 16] - 6, a - 2, surf[a - 16] - 1);
          stoneSlab(t, z + 2, surf[z + 16] - 6, z + 16, surf[z + 16] - 1);
        }
        if (p.bridge) {
          const xa = a - 10;
          const xz = z + 10;
          const ya = surf[xa];
          const yz = surf[xz];
          const m = biome === "industrial" ? BEAM : biome === "jungle" ? STONE : DIRT;
          for (let x = xa; x <= xz; x++) {
            const y0 = Math.round(ya + (yz - ya) * (x - xa) / (xz - xa));
            for (let y = y0; y < y0 + p.bridgeT; y++) {
              const i = y * t.w + x;
              if (t.front[i] === AIR) t.front[i] = m;
            }
          }
        }
        break;
      }
    }
  }
  function shed(b, sx) {
    const { t, surf, specs } = b;
    let g = t.h;
    for (let x = sx; x <= sx + 34; x++) g = Math.min(g, surf[x]);
    for (let x = sx; x <= sx + 34; x++) fillRect(t, x, g, x, surf[x], BRICK, "both");
    fillRect(t, sx, g - 30, sx + 34, g - 1, BRICK);
    fillRect(t, sx - 3, g - 33, sx + 37, g - 31, METAL);
    fillRect(t, sx + 4, g - 26, sx + 30, g - 1, AIR);
    fillRect(t, sx + 4, g - 26, sx + 30, g - 1, BRICK, "back");
    fillRect(t, sx, g - 18, sx + 3, g - 1, AIR);
    fillRect(t, sx, g - 18, sx + 3, g - 1, BRICK, "back");
    specs.push({ kind: "barrel", x: sx + 18, y: g - 12 });
  }
  function beamDeck(b, cx) {
    const { t, rng, surf, specs } = b;
    const cy = surf[cx] - rng.int(58, 70);
    fillRect(t, cx - 20, cy, cx + 20, cy + 3, BEAM);
    for (const px of [cx - 18, cx + 15]) {
      const gy = columnGround(t, px, cy + 4);
      fillRect(t, px, cy + 4, px + 2, gy - 1, POST);
    }
    specs.push({ kind: "barrel", x: cx - 5, y: cy - 12 });
  }
  const COLLAPSE_BUDGET = 4e3;
  const COLLAPSE_MAX_SPEED = 4;
  const COLLAPSE_FRAME_ITERS = 2;
  const COLLAPSE_MAX_ITERS = 240;
  const COLLAPSE_EXTRA_ITERS = 2e3;
  let seen = new Uint32Array(0);
  let comp = new Int32Array(0);
  let falling = new Uint32Array(0);
  let touchedAt = new Uint32Array(0);
  let gen = 0;
  let stack = new Int32Array(4096);
  function ensure(n) {
    if (seen.length >= n) return;
    seen = new Uint32Array(n);
    comp = new Int32Array(n);
    falling = new Uint32Array(n);
    touchedAt = new Uint32Array(n);
    gen = 0;
  }
  function nextGen() {
    gen++;
    if (gen === 4294967295) {
      seen.fill(0);
      falling.fill(0);
      touchedAt.fill(0);
      gen = 1;
    }
    return gen;
  }
  const ANCHOR = new Uint8Array(256);
  for (let m = 1; m < 256; m++) if (SOLID[m] && m !== DIRT && m !== STONE) ANCHOR[m] = 1;
  const collapseStats = { calls: 0, collapses: 0, ms: 0, worst: 0, cells: 0 };
  function collapseTerrain(t, opts) {
    const report = { changed: false, cells: 0, lost: 0, stone: 0, iters: 0, patches: [], landed: [], touched: null };
    const seed = opts.seed;
    if (!seed) return report;
    const { w, h, front: front2 } = t;
    const pits = t.pits;
    ensure(w * h);
    const call = nextGen();
    const loose = [];
    const anchored = [];
    const x0 = Math.max(0, seed.x0 - 1);
    const x1 = Math.min(w - 1, seed.x1 + 1);
    const y0 = Math.max(0, seed.y0 - 1);
    const y1 = Math.min(h - 1, seed.y1 + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const m = front2[i];
        if (m !== DIRT && m !== STONE || seen[i] === call) continue;
        const id = anchored.length;
        const cells = flood(i, id);
        anchored.push(cells === null);
        if (cells) for (const c of cells) loose.push(c);
      }
    }
    if (loose.length === 0) return report;
    function flood(start, id) {
      const cells = [];
      let sp = 0;
      stack[sp++] = start;
      seen[start] = call;
      comp[start] = id;
      let ok = false;
      let old = false;
      while (sp > 0) {
        const i = stack[--sp];
        cells.push(i);
        const x = i % w;
        const y = (i - x) / w;
        const floats = front2[i] === STONE && y < h - 1 && LIQUID[front2[i + w]] === 1;
        if (old || floats || ANCHOR[front2[i]] || y === h - 1 && !(pits && pits[x]) || cells.length > COLLAPSE_BUDGET) {
          ok = true;
          break;
        }
        if (x > 0) {
          push(i - 1);
          if (y > 0) push(i - w - 1);
          if (y < h - 1) push(i + w - 1);
        }
        if (x < w - 1) {
          push(i + 1);
          if (y > 0) push(i - w + 1);
          if (y < h - 1) push(i + w + 1);
        }
        if (y > 0) push(i - w);
        if (y < h - 1) push(i + w);
      }
      return ok ? null : cells;
      function push(j) {
        if (!SOLID[front2[j]]) return;
        if (seen[j] === call) {
          if (comp[j] !== id) old = true;
          return;
        }
        seen[j] = call;
        comp[j] = id;
        if (sp >= stack.length) {
          const b = new Int32Array(stack.length * 2);
          b.set(stack);
          stack = b;
        }
        stack[sp++] = j;
      }
    }
    loose.sort((a, b) => {
      const ya = a / w | 0;
      const yb = b / w | 0;
      return yb - ya || a - b;
    });
    const n = loose.length;
    const pos = Int32Array.from(loose);
    const startY = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      startY[k] = pos[k] / w | 0;
      falling[pos[k]] = call;
    }
    report.cells = n;
    const band = opts.band ?? Infinity;
    const origIdx = [];
    const origVal = [];
    let wx0 = w;
    let wy0 = h;
    let wx1 = -1;
    let wy1 = -1;
    let tx0 = w;
    let ty0 = h;
    let tx1 = -1;
    let ty1 = -1;
    const set = (i, m) => {
      if (touchedAt[i] !== call) {
        touchedAt[i] = call;
        origIdx.push(i);
        origVal.push(front2[i]);
      }
      front2[i] = m;
      const x = i % w;
      const y = (i - x) / w;
      if (x < wx0) wx0 = x;
      if (x > wx1) wx1 = x;
      if (y < wy0) wy0 = y;
      if (y > wy1) wy1 = y;
    };
    const flush = () => {
      if (wx1 < 0) return;
      if (wx0 < tx0) tx0 = wx0;
      if (wx1 > tx1) tx1 = wx1;
      if (wy0 < ty0) ty0 = wy0;
      if (wy1 > ty1) ty1 = wy1;
      if (opts.record) report.patches.push(patchOf(t, wx0, wy0, wx1, wy1));
      wx0 = w;
      wy0 = h;
      wx1 = wy1 = -1;
    };
    const land = (k) => {
      const i = pos[k];
      falling[i] = 0;
      pos[k] = -1;
      const drop = (i / w | 0) - startY[k];
      if (drop > 0) report.landed.push({ i, drop });
    };
    let active = n;
    let iter = 0;
    const limit = COLLAPSE_MAX_ITERS + COLLAPSE_EXTRA_ITERS;
    while (active > 0 && iter < limit) {
      iter++;
      const speed = Math.min(COLLAPSE_MAX_SPEED, 1 + (iter - 1 >> 2));
      for (let k = 0; k < n; k++) {
        let i = pos[k];
        if (i < 0) continue;
        const x = i % w;
        for (let s = 0; s < speed; s++) {
          const y = (i - x) / w;
          if (y + 1 >= h) {
            if (pits && pits[x]) {
              set(i, AIR);
              falling[i] = 0;
              pos[k] = -1;
              report.lost++;
              active--;
            } else {
              land(k);
              active--;
            }
            break;
          }
          const j = i + w;
          const below = front2[j];
          if (below === AIR) {
            let m = front2[i];
            if (m === DIRT && y + 1 >= band) {
              m = STONE;
              report.stone++;
            }
            set(i, AIR);
            set(j, m);
            falling[i] = 0;
            falling[j] = call;
            i = j;
            pos[k] = j;
            continue;
          }
          if (below === WATER) {
            const m = front2[i];
            set(i, WATER);
            set(j, m);
            falling[i] = 0;
            falling[j] = call;
            pos[k] = j;
            break;
          }
          if (below === LAVA) {
            if (front2[i] === DIRT) {
              set(i, STONE);
              report.stone++;
            }
            land(k);
            active--;
            break;
          }
          if (falling[j] !== call) {
            land(k);
            active--;
          }
          break;
        }
      }
      if (iter % COLLAPSE_FRAME_ITERS === 0 && iter <= COLLAPSE_MAX_ITERS) flush();
    }
    for (let k = 0; k < n; k++) if (pos[k] >= 0) {
      falling[pos[k]] = 0;
      land(k);
    }
    flush();
    report.iters = iter;
    if (tx1 < 0) return report;
    report.changed = true;
    report.touched = { x0: tx0, y0: ty0, x1: tx1, y1: ty1 };
    markDirty(t, tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1);
    if (opts.record) {
      const p0 = patchOf(t, tx0, ty0, tx1, ty1);
      const pw = p0.w;
      for (let k = 0; k < origIdx.length; k++) {
        const i = origIdx[k];
        const x = i % w;
        const y = (i - x) / w;
        p0.front[(y - ty0) * pw + (x - tx0)] = origVal[k];
      }
      report.patches.unshift(p0);
    }
    return report;
  }
  const BLAST_STEP = 2;
  const SLOPE_STEP = 1;
  const SLIDE_MAX = 160;
  const EDGE_COLS = 3;
  const SLOPE_CAP = 6 * TANK_W;
  function stepTank(state, p, x, y, dir, tankFloorFn) {
    const t = state.terrain;
    const nx = x + dir;
    if (nx < TANK_HALF_W || nx > state.width - TANK_HALF_W) return null;
    const edge = dir > 0 ? nx + TANK_HALF_W - 1 : nx - TANK_HALF_W;
    for (let yy = y - TANK_H; yy < y - MAX_CLIMB; yy++) if (isSolid(t, edge, yy)) return null;
    let floor = tankFloorFn(t, nx, y - MAX_CLIMB);
    const air = floor > y + MAX_CLIMB;
    if (air) floor = y;
    for (let yy = floor - TANK_H; yy < y - TANK_H; yy++) {
      for (let xx = nx - TANK_HALF_W; xx < nx + TANK_HALF_W; xx++) if (isSolid(t, xx, yy)) return null;
    }
    for (const q of state.players) {
      if (q.id === p.id || !q.alive) continue;
      if (Math.abs(q.x - nx) < TANK_W && Math.abs(q.x - nx) < Math.abs(q.x - x) && Math.abs(q.y - floor) < TANK_H) return null;
    }
    return { x: nx, floor, air };
  }
  function slopeAt(state, x, y) {
    const t = state.terrain;
    const cx = Math.round(x);
    const edge = (from) => {
      let best = y + SLOPE_CAP;
      for (let i = 0; i < EDGE_COLS; i++) best = Math.min(best, columnGround(t, from + i, y - MAX_CLIMB));
      return Math.min(best, y + SLOPE_CAP);
    };
    const left = edge(cx - TANK_HALF_W);
    const right = edge(cx + TANK_HALF_W - EDGE_COLS);
    return (right - left) / TANK_W;
  }
  function tipDir(state, p) {
    const t = state.terrain;
    if (!t.pits) return null;
    const cx = Math.round(p.x);
    if (!t.pits[cx - 1] || !t.pits[cx]) return null;
    let left = 0;
    let right = 0;
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
      let solid = false;
      for (let y = p.y; y <= p.y + TIP_DEPTH && !solid; y++) solid = isSolid(t, ix, y);
      if (!solid) continue;
      if (ix < cx - 1) left++;
      else if (ix > cx) right++;
      else return null;
    }
    if (left > 0 && right === 0 && t.pits[cx + TANK_HALF_W - 1]) return 1;
    if (right > 0 && left === 0 && t.pits[cx - TANK_HALF_W]) return -1;
    return null;
  }
  const TIP_DEPTH = 2;
  function travel(state, p, dir, dist, per, tankFloorFn, stopWhenFlat) {
    const path = [{ x: p.x, y: p.y }];
    let moved = 0;
    for (let i = 0; i < dist; i++) {
      const s = stepTank(state, p, p.x, p.y, dir, tankFloorFn);
      if (!s) break;
      p.x = s.x;
      p.y = s.floor;
      moved++;
      if (moved % per === 0) path.push({ x: p.x, y: p.y });
      if (s.air) break;
      if (stopWhenFlat && slopeAt(state, p.x, p.y) * dir <= SLIDE_SLOPE) break;
    }
    if (moved === 0) return null;
    const last = path[path.length - 1];
    if (last.x !== p.x || last.y !== p.y) path.push({ x: p.x, y: p.y });
    return path;
  }
  function knock(state, p, dir, dist, t, events, tankFloorFn) {
    if (p.y >= state.terrain.h || tankFloorFn(state.terrain, p.x, p.y - MAX_CLIMB) > p.y + MAX_CLIMB) return t;
    const path = travel(state, p, dir, dist, BLAST_STEP, tankFloorFn, false);
    if (!path) return t;
    events.push({ type: "slide", playerId: p.id, cause: "blast", path, t });
    return t + (path.length - 1) * PATH_DT;
  }
  function slideDown(state, p, t, events, tankFloorFn) {
    if (!p.alive || p.y >= state.terrain.h) return null;
    const s = slopeAt(state, p.x, p.y);
    const tip = tipDir(state, p);
    if (Math.abs(s) <= SLIDE_SLOPE && !tip) return null;
    const dir = tip ?? (s > 0 ? 1 : -1);
    const path = travel(state, p, dir, SLIDE_MAX, SLOPE_STEP, tankFloorFn, !tip);
    if (!path) return null;
    const e = { type: "slide", playerId: p.id, cause: "slope", path };
    if (t !== void 0) e.t = t;
    events.push(e);
    return (t ?? 0) + (path.length - 1) * PATH_DT;
  }
  const BARREL_RADIUS = 18;
  const BARREL_DAMAGE = 30;
  const CHAIN_DELAY = 0.18;
  const CRUSH_DEPTH = 8;
  const CRUSH_DAMAGE = 2;
  const MIN_SUPPORT$1 = 3;
  const ABYSS_DROP = 60;
  const KNOCKBACK_REF = 22;
  const FALL_SETTLE = 0.15;
  const SETTLE_ROUNDS = 4;
  function tankDistance(p, x, y) {
    const dx = Math.max(p.x - TANK_HALF_W - x, 0, x - (p.x + TANK_HALF_W));
    const dy = Math.max(p.y - TANK_H - y, 0, y - p.y);
    return Math.hypot(dx, dy);
  }
  function blastDamage(p, b) {
    const d = tankDistance(p, b.x, b.y);
    const reach = b.terrain === "build" ? b.radius * 0.5 : b.radius;
    if (d > reach) return 0;
    return b.damage * (1 - d / (reach + 1));
  }
  function propDistance(p, x, y) {
    const dx = Math.max(p.x - x, 0, x - (p.x + p.w - 1));
    const dy = Math.max(p.y - y, 0, y - (p.y + p.h - 1));
    return Math.hypot(dx, dy);
  }
  function hurt(p, raw, events) {
    let total = Math.round(raw);
    if (!p.alive || total <= 0) return;
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, total);
      p.shield -= absorbed;
      total -= absorbed;
      events.push({ type: "shield", playerId: p.id, absorbed, left: p.shield });
    }
    const amount = Math.min(p.hp, total);
    if (amount <= 0) return;
    p.hp -= amount;
    events.push({ type: "damage", playerId: p.id, amount, hp: p.hp });
    if (p.hp <= 0) {
      p.alive = false;
      events.push({ type: "death", playerId: p.id });
    }
  }
  function resolveBlast(state, first, after) {
    const events = [];
    const coverBefore = state.players.map((p) => cover(state.terrain, p));
    const queue = [first];
    const busy = /* @__PURE__ */ new Map();
    let last = first.t;
    while (queue.length > 0) {
      const b = queue.shift();
      if (submerged(state.terrain, b.x, b.y)) {
        b.radius *= WATER_BLAST_SCALE;
        b.water = true;
      }
      const debris = b.terrain === "wall" || b.terrain === "none" ? {} : deform(state.terrain, b.x, b.y, b.radius, b.terrain, state.lava ?? Infinity);
      events.push({
        type: "impact",
        x: b.x,
        y: b.y,
        weapon: b.weapon,
        blast: b.blast,
        radius: b.radius,
        t: b.t,
        debris,
        source: b.source ?? "shot",
        ...b.water ? { water: true } : {}
        // v2.4: también en barriles en cadena
      });
      const mark = events.length;
      const pushes = [];
      for (const p of state.players) {
        if (!p.alive) continue;
        const amount = p.id === b.directTank ? b.damage : blastDamage(p, b);
        if (amount > 0) hurt(p, amount, events);
        const dist = b.terrain === "build" || amount <= 0 ? 0 : Math.round(KNOCKBACK_MAX * Math.min(1, amount / KNOCKBACK_REF));
        const dx = p.x - b.x;
        if (dist > 2 && p.id === b.directTank && b.heading) pushes.push({ p, dist, dir: b.heading });
        else if (dist > 2 && Math.abs(dx) >= 1) pushes.push({ p, dist, dir: dx > 0 ? 1 : -1 });
      }
      for (const prop of state.props) {
        if (!prop.alive) continue;
        const d = propDistance(prop, b.x, b.y);
        const breaks = prop.kind === "barrel" || prop.kind === "crate" ? d <= b.radius : d <= b.radius * 0.6;
        if (!breaks) continue;
        prop.alive = false;
        events.push({ type: "prop", propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true });
        if (prop.kind === "barrel") {
          queue.push({
            x: prop.x + prop.w / 2,
            y: prop.y + prop.h / 2,
            radius: BARREL_RADIUS,
            damage: BARREL_DAMAGE,
            weapon: "normal",
            blast: "fire",
            terrain: "destroy",
            t: b.t + CHAIN_DELAY,
            source: "barrel"
          });
        }
      }
      for (let i = mark; i < events.length; i++) {
        const e = events[i];
        if (e.type === "damage" || e.type === "death" || e.type === "prop" || e.type === "shield") e.t = b.t;
      }
      for (const { p, dist, dir } of pushes) {
        if (!p.alive) continue;
        busy.set(p.id, knock(state, p, dir, dist, Math.max(b.t, busy.get(p.id) ?? -Infinity), events, tankFloor));
      }
      last = Math.max(last, b.t);
    }
    after?.(events);
    settleProps(state, events);
    settleTanks(state, coverBefore, events, last, busy);
    return events;
  }
  function submerged(t, x, y) {
    return liquidAt(t, x, y) === WATER || liquidAt(t, x, y - 1) === WATER || liquidAt(t, x - 1, y) === WATER || liquidAt(t, x + 1, y) === WATER || liquidAt(t, x, y + 1) === WATER;
  }
  const WATER_FALL_CELLS = 3 * TANK_W;
  function inWater(t, x, floor) {
    const cx = Math.round(x);
    let n = 0;
    const { w, front: front2 } = t;
    for (let y = Math.max(0, floor - TANK_H); y < Math.min(t.h, floor); y++) {
      for (let ix = Math.max(0, cx - TANK_HALF_W); ix < Math.min(w, cx + TANK_HALF_W); ix++) {
        if (front2[y * w + ix] === WATER && ++n >= WATER_FALL_CELLS) return true;
      }
    }
    return false;
  }
  function inLava(t, p) {
    const cx = Math.round(p.x);
    return hasLiquid(t, LAVA, cx - TANK_HALF_W, p.y - TANK_H, cx + TANK_HALF_W, p.y + 1);
  }
  function engulfedInLava(t, p) {
    return hasLiquid(t, LAVA, Math.round(p.x) - 2, p.y - TANK_H, Math.round(p.x) + 2, p.y - TANK_H + 1);
  }
  function kill(p, events, cause) {
    if (!p.alive) return;
    const amount = p.hp;
    p.hp = 0;
    p.shield = 0;
    p.alive = false;
    if (amount > 0) events.push({ type: "damage", playerId: p.id, amount, hp: 0, cause: "lava" });
    events.push({ type: "death", playerId: p.id, cause });
  }
  function cover(t, p) {
    return solidRunUp(t, p.x, p.y - TANK_H, 64);
  }
  function solidPropAt(props, self2, x, y) {
    for (const o of props) {
      if (o === self2 || !o.alive || o.kind !== "barrel" && o.kind !== "crate") continue;
      if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return true;
    }
    return false;
  }
  function rowSupported(state, prop, y) {
    for (let x = prop.x; x < prop.x + prop.w; x++) {
      if (isSolid(state.terrain, x, y) || solidPropAt(state.props, prop, x, y)) return true;
    }
    return false;
  }
  function propSupported(state, prop) {
    const t = state.terrain;
    switch (prop.kind) {
      case "barrel":
      case "crate":
      case "loot":
      // v3
      case "target":
        return rowSupported(state, prop, prop.y + prop.h);
      case "lamp":
        for (let x = prop.x; x < prop.x + prop.w; x++) if (isSolid(t, x, prop.y - 1)) return true;
        return false;
      case "flag":
      case "windsock":
        return isSolid(t, prop.x, prop.y + prop.h) || isSolid(t, prop.x + 1, prop.y + prop.h);
      case "ladder":
        for (let y = prop.y; y <= prop.y + prop.h; y++) {
          if (isSolid(t, prop.x - 1, y) || isSolid(t, prop.x + prop.w, y)) return true;
          if (y === prop.y + prop.h) {
            for (let x = prop.x; x < prop.x + prop.w; x++) if (isSolid(t, x, y)) return true;
          }
        }
        return false;
    }
  }
  function settleProps(state, events) {
    const order = state.props.filter((p) => p.alive).sort((a, b) => b.y + b.h - (a.y + a.h) || a.id - b.id);
    for (const prop of order) {
      if (propSupported(state, prop)) continue;
      if (prop.kind !== "barrel" && prop.kind !== "crate") {
        prop.alive = false;
        events.push({ type: "prop", propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true });
        continue;
      }
      let y = prop.y;
      while (y + prop.h < state.terrain.h && !rowSupported(state, prop, y + prop.h)) {
        y++;
        prop.y = y;
      }
      const lost = !rowSupported(state, prop, prop.y + prop.h);
      if (lost) prop.alive = false;
      events.push({ type: "prop", propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: lost });
    }
    burnCrates(state, events);
  }
  function burnCrates(state, events) {
    for (const prop of state.props) {
      if (!prop.alive || prop.kind !== "crate") continue;
      if (!hasLiquid(state.terrain, LAVA, prop.x, prop.y, prop.x + prop.w, prop.y + prop.h + 1)) continue;
      prop.alive = false;
      events.push({ type: "prop", propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true });
    }
  }
  function settleAfterFlow(state, events, t) {
    const mark = events.length;
    settleProps(state, events);
    settleTanks(
      state,
      state.players.map(() => Infinity),
      events,
      t,
      new Map(state.players.map((p) => [p.id, t]))
    );
    for (let i = mark; i < events.length; i++) {
      const e = events[i];
      if ((e.type === "prop" || e.type === "fall" || e.type === "damage" || e.type === "death" || e.type === "shield") && e.t === void 0) e.t = t;
    }
  }
  const COLLAPSE_DELAY = 0.1;
  const COLLAPSE_DT = 1 / 30;
  const COLLAPSE_MIN_DROP = 4;
  const COLLAPSE_PILE = 12;
  const COLLAPSE_MIN_CELLS = 24;
  const COLLAPSE_CELLS_PER_HP = 10;
  const COLLAPSE_MAX_DAMAGE = 40;
  function collapseAfterShot(state, events, t, record) {
    const t0 = performance.now();
    const rep = collapseTerrain(state.terrain, { seed: peekDirty(state.terrain), record, band: state.lava ?? void 0 });
    const ms = performance.now() - t0;
    if (record) {
      collapseStats.calls++;
      collapseStats.ms += ms;
      collapseStats.worst = Math.max(collapseStats.worst, ms);
    }
    if (!rep.changed) return t;
    const frames = record ? rep.patches.length - 1 : Math.ceil(Math.min(rep.iters, 240) / COLLAPSE_FRAME_ITERS);
    const end = t + Math.max(0, frames) * COLLAPSE_DT;
    if (record) {
      collapseStats.collapses++;
      collapseStats.cells += rep.cells;
      events.push({ type: "collapse", t, dt: COLLAPSE_DT, patches: rep.patches, cells: rep.cells });
    }
    const w = state.terrain.w;
    for (const p of state.players) {
      if (!p.alive) continue;
      const cx = Math.round(p.x);
      let n = 0;
      for (const c of rep.landed) {
        if (c.drop < COLLAPSE_MIN_DROP) continue;
        const x = c.i % w;
        const y = (c.i - x) / w;
        if (x >= cx - TANK_HALF_W && x < cx + TANK_HALF_W && y >= p.y - TANK_H - COLLAPSE_PILE && y < p.y) n++;
      }
      if (n < COLLAPSE_MIN_CELLS) continue;
      const mark = events.length;
      hurt(p, Math.min(COLLAPSE_MAX_DAMAGE, n / COLLAPSE_CELLS_PER_HP), events);
      for (let i = mark; i < events.length; i++) {
        const e = events[i];
        if (e.type === "damage") {
          e.t = end;
          e.cause = "collapse";
        } else if (e.type === "death" || e.type === "shield") e.t = end;
      }
    }
    settleAfterFlow(state, events, end);
    return end;
  }
  function overAbyss(t, x, floor) {
    if (floor < t.h || !t.pits) return false;
    const cx = Math.round(x);
    for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (isPit(t, ix)) return true;
    return false;
  }
  function dropIntoAbyss(t, p, events) {
    const from = p.y;
    p.y = t.h + ABYSS_DROP;
    events.push({ type: "fall", playerId: p.id, from, to: p.y });
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    events.push({ type: "death", playerId: p.id, cause: "abyss" });
  }
  function tankFloor(t, x, y) {
    const cx = Math.round(x);
    for (let yy = Math.max(0, Math.floor(y)); yy < t.h; yy++) {
      let n = 0;
      for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) if (isSolid(t, ix, yy)) n++;
      if (n >= MIN_SUPPORT$1) return yy;
    }
    return t.h;
  }
  function settleTanks(state, coverBefore, events, base, busy) {
    for (const p of state.players) settleTank(state, p, events, base, busy.get(p.id));
    state.players.forEach((p, i) => {
      if (!p.alive) return;
      const depth = cover(state.terrain, p);
      if (depth > CRUSH_DEPTH && depth > coverBefore[i]) hurt(p, (depth - CRUSH_DEPTH) * CRUSH_DAMAGE, events);
    });
  }
  function settleTank(state, p, events, base, t, free = 0) {
    const timed = base !== void 0 || t !== void 0;
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      const mark = events.length;
      const drop = fallTank(state, p, events, free);
      if (t !== void 0) {
        for (let i = mark; i < events.length; i++) {
          const e = events[i];
          if (e.type === "fall" || e.type === "damage" || e.type === "death" || e.type === "shield") e.t = t;
        }
      }
      if (!p.alive || p.y >= state.terrain.h) break;
      const start = timed ? (t ?? base ?? 0) + (drop > 0 ? FALL_SETTLE : 0) : void 0;
      const end = slideDown(state, p, start, events, tankFloor);
      if (end === null) break;
      if (timed) t = end;
    }
    return t;
  }
  function fallTank(state, p, events, free = 0) {
    const t = state.terrain;
    if (p.y >= t.h) return 0;
    const floor = tankFloor(t, p.x, p.y);
    if (overAbyss(t, p.x, floor)) {
      const from2 = p.y;
      dropIntoAbyss(t, p, events);
      return p.y - from2;
    }
    if (floor <= p.y) return 0;
    const from = p.y;
    const drop = floor - from;
    p.y = floor;
    if (inWater(t, p.x, floor)) {
      events.push({ type: "fall", playerId: p.id, from, to: floor, water: true });
      return drop;
    }
    const amount = Math.round(Math.max(0, drop - free) * FALL_DAMAGE);
    const harmful = p.alive && (free > 0 || drop > 2) && amount > 0;
    if (harmful && amount >= PARACHUTE_MIN_DAMAGE && p.items.parachute > 0) {
      p.items.parachute -= 1;
      events.push({ type: "fall", playerId: p.id, from, to: floor, parachute: true });
      return drop;
    }
    events.push({ type: "fall", playerId: p.id, from, to: floor });
    if (harmful) hurt(p, amount, events);
    return drop;
  }
  const HEADING_MIN = 4;
  function blastFor(weapon, x, y, t, directTank, vx = 0) {
    const w = WEAPONS[weapon];
    const b = { x, y, radius: w.radius, damage: w.damage, weapon, blast: w.blast, terrain: w.terrain, t, directTank };
    if (directTank !== void 0 && Math.abs(vx) >= HEADING_MIN) b.heading = vx > 0 ? 1 : -1;
    return b;
  }
  const CLUSTER_SPREAD = 26;
  const NAPALM_SPREAD = 40;
  const NAPALM_DPS = 6;
  const NAPALM_CHAR = 12;
  const DIG_LENGTH = 80;
  const DIG_RADIUS = 6;
  const ROLL_MAX_T = 6;
  const ROLL_R = 3;
  function toFlight(f, startT) {
    const flight = { path: f.path, impact: f.impact, startT };
    if (f.splashes) flight.splashes = f.splashes;
    return flight;
  }
  function resolveShot(state, shooter, weapon) {
    const w = WEAPONS[weapon];
    const base = {
      terrain: state.terrain,
      players: state.players,
      props: state.props,
      ownerId: shooter.id,
      angle: shooter.angle,
      power: shooter.power,
      wind: state.wind,
      lava: state.lava ?? void 0,
      // v2: lo que toca la lava se derrite sin explotar
      lavaSolid: w.terrain === "build"
      // Pulido v2: salvo la Tierra, que construye ahí
    };
    if (w.split) return cluster(state, shooter, weapon, fly({ ...base, stopAtApex: true }));
    const flight = fly(base);
    const flights = [toFlight(flight, 0)];
    if (flight.impact.kind === "out" || flight.impact.kind === "lava") return { flights, events: [] };
    const { x, y, tankId } = flight.impact;
    if (w.rolls && flight.impact.kind === "terrain") return roll(state, shooter, weapon, flight, flights);
    const blast = blastFor(weapon, x, y, flight.time, tankId, flight.vel.x);
    const after = w.terrain === "dig" ? (ev) => tunnel(state, flight, ev) : w.burn ? (ev) => napalm(state, x, y, flight.time, w.burn, ev) : void 0;
    const events = resolveBlast(state, blast, after);
    markWater(flights[0], blast);
    return { flights, events };
  }
  function markWater(f, b) {
    if (b.water) f.impact = { ...f.impact, water: true };
  }
  function cluster(state, shooter, weapon, main) {
    const w = WEAPONS[weapon];
    const flights = [toFlight(main, 0)];
    if (!main.apex) {
      if (main.impact.kind === "out" || main.impact.kind === "lava") return { flights, events: [] };
      const b = blastFor(weapon, main.impact.x, main.impact.y, main.time, main.impact.tankId, main.vel.x);
      const events2 = resolveBlast(state, b);
      markWater(flights[0], b);
      return { flights, events: events2 };
    }
    const n = w.split ?? 1;
    const origin = { x: main.impact.x, y: main.impact.y };
    const bombs = [];
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      bombs.push(
        fly({
          terrain: state.terrain,
          players: state.players,
          props: state.props,
          ownerId: shooter.id,
          angle: 0,
          power: 0,
          wind: state.wind,
          origin,
          velocity: { x: main.vel.x + k * CLUSTER_SPREAD, y: -18 + Math.abs(k) * 6 },
          lava: state.lava ?? void 0
        })
      );
    }
    const order = bombs.map((_, i) => i).sort((a, b) => bombs[a].time - bombs[b].time || a - b);
    const events = [];
    for (const i of order) {
      const f = bombs[i];
      flights.push(toFlight(f, main.time));
      if (f.impact.kind === "out" || f.impact.kind === "lava") continue;
      const tankId = f.impact.tankId !== void 0 && state.players[f.impact.tankId]?.alive ? f.impact.tankId : void 0;
      const b = blastFor(weapon, f.impact.x, f.impact.y, main.time + f.time, tankId, f.vel.x);
      events.push(...resolveBlast(state, b));
      markWater(flights[flights.length - 1], b);
    }
    return { flights, events };
  }
  function tunnel(state, flight, events) {
    const len = Math.hypot(flight.vel.x, flight.vel.y) || 1;
    const dx = flight.vel.x / len;
    const dy = flight.vel.y / len;
    const impact = events[0];
    if (impact.type !== "impact") return;
    for (let d = 0; d <= DIG_LENGTH; d += 2) {
      const debris = deform(state.terrain, flight.impact.x + dx * d, flight.impact.y + dy * d, DIG_RADIUS, "dig");
      for (const k in debris) {
        const m = Number(k);
        impact.debris[m] = (impact.debris[m] ?? 0) + (debris[m] ?? 0);
      }
    }
  }
  function surfaceFrom(state, x, y) {
    return columnGround(state.terrain, x, y);
  }
  const NAPALM_CRUST = 4;
  function waterTop(t, x, y) {
    let yy = Math.floor(y);
    while (yy > 0 && liquidAt(t, x, yy - 1) === WATER) yy--;
    return yy;
  }
  function napalm(state, ix, iy, t0, seconds, events) {
    const t = state.terrain;
    const cx = Math.round(ix);
    const surface2 = (x, fromY) => columnTop(t, x, fromY);
    let start;
    if (submerged(t, ix, iy)) {
      const wy = liquidAt(t, cx, iy) === WATER ? iy : liquidAt(t, cx, iy - 1) === WATER ? iy - 1 : -1;
      start = wy >= 0 ? waterTop(t, cx, wy) : surface2(cx, Math.floor(iy) - 8);
    } else start = surface2(cx, Math.floor(iy) - 8);
    const band = state.lava ?? Infinity;
    const underLava = (x, y) => y >= band || liquidAt(t, x, y) === LAVA || liquidAt(t, x, y - 1) === LAVA;
    if (start >= t.h || underLava(cx, start)) return;
    const burning = [];
    const crust = [];
    const mark = (x, y) => {
      if (liquidAt(t, x, y) === WATER) crust.push({ x, y, n: 0 });
      else burning.push({ x, y });
    };
    mark(cx, start);
    for (const dir of [-1, 1]) {
      let y = start;
      let budget = NAPALM_SPREAD;
      for (let x = cx + dir; budget > 0 && x >= 0 && x < t.w; x += dir) {
        if (isSolid(t, x, y - 6)) break;
        const g = surface2(x, y - 5);
        if (g >= t.h || underLava(x, g)) break;
        budget -= 1 + Math.max(0, y - g);
        y = g;
        mark(x, y);
      }
    }
    burning.sort((a, b) => a.x - b.x);
    crust.sort((a, b) => a.x - b.x);
    for (const c of crust) {
      let n = 0;
      for (let y = c.y; y < c.y + NAPALM_CRUST && y < t.h; y++) {
        if (t.front[y * t.w + c.x] !== WATER) break;
        t.front[y * t.w + c.x] = STONE;
        n++;
      }
      markDirty(t, c.x - 1, c.y - 1, c.x + 1, c.y + NAPALM_CRUST);
      c.n = n;
    }
    for (let i = 0; i < crust.length; i += 10) {
      const seg = crust.slice(i, i + 10);
      const mid = seg[Math.floor(seg.length / 2)];
      const n = seg.reduce((a, c) => a + c.n, 0);
      events.push({ type: "steam", x: mid.x, y: mid.y, n, t: t0 + Math.abs(mid.x - cx) / 90 });
    }
    if (burning.length === 0) return;
    const r = NAPALM_CHAR;
    for (let i = 0; i < burning.length; i += 3) {
      const p = burning[i];
      markDirty(t, p.x - r - 1, p.y - r - 1, p.x + r + 1, p.y + r + 1);
      for (let y = p.y - r; y <= p.y + r; y++) {
        if (y < 0 || y >= t.h || y >= band) continue;
        for (let x = p.x - r; x <= p.x + r; x++) {
          if (x < 0 || x >= t.w || (x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue;
          const idx = y * t.w + x;
          const m = t.front[idx];
          if (m !== AIR && MATERIALS[m]?.flammable) t.front[idx] = AIR;
        }
      }
    }
    for (let i = 0; i < burning.length; ) {
      let j = i + 1;
      while (j < burning.length && j - i < 10 && burning[j].x === burning[j - 1].x + 1) j++;
      const seg = burning.slice(i, j);
      const mid = seg[Math.floor(seg.length / 2)];
      events.push({ type: "burn", x: seg[0].x, y: mid.y, w: seg.length, t: t0 + Math.abs(mid.x - cx) / 90 });
      i = j;
    }
    const x0 = burning[0].x;
    const x1 = burning[burning.length - 1].x;
    for (const p of state.players) {
      if (!p.alive || p.x + TANK_HALF_W < x0 || p.x - TANK_HALF_W > x1) continue;
      const near = burning.some((b) => Math.abs(b.x - p.x) <= TANK_HALF_W && b.y >= p.y - TANK_H - 4 && b.y <= p.y + 6);
      if (!near) continue;
      const mark2 = events.length;
      hurt(p, NAPALM_DPS * seconds, events);
      for (let i = mark2; i < events.length; i++) {
        const e = events[i];
        if (e.type === "damage" || e.type === "death" || e.type === "shield") e.t = t0 + 0.4;
      }
    }
    for (const prop of state.props) {
      if (!prop.alive || prop.kind !== "crate") continue;
      if (prop.x + prop.w < x0 || prop.x > x1) continue;
      prop.alive = false;
      events.push({ type: "prop", propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, destroyed: true, t: t0 + 0.3 });
    }
  }
  function tankAt(state, x, y) {
    return state.players.find(
      (p) => p.alive && x >= p.x - TANK_HALF_W && x <= p.x + TANK_HALF_W && y >= p.y - TANK_H && y <= p.y
    );
  }
  function roll(state, shooter, weapon, flight, flights) {
    const t = state.terrain;
    const gravity = physicsFor(t.w).gravity;
    let x = flight.impact.x;
    let y = surfaceFrom(state, Math.round(x), Math.floor(flight.impact.y) - 6) - ROLL_R;
    const slopeAt2 = (px) => surfaceFrom(state, Math.round(px) + 2, y - 6) - surfaceFrom(state, Math.round(px) - 2, y - 6);
    let vx = flight.vel.x * 0.35;
    if (Math.abs(vx) < 20) vx = slopeAt2(x) !== 0 ? Math.sign(slopeAt2(x)) * 20 : Math.sign(flight.vel.x || 1) * 20;
    let vy = 0;
    let air = false;
    let time = 0;
    let still = 0;
    let n = 0;
    let hit;
    const path = [{ x, y }];
    const lava = state.lava ?? Infinity;
    let wet = liquidAt(t, x, y) === WATER;
    const splashes = [];
    const drag = WATER_DRAG ** SUBSTEP;
    const push = (impact) => {
      const f = { path, impact, startT: flight.time };
      if (splashes.length > 0) f.splashes = splashes;
      flights.push(f);
    };
    while (time < ROLL_MAX_T) {
      time += SUBSTEP;
      n++;
      if (wet) {
        vx *= drag;
        vy *= drag;
      }
      if (!air) {
        const s = slopeAt2(x) / 4;
        vx += gravity * 0.9 * s / Math.sqrt(1 + s * s) * SUBSTEP;
        const fr = 70 * SUBSTEP;
        vx = Math.abs(vx) <= fr ? 0 : vx - Math.sign(vx) * fr;
        const nx = x + vx * SUBSTEP;
        const g = surfaceFrom(state, Math.round(nx), y - 6);
        if (isSolid(t, nx, y - 6) || g < y + ROLL_R - 5) break;
        x = nx;
        if (g > y + ROLL_R + 2) air = true;
        else y = g - ROLL_R;
        still = Math.abs(vx) < 4 ? still + SUBSTEP : 0;
        if (still > 0.25) break;
      } else {
        vy += gravity * SUBSTEP;
        x += vx * SUBSTEP;
        y += vy * SUBSTEP;
        if (isSolid(t, x, y + ROLL_R)) {
          y = surfaceFrom(state, Math.round(x), y - 6) - ROLL_R;
          vy = 0;
          air = false;
        }
      }
      if (x < -20 || x > t.w + 20 || y > t.h) {
        path.push({ x, y });
        push({ kind: "out", x, y });
        return { flights, events: [] };
      }
      if (y + ROLL_R >= lava || liquidAt(t, x, y) === LAVA || liquidAt(t, x, y + ROLL_R - 1) === LAVA) {
        path.push({ x, y });
        push({ kind: "lava", x, y });
        return { flights, events: [] };
      }
      if (liquidAt(t, x, y) === WATER) {
        if (!wet) splashes.push({ x, y, t: time });
        wet = true;
      } else wet = false;
      hit = tankAt(state, x, y);
      if (hit && (hit.id !== shooter.id || time > 0.3)) break;
      hit = void 0;
      if (n % 4 === 0) path.push({ x, y });
    }
    path.push({ x, y });
    push(hit ? { kind: "tank", x, y, tankId: hit.id } : { kind: "terrain", x, y });
    const endT = flight.time + (path.length - 1) * PATH_DT;
    const b = blastFor(weapon, x, y, endT, hit?.id, vx);
    const events = resolveBlast(state, b);
    markWater(flights[flights.length - 1], b);
    return { flights, events };
  }
  const SELL_RATE = 1;
  function shopEntry(id) {
    return SHOP.find((e) => e.id === id);
  }
  function owned(player, id) {
    if (id in WEAPONS) return player.ammo[id] ?? 0;
    return player.items[id] ?? 0;
  }
  function setOwned(player, id, n) {
    if (id in WEAPONS) player.ammo[id] = n;
    else player.items[id] = n;
  }
  function canBuy(player, entry) {
    return player.money >= entry.price && owned(player, entry.id) + entry.qty <= entry.max;
  }
  function canSell(player, entry) {
    return owned(player, entry.id) > 0;
  }
  function sellPrice(player, entry) {
    const n = Math.min(entry.qty, owned(player, entry.id));
    return Math.floor(entry.price * SELL_RATE * n / entry.qty);
  }
  function buyEntry(player, entry) {
    if (!canBuy(player, entry)) return false;
    player.money -= entry.price;
    setOwned(player, entry.id, owned(player, entry.id) + entry.qty);
    return true;
  }
  function sellEntry(player, entry) {
    if (!canSell(player, entry)) return false;
    const n = Math.min(entry.qty, owned(player, entry.id));
    player.money += sellPrice(player, entry);
    setOwned(player, entry.id, owned(player, entry.id) - n);
    return true;
  }
  const WANT = {
    easy: { heavy: [3, 4], cluster: [2, 4], napalm: [2, 4], roller: [2, 4], dirt: [1, 3], nuke: [1, 1], shield: [2, 1], repair: [2, 1], parachute: [1, 1], fuel: [1, 1], tracer: [1, 1] },
    normal: { heavy: [4, 6], cluster: [2, 4], napalm: [3, 4], roller: [3, 4], digger: [1, 2], nuke: [2, 1], shield: [3, 2], repair: [3, 2], parachute: [2, 1] },
    hard: { heavy: [5, 6], cluster: [2, 4], napalm: [3, 4], roller: [3, 4], digger: [1, 2], nuke: [4, 2], shield: [4, 2], repair: [4, 2], parachute: [2, 1] }
  };
  const STOP = { easy: 0.3, normal: 0.12, hard: 0.05 };
  function aiShop(player, difficulty, seed, round) {
    const rng = new Rng(hashSeed(seed ^ Math.imul(round + 1, 2246822507) ^ Math.imul(player.id + 1, 3266489909)));
    const want = WANT[difficulty];
    const bought = [];
    const nuke = shopEntry("nuke");
    if (difficulty === "hard" && nuke && canBuy(player, nuke) && owned(player, "nuke") === 0) {
      buyEntry(player, nuke);
      bought.push("nuke");
    }
    for (let n = 0; n < 12; n++) {
      const options = [];
      for (const e of SHOP) {
        const w = want[e.id];
        if (!w || !canBuy(player, e) || owned(player, e.id) >= w[1]) continue;
        options.push([e, w[0]]);
      }
      if (options.length === 0) break;
      if (bought.length > 0 && rng.chance(STOP[difficulty])) break;
      let roll2 = rng.next() * options.reduce((a, o) => a + o[1], 0);
      let pick2 = options[0][0];
      for (const [e, w] of options) {
        roll2 -= w;
        if (roll2 < 0) {
          pick2 = e;
          break;
        }
      }
      buyEntry(player, pick2);
      bought.push(pick2.id);
    }
    return bought;
  }
  function roundSeed(seed, round) {
    return round <= 1 ? hashSeed(seed) : hashSeed(seed ^ Math.imul(round, 2654435761));
  }
  function biomeFor(mode, seed, round) {
    if (mode === "rotate") return BIOMES[(round - 1) % BIOMES.length];
    if (mode === "random") return BIOMES[hashSeed(seed ^ Math.imul(round, 668265263)) % BIOMES.length];
    return BIOMES.includes(mode) ? mode : BIOMES[0];
  }
  const ORDER_SALT = 625341585;
  function setupRound(state) {
    const rng = new Rng(roundSeed(state.seed, state.round));
    const biome = biomeFor(state.biomeMode, state.seed, state.round);
    const humans = state.players.filter((p) => p.kind === "human").length;
    const gen2 = generate(biome, rng, state.players.length, state.width, state.height, humans);
    state.biome = biome;
    state.terrain = gen2.terrain;
    state.props = gen2.props;
    const draw = new Rng(hashSeed(roundSeed(state.seed, state.round) ^ ORDER_SALT));
    const seat = state.players.map((_, i) => i);
    for (let i = seat.length - 1; i > 0; i--) {
      const j = draw.int(0, i);
      const tmp = seat[i];
      seat[i] = seat[j];
      seat[j] = tmp;
    }
    const opener = draw.int(0, state.players.length - 1);
    const safe = gen2.safe;
    if (safe) {
      state.players.forEach((p, i) => {
        if (p.kind !== "human" || safe[seat[i]]) return;
        const pool = state.players.filter((q, j2) => q.kind !== "human" && safe[seat[j2]]).map((q) => state.players.indexOf(q));
        if (pool.length === 0) return;
        const j = pool[draw.int(0, pool.length - 1)];
        const tmp = seat[i];
        seat[i] = seat[j];
        seat[j] = tmp;
      });
    }
    state.players.forEach((p, i) => {
      const x = gen2.spawns[seat[i]];
      p.x = x;
      p.y = tankFloor(gen2.terrain, x, 0);
      p.hp = PLAYER_HP;
      p.alive = true;
      p.angle = x < state.width / 2 ? 55 : 125;
      p.power = 60;
      p.fuel = fuelFor(state.width);
      p.shield = 0;
      p.tracer = false;
      p.ready = false;
      p.ammo.normal = WEAPONS.normal.ammo;
      if (p.ammo[p.weapon] <= 0) p.weapon = "normal";
    });
    const wind = irange(rng.state, -10, 10);
    state.wind = wind.value;
    state.rng = wind.state;
    state.windLeft = state.players.length;
    state.current = opener;
    state.phase = "aiming";
    state.roundWinnerId = null;
    state.turn = 1;
    state.calm = 0;
    state.lava = null;
    state.hazards = [];
    state.guided = null;
    state.bonusFirstBlood = false;
    state.earnings = Object.fromEntries(state.players.map((p) => [p.id, 0]));
  }
  function cloneState(state) {
    return {
      ...state,
      terrain: cloneTerrain(state.terrain),
      props: state.props.map((p) => ({ ...p })),
      players: clonePlayers(state.players),
      earnings: { ...state.earnings }
    };
  }
  function clonePlayers(players) {
    return players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } }));
  }
  function shallow(state) {
    return { ...state, players: clonePlayers(state.players), earnings: { ...state.earnings } };
  }
  function applyCommand(state, command) {
    switch (command.type) {
      case "nextRound":
        return state.phase === "roundover" ? nextRound(state) : { state, events: [] };
      case "steer":
        return { state, events: [] };
      // v3 stub: el misil teledirigido lo implementa el área sim
      case "setKind": {
        const i = state.players.findIndex((p2) => p2.id === command.playerId);
        if (i < 0 || command.kind !== "human" && command.kind !== "ai" || state.players[i].kind === command.kind) return { state, events: [] };
        const next = shallow(state);
        const p = next.players[i];
        p.kind = command.kind;
        if (next.phase === "shop" && p.kind === "ai" && !p.ready) {
          aiShop(p, next.difficulty, next.seed, next.round);
          p.ready = true;
          return startIfReady(next, []);
        }
        return { state: next, events: [] };
      }
      case "buy":
      case "sell":
      case "ready":
        return state.phase === "shop" ? shop(state, command) : { state, events: [] };
    }
    if (state.phase !== "aiming") return { state, events: [] };
    const actor = state.players[state.current];
    if (!actor || actor.id !== command.playerId || !actor.alive) return { state, events: [] };
    switch (command.type) {
      case "aim": {
        const next = cloneState(state);
        const p = next.players[next.current];
        p.angle = clamp$1(Number.isFinite(command.angle) ? command.angle : p.angle, 0, 180);
        p.power = clamp$1(Number.isFinite(command.power) ? command.power : p.power, 0, 100);
        return { state: next, events: [] };
      }
      case "selectWeapon": {
        if (!(command.weapon in WEAPONS) || actor.ammo[command.weapon] <= 0) return { state, events: [] };
        const next = cloneState(state);
        next.players[next.current].weapon = command.weapon;
        return { state: next, events: [] };
      }
      case "move":
        return move(state, command.dir);
      case "fire":
        return fire(state, actor);
      case "useItem":
        return useItem(state, command.item);
    }
  }
  function useItem(state, item) {
    const actor = state.players[state.current];
    if (!(actor.items[item] > 0)) return { state, events: [] };
    const ok = item === "shield" ? actor.shield <= 0 : item === "repair" ? actor.hp < PLAYER_HP : item === "tracer" ? !actor.tracer : item === "fuel";
    if (!ok) return { state, events: [] };
    const next = shallow(state);
    const p = next.players[next.current];
    p.items[item] -= 1;
    if (item === "shield") p.shield = SHIELD_HP;
    else if (item === "repair") p.hp = Math.min(PLAYER_HP, p.hp + REPAIR_HP);
    else if (item === "tracer") p.tracer = true;
    else p.fuel += fuelFor(state.width);
    return { state: next, events: [{ type: "item", playerId: p.id, item }] };
  }
  const MOVE_FREE_FALL = 12;
  const CLIMB_FUEL = 0.6;
  function move(state, dir) {
    const actor = state.players[state.current];
    if (actor.fuel <= 0 || dir !== 1 && dir !== -1) return { state, events: [] };
    const step = stepTank(state, actor, actor.x, actor.y, dir, tankFloor);
    if (!step) return { state, events: [] };
    if (!step.air && slopeAt(state, step.x, step.floor) * -dir > SLIDE_SLOPE) return { state, events: [] };
    const next = shallow(state);
    const p = next.players[next.current];
    const events = [];
    const uphill = step.air ? 0 : Math.max(0, slopeAt(state, step.x, step.floor) * -dir, (actor.y - step.floor) / 2);
    p.x = step.x;
    p.y = step.floor;
    p.fuel = Math.max(0, p.fuel - (1 + CLIMB_FUEL * uphill));
    settleTank(next, p, events, void 0, void 0, MOVE_FREE_FALL);
    if (!p.alive) return endTurn(next, events, [], false);
    return { state: next, events };
  }
  function fire(state, actor) {
    if (actor.ammo[actor.weapon] <= 0) {
      if (!hasAmmo(actor)) return endTurn(cloneState(state), [{ type: "empty", playerId: actor.id }], [], false);
      return { state, events: [{ type: "empty", playerId: actor.id }] };
    }
    const next = cloneState(state);
    const shooter = next.players[next.current];
    shooter.ammo[shooter.weapon] -= 1;
    shooter.tracer = false;
    const weapon = shooter.weapon;
    const before = next.players.map((p) => ({ hp: p.hp + p.shield, alive: p.alive }));
    const { flights, events } = resolveShot(next, shooter, weapon);
    collapseAfterShot(next, events, shotEnd(events, flights) + COLLAPSE_DELAY, true);
    settleLiquids(next, events, flights);
    const abyss = /* @__PURE__ */ new Set();
    for (const e of events) if (e.type === "death" && e.cause === "abyss") abyss.add(e.playerId);
    let earned = 0;
    let damaged = [...abyss].some((id) => id !== shooter.id);
    for (const p of next.players) {
      const b = before[p.id];
      if (!b.alive) continue;
      const dmg = abyss.has(p.id) ? hitBeforeFall(events, p.id) : b.hp - (p.hp + p.shield);
      if (dmg > 0 && p.id !== shooter.id) damaged = true;
      if (p.id === shooter.id) earned += dmg * EARN.selfDamage;
      else {
        earned += dmg * EARN.perDamage;
        if (!p.alive) {
          earned += EARN.kill;
          shooter.kills += 1;
        }
      }
    }
    next.earnings[shooter.id] = (next.earnings[shooter.id] ?? 0) + earned;
    if (shooter.ammo[weapon] <= 0) {
      const fallback = WEAPON_ORDER.find((id) => shooter.ammo[id] > 0);
      if (fallback) shooter.weapon = fallback;
    }
    return { ...endTurn(next, events, flights, damaged), flights };
  }
  const FLOW_DELAY = 0.15;
  const FLOW_DT = 1 / 30;
  function settleLiquids(state, events, flights) {
    takeDirty(state.terrain);
    const t0 = performance.now();
    const report = flowLiquids(state.terrain, { seed: null, record: true });
    performance.now() - t0;
    if (!report.changed) return;
    const t = shotEnd(events, flights) + FLOW_DELAY;
    events.push({ type: "flow", t, dt: FLOW_DT, patches: report.patches });
    for (const s of report.steam) events.push({ type: "steam", x: Math.round(s.x), y: Math.round(s.y), n: s.n, t: t + s.frame * FLOW_DT });
    for (const b of report.burns) events.push({ type: "burn", x: b.x, y: b.y, w: b.w, t: t + b.frame * FLOW_DT });
    settleAfterFlow(state, events, t + (report.patches.length - 1) * FLOW_DT);
  }
  function hitBeforeFall(events, id) {
    let n = 0;
    for (const e of events) {
      if (e.type === "damage" && e.playerId === id) n += e.amount;
      else if (e.type === "shield" && e.playerId === id) n += e.absorbed;
    }
    return n;
  }
  const LAVA_DELAY = 0.4;
  function suddenDeath(state) {
    return state.calm >= SUDDEN_DEATH_CALM;
  }
  function endTurn(state, events, flights, damaged) {
    const leftBefore = Math.max(0, SUDDEN_DEATH_CALM - state.calm);
    state.calm = damaged ? 0 : Math.min(SUDDEN_DEATH_CALM, state.calm + 1);
    const left = Math.max(0, SUDDEN_DEATH_CALM - state.calm);
    if (left !== leftBefore) events.push({ type: "calm", left });
    if (state.players.filter((p) => p.alive).length > 1) {
      const t = shotEnd(events, flights) + LAVA_DELAY;
      if (suddenDeath(state)) riseLava(state, events);
      burnInLava(state, events, t);
    }
    return advance(state, events);
  }
  function shotEnd(events, flights) {
    let end = 0;
    for (const f of flights) end = Math.max(end, (f.startT ?? 0) + Math.max(0, f.path.length - 1) * PATH_DT);
    for (const e of events) {
      if ("t" in e && typeof e.t === "number") end = Math.max(end, e.t);
      if (e.type === "flow" || e.type === "collapse") end = Math.max(end, e.t + Math.max(0, e.patches.length - 1) * e.dt);
    }
    return end;
  }
  function riseLava(state, events) {
    const from = state.lava;
    const to = Math.max(0, (from ?? state.height) - LAVA_RISE);
    state.lava = to;
    events.push({ type: "lava", from, to, warn: 0 });
  }
  function burnInLava(state, events, t) {
    const band = state.lava;
    const victims = state.players.filter((p) => p.alive && (band !== null && p.y > band || inLava(state.terrain, p)));
    victims.sort((a, b) => b.y - a.y || a.hp + a.shield - (b.hp + b.shield) || a.id - b.id);
    let fallen = null;
    for (const p of victims) {
      const life = p.hp + p.shield;
      const engulfed = band !== null && band <= p.y - TANK_H || engulfedInLava(state.terrain, p);
      const dies = engulfed || life <= LAVA_DAMAGE;
      const last = state.players.every((q) => q === p || !q.alive);
      if (dies && last && !(fallen && fallen.y === p.y && fallen.life === life)) continue;
      const mark = events.length;
      if (engulfed) kill(p, events, "lava");
      else hurt(p, LAVA_DAMAGE, events);
      if (!p.alive) fallen = { y: p.y, life };
      for (let i = mark; i < events.length; i++) {
        const e = events[i];
        if (e.type === "damage") {
          e.t = t;
          e.cause = "lava";
        } else if (e.type === "death" || e.type === "shield") e.t = t;
      }
    }
  }
  function advance(state, events) {
    const alive = state.players.filter((p) => p.alive);
    if (alive.length <= 1) return endRound(state, events, alive[0]?.id ?? null);
    for (let i = 1; i <= state.players.length; i++) {
      const idx = (state.current + i) % state.players.length;
      if (state.players[idx].alive) {
        state.current = idx;
        break;
      }
    }
    state.windLeft -= 1;
    const windChanged = state.windLeft <= 0;
    if (windChanged) {
      const wind = irange(state.rng, -10, 10);
      state.wind = wind.value;
      state.rng = wind.state;
      state.windLeft = alive.length;
    }
    state.turn += 1;
    state.players[state.current].fuel = fuelFor(state.width);
    events.push({ type: "turn", playerId: state.players[state.current].id });
    if (windChanged) events.push({ type: "wind", value: state.wind });
    return { state, events };
  }
  function endRound(state, events, winnerId) {
    state.phase = "roundover";
    state.roundWinnerId = winnerId;
    const earnings = {};
    for (const p of state.players) {
      let e = state.earnings[p.id] ?? 0;
      if (p.alive) e += EARN.survive;
      if (p.id === winnerId) {
        e += EARN.roundWin;
        p.roundsWon += 1;
      }
      const money = Math.max(0, p.money + Math.round(e));
      earnings[p.id] = money - p.money;
      p.money = money;
    }
    state.earnings = earnings;
    events.push({ type: "roundover", winnerId, earnings: { ...earnings }, last: state.round >= state.rounds });
    return { state, events };
  }
  function nextRound(state) {
    const next = shallow(state);
    const events = [];
    if (next.round >= next.rounds) {
      next.phase = "gameover";
      next.winnerId = matchWinner(next.players);
      events.push({ type: "gameover", winnerId: next.winnerId });
      return { state: next, events };
    }
    next.phase = "shop";
    for (const p of next.players) {
      p.ready = p.kind === "ai";
      if (p.kind === "ai") aiShop(p, next.difficulty, next.seed, next.round);
    }
    events.push({ type: "shop" });
    return startIfReady(next, events);
  }
  function shop(state, command) {
    const idx = state.players.findIndex((p2) => p2.id === command.playerId);
    if (idx < 0 || state.players[idx].ready) return { state, events: [] };
    const next = shallow(state);
    const p = next.players[idx];
    if (command.type === "ready") {
      p.ready = true;
      return startIfReady(next, []);
    }
    const entry = shopEntry(command.id);
    if (!entry) return { state, events: [] };
    const ok = command.type === "buy" ? buyEntry(p, entry) : sellEntry(p, entry);
    return ok ? { state: next, events: [] } : { state, events: [] };
  }
  function startIfReady(state, events) {
    if (!state.players.every((p) => p.ready)) return { state, events };
    state.round += 1;
    setupRound(state);
    events.push({ type: "round", round: state.round, biome: state.biome });
    events.push({ type: "turn", playerId: state.players[state.current].id });
    events.push({ type: "wind", value: state.wind });
    return { state, events };
  }
  function matchWinner(players) {
    const key = (p) => [p.roundsWon, p.kills, p.money];
    const sorted2 = [...players].sort((a2, b2) => {
      const ka = key(a2);
      const kb = key(b2);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    });
    const [a, b] = sorted2;
    if (b && a.roundsWon === b.roundsWon && a.kills === b.kills && a.money === b.money) return null;
    return a.id;
  }
  function hasAmmo(player) {
    return WEAPON_ORDER.some((id) => player.ammo[id] > 0);
  }
  function clamp$1(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }
  const ERROR = {
    easy: { angle: 9, power: 12 },
    normal: { angle: 7, power: 8 },
    hard: { angle: 1, power: 1.5 }
  };
  const ERROR_SCALE_EXP = 1.15;
  function mapScale(state) {
    return state.terrain.w / WORLD_W;
  }
  const COST = {
    normal: 0,
    heavy: 90,
    dirt: 1e9,
    cluster: 110,
    napalm: 60,
    digger: 400,
    roller: 60,
    nuke: 450,
    // v3: valores iniciales; el área sim los ajusta
    guided: 200,
    bouncer: 120,
    laser: 150,
    mine: 1e9,
    quake: 1e9,
    blackhole: 1e9,
    acid: 150,
    wall: 1e9
  };
  const LAVA_COST_SCALE = 0.25;
  const SELF_WEIGHT = 18;
  const TIE_EPS = 1e-6;
  function flatTie(angle) {
    return -Math.min(angle, 180 - angle) * TIE_EPS;
  }
  const NEAR_W = 0.15;
  const NEAR_RANGE = 600;
  const STRONG_W = 0.3;
  const LEADER_W = 0.1;
  const DUTY_W = 0.15;
  const EDGE_W = 0.12;
  const KILL_BONUS = 40;
  function priorities(actor, targets) {
    const out = /* @__PURE__ */ new Map();
    if (targets.length < 2) {
      for (const t of targets) out.set(t.id, 1);
      return out;
    }
    const topWins = Math.max(...targets.map((t) => t.roundsWon));
    const leaders = targets.filter((t) => t.roundsWon === topWins).length;
    for (const t of targets) {
      let w = 1 + NEAR_W * Math.max(0, 1 - Math.abs(t.x - actor.x) / NEAR_RANGE);
      const mine = Math.abs(t.x - actor.x);
      if (targets.every((o) => o === t || Math.abs(o.x - t.x) >= mine)) w += DUTY_W;
      if (actor.x > t.x ? targets.every((o) => o.x >= t.x) : targets.every((o) => o.x <= t.x)) w += EDGE_W;
      w += STRONG_W * Math.min(PLAYER_HP, t.hp + t.shield) / PLAYER_HP;
      if (topWins > 0 && leaders === 1 && t.roundsWon === topWins) w += LEADER_W;
      out.set(t.id, w);
    }
    return out;
  }
  function costOf(state, id) {
    return state.lava !== null ? COST[id] * LAVA_COST_SCALE : COST[id];
  }
  function lavaRisk(state, y) {
    if (state.lava === null) return 0;
    const rises = state.players.filter((p) => p.alive).length;
    let n = 0;
    for (let k = 1; k <= rises; k++) if (y > state.lava - k * LAVA_RISE) n++;
    return n * LAVA_DAMAGE * SELF_WEIGHT;
  }
  function poolRisk(state, p) {
    return inLava(state.terrain, p) ? 2 * LAVA_DAMAGE * SELF_WEIGHT : 0;
  }
  const ITEM_HP = {
    easy: { repair: 40, shield: 55 },
    normal: { repair: 60, shield: 80 },
    hard: { repair: PLAYER_HP - REPAIR_HP, shield: PLAYER_HP }
  };
  function chooseItems(state, difficulty) {
    const actor = state.players[state.current];
    const th = ITEM_HP[difficulty];
    const items = [];
    if (actor.items.repair > 0 && actor.hp <= th.repair) items.push("repair");
    const rivals = state.players.filter((p) => p.alive && p.id !== actor.id).length;
    const threat = difficulty === "hard" ? rivals >= 2 || actor.hp < PLAYER_HP : actor.hp <= th.shield;
    if (actor.items.shield > 0 && actor.shield <= 0 && threat) items.push("shield");
    return items;
  }
  const PUSH_POOL = 6;
  function chooseShot(state, difficulty, random) {
    const actor = state.players[state.current];
    const rand = random ?? rngFor(state);
    flowBudget = flowBudgetFor(state.terrain.w);
    centerAlways = difficulty === "hard";
    const weapons = WEAPON_ORDER.filter((id) => actor.ammo[id] > 0 && WEAPONS[id].terrain !== "build");
    const fallback = weapons[0] ?? WEAPON_ORDER.find((id) => actor.ammo[id] > 0) ?? "normal";
    const targets = state.players.filter((p) => p.alive && p.id !== actor.id);
    const items = chooseItems(state, difficulty);
    const extra = items.length > 0 ? { items } : {};
    if (targets.length === 0 || weapons.length === 0) {
      return { angle: actor.angle, power: Math.max(30, actor.power), weapon: fallback, ...extra };
    }
    const here = search(state, weapons, true);
    let best = here.best;
    let move2 = 0;
    const wander = rand() < 0.15;
    const risk = lavaRisk(state, actor.y) + poolRisk(state, actor);
    const total = best.score - risk;
    if (actor.fuel > 0 && (best.score < 1e3 || wander || risk > 0)) {
      const steps = risk > 0 ? [-60, -40, -20, 20, 40, 60] : best.score < 1e3 ? [-40, -20, 20, 40] : [-20, 20];
      let top = total + 60;
      for (const d of steps) {
        const moved = walk(state, d);
        if (!moved) continue;
        const c = search(moved.state, weapons, false).best;
        const mp = moved.state.players[moved.state.current];
        const score = c.score - lavaRisk(state, mp.y) - poolRisk(moved.state, mp);
        if (score > top) {
          best = c;
          top = score;
          move2 = moved.dx;
        }
      }
    }
    if (best.score < 1e3 && difficulty !== "easy") {
      const b = bridgePlan(state, targets);
      if (b?.shot) {
        best = { angle: b.shot.angle, power: b.shot.power, weapon: "dirt", score: 0 };
        move2 = b.move;
      } else if (b) {
        best = search(b.state, weapons, false).best;
        move2 = b.move;
      }
    }
    if (best.score < 1e3 && best.weapon !== "dirt" && move2 === 0 && here.blocked > 0.5 && actor.ammo.digger > 0) {
      const t = nearest(actor, targets);
      return { angle: t.x > actor.x ? 30 : 150, power: 45, weapon: "digger", ...extra };
    }
    const k = mapScale(state);
    const errScale = k > 1 ? k ** ERROR_SCALE_EXP : 1;
    const err = ERROR[difficulty];
    const q = k > 1 ? 10 : 1;
    const round = (n) => Math.round(n * q) / q;
    const plan = {
      angle: clamp(round(best.angle + (rand() * 2 - 1) * err.angle / errScale), 0, 180),
      power: clamp(round(best.power + (rand() * 2 - 1) * err.power / errScale), 10, 100),
      weapon: best.weapon
    };
    if (move2 !== 0) plan.move = move2;
    if (items.length > 0) plan.items = items;
    return plan;
  }
  const AI_ABYSS_MARGIN = 24;
  function walk(state, dx) {
    const id = state.players[state.current].id;
    const dir = dx > 0 ? 1 : -1;
    const want = Math.abs(dx);
    const states = [state];
    let s = state;
    let limit = want;
    const t = state.terrain;
    const x = state.players[state.current].x;
    const reach = want + AI_ABYSS_MARGIN + TANK_HALF_W + SLIDE_MAX;
    let pit = false;
    if (t.pits) for (let k = 0; k <= reach && !pit; k++) pit = t.pits[Math.round(x + dir * k)] === 1;
    for (let n2 = 0; n2 < want + (pit ? AI_ABYSS_MARGIN : 0); n2++) {
      const r = applyCommand(s, { type: "move", playerId: id, dir });
      if (r.state === s) break;
      if (r.state.current !== s.current || r.state.phase !== "aiming") {
        const abyss = r.events.some((e) => e.type === "death" && e.playerId === id && e.cause === "abyss");
        limit = Math.min(limit, abyss ? n2 - AI_ABYSS_MARGIN : n2);
        break;
      }
      if (inLava(r.state.terrain, r.state.players[r.state.current]) && !inLava(s.terrain, s.players[s.current])) {
        limit = Math.min(limit, n2);
        break;
      }
      s = r.state;
      states.push(s);
    }
    const n = Math.min(limit, states.length - 1);
    if (n < 4) return null;
    return { state: states[n], dx: dir * n };
  }
  const BRIDGE_SCAN = 320;
  const BRIDGE_AHEAD = 6;
  const BRIDGE_TOL = 10;
  const BRIDGE_CLEAR = TANK_HALF_W + WEAPONS.dirt.radius / 2 + 6;
  function bridgePlan(state, targets) {
    const actor = state.players[state.current];
    if (actor.ammo.dirt <= 0 || targets.length === 0) return null;
    const goal = nearest(actor, targets);
    const dir = goal.x > actor.x ? 1 : -1;
    const t = state.terrain;
    let any = false;
    for (let x = Math.round(actor.x); x !== Math.round(goal.x) && !any; x += dir) {
      const top = columnTop(t, x);
      any = top < t.h && t.front[top * t.w + x] === LAVA;
    }
    if (!any) return null;
    let moved = actor.fuel > 0 ? walk(state, dir * Math.ceil(actor.fuel)) : null;
    let s = moved?.state ?? state;
    let p = s.players[s.current];
    let lx = -1;
    for (let d = 0; d <= BRIDGE_SCAN && lx < 0; d++) {
      const x = Math.round(p.x + dir * d);
      if (x < 0 || x >= t.w || (x - goal.x) * dir >= 0) break;
      const top = columnTop(t, x, Math.max(0, p.y - 2 * TANK_H));
      if (top < t.h && t.front[top * t.w + x] === LAVA) lx = x;
    }
    if (lx < 0) return moved ? { move: moved.dx, state: s } : null;
    const ax = lx + dir * BRIDGE_AHEAD;
    const ay = columnTop(t, lx, Math.max(0, p.y - 2 * TANK_H));
    if (Math.abs(ax - p.x) < BRIDGE_CLEAR) {
      const dx = Math.round(ax - dir * BRIDGE_CLEAR - actor.x);
      moved = Math.abs(dx) >= 4 && actor.fuel > 0 ? walk(state, dx) : null;
      s = moved?.state ?? state;
      p = s.players[s.current];
      if (Math.abs(ax - p.x) < BRIDGE_CLEAR) return null;
    }
    const sky = skylineOf(s.terrain, s.players, s.props);
    let best = { angle: 0, power: 0, d: Infinity };
    const tryShot = (angle, power) => {
      const f = fly({ skyline: sky, terrain: s.terrain, players: s.players, props: s.props, ownerId: p.id, angle, power, wind: s.wind, lava: s.lava ?? void 0, lavaSolid: true });
      if (f.impact.kind !== "terrain") return;
      const d = Math.hypot(f.impact.x - ax, f.impact.y - ay);
      if (Math.abs(f.impact.x - p.x) < BRIDGE_CLEAR) return;
      if (d < best.d) best = { angle, power, d };
    };
    const k = mapScale(state);
    const a0 = dir > 0 ? 6 : 96;
    for (let angle = a0; angle <= a0 + 78; angle += 4) for (let power = k > 1 ? 10 : 20; power <= 100; power += 4) tryShot(angle, power);
    if (best.d < 60) {
      const { angle: a1, power: p1 } = best;
      for (let a = -3; a <= 3; a += 1) for (let pw = -3; pw <= 3; pw += 0.5) tryShot(clamp(a1 + a, 0, 180), clamp(p1 + pw, 10, 100));
    }
    if (best.d > BRIDGE_TOL) return null;
    return { shot: { angle: best.angle, power: best.power }, move: moved?.dx ?? 0, state: s };
  }
  function search(state, weapons, fine) {
    const actor = state.players[state.current];
    const targets = state.players.filter((p) => p.alive && p.id !== actor.id);
    const perWeapon = /* @__PURE__ */ new Map();
    let best = { angle: actor.angle, power: actor.power, weapon: weapons[0], score: -Infinity };
    let total = 0;
    let blocked = 0;
    const sky = skylineOf(state.terrain, state.players, state.props);
    const prio = priorities(actor, targets);
    const ledges = ledgesOf(state.terrain, targets);
    let aim = { angle: 0, power: 0, d: Infinity };
    const pushes = [];
    const addPush = (c) => {
      if (pushes.some((q) => q.angle === c.angle && q.power === c.power)) return;
      pushes.push(c);
      pushes.sort((a, b) => b.score - a.score);
      if (pushes.length > PUSH_POOL) pushes.pop();
    };
    const lips = lavaLipsOf(state.terrain, targets);
    const lipAim = lips.map(() => ({ angle: 0, power: 0, d: Infinity }));
    const brinks = brinksOf(state.terrain, targets);
    const brinkAim = brinks.map(() => ({ angle: 0, power: 0, d: Infinity }));
    let direct = false;
    const consider = (angle, power) => {
      const r = estimate(state, actor, targets, weapons, angle, power, sky, ledges, prio);
      total++;
      if (r.at) {
        for (const l of ledges) {
          const d = Math.abs(r.at.x - l.p.x) + Math.max(0, r.at.y - l.p.y);
          if (d < aim.d) aim = { angle, power, d };
        }
        for (let i = 0; i < lips.length; i++) {
          const d = Math.abs(r.at.x - lips[i].x) + Math.abs(r.at.y - lips[i].y);
          if (d < lipAim[i].d) lipAim[i] = { angle, power, d };
        }
        for (let i = 0; i < brinks.length; i++) {
          const d = Math.abs(r.at.x - brinks[i].x) + Math.abs(r.at.y - brinks[i].y);
          if (d < brinkAim[i].d) brinkAim[i] = { angle, power, d };
        }
      }
      if (r.blocked) blocked++;
      if (r.direct) direct = true;
      for (const c of r.list) {
        const prev = perWeapon.get(c.weapon);
        if (!prev || c.score > prev.score) perWeapon.set(c.weapon, c);
        if (c.score > best.score) best = c;
        if (c.push) addPush(c);
      }
    };
    const k = mapScale(state);
    const da = fine ? 6 : 12;
    const dp = fine ? 4 : 8;
    const p0 = k > 1 ? 12 : 24;
    for (let angle = 6; angle <= 174; angle += da) for (let power = p0; power <= 100; power += dp) consider(angle, power);
    const narrow = fine && !direct;
    if (narrow) mortar(state, actor, nearest(actor, targets), sky, consider);
    if (aim.d < 40) {
      for (let a = -3; a <= 3; a += 1) for (let p = -2; p <= 2; p += 0.5) consider(clamp(aim.angle + a, 0, 180), clamp(aim.power + p, 10, 100));
    }
    if (fine) {
      const a0 = best.angle;
      const p02 = best.power;
      for (let a = -4; a <= 4; a += 1) for (let p = -3; p <= 3; p += 1) consider(clamp(a0 + a, 0, 180), clamp(p02 + p, 10, 100));
    }
    if (k > 1) {
      const a1 = best.angle;
      const p1 = best.power;
      for (let a = -1; a <= 1; a += 0.5) for (let p = -1; p <= 1; p += 0.25) if (a !== 0 || p !== 0) consider(clamp(a1 + a, 0, 180), clamp(p1 + p, 10, 100));
    }
    for (let i = 0; i < lips.length; i++) {
      const la = lipAim[i];
      if (la.d >= 40) continue;
      for (let a = -2; a <= 2; a += 1) for (let p = -1.5; p <= 1.5; p += 0.5) consider(clamp(la.angle + a, 0, 180), clamp(la.power + p, 10, 100));
    }
    for (let i = 0; i < brinks.length; i++) {
      const ba = brinkAim[i];
      if (ba.d >= 40) continue;
      for (let a = -2; a <= 2; a += 1) for (let p = -1.5; p <= 1.5; p += 0.5) consider(clamp(ba.angle + a, 0, 180), clamp(ba.power + p, 10, 100));
    }
    const pool = [...perWeapon.values(), best, ...pushes];
    for (const ba of brinkAim) {
      if (ba.d >= 16) continue;
      for (const id of BRINK_WEAPONS) if (weapons.includes(id)) pool.push({ angle: ba.angle, power: ba.power, weapon: id, score: 0 });
    }
    const lipWeapon = weapons.includes("heavy") ? "heavy" : weapons[0];
    for (const la of lipAim) if (la.d < 16) pool.push({ angle: la.angle, power: la.power, weapon: lipWeapon, score: 0 });
    let verified = { ...best, score: -Infinity };
    for (const c of pool) {
      const score = simulate(state, c, prio);
      if (score > verified.score) verified = { ...c, score };
    }
    if ((narrow || centerAlways) && verified.score > 0) {
      const c = center(state, actor, verified, sky);
      if (c !== verified) {
        const score = simulate(state, c, prio);
        if (score >= verified.score - 1) verified = { ...c, score };
      }
    }
    return { best: verified, blocked: total > 0 ? blocked / total : 0 };
  }
  const CENTER_STEP = 0.2;
  const CENTER_SPAN = 4;
  function center(state, actor, c, sky) {
    const shot = (angle, power) => fly({ skyline: sky, terrain: state.terrain, players: state.players, props: state.props, ownerId: actor.id, angle, power, wind: state.wind, lava: state.lava ?? void 0 }).impact;
    const first = shot(c.angle, c.power);
    if (first.kind !== "tank" || first.tankId === void 0 || first.tankId === actor.id) return c;
    const id = first.tankId;
    const hit = (angle, power) => {
      const imp = shot(angle, power);
      return imp.kind === "tank" && imp.tankId === id;
    };
    const mid = (v0, lo, hi, f) => {
      let a2 = v0;
      let b = v0;
      while (a2 - CENTER_STEP >= lo && v0 - a2 < CENTER_SPAN && f(a2 - CENTER_STEP)) a2 -= CENTER_STEP;
      while (b + CENTER_STEP <= hi && b - v0 < CENTER_SPAN && f(b + CENTER_STEP)) b += CENTER_STEP;
      return Math.round((a2 + b) / 2 * 100) / 100;
    };
    let p = mid(c.power, 10, 100, (v) => hit(c.angle, v));
    const a = mid(c.angle, 0, 180, (v) => hit(v, p));
    if (hit(a, p)) p = mid(p, 10, 100, (v) => hit(a, v));
    if (!hit(a, p)) return c;
    return a === c.angle && p === c.power ? c : { ...c, angle: a, power: p };
  }
  function estimate(state, actor, targets, weapons, angle, power, skyline, ledges = [], prio) {
    const flight = fly({
      skyline,
      terrain: state.terrain,
      players: state.players,
      props: state.props,
      ownerId: actor.id,
      angle,
      power,
      wind: state.wind,
      lava: state.lava ?? void 0
    });
    if (flight.impact.kind === "out" || flight.impact.kind === "lava") return { list: [{ angle, power, weapon: weapons[0], score: -1e6 }], blocked: false };
    const { x, y } = flight.impact;
    const m = muzzle(actor.x, actor.y, angle, tankTilt(state.terrain, actor.x, actor.y));
    const blocked = Math.hypot(x - m.x, y - m.y) < 30;
    let near = Infinity;
    for (const t of targets) near = Math.min(near, Math.hypot(t.x - x, t.y - TANK_H / 2 - y));
    const list = [];
    const wet = submerged(state.terrain, x, y) ? WATER_BLAST_SCALE : 1;
    for (const id of weapons) {
      const w = WEAPONS[id];
      const spread = w.split ? 2.4 : w.rolls ? 2 : 1;
      const blast = { x, y, radius: w.radius * spread * wet, damage: w.damage, terrain: w.terrain };
      let dmg = 0;
      for (const t of targets) {
        let d = t.id === flight.impact.tankId ? w.damage : blastDamage(t, blast);
        if (w.burn && Math.abs(t.x - x) < NAPALM_SPREAD && Math.abs(t.y - y) < 30) d += NAPALM_DPS * w.burn;
        const hit = Math.min(t.hp + t.shield, d);
        if (hit > 0) dmg += hit * (prio?.get(t.id) ?? 1) + (d >= t.hp + t.shield ? KILL_BONUS : 0);
      }
      let push = false;
      if (w.terrain === "destroy") {
        for (const l of ledges) {
          if (!dropsInto(l, x, y, w.radius)) continue;
          dmg += l.p.hp + l.p.shield + 25;
          push = true;
        }
      }
      const self2 = blastDamage(actor, blast);
      const cost = costOf(state, id);
      const score = (dmg > 0 ? 1e3 + dmg * 10 - self2 * SELF_WEIGHT - cost : -near - self2 * SELF_WEIGHT - cost * 0.01) + flatTie(angle);
      list.push(push ? { angle, power, weapon: id, score, push } : { angle, power, weapon: id, score });
    }
    const direct = flight.impact.kind === "tank" && targets.some((t) => t.id === flight.impact.tankId);
    return { list, blocked, at: flight.impact, direct };
  }
  const MORTAR_A0 = 40;
  const MORTAR_A1 = 88;
  const MORTAR_DA = 2.5;
  const MORTAR_STEPS = 9;
  function mortar(state, actor, target, sky, consider) {
    const dir = target.x > actor.x ? 1 : -1;
    for (let a = MORTAR_A0; a <= MORTAR_A1; a += MORTAR_DA) {
      const angle = dir > 0 ? a : 180 - a;
      let lo = 10;
      let hi = 100;
      for (let k = 0; k < MORTAR_STEPS; k++) {
        const p2 = (lo + hi) / 2;
        const f = fly({ skyline: sky, terrain: state.terrain, players: state.players, props: state.props, ownerId: actor.id, angle, power: p2, wind: state.wind, lava: state.lava ?? void 0 });
        if (f.impact.kind === "tank" && f.impact.tankId === target.id) {
          lo = hi = p2;
          break;
        }
        const long = f.impact.kind === "out" || (f.impact.x - target.x) * dir > 0;
        if (long) hi = p2;
        else lo = p2;
      }
      const p = (lo + hi) / 2;
      for (const dp of [-0.5, 0, 0.5]) consider(angle, clamp(p + dp, 10, 100));
    }
  }
  const MIN_SUPPORT = 3;
  function ledgesOf(t, targets) {
    const out = [];
    if (!t.pits) return out;
    for (const p of targets) {
      const cx = Math.round(p.x);
      let any = false;
      for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W && !any; ix++) if (ix >= 0 && ix < t.w && t.pits[ix]) any = true;
      if (!any) continue;
      const cuts = [];
      let anchored = 0;
      for (let ix = cx - TANK_HALF_W; ix < cx + TANK_HALF_W; ix++) {
        if (ix < 0 || ix >= t.w) continue;
        let y = Math.max(0, p.y);
        if (y >= t.h || t.front[y * t.w + ix] === 0) continue;
        while (y < t.h && t.front[y * t.w + ix] !== 0) y++;
        let open = t.pits[ix] === 1;
        for (let yy = y; open && yy < t.h; yy++) if (t.front[yy * t.w + ix] !== 0) open = false;
        if (open) cuts.push({ x: ix, y: y - 1 });
        else anchored++;
      }
      if (anchored < MIN_SUPPORT && cuts.length > 0) out.push({ p, cuts, anchored });
    }
    return out;
  }
  function dropsInto(l, x, y, r) {
    let left = l.anchored;
    const r2 = r * r;
    for (const c of l.cuts) if ((c.x - x) ** 2 + (c.y - y) ** 2 > r2) left++;
    return left < MIN_SUPPORT;
  }
  let scratch = null;
  function scratchCopy(t) {
    if (!scratch || scratch.front.length !== t.front.length) {
      scratch = { w: t.w, h: t.h, front: new Uint8Array(t.front.length), back: new Uint8Array(t.back.length) };
    }
    scratch.w = t.w;
    scratch.h = t.h;
    scratch.front.set(t.front);
    scratch.back.set(t.back);
    scratch.pits = t.pits;
    return scratch;
  }
  function scratchState(state) {
    return {
      ...state,
      terrain: scratchCopy(state.terrain),
      props: state.props.map((p) => ({ ...p })),
      players: state.players.map((p) => ({ ...p, ammo: { ...p.ammo }, items: { ...p.items } })),
      earnings: { ...state.earnings }
    };
  }
  function simulate(state, c, prio) {
    const s = scratchState(state);
    const actor = s.players[s.current];
    actor.angle = c.angle;
    actor.power = c.power;
    const before = s.players.map((p) => ({ hp: p.hp, alive: p.alive, x: p.x, y: p.y }));
    const { events } = resolveShot(s, actor, c.weapon);
    collapseAfterShot(s, events, 0, false);
    const dirty = takeDirty(s.terrain);
    if (flowBudget > 0 && dirty && hasLiquid(s.terrain, LAVA, dirty.x0 - 2, dirty.y0 - 2, dirty.x1 + 3, dirty.y1 + 3)) {
      flowBudget--;
      flowLiquids(s.terrain, { seed: dirty, record: false, maxIters: AI_FLOW_ITERS, extraIters: 0 });
    }
    let dmg = 0;
    let kills = 0;
    let near = Infinity;
    for (const p of s.players) {
      const b = before[p.id];
      if (p.id === actor.id || !b.alive) continue;
      dmg += (b.hp - p.hp) * (prio?.get(p.id) ?? 1);
      if (!p.alive) kills++;
      else if (newlyInLava(state, s, p.id)) dmg += Math.min(p.hp + p.shield, AI_LAVA_HIT);
      for (const e of events) if (e.type === "impact") near = Math.min(near, Math.hypot(p.x - e.x, p.y - TANK_H / 2 - e.y));
    }
    let self2 = before[actor.id].hp - actor.hp;
    if (actor.alive && newlyInLava(state, s, actor.id)) self2 += AI_LAVA_HIT;
    if (!actor.alive) return -1e5;
    if (!Number.isFinite(near)) return -1e6;
    const mask = hazardMask(state.terrain);
    let drift = 0;
    for (const p of s.players) {
      if (!p.alive || !before[p.id].alive || p.x === before[p.id].x) continue;
      const d0 = hazardDist(mask, before[p.id].x, before[p.id].y);
      const d1 = hazardDist(mask, p.x, p.y);
      if (d1 >= d0) continue;
      drift += p.id === actor.id ? -2 * (d0 - d1) * HAZARD_PULL : (d0 - d1) * HAZARD_PULL;
    }
    const cost = costOf(state, c.weapon);
    return (dmg > 0 ? 1e3 + dmg * 10 + kills * KILL_BONUS * 10 - self2 * SELF_WEIGHT - cost : -near - self2 * SELF_WEIGHT - cost * 0.01) + drift + flatTie(c.angle);
  }
  const HAZARD_RANGE = 160;
  const HAZARD_PULL = 3;
  const HAZARD_NONE = 32767;
  const hazardCache = /* @__PURE__ */ new WeakMap();
  function hazardMask(t) {
    const cached = hazardCache.get(t);
    if (cached) return cached;
    const m = new Int16Array(t.w).fill(HAZARD_NONE);
    for (let x = 0; x < t.w; x++) {
      const top = columnTop(t, x);
      if (top < t.h && t.front[top * t.w + x] === LAVA) m[x] = 0;
      else if (t.pits?.[x]) {
        let y = t.h;
        while (y > 0 && t.front[(y - 1) * t.w + x] === 0) y--;
        m[x] = y;
      }
    }
    hazardCache.set(t, m);
    return m;
  }
  function hazardDist(m, x, y) {
    const cx = Math.round(x);
    for (let d = 0; d < HAZARD_RANGE; d++) {
      const a = cx - TANK_HALF_W - d;
      const b = cx + TANK_HALF_W - 1 + d;
      if (a >= 0 && m[a] <= y || b < m.length && m[b] <= y) return d;
    }
    return HAZARD_RANGE;
  }
  const edgeCache = /* @__PURE__ */ new WeakMap();
  function poolEdges(t) {
    const cached = edgeCache.get(t);
    if (cached) return cached;
    const out = [];
    let start = -1;
    let startY = 0;
    let lastY = 0;
    for (let x = 0; x <= t.w; x++) {
      const top = x < t.w ? columnTop(t, x) : t.h;
      const lava = top < t.h && t.front[top * t.w + x] === LAVA;
      if (lava) {
        if (start < 0) {
          start = x;
          startY = top;
        }
        lastY = top;
      } else if (start >= 0) {
        if (start > 0) out.push({ x: start - 1, y: startY, side: -1 });
        if (x < t.w) out.push({ x, y: lastY, side: 1 });
        start = -1;
      }
    }
    edgeCache.set(t, out);
    return out;
  }
  const LIP_RANGE = 320;
  function lavaLipsOf(t, targets) {
    const out = [];
    for (const e of poolEdges(t)) {
      const toward = targets.some((p) => (p.x - e.x) * e.side > 0 && Math.abs(p.x - e.x) < LIP_RANGE && p.y > e.y + 6);
      if (toward) out.push({ x: e.x + e.side * 2, y: e.y + 4 });
    }
    return out;
  }
  const BRINK_REACH = KNOCKBACK_MAX + 8;
  const BRINK_WEAPONS = ["heavy", "normal", "nuke"];
  function brinksOf(t, targets) {
    const out = [];
    for (const p of targets) {
      for (const side of [-1, 1]) {
        let hazard = false;
        for (let d = TANK_HALF_W; d <= TANK_HALF_W + BRINK_REACH && !hazard; d += 2) {
          const x = Math.round(p.x + side * d);
          if (x < 0 || x >= t.w) break;
          if (t.pits?.[x] && columnTop(t, x, Math.max(0, p.y - TANK_H)) >= t.h) hazard = true;
          else {
            const top = columnTop(t, x, Math.max(0, p.y - TANK_H));
            if (top < t.h && t.front[top * t.w + x] === LAVA) hazard = true;
          }
        }
        if (hazard) out.push({ x: p.x - side * (TANK_HALF_W + 3), y: p.y - 3 });
      }
    }
    return out;
  }
  const AI_LAVA_HIT = 2 * LAVA_DAMAGE;
  const AI_FLOW_ITERS = 200;
  const AI_FLOW_BUDGET = 8;
  let flowBudget = AI_FLOW_BUDGET;
  let centerAlways = false;
  function flowBudgetFor(width) {
    return Math.min(AI_FLOW_BUDGET, Math.round(AI_FLOW_BUDGET * (1600 / width) ** 2));
  }
  function newlyInLava(before, after, id) {
    const a = after.players[id];
    if (!inLava(after.terrain, a)) return false;
    return !inLava(before.terrain, before.players[id]);
  }
  function nearest(actor, targets) {
    let best = targets[0];
    for (const t of targets) if (Math.abs(t.x - actor.x) < Math.abs(best.x - actor.x)) best = t;
    return best;
  }
  function rngFor(state) {
    const r = new Rng(hashSeed(state.rng ^ Math.imul(state.turn, 2654435761) ^ state.current));
    return () => r.next();
  }
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }
  const f64 = new Float64Array(1);
  new Uint32Array(f64.buffer);
  function seededRandom(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const scope = self;
  scope.onmessage = (e) => {
    const { id, state, difficulty, seed } = e.data;
    try {
      const plan = chooseShot(state, difficulty, seededRandom(seed));
      scope.postMessage({ id, plan });
    } catch (err) {
      scope.postMessage({ id, plan: null, error: String(err) });
    }
  };
})();
