// Mobile online flow: create a room and reach START RACE by scrolling, on both
// a portrait and a landscape phone. Verifies the panel actually scrolls and
// every control (name field, CREATE ROOM, READY, START RACE) is reachable.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--mute-audio'],
});

const problems = [];

/**
 * Finds a button by text, scrolls its container so it is in view (the same
 * gesture a thumb-scroll would produce), and clicks it. Uses a real DOM click
 * rather than a synthetic touch event: what is under test here is whether the
 * scrollable panel makes the control reachable at all, not touch dispatch.
 */
async function tapByText(page, text) {
  const result = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.offsetParent !== null && x.textContent.trim().toLowerCase() === t.toLowerCase(),
    );
    if (!b) return { found: false };
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const onScreen = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    b.click();
    return { found: true, onScreen, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) } };
  }, text);
  if (!result.found) {
    problems.push(`could not find "${text}"`);
    return false;
  }
  if (!result.onScreen) {
    problems.push(`"${text}" scrolled into view but rect is still off-screen: ${JSON.stringify(result.rect)}`);
  }
  return true;
}

async function run(label, width, height) {
  console.log(`\n=== ${label} (${width}x${height}) ===`);
  const p1 = await browser.newPage();
  const p2 = await browser.newPage();
  for (const [tag, p] of [['host', p1], ['guest', p2]]) {
    p.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') problems.push(`[${tag}] console: ${m.text().slice(0, 140)}`);
    });
    await p.setUserAgent(UA);
    await p.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: width > height });
  }

  await p1.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await p1.waitForSelector('.logo-word', { timeout: 20000 });
  await sleep(1500);
  await tapByText(p1, 'PLAY ONLINE');
  await sleep(1200);

  // Is the connect panel actually scrollable, and does the content overflow
  // (proving this test would have failed before the fix)?
  const connectMetrics = await p1.evaluate(() => {
    const el = document.querySelector('.panel-online');
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
  });
  console.log(`  connect panel: content=${connectMetrics.scrollHeight}px viewport=${connectMetrics.clientHeight}px overflow-y=${connectMetrics.overflowY}`);
  if (connectMetrics.scrollHeight > connectMetrics.clientHeight && connectMetrics.overflowY !== 'auto' && connectMetrics.overflowY !== 'scroll') {
    problems.push(`[${label}] connect panel overflows (${connectMetrics.scrollHeight}>${connectMetrics.clientHeight}) but overflow-y is "${connectMetrics.overflowY}"`);
  }

  await p1.evaluate(() => {
    const i = document.querySelector('.panel-online .field-input');
    if (i) i.value = 'Diae';
  });
  const created = await tapByText(p1, 'CREATE ROOM');
  if (!created) { console.log('  FAILED to tap CREATE ROOM'); await browser.close(); process.exit(1); }
  const roomOk = await p1
    .waitForFunction(() => document.querySelector('.lobby-code')?.textContent?.length === 4, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  console.log(`  room created: ${roomOk}`);
  if (!roomOk) problems.push(`[${label}] room never appeared after CREATE ROOM`);
  const code = await p1.evaluate(() => document.querySelector('.lobby-code')?.textContent ?? '');

  // Lobby: is it scrollable, and can we scroll to and tap every control?
  const lobbyMetrics = await p1.evaluate(() => {
    const el = document.querySelector('.panel-lobby');
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
  });
  console.log(`  lobby panel: content=${lobbyMetrics.scrollHeight}px viewport=${lobbyMetrics.clientHeight}px overflow-y=${lobbyMetrics.overflowY} overflows=${lobbyMetrics.scrollHeight > lobbyMetrics.clientHeight}`);
  if (lobbyMetrics.scrollHeight > lobbyMetrics.clientHeight && !['auto', 'scroll'].includes(lobbyMetrics.overflowY)) {
    problems.push(`[${label}] lobby panel overflows but does not scroll`);
  }

  // Guest joins, picks a different racer, readies up - all via scroll+tap.
  await p2.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await p2.waitForSelector('.logo-word', { timeout: 20000 });
  await sleep(1200);
  await tapByText(p2, 'PLAY ONLINE');
  await sleep(1000);
  await p2.evaluate((c) => {
    const fields = document.querySelectorAll('.panel-online .field-input');
    if (fields[0]) fields[0].value = 'Aicha';
    if (fields[1]) fields[1].value = c;
  }, code);
  await tapByText(p2, 'JOIN');
  await sleep(1500);

  // Tap a racer chip that isn't taken - scrolled into view, tapped for real.
  const chipTapped = await p2.evaluate(() => {
    const chip = [...document.querySelectorAll('.panel-lobby .chip-strip .chip')].find((c) => !c.disabled && !c.classList.contains('on'));
    if (!chip) return false;
    chip.scrollIntoView({ block: 'center' });
    return true;
  });
  await sleep(200);
  if (chipTapped) {
    await p2.evaluate(() => {
      const chip = [...document.querySelectorAll('.panel-lobby .chip-strip .chip')].find((c) => !c.disabled && !c.classList.contains('on'));
      chip?.click();
    });
  } else {
    problems.push(`[${label}] no selectable racer chip found for the guest`);
  }
  await sleep(400);
  const readyOk = await tapByText(p2, 'READY');
  if (!readyOk) problems.push(`[${label}] could not reach/tap READY`);
  await sleep(600);

  const startOk = await tapByText(p1, 'START RACE');
  if (!startOk) problems.push(`[${label}] could not reach/tap START RACE`);
  await sleep(500);
  const hostDebug = await p1.evaluate(() => ({
    uiState: document.getElementById('ui')?.dataset.state,
    panel: window.__lmongolyanKart?.onlineMenu?.currentPanel,
    isHost: window.__lmongolyanKart?.netClient?.isHost,
    room: window.__lmongolyanKart?.netClient?.room?.state,
  }));
  console.log('  host debug right after tapping START RACE:', JSON.stringify(hostDebug));
  const raced = await Promise.all(
    [p1, p2].map((p) =>
      p
        .waitForFunction(() => ['countdown', 'racing'].includes(document.getElementById('ui')?.dataset.state), { timeout: 90000 })
        .then(() => true)
        .catch(() => false),
    ),
  );
  console.log(`  host entered race: ${raced[0]}  guest entered race: ${raced[1]}`);
  if (!raced[0]) problems.push(`[${label}] host never entered the race`);
  if (!raced[1]) problems.push(`[${label}] guest never entered the race`);

  await p1.screenshot({ path: `shots-mobile/${label}-lobby.png`, fullPage: false });
  await p1.close();
  await p2.close();
}

fs.mkdirSync('shots-mobile', { recursive: true });
await run('online-portrait', 390, 844);
await run('online-landscape', 844, 390);
await browser.close();

console.log('\n--- problems ---');
if (!problems.length) console.log('none');
else for (const p of problems) console.log(' *', p);
process.exit(problems.length ? 1 : 0);
