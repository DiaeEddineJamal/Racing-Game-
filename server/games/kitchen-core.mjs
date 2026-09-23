/**
 * Lmongolyan Chefs: kitchen rules, recipes and the CPU chef.
 *
 * SHARED FILE. The server and the browser game run this exact module. Edit it
 * here, in racing-game/server/games/, then run `npm run sync:cores` from the
 * repository root to copy it into the game.
 *
 * The kitchen is a grid. Chefs walk on floor tiles and work the tile they
 * face: crates hand out raw food, boards chop, stoves cook patties, plates
 * collect finished parts, the window takes orders.
 */

export const KITCHEN = {
  T: 64, COLS: 15, ROWS: 9, W: 64 * 15, H: 64 * 9, chefR: 21, chefSpeed: 250,
  roundTime: 180, chopTime: 1.3, cookTime: 5, burnTime: 7, maxOrders: 4,
};

/** @typedef {string | { plate: string[] } | null} Item */
/** @typedef {{ type: string, ing: string | null, item: Item, progress: number }} Tile */
/** @typedef {{ x: number, y: number, fx: number, fy: number, holding: Item, chopping: boolean, rate: number }} Chef */
/** @typedef {{ id: number, recipe: string, timeLeft: number, total: number }} Order */

// # counter  T/L/B/M crates  C board  S stove  P plates  W window  X trash
export const LAYOUT = [
  '#T#L#B#M###SS##',
  '#.............#',
  'C.............W',
  '#....##PP##...#',
  'C....######...X',
  '#....######...#',
  'C.............W',
  '#.............#',
  '###############',
];

const TYPE = { '#': 'counter', T: 'crate', L: 'crate', B: 'crate', M: 'crate', C: 'board', S: 'stove', P: 'plates', W: 'window', X: 'trash', '.': 'floor' };
const CRATE = { T: 'tomato', L: 'lettuce', B: 'bread', M: 'meat' };

export const RECIPES = {
  salad: { name: 'Garden salad', items: ['lettuce_chopped', 'tomato_chopped'], reward: 30, time: 70 },
  toast: { name: 'Tomato toast', items: ['bread', 'tomato_chopped'], reward: 24, time: 60 },
  burger: { name: 'Burger', items: ['bread', 'meat_cooked'], reward: 40, time: 80 },
  deluxe: { name: 'Deluxe burger', items: ['bread', 'meat_cooked', 'lettuce_chopped', 'tomato_chopped'], reward: 75, time: 100 },
};
export const PLATEABLE = new Set(['lettuce_chopped', 'tomato_chopped', 'bread', 'meat_cooked']);
export const STAR_SCORES = [80, 160, 260];

/** @param {Item} item @returns {item is { plate: string[] }} */
export const isPlate = (item) => !!item && typeof item === 'object';
const { T, COLS, ROWS } = KITCHEN;
const idxOf = (c, r) => r * COLS + c;

/** Kitchen pace per difficulty: how fast orders arrive and how long customers wait. */
export const PACE = { easy: 0.75, normal: 1, hard: 1.35 };

export function createKitchen(difficulty = 'normal') {
  /** @type {Tile[]} */
  const tiles = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const ch = LAYOUT[r][c];
    tiles.push({ type: TYPE[ch], ing: CRATE[ch] ?? null, item: null, progress: 0 });
  }
  /** @returns {Chef} */
  const chef = (c, r) => ({ x: (c + 0.5) * T, y: (r + 0.5) * T, fx: 0, fy: -1, holding: null, chopping: false, rate: 1 });
  return {
    tiles, chefs: [chef(2, 5), chef(12, 5)], pace: PACE[difficulty] ?? 1, difficulty: PACE[difficulty] ? difficulty : 'normal',
    orders: /** @type {Order[]} */ ([]), orderId: 0, nextOrderIn: 1.5, score: 0, served: 0, missed: 0,
    timeLeft: KITCHEN.roundTime, elapsed: 0, over: false, msg: /** @type {{ text: string, ttl: number } | null} */ (null), msgId: 0,
  };
}

const say = (k, text) => { k.msg = { text, ttl: 2.2 }; k.msgId++; };
export const starsFor = (score) => STAR_SCORES.filter((s) => score >= s).length;
const solidAt = (c, r) => c < 0 || r < 0 || c >= COLS || r >= ROWS || LAYOUT[r][c] !== '.';

