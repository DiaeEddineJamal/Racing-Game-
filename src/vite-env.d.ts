/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute URL of the multiplayer server, baked in at build time.
   *
   * Empty (the default) means same origin, which is what `npm run serve` and
   * the dev server give you. Set it when the client is hosted somewhere that
   * cannot hold a WebSocket open - Vercel, Netlify, GitHub Pages - and the
   * server runs elsewhere:
   *
   *   VITE_GAME_SERVER=https://kart-server.onrender.com npm run build
   */
  readonly VITE_GAME_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
