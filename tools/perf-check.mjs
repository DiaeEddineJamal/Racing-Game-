/**
 * Frame-time pass: races for a while and reports how even the frames are.
 *
 * Averages hide stutter, so this reports the distribution and the worst
 * frames, plus a CPU profile of the same window so a hitch can be traced to
 * the function that caused it.
 *
 *   npm run build && npm run server
 *   node tools/perf-check.mjs [baseUrl] [trackName] [seconds]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const TRACK = process.argv[3] ?? 'casa';
const SECONDS = Number(process.argv[4] ?? 25);
/** CPU slowdown factor, so a mid-range laptop or phone can be measured too. */
const CPU = Number(process.argv[5] ?? 1);
/** Quality tier override passed to the page (low | medium | high). */
const QUALITY = process.argv[6] ?? '';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('No Chrome or Edge binary found.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No swiftshader flag: let Chrome use the real GPU if this machine has one,
// because software rendering hides exactly the hitches we are looking for.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
const click = (t) =>
  page.evaluate(
    (x) => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim().toLowerCase() === x.toLowerCase())?.click(),
    t,
  );

const cdp = await page.createCDPSession();
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const url = `${BASE}/?auto=1${QUALITY ? `&quality=${QUALITY}` : ''}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('.logo-word', { timeout: 20000 });
await sleep(2000);

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`renderer: ${gpu}`);
console.log(`cpu throttle: ${CPU}x   quality: ${QUALITY || 'auto'} (${await page.evaluate(() => document.body.dataset.quality)})`);

await click('GRAND PRIX');
await sleep(1400);
await click('CONTINUE →');
await sleep(1400);
await page.evaluate(
  (n) => [...document.querySelectorAll('.track-card')].find((c) => (c.querySelector('.card-name')?.textContent ?? '').toUpperCase().includes(n))?.click(),
  TRACK.toUpperCase(),
);
await sleep(300);
const startedAt = Date.now();
await click('START RACE');
await page.waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), { timeout: 180000 });
console.log(`loading screen: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
// Let the countdown finish and the first-lap shader/texture work settle.
await sleep(7000);

// Collect one sample per animation frame, in the page, with no I/O per frame.
await page.evaluate(() => {
  window.__frames = [];
  window.__heap = [];
  let last = performance.now();
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    if (window.__frames.length % 60 === 0 && performance.memory) {
      window.__heap.push(performance.memory.usedJSHeapSize / 1048576);
    }
    // Any program compiled from here on is a shader the race was not warmed
    // for, and that shows up as a hitch. Record which one, and when.
    const renderer = window.__lmongolyanKart?.renderer;
    if (renderer) {
      const programs = renderer.info.programs ?? [];
      if (programs.length > window.__programCount) {
        for (let i = window.__programCount; i < programs.length; i++) {
          window.__newPrograms.push({ frame: window.__frames.length, key: String(programs[i].cacheKey) });
        }
        window.__programCount = programs.length;
        if (!window.__afterDiff) {
          const after = window.__snapshot();
          const added = [];
          const changed = [];
          for (const [uuid, info] of after) {
            const was = window.__before.get(uuid);
            if (!was) added.push(`${info.object} [${info.type}] ${info.flags}`);
            else if (was.flags !== info.flags) changed.push(`${info.object} [${info.type}] ${was.flags} -> ${info.flags}`);
            else if (was.visible !== info.visible) changed.push(`${info.object} visible ${was.visible} -> ${info.visible}`);
          }
          window.__afterDiff = { added: added.slice(0, 10), changed: changed.slice(0, 10), sizeBefore: window.__before.size, sizeAfter: after.size };
        }
      }
    }
    window.__frameHandle = requestAnimationFrame(tick);
  };
  window.__programCount = window.__lmongolyanKart?.renderer?.info?.programs?.length ?? 0;
  window.__baseKeys = [...(window.__lmongolyanKart?.renderer?.info?.programs ?? [])].map((p) => String(p.cacheKey));
  window.__newPrograms = [];
  // Snapshot every material in the scene, so a program compiled mid-race can be
  // matched to the object that brought it in.
  window.__snapshot = () => {
    const out = new Map();
    window.__lmongolyanKart?.scene?.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        out.set(m.uuid, {
          object: `${o.name || o.type}${o.parent?.name ? ` in ${o.parent.name}` : ''}`,
          type: m.type,
          visible: o.visible,
          flags: [m.vertexColors, m.transparent, m.alphaTest, m.flatShading, m.side, !!m.envMap, m.fog, m.clearcoat, m.transmission, m.dithering, m.wireframe].join('|'),
        });
      }
    });
    return out;
  };
  window.__before = window.__snapshot();
  window.__frameHandle = requestAnimationFrame(tick);
});

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await sleep(SECONDS * 1000);
const { profile } = await cdp.send('Profiler.stop');

const { frames, heap, newPrograms, programCount, baseKeys, diff } = await page.evaluate(() => {
  cancelAnimationFrame(window.__frameHandle);
  return {
    frames: window.__frames,
    heap: window.__heap,
    newPrograms: window.__newPrograms,
    programCount: window.__programCount,
    baseKeys: window.__baseKeys,
    diff: window.__afterDiff ?? null,
  };
});

