/**
 * Lmongolyan Kart game server.
 *
 * Serves the built client out of dist/ and runs the multiplayer rooms over
 * Socket.IO. The server is deliberately thin: clients simulate their own karts
 * and relay snapshots through here. What the server does own is everything that
 * has to be agreed on - room membership, grid slots, the shared seed, the
 * finishing order and the leaderboard.
 *
 *   npm run build && npm run server        # http://localhost:3000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const LEADERBOARD_FILE = path.join(ROOT, 'server', 'leaderboard.json');

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;
const MAX_PLAYERS = 8;
const GRID_SIZE = 8;
const ROOM_IDLE_MS = 30 * 60 * 1000;
/** How often merged kart snapshots go out to each room. */
const RELAY_HZ = 30;
const LEADERBOARD_ROWS = 10;

const DEFAULT_SETTINGS = { trackId: 'menara', laps: 3, difficulty: 'normal', cpuCount: 7 };

/**
 * Names for the CPU field. Kept in step with src/kart/roster.ts - the client
 * looks characters up by id and falls back to its own roster order if an id here
 * ever goes stale.
 */
const CPU_CHARACTERS = [
  'bzizla', 'zniqui', 'aicha', 'nugget', 'diae', 'bghrir',
  'gary', 'kaskrout', 'l7afozli9', 'l7ezza9', 'bigkevin', 'wanda',
];

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/** trackId -> rows sorted fastest first. Persisted so records survive a restart. */
let leaderboard = {};
try {
  if (fs.existsSync(LEADERBOARD_FILE)) {
    leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('[server] could not read the leaderboard, starting empty:', err.message);
  leaderboard = {};
}

let saveTimer = null;
function saveLeaderboard() {
  if (saveTimer) return;
  // Coalesce the writes: a full grid finishing produces eight submissions at once.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), (err) => {
      if (err) console.warn('[server] could not save the leaderboard:', err.message);
    });
  }, 1500);
}

