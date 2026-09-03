/**
 * Drives the built game in real Chrome: walks the menus, races every circuit,
 * plays a full race through to the results screen, and runs a two-player online
 * race between two browser pages. Any console error, page error or failed
 * request fails the run.
 *
 *   npm run build && npm run server            # in one terminal
 *   node tools/browser-check.mjs [baseUrl]     # in another
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = path.resolve('shots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome or Edge binary found; skipping the browser check.');
  process.exit(2);
}

const TRACKS = [
  ['menara', 'Menara'],
  ['merzouga', 'Merzouga'],
  ['agadir', 'Agadir'],
  ['atlas', 'Atlas'],
  ['jbel', 'Jbel'],
  ['casa_neon', 'Casa Neon'],
];

fs.mkdirSync(OUT, { recursive: true });
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--window-size=1600,900',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
  defaultViewport: { width: 1600, height: 900 },
});

/** Attaches console / error / request listeners, tagged with a page label. */
function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${label}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.startsWith('data:')) problems.push(`[${label}] request failed: ${u} (${r.failure()?.errorText})`);
  });
}

const clickText = async (page, text) => {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.offsetParent !== null && x.textContent.trim().toLowerCase() === t.toLowerCase(),
    );
    if (!b) return false;
    b.click();
    return true;
  }, text);
  if (!ok) problems.push(`could not find button "${text}"`);
  return ok;
};

const uiState = (page) => page.evaluate(() => document.getElementById('ui')?.dataset.state ?? '');

const raceState = (page) =>
  page.evaluate(() => {
    const g = window.__lmongolyanKart;
    const r = g?.race;
    if (!r) return null;
    const k = r.player.state;
    return {
      state: g.currentState,
      speed: +k.speed.toFixed(1),
      place: k.place,
      lap: k.lap,
      surface: k.surface,
      karts: r.karts.length,
      finite: [k.position.x, k.position.y, k.position.z, k.speed, k.heading].every(Number.isFinite),
      names: r.karts.map((x) => x.state.displayName ?? x.state.character.name),
    };
  });

// ---------------------------------------------------------------------------
// Single player
// ---------------------------------------------------------------------------

const page = await browser.newPage();
watch(page, 'p1');

console.log(`Loading ${BASE} …`);
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('.logo-word', { timeout: 20000 });
await sleep(2500);
await page.screenshot({ path: path.join(OUT, '01-title.png') });
console.log('  title screen ok');

await clickText(page, 'GRAND PRIX');
await sleep(2000);
await page.screenshot({ path: path.join(OUT, '02-racers.png') });
const racers = await page.evaluate(() => [...document.querySelectorAll('.char-card .card-name')].map((n) => n.textContent));
console.log(`  racers: ${racers.join(', ')}`);
if (racers.length < 8) problems.push(`only ${racers.length} racers on the select screen`);
for (const want of ['DIAE', 'AICHA', 'L7AFOZLI9', 'BZIZLA']) {
  if (!racers.includes(want)) problems.push(`racer "${want}" missing from the roster`);
}

await clickText(page, 'CONTINUE →');
await sleep(1600);
await page.screenshot({ path: path.join(OUT, '03-circuits.png') });
const circuits = await page.evaluate(() => [...document.querySelectorAll('.track-card .card-name')].map((n) => n.textContent));
console.log(`  circuits: ${circuits.join(', ')}`);
if (circuits.length !== 6) problems.push(`expected 6 circuits, found ${circuits.length}`);
const posters = await page.evaluate(() => document.querySelectorAll('.track-art canvas').length);
if (posters !== circuits.length) problems.push(`only ${posters} of ${circuits.length} circuits have poster art`);

