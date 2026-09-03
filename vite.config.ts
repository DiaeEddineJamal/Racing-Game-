import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { defineConfig, type Plugin } from 'vite';

// The multiplayer server (server/index.js) listens on its own port. In dev the
// page is served by Vite, so socket.io traffic is proxied through to it - that
// way the client can keep assuming same-origin in both dev and production.
const GAME_SERVER = process.env.GAME_SERVER || 'http://localhost:3000';

/** True when something is already listening on host:port. */
function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Starts server/index.js alongside `vite dev` unless it is already up.
 *
 * Without this, "PLAY ONLINE" in a dev session fails with a stream of
 * `ws proxy error: ECONNREFUSED` in the terminal and "could not reach the game
 * server" in the browser - the proxy has nothing to proxy to, because the
 * multiplayer server is a second process people forget to start. Pointing
 * GAME_SERVER at a non-local host opts out: that machine runs its own.
 */
function gameServerPlugin(): Plugin {
  let child: ChildProcess | null = null;

  const stop = (): void => {
    if (!child) return;
    const proc = child;
    child = null;
    proc.kill();
  };

  return {
    name: 'kart-dev-game-server',
    apply: 'serve',
    async configureServer(server) {
      const url = new URL(GAME_SERVER);
      const host = url.hostname;
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return;
      const port = Number(url.port || 80);

      if (await isListening(host === '[::1]' ? '::1' : host, port)) {
        server.config.logger.info(`  ➜  Game server:  already running on ${GAME_SERVER}`);
        return;
      }

      child = spawn(process.execPath, ['server/index.js'], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const relay = (buf: Buffer): void => {
        const text = buf.toString().trimEnd();
        if (text) server.config.logger.info(`[game server] ${text}`);
      };
      child.stdout?.on('data', relay);
      child.stderr?.on('data', relay);
      child.on('exit', (code) => {
        if (child) server.config.logger.warn(`[game server] exited (${code}); online play is unavailable`);
        child = null;
      });
      server.config.logger.info(`  ➜  Game server:  starting on ${GAME_SERVER}`);

      server.httpServer?.once('close', stop);
      process.once('exit', stop);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    closeBundle: stop,
  };
}

export default defineConfig({
  base: './',
  plugins: [gameServerPlugin()],
  server: {
    port: 5178,
    strictPort: false,
    open: false,
    proxy: {
      '/socket.io': { target: GAME_SERVER, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