function submitTime(trackId, row) {
  if (!Number.isFinite(row.time) || row.time <= 0 || row.time > 60 * 60) return;
  const rows = leaderboard[trackId] ?? (leaderboard[trackId] = []);
  rows.push(row);
  rows.sort((a, b) => a.time - b.time);
  rows.length = Math.min(rows.length, LEADERBOARD_ROWS);
  saveLeaderboard();
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** code -> room */
const rooms = new Map();
/** Tiny two-player rooms shared by the separate Mangolian Pong project. */
const pongRooms = new Map();
const PONG = { width: 960, height: 540, paddleHeight: 148, speed: 440, tickMs: 1000 / 60 };

/**
 * Strips angle brackets and control characters only. Names legitimately contain
 * spaces and digits - "Big Kevin", "L7afozli9" - so a stricter filter would
 * mangle exactly the names this game ships with.
 */
function sanitize(s, max = 16) {
  return String(s ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function newCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function newPongCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = newCode();
    if (code && !pongRooms.has(code)) return code;
  }
  return null;
}

function freshPongState() {
  return {
    left: PONG.height / 2 - PONG.paddleHeight / 2,
    right: PONG.height / 2 - PONG.paddleHeight / 2,
    ball: { x: PONG.width / 2, y: PONG.height / 2 },
    velocity: { x: 275, y: 132 },
    leftScore: 0, rightScore: 0, hits: 0, storm: 0, nextStorm: 12, paused: false,
  };
}

function resetPongBall(state, toLeft = Math.random() > 0.5) {
  state.ball = { x: PONG.width / 2, y: PONG.height / 2 };
  state.velocity = {
    x: (toLeft ? -1 : 1) * (260 + Math.min(state.hits * 8, 170)),
    y: Math.random() * 180 - 90,
  };
  state.hits = 0;
}

function tickPong(room, dt) {
  if (!room.playing || room.players.size !== 2) return;
  const s = room.state;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const left = room.inputs.left;
  const right = room.inputs.right;
  const leftMove = (left.up ? -1 : 0) + (left.down ? 1 : 0);
  const rightMove = (right.up ? -1 : 0) + (right.down ? 1 : 0);
  s.left = clamp(s.left + leftMove * PONG.speed * dt, 0, PONG.height - PONG.paddleHeight);
  s.right = clamp(s.right + rightMove * PONG.speed * dt, 0, PONG.height - PONG.paddleHeight);
  s.ball.x += s.velocity.x * dt;
  s.ball.y += s.velocity.y * dt;
  if (s.ball.y < 14 || s.ball.y > PONG.height - 14) {
    s.velocity.y *= -1;
    s.ball.y = clamp(s.ball.y, 14, PONG.height - 14);
  }
  const leftHit = s.velocity.x < 0 && s.ball.x - 18 < 76 && s.ball.x + 18 > 24 && s.ball.y > s.left && s.ball.y < s.left + PONG.paddleHeight;
  const rightHit = s.velocity.x > 0 && s.ball.x + 18 > PONG.width - 76 && s.ball.x - 18 < PONG.width - 24 && s.ball.y > s.right && s.ball.y < s.right + PONG.paddleHeight;
  if (leftHit || rightHit) {
    const paddleY = leftHit ? s.left : s.right;
    const relative = (s.ball.y - (paddleY + PONG.paddleHeight / 2)) / (PONG.paddleHeight / 2);
    s.velocity.x = (leftHit ? 1 : -1) * Math.min(Math.abs(s.velocity.x) + 21, 610);
    s.velocity.y += relative * 105;
    s.ball.x = leftHit ? 78 : PONG.width - 78;
    s.hits++;
  }
  if (s.ball.x < -30 || s.ball.x > PONG.width + 30) {
    const leftWon = s.ball.x > PONG.width + 30;
    if (leftWon) s.leftScore++; else s.rightScore++;
    if ((leftWon ? s.leftScore : s.rightScore) >= 11) {
      s.leftScore = 0;
      s.rightScore = 0;
    }
    resetPongBall(s, !leftWon);
  }
  s.nextStorm -= dt;
  if (s.nextStorm <= 0) {
    s.storm = s.storm ? 0 : 5.5;
    s.nextStorm = s.storm ? 5.5 : 12;
    if (s.storm) s.velocity.y *= 1.65;
  }
  if (s.storm) {
    s.storm -= dt;
    room.elapsed += dt;
    s.velocity.y += Math.sin(room.elapsed * 6) * 2.8;
  }
  // The packet is deliberately tiny; at two players, a 60 Hz volatile relay
  // makes remote motion feel immediate without queueing old frames.
  io.to(room.code).volatile.emit('pong:state', s);
}

function publicPongRoom(room) {
  return { code: room.code, hostId: room.hostId, players: [...room.players.values()] };
}

function broadcastPong(room) {
  room.touched = Date.now();
  io.to(room.code).emit('pong:room', publicPongRoom(room));
}

function leavePongRoom(socket) {
  const code = socket.data.pongRoomCode;
  if (!code) return;
  socket.data.pongRoomCode = null;
  const room = pongRooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.players.size === 0) {
    pongRooms.delete(code);
    return;
  }
  room.playing = false;
  room.inputs = { left: { up: false, down: false }, right: { up: false, down: false } };
  if (room.hostId === socket.id) {
    // A Pong match is host-authoritative; losing the host returns the guest to the lobby.
    room.hostId = room.players.keys().next().value;
    for (const player of room.players.values()) player.side = 'left';
    io.to(code).emit('pong:hostChanged', { hostId: room.hostId });
  }
  broadcastPong(room);
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    racing: room.racing,
    settings: room.settings,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      characterId: p.characterId,
      ready: p.ready,
      kartId: p.kartId,
      host: p.id === room.hostId,
    })),
  };
}

function broadcastRoom(room) {
  room.touched = Date.now();
  io.to(room.code).emit('room:update', publicRoom(room));
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) {
    // Oldest remaining player takes over, so the room does not die with the host.
    room.hostId = room.players.keys().next().value;
  }
  io.to(code).emit('room:left', { id: socket.id });
  broadcastRoom(room);
}

// ---------------------------------------------------------------------------
// HTTP + sockets
// ---------------------------------------------------------------------------