function blocked(x, y) {
  const R = KITCHEN.chefR;
  for (let r = Math.floor((y - R) / T); r <= Math.floor((y + R) / T); r++) {
    for (let c = Math.floor((x - R) / T); c <= Math.floor((x + R) / T); c++) {
      if (!solidAt(c, r)) continue;
      const nx = Math.max(c * T, Math.min(x, (c + 1) * T)), ny = Math.max(r * T, Math.min(y, (r + 1) * T));
      if ((x - nx) ** 2 + (y - ny) ** 2 < R * R) return true;
    }
  }
  return false;
}

/** Walks a chef with an input direction; slides along counters. */
export function moveChef(k, i, ix, iy, dt, speedMul = 1) {
  const chef = k.chefs[i];
  const len = Math.hypot(ix, iy);
  if (len < 0.15) return;
  const ux = ix / len, uy = iy / len;
  if (Math.abs(ux) > Math.abs(uy)) { chef.fx = Math.sign(ux); chef.fy = 0; } else { chef.fx = 0; chef.fy = Math.sign(uy); }
  const step = KITCHEN.chefSpeed * speedMul * dt * Math.min(1, len);
  const nx = chef.x + ux * step;
  if (!blocked(nx, chef.y)) chef.x = nx;
  const ny = chef.y + uy * step;
  if (!blocked(chef.x, ny)) chef.y = ny;
}

/** Index of the work tile a chef is facing, or -1. */
export function targetIndex(k, i) {
  const chef = k.chefs[i];
  const c = Math.floor((chef.x + chef.fx * T * 0.72) / T), r = Math.floor((chef.y + chef.fy * T * 0.72) / T);
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS || LAYOUT[r][c] === '.') return -1;
  return idxOf(c, r);
}

