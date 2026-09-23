/**
 * Two-seat private rooms for the arcade's duo games (Mangolian Puck,
 * Lmongolyan Chefs). One implementation of the lobby rules so every game gets
 * the same behaviour:
 *
 *   - players are identified by a per-tab token, not the socket id, so a
 *     dropped phone connection takes its seat back on `resume`;
 *   - a dropped player's seat is held for `graceMs` and the match pauses;
 *   - the host (seat 0) starts the match; if the host leaves for good the
 *     remaining player becomes seat 0 and host.
 *
 * A game plugs in with `createGame`, `tick(room, dt)`, `snapshot(room)` and
 * extra socket handlers. Events are namespaced `${prefix}:...`.
 */

const clampSeat = (n) => (n === 1 ? 1 : 0);

export function createDuoRooms({
  io, prefix, newCode, sanitize, codeLength, graceMs = 45_000, idleMs = 30 * 60_000,
  tickHz = 60, sendEvery = 2, createGame, tick, snapshot, onResume, handlers,
}) {
  const rooms = new Map();
  const ev = (name) => `${prefix}:${name}`;
  const ack = (fn, reply) => { if (typeof fn === 'function') fn(reply); };
  const tokenOf = (value) => {
    const token = sanitize(value, 64);
    return token.length >= 8 ? token : null;
  };

  const connectedCount = (room) => [...room.players.values()].filter((p) => p.connected).length;
  const publicRoom = (room) => ({
    code: room.code,
    playing: room.playing,
    players: [...room.players.values()].map((p) => ({ seat: p.seat, connected: p.connected })),
  });
  const broadcast = (room) => {
    room.touched = Date.now();
    io.to(room.channel).emit(ev('room'), publicRoom(room));
  };

  function bind(socket, room, player) {
    if (player.dropTimer) clearTimeout(player.dropTimer);
    player.dropTimer = null;
    if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.leave(room.channel);
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.channel);
    socket.data[prefix] = { code: room.code, token: player.token };
  }

  function remove(room, token) {
    const player = room.players.get(token);
    if (!player) return;
    if (player.dropTimer) clearTimeout(player.dropTimer);
    room.players.delete(token);
    if (player.socketId) io.sockets.sockets.get(player.socketId)?.leave(room.channel);
    if (room.players.size === 0) {
      if (rooms.get(room.code) === room) rooms.delete(room.code);
      return;
    }
    room.playing = false;
    if (room.hostToken === token) {
      const next = room.players.values().next().value;
      room.hostToken = next.token;
      next.seat = 0;
      if (next.socketId) io.to(next.socketId).emit(ev('hostChanged'), {});
    }
    broadcast(room);
  }

  /** The seat for this socket, if it is the live connection for it. */
  function seatOf(socket) {
    const ref = socket.data[prefix];
    const room = ref && rooms.get(ref.code);
    const player = room?.players.get(ref.token);
    return room && player && player.socketId === socket.id ? { room, player } : null;
  }

  function attach(socket) {
    socket.data[prefix] = null;
    const leave = () => {
      const ref = socket.data[prefix];
      socket.data[prefix] = null;
      const room = ref && rooms.get(ref.code);
      if (room) remove(room, ref.token);
    };

    socket.on(ev('ping'), (_payload, fn) => ack(fn, Date.now()));

    socket.on(ev('create'), (payload = {}, fn) => {
      const token = tokenOf(payload?.token);
      if (!token) return ack(fn, { error: 'Please refresh the page and try again.' });
      leave();
      const code = newCode((c) => rooms.has(c));
      if (!code) return ack(fn, { error: 'No room codes are available right now.' });
      const room = { code, channel: `${prefix}:${code}`, hostToken: token, players: new Map(), playing: false, touched: Date.now(), lastTick: Date.now(), game: null };
      const player = { token, seat: 0, socketId: null, connected: false, dropTimer: null };
      room.players.set(token, player);
      rooms.set(code, room);
      bind(socket, room, player);
      ack(fn, { room: publicRoom(room), seat: 0 });
      broadcast(room);
    });

    socket.on(ev('join'), (payload = {}, fn) => {
      const token = tokenOf(payload?.token);
      if (!token) return ack(fn, { error: 'Please refresh the page and try again.' });
      const room = rooms.get(sanitize(payload?.code, codeLength).toUpperCase());
      if (!room) return ack(fn, { error: 'No room has that code.' });
      let player = room.players.get(token);
      if (!player) {
        if (room.players.size >= 2) return ack(fn, { error: 'That room already has two players.' });
        leave();
        const taken = [...room.players.values()].map((p) => p.seat);
        player = { token, seat: taken.includes(0) ? 1 : 0, socketId: null, connected: false, dropTimer: null };
        room.players.set(token, player);
      }
      bind(socket, room, player);
      ack(fn, { room: publicRoom(room), seat: player.seat });
      broadcast(room);
    });

    socket.on(ev('resume'), (payload = {}, fn) => {
      const room = rooms.get(sanitize(payload?.code, codeLength).toUpperCase());
      const player = room?.players.get(tokenOf(payload?.token));
      if (!room || !player) return ack(fn, { error: 'That match has ended.' });
      bind(socket, room, player);
      room.lastTick = Date.now();
      if (room.playing && room.game) onResume?.(room);
      ack(fn, { room: publicRoom(room), seat: player.seat });
      broadcast(room);
      if (room.playing && room.game) socket.emit(ev('s'), snapshot(room));
    });

    socket.on(ev('leave'), leave);

    socket.on(ev('start'), (options = {}) => {
      const seat = seatOf(socket);
      const room = seat?.room;
      if (!room || room.hostToken !== seat.player.token || room.players.size !== 2 || connectedCount(room) !== 2) return;
      room.game = createGame(room, options && typeof options === 'object' ? options : {});
      room.playing = true;
      room.lastTick = Date.now();
      io.to(room.channel).emit(ev('start'), {});
      broadcast(room);
      io.to(room.channel).emit(ev('s'), snapshot(room));
    });

    socket.on('disconnect', () => {
      const ref = socket.data[prefix];
      const room = ref && rooms.get(ref.code);
      const player = room?.players.get(ref.token);
      if (!room || !player || player.socketId !== socket.id) return;
      player.connected = false;
      player.socketId = null;
      player.dropTimer = setTimeout(() => remove(room, player.token), graceMs);
      broadcast(room);
    });

    handlers?.(socket, () => seatOf(socket), { broadcastSnapshot: (room) => io.to(room.channel).emit(ev('s'), snapshot(room)) });
  }

  let frame = 0;
  setInterval(() => {
    const now = Date.now();
    const send = frame++ % sendEvery === 0;
    for (const room of rooms.values()) {
      const dt = Math.min((now - room.lastTick) / 1000, 0.05);
      room.lastTick = now;
      if (!room.playing || !room.game) continue;
      // A missing player pauses the match rather than handing the other a win.
      if (room.players.size === 2 && connectedCount(room) === 2) tick(room, dt, now);
      if (send) {
        room.touched = now;
        io.to(room.channel).volatile.emit(ev('s'), snapshot(room));
      }
    }
  }, 1000 / tickHz);

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.players.size === 0 || now - room.touched > idleMs) {
        for (const player of room.players.values()) if (player.dropTimer) clearTimeout(player.dropTimer);
        rooms.delete(code);
      }
    }
  }, 60_000);

  return { attach, rooms, seatOf, clampSeat, connectedCount };
}
