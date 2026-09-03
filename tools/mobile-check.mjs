/**
 * Phone pass: loads the built game in an emulated touch device, portrait and
 * landscape, walks the menus with taps and reports where every on-screen
 * control actually landed (and whether anything overlaps).
 *
 *   npm run build && npm run server
 *   node tools/mobile-check.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = path.resolve('shots-mobile');
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

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

const problems = [];

const tapText = async (page, text) => {
  const box = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.offsetParent !== null && x.textContent.trim().toLowerCase() === t.toLowerCase(),
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  if (!box) {
    problems.push(`could not find button "${text}"`);
    return false;
  }
  await page.touchscreen.tap(box.x, box.y);
  return true;
};

/** Rect + visibility for a selector, as the layout engine sees it. */
const probe = (page, selectors) =>
  page.evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const nodes = [...document.querySelectorAll(sel)];
      out[sel] = nodes.map((n) => {
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          z: cs.zIndex,
          onScreen: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.x < innerWidth && r.y < innerHeight,
          label: (n.textContent || '').trim().slice(0, 14),
        };
      });
    }
    return out;
  }, selectors);

async function run(name, width, height) {
  console.log(`\n=== ${name} (${width}x${height}) ===`);
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] console: ${m.text()}`);
  });
  await page.setUserAgent(UA);
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: width > height });

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.logo-word', { timeout: 20000 });
  await sleep(2200);

  const env = await page.evaluate(() => ({
    body: document.body.className,
    quality: document.body.dataset.quality,
    coarse: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: none)').matches,
    touchPoints: navigator.maxTouchPoints,
    inner: [innerWidth, innerHeight],
  }));
  console.log('  env:', JSON.stringify(env));
  if (!env.body.includes('touch-device')) problems.push(`[${name}] body is missing the touch-device class`);

  await page.screenshot({ path: path.join(OUT, `${name}-01-title.png`) });
  await tapText(page, 'GRAND PRIX');
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, `${name}-02-racers.png`) });
  const cards = await probe(page, ['.char-card', '.card-grid', '.select-footer']);
  const c0 = cards['.char-card'][0];
  console.log(`  racer card: ${c0?.w}x${c0?.h}  (${cards['.char-card'].length} cards)`);
  console.log(`  grid: ${JSON.stringify(cards['.card-grid'][0])}`);

  await tapText(page, 'CONTINUE →');
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, `${name}-03-circuits.png`) });
  const tcards = await probe(page, ['.track-card', '.track-art', '.card-grid', '.select-footer']);
  const t0 = tcards['.track-card'][0];
  console.log(`  track card: ${t0?.w}x${t0?.h}, art ${tcards['.track-art'][0]?.w}x${tcards['.track-art'][0]?.h}`);

  // Tap a card that is not already selected, so the tap selects rather than
  // starting the race, then start it from the footer button like a player would.
  await page.evaluate(() => document.querySelectorAll('.track-card')[1]?.click());
  await sleep(400);
  await tapText(page, 'START RACE');
  const started = await page
    .waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  if (!started) {
    problems.push(`[${name}] race never started`);
    await page.screenshot({ path: path.join(OUT, `${name}-err.png`) });
    await page.close();
    return;
  }
  await sleep(6000);
  await page.screenshot({ path: path.join(OUT, `${name}-04-race.png`) });

  const controls = await probe(page, [
    '.touch-controls',
    '.touch-steer',
    '.touch-drive',
    '.touch-btn',
    '.touch-aux',
    '.touch-corner',
    '.hud-speed',
    '.hud-minimap',
    '.hud-place',
    '.hud-item',
    '.hud-lap',
  ]);
  for (const [sel, list] of Object.entries(controls)) {
    if (!list.length) {
      console.log(`  ${sel.padEnd(16)} — absent`);
      continue;
    }
    for (const r of list) {
      console.log(
        `  ${sel.padEnd(16)} ${String(r.label).padEnd(6)} ${r.w}x${r.h} @ ${r.x},${r.y} display=${r.display} on=${r.onScreen}`,
      );
    }
  }
  if (!controls['.touch-controls'].length) problems.push(`[${name}] touch controls were never built`);
  else if (controls['.touch-controls'][0].display === 'none') problems.push(`[${name}] touch controls are display:none while racing`);
  if (!controls['.touch-btn'].some((b) => b.onScreen)) problems.push(`[${name}] no drive button is on screen`);
  if (!controls['.touch-steer'].some((b) => b.onScreen)) problems.push(`[${name}] the steer pad is off screen`);

  // Does anything overlap the driving controls?
  const overlaps = await page.evaluate(() => {
    const rect = (s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return r.width ? r : null;
    };
    const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const pads = ['.touch-steer', '.touch-drive', '.touch-aux'];
    const hud = ['.hud-speed', '.hud-minimap', '.hud-place', '.hud-item', '.hud-lap', '.hud-timer', '.hud-net'];
    const found = [];
    for (const p of pads) for (const h of hud) if (hit(rect(p), rect(h))) found.push(`${h} overlaps ${p}`);
    return found;
  });
  for (const o of overlaps) {
    console.log(`  OVERLAP: ${o}`);
    problems.push(`[${name}] ${o}`);
  }

  // Do the controls actually drive the kart? Auto-gas is on by default, so
  // turn it off first: otherwise the kart is already at speed and the GAS
  // button proves nothing.
  const speed = () => page.evaluate(() => window.__lmongolyanKart?.race?.player.state.speed ?? -1);
  const auto = controls['.touch-auto']?.[0] ?? (await probe(page, ['.touch-auto']))['.touch-auto'][0];
  if (auto) {
    const cx = auto.x + auto.w / 2;
    const cy = auto.y + auto.h / 2;
    const hitBefore = await page.evaluate(
      (x, y) => document.elementFromPoint(x, y)?.className ?? 'nothing',
      cx,
      cy,
    );
    // The setting is remembered in localStorage, which the two runs share, so
    // only tap when auto-gas is actually on.
    if (await page.evaluate(() => document.querySelector('.touch-auto')?.classList.contains('on') ?? false)) {
      await page.touchscreen.tap(cx, cy);
    }
    await sleep(2600);
    const chipState = await page.evaluate(() => document.querySelector('.touch-auto')?.textContent ?? '?');
    console.log(`  auto-gas chip at ${cx},${cy} over "${hitBefore}" -> ${chipState}`);
  }
  const coasting = await speed();
  const gas = controls['.touch-btn'].find((b) => b.label.includes('GAS'));
  if (gas) {
    await page.touchscreen.touchStart(gas.x + gas.w / 2, gas.y + gas.h / 2);
    await sleep(3000);
    const during = await speed();
    await page.touchscreen.touchEnd();
    console.log(`  speed coasting=${coasting.toFixed?.(1) ?? coasting} holding GAS=${during.toFixed?.(1) ?? during}`);
    if (during <= coasting + 1) problems.push(`[${name}] holding GAS did not accelerate the kart (${coasting} -> ${during})`);
  }

  // And does the steer pad register? steerVisual is the smoothed input the
  // kart actually turns on.
  const steer = controls['.touch-steer'][0];
  if (steer) {
    await page.touchscreen.touchStart(steer.x + steer.w * 0.92, steer.y + steer.h * 0.4);
    await sleep(800);
    const s = await page.evaluate(() => window.__lmongolyanKart?.race?.player.state.steerVisual ?? 0);
    await page.touchscreen.touchEnd();
    console.log(`  steerVisual after right-hold: ${s.toFixed?.(2) ?? s}`);
    if (s < 0.3) problems.push(`[${name}] the steer pad did not turn the kart (${s})`);
  }
  await page.screenshot({ path: path.join(OUT, `${name}-05-controls.png`) });
  await page.close();
}

await run('landscape', 844, 390);
await run('portrait', 390, 844);

await browser.close();
console.log('\n--- problems ---');
if (!problems.length) console.log('none');
else for (const p of problems) console.log(' *', p);
console.log(`\nshots in ${OUT}`);
process.exit(problems.length ? 1 : 0);