const app = express();
app.use(compression());
app.get('/healthz', (_req, res) => res.json({ ok: true, racingRooms: rooms.size, pongRooms: pongRooms.size }));
app.get('/api/leaderboard/:trackId', (req, res) => {
  res.json({ trackId: req.params.trackId, rows: leaderboard[req.params.trackId] ?? [] });
});

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { maxAge: '1h', index: 'index.html' }));
  // public/ is served straight from the repo as well as from whatever vite
  // copied into dist/. A free host installs production dependencies only, so it
  // cannot run the build; the committed dist/ holds just index.html and the
  // hashed bundle, and the karts, audio and fonts come from here.
  app.use(express.static(PUBLIC, { maxAge: '1d' }));
  app.use((_req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.use((_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('No build found. Run "npm run build" first, or use "npm run dev" for the dev server.');
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  pingInterval: 12000,
  pingTimeout: 20000,
  // Position snapshots are small and go out ~30 times a second per kart -
  // compressing them costs more CPU (and, per packet, more wall-clock time)
  // than it ever saves in bytes. Both flags are off by default in recent
  // Engine.IO, but that has changed before and setting them explicitly means
  // a version bump can't quietly reintroduce per-message deflate here.
  perMessageDeflate: false,
  httpCompression: false,
});

// Nagle's algorithm batches small writes to fill a full TCP segment before
// sending, which is exactly wrong for a stream of tiny, frequent kart
// snapshots: it can hold one back for tens of milliseconds waiting for more
// data that never comes. Disabling it trades a little bandwidth efficiency
// for lower latency on every packet, which is the right trade for real-time
// state - see the Socket.IO performance guide.
io.engine.on('connection', (rawSocket) => {
  try {
    rawSocket.setNoDelay(true);
  } catch {
    /* not every transport (long-polling) exposes a raw TCP socket here */
  }
});

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.pongRoomCode = null;
  socket.data.name = 'Racer';

  // --- Mangolian Pong rooms -------------------------------------------------
  // The server advances the shared game loop; it owns admission, codes, and
  // which side each connected player uses.
  socket.on('pong:create', (_payload, ack) => {
    leavePongRoom(socket);
    const code = newPongCode();
    if (!code) {
      if (typeof ack === 'function') ack({ error: 'No room codes are available right now.' });
      return;
    }
    const room = {
      code, hostId: socket.id, players: new Map(), touched: Date.now(),
      inputs: { left: { up: false, down: false }, right: { up: false, down: false } },
      state: freshPongState(), playing: false, frames: 0, elapsed: 0, lastTick: Date.now(),
    };
    room.players.set(socket.id, { id: socket.id, side: 'left' });
    pongRooms.set(code, room);
    socket.join(code);
    socket.data.pongRoomCode = code;
    if (typeof ack === 'function') ack({ room: publicPongRoom(room), you: socket.id });
    broadcastPong(room);
  });

  socket.on('pong:join', ({ code } = {}, ack) => {
    const room = pongRooms.get(sanitize(code, ROOM_CODE_LENGTH).toUpperCase());
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'No Pong room has that code.' });
      return;
    }
    if (room.players.size >= 2) {
      if (typeof ack === 'function') ack({ error: 'That Pong room already has two players.' });
      return;
    }
    leavePongRoom(socket);
    room.players.set(socket.id, { id: socket.id, side: 'right' });
    socket.join(room.code);
    socket.data.pongRoomCode = room.code;
    if (typeof ack === 'function') ack({ room: publicPongRoom(room), you: socket.id });
    broadcastPong(room);
  });

  socket.on('pong:leave', () => leavePongRoom(socket));
  socket.on('pong:input', (input = {}) => {
    const room = pongRooms.get(socket.data.pongRoomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    const legacyKey = String(input.key ?? '').toLowerCase();
    const action = input.action === 'up' || input.action === 'down'
      ? input.action
      : legacyKey === 'w' || legacyKey === 'arrowup' ? 'up' : legacyKey === 's' || legacyKey === 'arrowdown' ? 'down' : null;
    if (!action) return;
    room.inputs[player.side][action] = !!input.down;
    room.touched = Date.now();
  });
  socket.on('pong:start', () => {
    const room = pongRooms.get(socket.data.pongRoomCode);
    if (!room || room.hostId !== socket.id || room.players.size !== 2) return;
    room.state = freshPongState();
    room.inputs = { left: { up: false, down: false }, right: { up: false, down: false } };
    room.playing = true;
    room.frames = 0;
    room.elapsed = 0;
    room.lastTick = Date.now();
    io.to(room.code).emit('pong:start', {});
    io.to(room.code).emit('pong:state', room.state);
  });

  socket.on('room:create', (payload, ack) => {
    leaveRoom(socket);
    const code = newCode();
    if (!code) {
      if (typeof ack === 'function') ack({ error: 'The server is full of rooms. Try again in a moment.' });
      return;
    }
    const name = sanitize(payload?.name) || 'Racer';
    socket.data.name = name;
    const room = {
      code,
      hostId: socket.id,
      racing: false,
      /** kartId -> newest snapshot, flushed to the room on the next relay tick. */
      pending: new Map(),
      settings: { ...DEFAULT_SETTINGS },
      players: new Map(),
      finishes: [],
      touched: Date.now(),
    };
    room.players.set(socket.id, {
      id: socket.id,
      name,
      characterId: sanitize(payload?.characterId, 24) || 'diae',
      ready: true,
      kartId: -1,
    });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    if (typeof ack === 'function') ack({ room: publicRoom(room), you: socket.id });
    broadcastRoom(room);
  });

  socket.on('room:join', (payload, ack) => {
    const code = sanitize(payload?.code, ROOM_CODE_LENGTH).toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      if (typeof ack === 'function') ack({ error: `No room with the code ${code || '????'}.` });
      return;
    }
    if (room.racing) {
      if (typeof ack === 'function') ack({ error: 'That race has already started.' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      if (typeof ack === 'function') ack({ error: 'That room is full.' });
      return;
    }
    leaveRoom(socket);
    const name = sanitize(payload?.name) || 'Racer';
    socket.data.name = name;
    room.players.set(socket.id, {
      id: socket.id,
      name,
      characterId: sanitize(payload?.characterId, 24) || 'diae',
      ready: false,
      kartId: -1,
    });
    socket.join(code);
    socket.data.roomCode = code;
    if (typeof ack === 'function') ack({ room: publicRoom(room), you: socket.id });
    broadcastRoom(room);
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('room:setCharacter', ({ characterId } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!player) return;
    player.characterId = sanitize(characterId, 24) || player.characterId;
    broadcastRoom(room);
  });

  socket.on('room:setReady', ({ ready } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!player) return;
    player.ready = !!ready;
    broadcastRoom(room);
  });

  socket.on('room:setSettings', (settings = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    const s = room.settings;
    if (typeof settings.trackId === 'string') s.trackId = sanitize(settings.trackId, 24) || s.trackId;
    if (Number.isFinite(settings.laps)) s.laps = Math.max(1, Math.min(7, Math.round(settings.laps)));
    if (['easy', 'normal', 'hard'].includes(settings.difficulty)) s.difficulty = settings.difficulty;
    if (Number.isFinite(settings.cpuCount)) {
      s.cpuCount = Math.max(0, Math.min(GRID_SIZE - 1, Math.round(settings.cpuCount)));
    }
    broadcastRoom(room);
  });

  socket.on('room:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.racing) return;
    const players = [...room.players.values()];
    // Grid slots: humans first in join order, then the CPU field.
    players.forEach((p, i) => {
      p.kartId = i;
    });
    const cpuCount = Math.max(0, Math.min(room.settings.cpuCount, GRID_SIZE - players.length));
    // Give the CPUs characters nobody in the room picked, so no two karts on the
    // grid are the same racer.
    const taken = new Set(players.map((p) => p.characterId));
    const pool = CPU_CHARACTERS.filter((id) => !taken.has(id));
    const cpus = [];
    for (let i = 0; i < cpuCount; i++) {
      cpus.push({ kartId: players.length + i, characterId: pool[i % Math.max(1, pool.length)] ?? CPU_CHARACTERS[i] });
    }
    room.racing = true;
    room.finishes = [];
    const begin = {
      settings: { ...room.settings, cpuCount },
      players: publicRoom(room).players,
      cpus,
      seed: (Math.random() * 0x7fffffff) | 0,
    };
    io.to(room.code).emit('race:begin', begin);
    broadcastRoom(room);
  });

  socket.on('room:abandon', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.racing = false;
    room.finishes = [];
    for (const p of room.players.values()) {
      p.kartId = -1;
      p.ready = p.id === room.hostId;
    }
    io.to(room.code).emit('race:abandon', {});
    broadcastRoom(room);
  });

  // --- in-race relays ------------------------------------------------------
  // These are hot paths: no validation beyond "you are in a room".

  /**
   * Snapshots are not forwarded on arrival. They are merged into the room's
   * pending map, keyed by kart, and the whole room goes out as one packet on the
   * next relay tick (see below). Four players used to mean four packets per
   * client per tick, each one able to arrive late on its own; now it is one, and
   * a client that sends twice between ticks simply overwrites itself instead of
   * queueing a snapshot that is already stale by the time it lands.
   */
  socket.on('net:states', (snapshots) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !Array.isArray(snapshots)) return;
    for (const snap of snapshots) {
      if (!snap || typeof snap.i !== 'number') continue;
      const kartId = Math.trunc(snap.i);
      if (kartId < 0 || kartId >= GRID_SIZE) continue;
      room.pending.set(kartId, snap);
    }
  });

  socket.on('net:event', (event) => {
    const code = socket.data.roomCode;
    if (!code || !event || typeof event.t !== 'string') return;
    // Events are one-shot and must not be dropped, so they skip the tick and go
    // out reliably, right now.
    socket.to(code).emit('net:event', event);
  });

  // Round-trip probe. The client uses the measured latency to extrapolate
  // remote karts forward, which is most of what makes them look smooth.
  socket.on('net:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('race:finished', (report = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.racing) return;
    const kartId = Math.trunc(report.kartId);
    if (!Number.isInteger(kartId) || kartId < 0 || kartId >= GRID_SIZE) return;
    if (room.finishes.some((f) => f.kartId === kartId)) return;
    const time = Number(report.time);
    const entry = { kartId, place: room.finishes.length + 1, time: Number.isFinite(time) ? time : 0 };
    room.finishes.push(entry);
    io.to(room.code).emit('race:order', entry);

    const player = [...room.players.values()].find((p) => p.kartId === kartId);
    if (player && Number.isFinite(time) && time > 0) {
      submitTime(room.settings.trackId, {
        name: player.name,
        characterId: player.characterId,
        time,
        at: Date.now(),
      });
    }
  });

  socket.on('leaderboard:get', ({ trackId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    ack({ trackId, rows: leaderboard[sanitize(trackId, 24)] ?? [] });
  });

  socket.on('disconnect', () => { leaveRoom(socket); leavePongRoom(socket); });
});