/** Picks a circuit, races for a few seconds, then quits back to the grid. */
async function race(id, label, index) {
  const picked = await page.evaluate((name) => {
    // Match on the card's own name element, case-insensitively: card-name is
    // rendered upper-case, and matching the whole card's textContent (as this
    // used to) can accidentally hit the flavour text instead (e.g. Atlas
    // Frostbite's description mentions "the High Atlas").
    const c = [...document.querySelectorAll('.track-card')].find((x) =>
      (x.querySelector('.card-name')?.textContent ?? '').toUpperCase().includes(name.toUpperCase()),
    );
    if (!c) return false;
    c.click();
    return true;
  }, label);
  if (!picked) {
    problems.push(`track card missing: ${id}`);
    return;
  }
  await sleep(300);
  await clickText(page, 'START RACE');
  try {
    await page.waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), {
      timeout: 90000,
    });
  } catch {
    problems.push(`${id}: race never started`);
    await page.screenshot({ path: path.join(OUT, `err-${id}.png`) });
    return;
  }
  await sleep(3600);
  await page.screenshot({ path: path.join(OUT, `${10 + index}-${id}-grid.png`) });

  await page.keyboard.down('KeyW');
  await sleep(3500);
  await page.keyboard.down('KeyD');
  await sleep(600);
  await page.keyboard.up('KeyD');
  await sleep(3000);
  await page.screenshot({ path: path.join(OUT, `${20 + index}-${id}-race.png`) });

  const st = await raceState(page);
  await page.keyboard.up('KeyW');
  if (!st) {
    problems.push(`${id}: no race object`);
  } else {
    console.log(`  ${id.padEnd(10)} state=${st.state} speed=${st.speed} place=${st.place} surface=${st.surface} karts=${st.karts}`);
    if (!st.finite) problems.push(`${id}: kart state went non-finite`);
    if (st.speed < 8) problems.push(`${id}: kart barely moved (${st.speed} m/s)`);
    if (st.karts < 8) problems.push(`${id}: field did not spawn (${st.karts})`);
    const dupes = st.names.filter((n, i) => st.names.indexOf(n) !== i);
    if (dupes.length) problems.push(`${id}: duplicate racer on the grid (${dupes.join(', ')})`);
  }

  await page.keyboard.press('Escape');
  await sleep(600);
  await clickText(page, 'QUIT TO MENU');
  await sleep(1400);
  await clickText(page, 'GRAND PRIX');
  await sleep(700);
  await clickText(page, 'CONTINUE →');
  await sleep(900);
}

for (let i = 0; i < TRACKS.length; i++) await race(TRACKS[i][0], TRACKS[i][1], i);

// --- full race through to the results screen --------------------------------
console.log('\n  running a full race to the results screen …');
// Reloaded with ?auto=1 so the AI drives the player's kart and the race actually
// finishes; holding W by hand just parks the kart in the first barrier.
await page.goto(`${BASE}/?auto=1`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('.logo-word', { timeout: 20000 });
await sleep(1500);
await clickText(page, 'GRAND PRIX');
await sleep(1200);
await clickText(page, 'CONTINUE →');
await sleep(1000);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.track-card')].find((x) => x.textContent.includes('Menara'));
  c?.click();
});
await sleep(250);
await clickText(page, 'START RACE');
await page
  .waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), { timeout: 90000 })
  .catch(() => problems.push('full race never started'));
const finished = await page
  .waitForFunction(() => document.getElementById('ui')?.dataset.state === 'results', { timeout: 300000, polling: 1000 })
  .then(() => true)
  .catch(() => false);
if (!finished) {
  problems.push('the race never reached the results screen');
  await page.screenshot({ path: path.join(OUT, 'err-results.png') });
} else {
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '30-results.png') });
  const rows = await page.evaluate(() => document.querySelectorAll('.results .standings > *').length);
  console.log(`  results screen ok (${rows} rows)`);
  if (rows < 8) problems.push(`results table has ${rows} rows, expected 8`);
  await clickText(page, 'MAIN MENU');
  await sleep(1200);
}

// ---------------------------------------------------------------------------
// Online: two pages, one room
// ---------------------------------------------------------------------------

console.log('\n  online: creating a room …');
const page2 = await browser.newPage();
watch(page2, 'p2');
await page2.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
await page2.waitForSelector('.logo-word', { timeout: 20000 });
await sleep(1500);

await clickText(page, 'PLAY ONLINE');
await sleep(1200);
await page.evaluate(() => {
  const input = document.querySelector('.panel-online .field-input');
  if (input) input.value = 'Diae';
});
await clickText(page, 'CREATE ROOM');
await page.waitForFunction(() => document.querySelector('.lobby-code')?.textContent?.length === 4, { timeout: 15000 }).catch(
  () => problems.push('online: the room code never appeared'),
);
const code = await page.evaluate(() => document.querySelector('.lobby-code')?.textContent ?? '');
console.log(`  room code: ${code}`);
await page.screenshot({ path: path.join(OUT, '40-lobby-host.png') });