const sorted = [...frames].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
const median = pct(0.5);
const fmt = (v) => `${v.toFixed(1)}ms`;
console.log(`\nframes: ${frames.length} over ${SECONDS}s`);
console.log(`  median ${fmt(median)} (${(1000 / median).toFixed(0)} fps)   p95 ${fmt(pct(0.95))}   p99 ${fmt(pct(0.99))}   max ${fmt(sorted.at(-1))}`);
const spikes = frames.filter((f) => f > median * 2);
const bad = frames.filter((f) => f > 33.4);
console.log(`  frames over 2x median: ${spikes.length} (${((spikes.length / frames.length) * 100).toFixed(2)}%)`);
console.log(`  frames over 33ms:      ${bad.length} (${((bad.length / frames.length) * 100).toFixed(2)}%)`);
const worst = frames
  .map((v, i) => [v, i])
  .sort((a, b) => b[0] - a[0])
  .slice(0, 10);
console.log(`  worst frames: ${worst.map(([v, i]) => `${v.toFixed(0)}ms@#${i}`).join(', ')}`);
console.log(`  shader programs: ${programCount} total, ${newPrograms.length} compiled during the run`);
for (const p of newPrograms.slice(0, 8)) {
  // Show it against the closest program that was already warm: the flags that
  // differ are the reason this one had to be compiled fresh.
  const parts = p.key.split(',');
  let best = { score: -1, key: '' };
  for (const k of baseKeys) {
    const other = k.split(',');
    let score = 0;
    for (let i = 0; i < Math.min(parts.length, other.length); i++) if (parts[i] === other[i]) score++;
    if (score > best.score) best = { score, key: k };
  }
  const other = best.key.split(',');
  const diffs = [];
  for (let i = 0; i < Math.max(parts.length, other.length); i++) {
    if (parts[i] !== other[i]) diffs.push(`#${i}: ${JSON.stringify(other[i])} -> ${JSON.stringify(parts[i])}`);
  }
  console.log(`    frame #${p.frame}: ${parts.slice(0, 6).join(',')}`);
  console.log(`      differs from the nearest warm program in ${diffs.length} field(s): ${diffs.slice(0, 8).join(' | ')}`);
}
if (diff) {
  console.log(`  scene materials ${diff.sizeBefore} -> ${diff.sizeAfter}`);
  for (const line of diff.added) console.log(`    + ${line}`);
  for (const line of diff.changed) console.log(`    ~ ${line}`);
}
if (heap.length > 1) console.log(`  JS heap: ${heap[0].toFixed(1)} -> ${heap.at(-1).toFixed(1)} MB (peak ${Math.max(...heap).toFixed(1)})`);

// --- attribute CPU time -----------------------------------------------------
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const label = (n) => {
  const f = n.callFrame;
  const file = f.url ? f.url.split('/').pop() : '';
  return `${f.functionName || '(anonymous)'}${file ? ` @${file}:${f.lineNumber}` : ''}`;
};
const chain = (id) => {
  const parts = [];
  for (let cur = id; cur !== undefined && parts.length < 8; cur = parent.get(cur)) {
    const n = nodes.get(cur);
    if (!n) break;
    parts.push(label(n));
  }
  return parts.join(' <- ');
};
const tally = (ids) => {
  const byId = new Map();
  for (const id of ids) byId.set(id, (byId.get(id) ?? 0) + 1);
  return [...byId.entries()].sort((a, b) => b[1] - a[1]);
};

const total = profile.samples.length || 1;
console.log('');
console.log('top self time over the run:');
for (const [id, count] of tally(profile.samples).slice(0, 10)) {
  const n = nodes.get(id);
  if (n) console.log(`  ${((count / total) * 100).toFixed(1).padStart(5)}%  ${label(n)}`);
}

// The hitch itself: the longest run of samples with no idle in between.
const times = [];
let t = profile.startTime;
for (const d of profile.timeDeltas) {
  t += d;
  times.push(t);
}
const idleIds = new Set(
  profile.nodes.filter((n) => ['(idle)', '(program)'].includes(n.callFrame.functionName)).map((n) => n.id),
);
let best = { len: 0, from: 0, to: 0 };
for (let i = 0; i < profile.samples.length; i++) {
  if (idleIds.has(profile.samples[i])) continue;
  let j = i;
  while (j + 1 < profile.samples.length && !idleIds.has(profile.samples[j + 1])) j++;
  const span = (times[j] - times[i]) / 1000;
  if (span > best.len) best = { len: span, from: i, to: j };
  i = j;
}
console.log('');
console.log(`longest uninterrupted task: ${best.len.toFixed(1)}ms (${best.to - best.from + 1} samples)`);
for (const [id, count] of tally(profile.samples.slice(best.from, best.to + 1)).slice(0, 6)) {
  console.log(`  ${String(count).padStart(4)}x  ${chain(id)}`);
}

await browser.close();