// Online Pong is server-authoritative: input arrives from both browsers, while
// a fixed simulation tick keeps their paddles and ball in the same timeline.
setInterval(() => {
  const now = Date.now();
  for (const room of pongRooms.values()) {
    const dt = Math.min((now - room.lastTick) / 1000, 0.05);
    room.lastTick = now;
    tickPong(room, dt);
  }
}, PONG.tickMs);

// Merged snapshot relay. One packet per room per tick, sent volatile: if a
// client's socket is backed up, the right thing is to drop this frame's
// positions rather than deliver them late behind a queue.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.pending.size === 0) continue;
    const batch = [...room.pending.values()];
    room.pending.clear();
    // Senders get their own karts back and ignore them client-side; filtering
    // per socket would cost one serialisation per player instead of one per room.
    io.to(room.code).volatile.emit('net:states', batch);
  }
}, 1000 / RELAY_HZ);

// Sweep rooms nobody has touched in half an hour.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || now - room.touched > ROOM_IDLE_MS) rooms.delete(code);
  }
  for (const [code, room] of pongRooms) {
    if (room.players.size === 0 || now - room.touched > ROOM_IDLE_MS) pongRooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Lmongolyan Kart server listening on http://localhost:${PORT}`);
  if (!fs.existsSync(DIST)) console.log('  (no dist/ yet - run "npm run build")');
});
