/**
 * Lmongolyan Chefs online rooms.
 *
 * The server owns the kitchen: what sits on every counter, the orders, the
 * clock and the score. Each browser walks its own chef and reports where it
 * is; picking up, placing and chopping are requests the server applies
 * against the shared kitchen, so two chefs can never grab the same tomato.
 */
import { KITCHEN, createKitchen, interact, packKitchen, tickKitchen } from './kitchen-core.mjs';
import { createDuoRooms } from './duo-rooms.mjs';

function handlers(socket, seatOf, { broadcastSnapshot }) {
  socket.on('chefs:move', (m) => {
    const seat = seatOf();
    const k = seat?.room.game;
    if (!k || !Array.isArray(m)) return;
    const [x, y, fx, fy] = m.map(Number);
    if (![x, y, fx, fy].every(Number.isFinite)) return;
    const chef = k.chefs[seat.player.seat];
    chef.x = Math.max(0, Math.min(KITCHEN.W, x));
    chef.y = Math.max(0, Math.min(KITCHEN.H, y));
    chef.fx = Math.sign(fx); chef.fy = chef.fx ? 0 : Math.sign(fy) || 1;
  });
  socket.on('chefs:act', (payload = {}) => {
    const seat = seatOf();
    const k = seat?.room.game;
    if (!k) return;
    // The action carries the chef's position at the moment of the key press,
    // so a request that arrives mid-stride still hits the counter they faced.
    const [x, y, fx, fy] = Array.isArray(payload.at) ? payload.at.map(Number) : [];
    const chef = k.chefs[seat.player.seat];
    if ([x, y, fx, fy].every(Number.isFinite) && Math.hypot(x - chef.x, y - chef.y) < KITCHEN.T) {
      chef.x = x; chef.y = y; chef.fx = Math.sign(fx); chef.fy = chef.fx ? 0 : Math.sign(fy) || 1;
    }
    interact(k, seat.player.seat);
    broadcastSnapshot(seat.room);
  });
  socket.on('chefs:chop', (on) => {
    const seat = seatOf();
    if (!seat?.room.game) return;
    seat.room.game.chefs[seat.player.seat].chopping = !!on;
  });
}

export function attachChefs(io, { newCode, sanitize, codeLength }) {
  return createDuoRooms({
    io, prefix: 'chefs', newCode, sanitize, codeLength, tickHz: 30, sendEvery: 2,
    createGame: (_room, options) => createKitchen(String(options.difficulty ?? 'normal')),
    tick: (room, dt) => tickKitchen(room.game, dt),
    snapshot: (room) => ({ t: Date.now(), ...packKitchen(room.game) }),
    handlers,
  });
}