await clickText(page2, 'PLAY ONLINE');
await sleep(1200);
await page2.evaluate((roomCode) => {
  const fields = document.querySelectorAll('.panel-online .field-input');
  if (fields[0]) fields[0].value = 'Aicha';
  if (fields[1]) fields[1].value = roomCode;
}, code);
await clickText(page2, 'JOIN');
await sleep(1600);
await page2.screenshot({ path: path.join(OUT, '41-lobby-guest.png') });

const lobbyNames = await page.evaluate(() => [...document.querySelectorAll('.player-name')].map((n) => n.textContent));
console.log(`  lobby: ${lobbyNames.join(', ')}`);
if (lobbyNames.length !== 2) problems.push(`online: host sees ${lobbyNames.length} players, expected 2`);

// Guest picks a different racer, then readies up.
await page2.evaluate(() => {
  const chips = [...document.querySelectorAll('.panel-lobby .chip-strip .chip')].filter((c) => !c.disabled);
  chips[2]?.click();
});
await sleep(500);
await clickText(page2, 'READY');
await sleep(600);

await clickText(page, 'START RACE');
const bothRacing = await Promise.all(
  [page, page2].map((p) =>
    p
      .waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), {
        timeout: 90000,
      })
      .then(() => true)
      .catch(() => false),
  ),
);
if (!bothRacing[0]) problems.push('online: the host never entered the race');
if (!bothRacing[1]) problems.push('online: the guest never entered the race');

await sleep(4000);
await page.keyboard.down('KeyW');
await page2.keyboard.down('KeyW');
await sleep(6000);
await page.screenshot({ path: path.join(OUT, '42-online-host.png') });
await page2.screenshot({ path: path.join(OUT, '43-online-guest.png') });

// Does the host actually see the guest's kart moving where the guest put it?
const [hostView, guestView] = await Promise.all([raceState(page), raceState(page2)]);
await page.keyboard.up('KeyW');
await page2.keyboard.up('KeyW');

if (!hostView || !guestView) {
  problems.push('online: one of the pages had no race object');
} else {
  console.log(`  host  : speed=${hostView.speed} karts=${hostView.karts} names=${hostView.names.join(', ')}`);
  console.log(`  guest : speed=${guestView.speed} karts=${guestView.karts}`);
  if (hostView.karts !== guestView.karts) {
    problems.push(`online: grid sizes disagree (${hostView.karts} vs ${guestView.karts})`);
  }
  if (!hostView.names.includes('Aicha')) problems.push('online: the host does not see the guest by name');
  if (!guestView.names.includes('Diae')) problems.push('online: the guest does not see the host by name');
  if (hostView.speed < 5 || guestView.speed < 5) problems.push('online: a kart never got moving');
}

// The remote kart on the host's screen must be tracking the guest's own position.
const drift = await (async () => {
  const guestPos = await page2.evaluate(() => {
    const r = window.__lmongolyanKart?.race;
    const k = r?.player.state;
    return k ? { id: k.id, x: k.position.x, y: k.position.y, z: k.position.z } : null;
  });
  if (!guestPos) return null;
  return page.evaluate((g) => {
    const r = window.__lmongolyanKart?.race;
    const k = r?.karts.find((x) => x.state.id === g.id);
    if (!k) return null;
    const p = k.state.position;
    return Math.hypot(p.x - g.x, p.y - g.y, p.z - g.z);
  }, guestPos);
})();
if (drift === null) problems.push('online: could not compare the two views of the guest kart');
else {
  console.log(`  remote kart position error: ${drift.toFixed(2)} m`);
  if (drift > 12) problems.push(`online: remote kart is ${drift.toFixed(1)} m out of sync`);
}

await page2.close();
await sleep(800);

// --- frame rate on the last running page ------------------------------------
const fps = await page.evaluate(async () => {
  let frames = 0;
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      frames++;
      performance.now() - t0 < 3000 ? requestAnimationFrame(tick) : res();
    };
    requestAnimationFrame(tick);
  });
  return Math.round((frames / (performance.now() - t0)) * 1000);
});
console.log(`\n  frame rate (software GL): ${fps} fps`);

await page.screenshot({ path: path.join(OUT, '99-final.png') });
await browser.close();

console.log('\n' + '='.repeat(64));
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.log('  - ' + p);
  process.exit(1);
}
console.log('Browser check passed. Screenshots in ./shots');
