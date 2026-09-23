/**
 * Mangolian Puck online rooms.
 *
 * The server owns the puck, the goals and the score. Each browser owns its
 * mallet, and also decides when *its own* mallet hits the puck: it sends the
 * puck's new position and velocity ("a claim") and the server accepts it if
 * the puck really was about there at that moment. Resolving hits on the
 * hitter's machine is what makes a strike feel instant; the opponent sees it
 * one network trip later, which is far less noticeable than a laggy mallet.
 */
import { PUCK, clamp, clampMallet, freshPuck, homeMallet, servePuck, stepPuck } from './puck-core.mjs';
import { createDuoRooms } from './duo-rooms.mjs';

const CLAIM_TOLERANCE = 110;   // px between the claimed puck and the server's at that time
const CLAIM_MAX_AGE = 220;     // ms a claim may reach back into the past
const GOAL_GRACE = 130;        // ms a goal waits for a defender's late save to arrive
const r1 = (n) => Math.round(n * 10) / 10;

function createGame() {
  return {
    puck: freshPuck(), hold: 1.6, scores: [0, 0], round: 0, lastWinner: 0, seq: 0,
    mallets: [homeMallet(0), homeMallet(1)], acks: [0, 0], lastClaimAt: [0, 0],
    history: [], pending: null,
  };
}

function finishGoal(g) {
  const scorer = g.pending.goal === 1 ? 0 : 1;
  g.pending = null;
  g.scores[scorer]++;
  if (g.scores[scorer] >= PUCK.winScore) {
    g.scores = [0, 0];
    g.round++;
    g.lastWinner = scorer + 1;
  }
  g.puck = servePuck(1 - scorer);
  g.hold = 1;
  g.seq++;
}

function tick(room, dt, now) {
  const g = room.game;
  g.history.push({ t: now, x: g.puck.x, y: g.puck.y });
  if (g.history.length > 40) g.history.shift();
  if (g.pending) {
    if (now - g.pending.at >= GOAL_GRACE) finishGoal(g);
    return;
  }
  if (g.hold > 0) { g.hold = Math.max(0, g.hold - dt); return; }
  const { goal } = stepPuck(g.puck, dt, [null, null]);
  if (goal) g.pending = { goal, at: now };
}

function snapshot(room) {
  const g = room.game, p = g.puck, [a, b] = g.mallets;
  return [
    Date.now(), r1(p.x), r1(p.y), r1(p.vx), r1(p.vy),
    r1(a.x), r1(a.y), r1(a.vx), r1(a.vy), r1(b.x), r1(b.y), r1(b.vx), r1(b.vy),
    g.scores[0], g.scores[1], g.round, g.lastWinner, r1(g.hold), g.seq, g.acks[0], g.acks[1], g.pending ? 1 : 0,
  ];
}

function handlers(socket, seatOf) {
  socket.on('puck:m', (m) => {
    const seat = seatOf();
    if (!seat?.room.game || !Array.isArray(m)) return;
    const [x, y, vx, vy] = m.map(Number);
    if (![x, y, vx, vy].every(Number.isFinite)) return;
    const side = seat.player.seat, pos = clampMallet(side, x, y);
    const cap = PUCK.malletSpeed * 1.5;
    seat.room.game.mallets[side] = { x: pos.x, y: pos.y, vx: clamp(vx, -cap, cap), vy: clamp(vy, -cap, cap) };
  });

  socket.on('puck:hit', (claim = {}) => {
    const seat = seatOf();
    const g = seat?.room.game;
    if (!g) return;
    const side = seat.player.seat, now = Date.now();
    const id = Number(claim.id) || 0;
    g.acks[side] = Math.max(g.acks[side], id);
    const { x, y, vx, vy } = { x: Number(claim.x), y: Number(claim.y), vx: Number(claim.vx), vy: Number(claim.vy) };
    if (![x, y, vx, vy].every(Number.isFinite) || g.hold > 0 || now - g.lastClaimAt[side] < 12) return;
    if (Math.hypot(vx, vy) > PUCK.maxSpeed + 1) return;
    // A player can only strike the puck on their own half.
    if (side === 0 ? x > PUCK.W / 2 + PUCK.puckR + 12 : x < PUCK.W / 2 - PUCK.puckR - 12) return;
    const at = clamp(Number(claim.t) || now, now - CLAIM_MAX_AGE, now);
    let past = null;
    for (const h of g.history) if (!past || Math.abs(h.t - at) < Math.abs(past.t - at)) past = h;
    if (past && Math.hypot(past.x - x, past.y - y) > CLAIM_TOLERANCE) return;
    g.lastClaimAt[side] = now;
    g.pending = null;
    g.puck = { x, y, vx, vy };
    // Bring the claimed puck up to the present.
    const { goal } = stepPuck(g.puck, (now - at) / 1000, [null, null]);
    if (goal) g.pending = { goal, at: now };
    g.seq++;
  });
}

export function attachPuck(io, { newCode, sanitize, codeLength }) {
  return createDuoRooms({
    io, prefix: 'puck', newCode, sanitize, codeLength, tickHz: 60, sendEvery: 2,
    createGame, tick, snapshot, handlers,
    onResume: (room) => { room.game.hold = Math.max(room.game.hold, 1); },
  });
}