const fitsSomeRecipe = (items) => Object.values(RECIPES).some((rec) => items.every((it) => rec.items.includes(it)));
function addToPlate(plate, item) {
  if (!PLATEABLE.has(item) || plate.plate.includes(item) || !fitsSomeRecipe([...plate.plate, item])) return false;
  plate.plate.push(item);
  return true;
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function serve(k, plate) {
  const order = k.orders.find((o) => sameSet(RECIPES[o.recipe].items, plate.plate));
  if (!order) { say(k, 'Nobody ordered that'); return false; }
  const rec = RECIPES[order.recipe];
  const tip = Math.round(10 * order.timeLeft / order.total);
  k.score += rec.reward + tip;
  k.served++;
  k.orders = k.orders.filter((o) => o !== order);
  say(k, `+${rec.reward + tip} ${rec.name}`);
  return true;
}

/** Pick up, put down, combine onto a plate, serve or bin: whatever fits. */
export function interact(k, i) {
  if (k.over) return;
  const idx = targetIndex(k, i);
  if (idx < 0) return;
  const chef = k.chefs[i], tile = k.tiles[idx], held = chef.holding;
  switch (tile.type) {
    case 'crate':
      if (!held) chef.holding = tile.ing;
      else if (isPlate(held)) addToPlate(held, tile.ing);
      return;
    case 'plates':
      if (!held) chef.holding = { plate: [] };
      else if (!isPlate(held) && PLATEABLE.has(held)) chef.holding = { plate: [held] };
      return;
    case 'trash':
      if (isPlate(held)) held.plate = [];
      else chef.holding = null;
      return;
    case 'window':
      if (isPlate(held) && held.plate.length && serve(k, held)) chef.holding = null;
      else if (held && !isPlate(held)) say(k, 'Plate it first');
      return;
    default: // counter, board, stove
      if (!held) {
        if (tile.item) { chef.holding = tile.item; tile.item = null; tile.progress = 0; }
      } else if (!tile.item) {
        if (tile.type === 'stove' && (isPlate(held) || !held.startsWith('meat'))) { say(k, 'Only patties go on the stove'); return; }
        tile.item = held; tile.progress = 0; chef.holding = null;
      } else if (isPlate(held) && !isPlate(tile.item)) {
        if (addToPlate(held, tile.item)) { tile.item = null; tile.progress = 0; }
      } else if (!isPlate(held) && isPlate(tile.item)) {
        if (addToPlate(tile.item, held)) chef.holding = null;
      }
  }
}

function addOrder(k) {
  const pool = k.elapsed < 50 ? ['salad', 'toast', 'burger'] : ['salad', 'toast', 'burger', 'deluxe', 'deluxe'];
  const recipe = pool[Math.floor(Math.random() * pool.length)];
  const total = Math.round(RECIPES[recipe].time / k.pace);
  k.orders.push({ id: ++k.orderId, recipe, timeLeft: total, total });
}

export function tickKitchen(k, dt) {
  if (k.over) return;
  k.elapsed += dt;
  k.timeLeft = Math.max(0, k.timeLeft - dt);
  if (k.msg && (k.msg.ttl -= dt) <= 0) k.msg = null;

  k.chefs.forEach((chef, i) => {
    if (!chef.chopping || chef.holding) return;
    const idx = targetIndex(k, i);
    const tile = idx >= 0 ? k.tiles[idx] : null;
    if (tile?.type !== 'board' || (tile.item !== 'tomato' && tile.item !== 'lettuce')) return;
    tile.progress += (dt / KITCHEN.chopTime) * chef.rate;
    if (tile.progress >= 1) { tile.item = `${tile.item}_chopped`; tile.progress = 0; }
  });
  for (const tile of k.tiles) {
    if (tile.type !== 'stove') continue;
    if (tile.item === 'meat') {
      tile.progress += dt / KITCHEN.cookTime;
      if (tile.progress >= 1) { tile.item = 'meat_cooked'; tile.progress = 0; }
    } else if (tile.item === 'meat_cooked') {
      tile.progress += dt / KITCHEN.burnTime;
      if (tile.progress >= 1) { tile.item = 'meat_burnt'; tile.progress = 0; say(k, 'A patty burnt!'); }
    }
  }

  for (const order of k.orders) order.timeLeft -= dt;
  const expired = k.orders.filter((o) => o.timeLeft <= 0);
  if (expired.length) {
    k.orders = k.orders.filter((o) => o.timeLeft > 0);
    k.missed += expired.length;
    k.score = Math.max(0, k.score - 10 * expired.length);
    say(k, `${RECIPES[expired[0].recipe].name} walked out · −10`);
  }
  k.nextOrderIn -= dt;
  if (k.orders.length === 0) k.nextOrderIn = Math.min(k.nextOrderIn, 1.5);
  if (k.nextOrderIn <= 0 && k.orders.length < KITCHEN.maxOrders) {
    addOrder(k);
    k.nextOrderIn = (Math.max(11, 20 - k.elapsed / 18) + Math.random() * 5) / k.pace;
  }
  if (k.timeLeft <= 0) { k.over = true; k.chefs.forEach((c) => { c.chopping = false; }); say(k, 'Service over'); }
}

/** The network form of the kitchen: only what changes, in small arrays. */
export function packKitchen(k) {
  const tiles = [];
  k.tiles.forEach((t, i) => { if (t.item || t.progress > 0) tiles.push([i, t.item, Math.round(t.progress * 100) / 100]); });
  return {
    tiles,
    chefs: k.chefs.map((c) => [Math.round(c.x), Math.round(c.y), c.fx, c.fy, c.holding, c.chopping ? 1 : 0]),
    orders: k.orders.map((o) => [o.id, o.recipe, Math.round(o.timeLeft * 10) / 10, o.total]),
    score: k.score, served: k.served, missed: k.missed, timeLeft: Math.round(k.timeLeft * 10) / 10,
    over: k.over, msg: k.msg?.text ?? null, msgId: k.msgId, difficulty: k.difficulty,
  };
}

// --- CPU chef ----------------------------------------------------------------
// A small planner: it looks at the open orders and at everything already in the
// kitchen (including what the human is carrying), picks the most useful next
// job, walks there on the grid and does it. Difficulty changes how fast it
// walks and chops and how long it hesitates between jobs.

export const BOT_LEVELS = {
  easy: { speed: 0.62, rate: 0.7, pause: 1.1, idleChance: 0.25 },
  normal: { speed: 0.85, rate: 0.9, pause: 0.5, idleChance: 0.08 },
  hard: { speed: 1, rate: 1.1, pause: 0.15, idleChance: 0 },
};

export function createBot(level = 'normal') {
  return { level, job: null, path: [], wait: 0.6, chopFor: 0 };
}

const cellOf = (chef) => ({ c: Math.floor(chef.x / T), r: Math.floor(chef.y / T) });
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Shortest walk to a floor cell next to tile `idx`; returns cells and the facing needed. */
function routeTo(chef, idx) {
  const tc = idx % COLS, tr = Math.floor(idx / COLS);
  const goals = new Map();
  for (const [dc, dr] of DIRS) if (!solidAt(tc + dc, tr + dr)) goals.set(idxOf(tc + dc, tr + dr), { fx: -dc, fy: -dr });
  const start = cellOf(chef), from = new Map([[idxOf(start.c, start.r), -1]]);
  const queue = [idxOf(start.c, start.r)];
  while (queue.length) {
    const cur = queue.shift();
    if (goals.has(cur)) {
      const path = [];
      for (let at = cur; at !== -1; at = from.get(at)) path.unshift(at);
      return { path, face: goals.get(cur) };
    }
    const c = cur % COLS, r = Math.floor(cur / COLS);
    for (const [dc, dr] of DIRS) {
      const n = idxOf(c + dc, r + dr);
      if (!solidAt(c + dc, r + dr) && !from.has(n)) { from.set(n, cur); queue.push(n); }
    }
  }
  return null;
}

const processed = (item) => (item === 'tomato' || item === 'lettuce' ? `${item}_chopped` : item === 'meat' ? 'meat_cooked' : item);

/** Decides the next job: { idx, act: 'interact' | 'chop' } or null. */
function planJob(k, i) {
  const me = k.chefs[i], held = me.holding;
  const tilesOf = (pred) => k.tiles.map((t, idx) => ({ t, idx })).filter(({ t }) => pred(t));
  const nearest = (list) => {
    let best = null, bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot((e.idx % COLS + 0.5) * T - me.x, (Math.floor(e.idx / COLS) + 0.5) * T - me.y);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  };
  const freeCounter = () => nearest(tilesOf((t) => t.type === 'counter' && !t.item));
  const open = k.orders.slice().sort((a, b) => a.timeLeft - b.timeLeft);
  const wanted = open.slice(0, 2).map((o) => RECIPES[o.recipe].items);
  const plateGood = (items) => items.length > 0 && wanted.some((w) => items.every((x) => w.includes(x)));
  const plateDone = (items) => k.orders.some((o) => sameSet(RECIPES[o.recipe].items, items));

  // What is already on its way, so the bot doesn't fetch a second of anything.
  const supply = new Map();
  const count = (item) => { if (item && !isPlate(item) && item !== 'meat_burnt') supply.set(processed(item), (supply.get(processed(item)) || 0) + 1); };
  const plates = [];
  for (const t of k.tiles) { if (isPlate(t.item)) plates.push(t.item.plate); else count(t.item); }
  for (const c of k.chefs) { if (isPlate(c.holding)) plates.push(c.holding.plate); else count(c.holding); }
  for (const p of plates) for (const it of p) count(it);
  const demand = new Map();
  for (const w of wanted) for (const it of w) demand.set(it, (demand.get(it) || 0) + 1);
  const missing = [...demand].filter(([it, n]) => (supply.get(it) || 0) < n).map(([it]) => it);
  const plateOnCounter = tilesOf((t) => isPlate(t.item) && (t.item.plate.length === 0 || plateGood(t.item.plate)));

  if (held) {
    if (isPlate(held)) {
      if (plateDone(held.plate)) return { idx: nearest(tilesOf((t) => t.type === 'window')).idx, act: 'interact' };
      const loose = nearest(tilesOf((t) => PLATEABLE.has(t.item) && plateGood([...held.plate, t.item]) && !held.plate.includes(t.item)));
      if (loose) return { idx: loose.idx, act: 'interact' };
      if (held.plate.length && !plateGood(held.plate)) return { idx: nearest(tilesOf((t) => t.type === 'trash')).idx, act: 'interact' };
      const spot = freeCounter();
      return spot ? { idx: spot.idx, act: 'interact' } : null;
    }
    if (held === 'meat_burnt') return { idx: nearest(tilesOf((t) => t.type === 'trash')).idx, act: 'interact' };
    if (held === 'tomato' || held === 'lettuce') {
      const board = nearest(tilesOf((t) => t.type === 'board' && !t.item));
      return board ? { idx: board.idx, act: 'interact' } : (freeCounter() && { idx: freeCounter().idx, act: 'interact' });
    }
    if (held === 'meat') {
      const stove = nearest(tilesOf((t) => t.type === 'stove' && !t.item));
      return stove ? { idx: stove.idx, act: 'interact' } : null;
    }
    const target = nearest(plateOnCounter.filter(({ t }) => !t.item.plate.includes(held) && plateGood([...t.item.plate, held])));
    if (target) return { idx: target.idx, act: 'interact' };
    const spot = freeCounter();
    return spot ? { idx: spot.idx, act: 'interact' } : null;
  }

  const done = nearest(tilesOf((t) => isPlate(t.item) && plateDone(t.item.plate)));
  if (done) return { idx: done.idx, act: 'interact' };
  const burnt = nearest(tilesOf((t) => t.item === 'meat_burnt'));
  if (burnt) return { idx: burnt.idx, act: 'interact' };
  const toChop = nearest(tilesOf((t) => t.type === 'board' && (t.item === 'tomato' || t.item === 'lettuce')));
  if (toChop && !k.chefs.some((c, j) => j !== i && c.chopping)) return { idx: toChop.idx, act: 'chop' };
  // Finished parts waiting on a board or stove go onto the plate.
  const ready = nearest(tilesOf((t) => (t.type === 'stove' && t.item === 'meat_cooked') || (t.type === 'board' && PLATEABLE.has(t.item)))
    .filter(({ t }) => plateOnCounter.some(({ t: p }) => plateGood([...p.item.plate, t.item]) && !p.item.plate.includes(t.item))));
  if (ready) return { idx: ready.idx, act: 'interact' };
  if (open.length && plateOnCounter.length === 0 && !k.chefs.some((c) => isPlate(c.holding))) {
    return { idx: nearest(tilesOf((t) => t.type === 'plates')).idx, act: 'interact' };
  }
  const raw = { tomato_chopped: 'tomato', lettuce_chopped: 'lettuce', meat_cooked: 'meat', bread: 'bread' };
  for (const need of missing) {
    const crate = nearest(tilesOf((t) => t.type === 'crate' && t.ing === raw[need]));
    if (need === 'meat_cooked' && !k.tiles.some((t) => t.type === 'stove' && !t.item)) continue;
    if (crate) return { idx: crate.idx, act: 'interact' };
  }
  return null;
}

/**
 * Runs the CPU chef for one frame: plans, walks, and acts through the same
 * moveChef / interact calls a player uses.
 */
export function stepBot(k, i, bot, dt) {
  const chef = k.chefs[i], level = BOT_LEVELS[bot.level] ?? BOT_LEVELS.normal;
  chef.rate = level.rate;
  if (k.over) return;
  if (bot.chopFor > 0) {
    const idx = targetIndex(k, i), tile = idx >= 0 ? k.tiles[idx] : null;
    if (tile?.type === 'board' && (tile.item === 'tomato' || tile.item === 'lettuce')) { chef.chopping = true; return; }
    bot.chopFor = 0; chef.chopping = false; bot.wait = level.pause;
  }
  if (bot.wait > 0) { bot.wait -= dt; return; }
  if (!bot.job) {
    bot.job = planJob(k, i);
    if (!bot.job || Math.random() < level.idleChance) { bot.job = null; bot.wait = level.pause + 0.4; return; }
    const route = routeTo(chef, bot.job.idx);
    if (!route) { bot.job = null; bot.wait = level.pause; return; }
    bot.path = route.path; bot.face = route.face;
  }
  const next = bot.path[0];
  if (next !== undefined) {
    const tx = (next % COLS + 0.5) * T, ty = (Math.floor(next / COLS) + 0.5) * T;
    const dx = tx - chef.x, dy = ty - chef.y;
    if (Math.hypot(dx, dy) < 5) { bot.path.shift(); return; }
    moveChef(k, i, dx, dy, dt, level.speed);
    return;
  }
  chef.fx = bot.face.fx; chef.fy = bot.face.fy;
  if (bot.job.act === 'chop') bot.chopFor = 1;
  else interact(k, i);
  bot.job = null;
  bot.wait = level.pause;
}
