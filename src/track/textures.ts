import * as THREE from 'three';
import type { TrackDefinition, TrackTheme } from '../core/types';
import { fbm2, clamp01, seededRandom } from '../core/math';
import { GAME_TITLE } from '../core/constants';

/** Length of one road texture tile along the track (metres). */
export const ROAD_TILE_LENGTH = 8;

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function css(hex: number, alpha = 1): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not available');
  return { canvas, ctx };
}

function finishTexture(canvas: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean; anisotropy?: number } = {}): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (opts.repeat !== false) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  if (opts.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = opts.anisotropy ?? 16;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Fill the canvas with a base colour modulated by tiling fbm noise. */
function fillNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  base: number,
  amount: number,
  scale: number,
  seed: number,
  tint?: { color: number; strength: number },
): void {
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const [br, bg, bb] = hexToRgb(base);
  const tintRgb = tint ? hexToRgb(tint.color) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Tile seamlessly by blending 4 offset copies is overkill; use a periodic domain via sin.
      const u = (x / w) * Math.PI * 2;
      const v = (y / h) * Math.PI * 2;
      const nx = Math.cos(u) * scale + seed;
      const ny = Math.sin(u) * scale + seed * 1.7;
      const nz = Math.cos(v) * scale + seed * 0.3;
      const nw = Math.sin(v) * scale + seed * 2.1;
      const n1 = fbm2(nx + nz, ny + nw, 4);
      const n2 = fbm2(nx * 2.7 - nw, ny * 2.7 + nz, 3);
      const n = (n1 - 0.5) * amount + (n2 - 0.5) * amount * 0.5;
      let r = br * (1 + n);
      let g = bg * (1 + n);
      let b = bb * (1 + n);
      if (tintRgb) {
        const k = clamp01((n2 - 0.5) * 2) * tint!.strength;
        r = r * (1 - k) + tintRgb[0] * k;
        g = g * (1 - k) + tintRgb[1] * k;
        b = b * (1 - k) + tintRgb[2] * k;
      }
      const i = (y * w + x) * 4;
      data[i] = clamp01(r / 255) * 255;
      data[i + 1] = clamp01(g / 255) * 255;
      data[i + 2] = clamp01(b / 255) * 255;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export interface RoadTextures {
  map: THREE.CanvasTexture;
  emissiveMap: THREE.CanvasTexture | null;
}

/**
 * Road surface: u = across the road (0 left edge .. 1 right edge), v = along the track,
 * one tile = ROAD_TILE_LENGTH metres. Contains asphalt/ice noise, edge lines and a centre dash.
 */
export function makeRoadTextures(def: TrackDefinition): RoadTextures {
  const W = 512;
  const H = 512;
  const { canvas, ctx } = makeCanvas(W, H);
  const theme = def.theme;
  const p = def.palette;
  const rng = seededRandom(1234);

  if (theme === 'snow') {
    // Smooth ice: pale blue-grey, only broad low-frequency variation, soft sheen and a few large cracks.
    fillNoise(ctx, W, H, p.road, 0.09, 0.55, 3.1, { color: 0xc9e2f2, strength: 0.22 });
    // soft sheen streaks along the driving direction
    for (let i = 0; i < 7; i++) {
      const x = rng() * W;
      const w = 40 + rng() * 90;
      const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(240,250,255,0.13)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - w / 2, 0, w, H);
    }
    // sparse large cracks: a bright core with a darker shadow line
    for (let i = 0; i < 5; i++) {
      const pts: [number, number][] = [];
      let x = rng() * W;
      let y = rng() * H;
      const dirX = (rng() - 0.5) * 1.4;
      const dirY = rng() < 0.5 ? -1 : 1;
      const segs = 5 + Math.floor(rng() * 4);
      for (let k = 0; k <= segs; k++) {
        pts.push([x, y]);
        x += dirX * 30 + (rng() - 0.5) * 34;
        y += dirY * (36 + rng() * 40);
      }
      const drawPoly = (): void => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.stroke();
      };
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(70,95,120,0.35)';
      ctx.lineWidth = 4.5;
      drawPoly();
      ctx.strokeStyle = 'rgba(235,248,255,0.55)';
      ctx.lineWidth = 1.8;
      drawPoly();
      // a short side branch
      if (rng() < 0.7) {
        const j = 1 + Math.floor(rng() * (pts.length - 2));
        ctx.beginPath();
        ctx.moveTo(pts[j][0], pts[j][1]);
        ctx.lineTo(pts[j][0] + (rng() - 0.5) * 70, pts[j][1] + (rng() - 0.5) * 50);
        ctx.strokeStyle = 'rgba(235,248,255,0.4)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  } else {
    // Asphalt: near-black grey with very fine aggregate grain and only a whisper of low-frequency mottling.
    fillNoise(ctx, W, H, p.road, theme === 'neon' ? 0.16 : 0.12, 0.9, 3.1);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const grain = theme === 'neon' ? 10 : 14;
    for (let i = 0; i < d.length; i += 4) {
      const g = (rng() - 0.5) * grain + (rng() < 0.035 ? 18 : 0);
      d[i] = clamp01((d[i] + g) / 255) * 255;
      d[i + 1] = clamp01((d[i + 1] + g) / 255) * 255;
      d[i + 2] = clamp01((d[i + 2] + g * 1.05) / 255) * 255;
    }
    ctx.putImageData(img, 0, 0);
    // faint lighter wear bands where the karts actually drive (worn aggregate reads lighter)
    for (const cx of [0.27, 0.73]) {
      const bw = W * 0.2;
      const g = ctx.createLinearGradient(W * cx - bw / 2, 0, W * cx + bw / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, theme === 'neon' ? 'rgba(200,210,255,0.07)' : 'rgba(255,255,255,0.09)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(W * cx - bw / 2, 0, bw, H);
    }
    if (theme === 'desert') {
      // sand blown onto the edges of the road
      for (const side of [0, 1]) {
        const g = ctx.createLinearGradient(side === 0 ? 0 : W, 0, side === 0 ? W * 0.12 : W * 0.88, 0);
        g.addColorStop(0, css(p.offroad, 0.32));
        g.addColorStop(1, css(p.offroad, 0));
        ctx.fillStyle = g;
        ctx.fillRect(side === 0 ? 0 : W * 0.88, 0, W * 0.12, H);
      }
    }
    // occasional darker patch (repair) to break up the tile
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#000';
    ctx.fillRect(W * 0.42, H * 0.3, W * 0.16, H * 0.22);
    ctx.globalAlpha = 1;
  }

  // Edge lines + centre dash
  const stripe = css(p.roadStripe);
  const edgeW = W * 0.02;
  const edgeInset = W * 0.035;
  ctx.fillStyle = stripe;
  ctx.globalAlpha = theme === 'snow' ? 0.55 : 0.9;
  ctx.fillRect(edgeInset, 0, edgeW, H);
  ctx.fillRect(W - edgeInset - edgeW, 0, edgeW, H);
  // centre dash: two 2.4 m dashes per 8 m tile
  const dashLen = (2.4 / ROAD_TILE_LENGTH) * H;
  const dashW = W * 0.018;
  ctx.fillRect(W / 2 - dashW / 2, H * 0.05, dashW, dashLen);
  ctx.fillRect(W / 2 - dashW / 2, H * 0.55, dashW, dashLen);
  ctx.globalAlpha = 1;
  if (theme !== 'snow') {
    // paint wear: knock the lines back a touch so they do not look freshly printed
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = css(p.road);
    for (let i = 0; i < 60; i++) ctx.fillRect(rng() * W, rng() * H, 2 + rng() * 6, 2 + rng() * 10);
    ctx.globalAlpha = 1;
  }
  const map = finishTexture(canvas);

  let emissiveMap: THREE.CanvasTexture | null = null;
  if (theme === 'neon') {
    const e = makeCanvas(W, H);
    e.ctx.fillStyle = '#000';
    e.ctx.fillRect(0, 0, W, H);
    e.ctx.fillStyle = css(p.roadStripe);
    e.ctx.fillRect(edgeInset, 0, edgeW, H);
    e.ctx.fillStyle = css(p.curb);
    e.ctx.fillRect(W - edgeInset - edgeW, 0, edgeW, H);
    e.ctx.fillStyle = css(p.roadStripe);
    e.ctx.fillRect(W / 2 - dashW / 2, H * 0.05, dashW, dashLen);
    e.ctx.fillRect(W / 2 - dashW / 2, H * 0.55, dashW, dashLen);
    // glow halo
    e.ctx.globalAlpha = 0.35;
    e.ctx.fillStyle = css(p.roadStripe);
    e.ctx.fillRect(edgeInset - edgeW, 0, edgeW * 3, H);
    e.ctx.fillStyle = css(p.curb);
    e.ctx.fillRect(W - edgeInset - edgeW * 2, 0, edgeW * 3, H);
    e.ctx.globalAlpha = 1;
    emissiveMap = finishTexture(e.canvas);
  }
  return { map, emissiveMap };
}

/** Tiling ground texture (grass / sand / snow / dark asphalt). One tile ~ 4 m. */
export function makeGroundTexture(theme: TrackTheme, base: number): THREE.CanvasTexture {
  const S = 256;
  const { canvas, ctx } = makeCanvas(S, S);
  const amount = theme === 'snow' ? 0.08 : theme === 'neon' ? 0.2 : theme === 'grassland' ? 0.2 : 0.32;
  const tint =
    theme === 'grassland'
      ? { color: 0x8fc93e, strength: 0.3 }
      : theme === 'desert'
        ? { color: 0xb87a3c, strength: 0.3 }
        : theme === 'beach'
          ? { color: 0xf0dcae, strength: 0.28 }
          : theme === 'volcano'
            ? { color: 0x2a1f1c, strength: 0.35 }
            : theme === 'snow'
              ? { color: 0xcfe3f5, strength: 0.25 }
              : undefined;
  fillNoise(ctx, S, S, base, amount, 1.3, 7.7, tint);
  const rng = seededRandom(99);
  if (theme === 'grassland') {
    // two-tone turf: broad darker patches over the base green (periodic so the tile stays seamless)
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * Math.PI * 2;
        const v = (y / S) * Math.PI * 2;
        const n = fbm2(Math.cos(u) * 0.9 + Math.cos(v) * 0.9 + 11.3, Math.sin(u) * 0.9 + Math.sin(v) * 0.9 + 4.2, 3);
        const k = clamp01((n - 0.47) * 3.2) * 0.42;
        const i = (y * S + x) * 4;
        d[i] = d[i] * (1 - k) + 0x2f * k;
        d[i + 1] = d[i + 1] * (1 - k) + 0x7a * k;
        d[i + 2] = d[i + 2] * (1 - k) + 0x24 * k;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = rng() < 0.5 ? 'rgba(170,230,80,0.6)' : 'rgba(30,80,25,0.65)';
      ctx.fillRect(rng() * S, rng() * S, 1, 2 + rng() * 3);
    }
  } else if (theme === 'desert') {
    // wind ripples
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = 'rgba(90,50,20,1)';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      const y = rng() * S;
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.1 + i) * 4);
      ctx.stroke();
    }
  } else if (theme === 'beach') {
    // wet-sand ripples plus scattered shell flecks
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = 'rgba(150,110,60,1)';
    for (let i = 0; i < 34; i++) {
      ctx.beginPath();
      const y = rng() * S;
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.08 + i) * 5);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = rng() < 0.5 ? 'rgba(255,250,235,0.8)' : 'rgba(190,160,120,0.7)';
      ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1 + rng());
    }
  } else if (theme === 'volcano') {
    // cracked basalt: a dark web with a faint ember glow in the fissures
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 26; i++) {
      let x = rng() * S;
      let y = rng() * S;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (rng() - 0.5) * 70;
        y += (rng() - 0.5) * 70;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(12,8,8,0.85)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,120,40,0.22)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    ctx.globalAlpha = 0.4;
    for (let i = 0; i < 420; i++) {
      ctx.fillStyle = rng() < 0.75 ? 'rgba(30,24,24,0.9)' : 'rgba(120,60,40,0.8)';
      ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1 + rng() * 2);
    }
  } else if (theme === 'snow') {
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(rng() * S, rng() * S, 1, 1);
    }
  } else if (theme === 'neon') {
    // pavement tiles
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = 'rgba(60,80,120,1)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo((i * S) / 4, 0);
      ctx.lineTo((i * S) / 4, S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (i * S) / 4);
      ctx.lineTo(S, (i * S) / 4);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  return finishTexture(canvas);
}

/** Black/white checker for the start/finish line. */
export function makeCheckerTexture(cols = 12, rows = 2): THREE.CanvasTexture {
  const cell = 32;
  const { canvas, ctx } = makeCanvas(cols * cell, rows * cell);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return finishTexture(canvas, { repeat: false });
}

/** Big banner with the game title for the start gantry. */
export function makeBannerTexture(theme: TrackTheme, accent: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  if (theme === 'neon') {
    grad.addColorStop(0, '#12061f');
    grad.addColorStop(1, '#1a0b33');
  } else {
    grad.addColorStop(0, '#c81e2b');
    grad.addColorStop(0.5, '#e63946');
    grad.addColorStop(1, '#c81e2b');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // checker border
  const cell = 16;
  for (let x = 0; x < W / cell; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.fillRect(x * cell, H - (y + 1) * cell, cell, cell);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'italic 900 96px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
  // Fit the title inside the banner with margins regardless of the platform font.
  const measured = ctx.measureText(GAME_TITLE).width;
  if (measured > W * 0.86) ctx.font = `italic 900 ${Math.floor((96 * W * 0.86) / measured)}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(GAME_TITLE, W / 2, H / 2 + 6);
  ctx.fillStyle = theme === 'neon' ? css(accent) : '#fff7d6';
  ctx.fillText(GAME_TITLE, W / 2, H / 2 + 6);
  if (theme === 'neon') {
    ctx.shadowColor = css(accent);
    ctx.shadowBlur = 40;
    ctx.fillText(GAME_TITLE, W / 2, H / 2 + 6);
    ctx.shadowBlur = 0;
  }
  return finishTexture(canvas, { repeat: false });
}

/** Boost pad body: dark rounded strip with a lighter rim (transparent outside). u across, v along. */
export function makeBoostBaseTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 128;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const r = 14;
  const rr = (x: number, y: number, w: number, h: number, rad: number): void => {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  };
  rr(2, 2, W - 4, H - 4, r);
  ctx.fillStyle = '#4a4b52';
  ctx.fill();
  rr(6, 6, W - 12, H - 12, r - 3);
  ctx.fillStyle = '#17171b';
  ctx.fill();
  // faint inner panel lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo((W * i) / 4, 8);
    ctx.lineTo((W * i) / 4, H - 8);
    ctx.stroke();
  }
  return finishTexture(canvas, { repeat: false });
}

/** One boost chevron per tile (transparent background), orange at the back fading to yellow at the tip. */
export function makeBoostChevronTile(): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  // chevron points toward canvas top (= +v = track forward, CanvasTexture flips Y)
  const thick = H * 0.3;
  const tipY = H * 0.12;
  const wingY = H * 0.62;
  const grad = ctx.createLinearGradient(0, wingY + thick, 0, tipY);
  grad.addColorStop(0, '#ff7a12');
  grad.addColorStop(0.55, '#ffb020');
  grad.addColorStop(1, '#ffef5a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(W * 0.06, wingY);
  ctx.lineTo(W / 2, tipY);
  ctx.lineTo(W * 0.94, wingY);
  ctx.lineTo(W * 0.94, wingY + thick);
  ctx.lineTo(W / 2, tipY + thick);
  ctx.lineTo(W * 0.06, wingY + thick);
  ctx.closePath();
  ctx.fill();
  // thin bright highlight along the leading edge
  ctx.strokeStyle = 'rgba(255,255,220,0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W * 0.06, wingY);
  ctx.lineTo(W / 2, tipY);
  ctx.lineTo(W * 0.94, wingY);
  ctx.stroke();
  return finishTexture(canvas);
}

/** Faint orange fade used for the on-road boost trail ahead of a pad (v = along, fades to 0 at v = 1). */
export function makeBoostTrailTexture(): THREE.CanvasTexture {
  const W = 64;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  // v = 0 is canvas bottom (flipY)
  const g = ctx.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, 'rgba(255,150,40,0.36)');
  g.addColorStop(0.45, 'rgba(255,170,50,0.16)');
  g.addColorStop(1, 'rgba(255,190,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // soften the sides
  const side = ctx.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(0,0,0,1)');
  side.addColorStop(0.2, 'rgba(0,0,0,0)');
  side.addColorStop(0.8, 'rgba(0,0,0,0)');
  side.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  return finishTexture(canvas, { repeat: false });
}

/** Single tyre skid streak: dark rubber with ragged edges, fading in at v = 0 and out at v = 1. */
export function makeSkidTexture(): THREE.CanvasTexture {
  const W = 32;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.clearRect(0, 0, W, H);
  const rng = seededRandom(31);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const fade = Math.sin(Math.PI * Math.min(1, Math.max(0, v))) ** 0.7;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const edge = 1 - Math.pow(Math.abs(u - 0.5) * 2, 3);
      const rough = 0.75 + rng() * 0.25;
      const a = fade * edge * rough * 0.78;
      const i = (y * W + x) * 4;
      d[i] = 12;
      d[i + 1] = 12;
      d[i + 2] = 14;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(canvas, { repeat: false });
}

/** Fictional sponsor banner (rounded panel, bold display text). */
export function makeSponsorTexture(text: string, bg: number, fg: number, accent: number, glow = false): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = css(bg);
  ctx.fillRect(0, 0, W, H);
  // diagonal accent stripes on the left and right
  ctx.fillStyle = css(accent);
  for (const x0 of [0, W - 140]) {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x0 + i * 46, 0);
      ctx.lineTo(x0 + i * 46 + 22, 0);
      ctx.lineTo(x0 + i * 46 + 22 + 60, H);
      ctx.lineTo(x0 + i * 46 + 60, H);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.strokeStyle = css(fg, 0.8);
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 128;
  ctx.font = `italic 900 ${size}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
  const measured = ctx.measureText(text).width;
  if (measured > W * 0.66) {
    size = Math.floor((size * W * 0.66) / measured);
    ctx.font = `italic 900 ${size}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
  }
  if (glow) {
    ctx.shadowColor = css(fg);
    ctx.shadowBlur = 36;
  }
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(text, W / 2, H / 2 + 4);
  ctx.fillStyle = css(fg);
  ctx.fillText(text, W / 2, H / 2 + 4);
  ctx.shadowBlur = 0;
  return finishTexture(canvas, { repeat: false });
}

/** Checkered start/finish banner with the words START and FINISH. */
export function makeStartBannerTexture(theme: TrackTheme, accent: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 192;
  const { canvas, ctx } = makeCanvas(W, H);
  const cell = 24;
  for (let y = 0; y < H / cell; y++) {
    for (let x = 0; x < W / cell; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#141416';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // central plaque
  const pw = W * 0.5;
  const ph = H * 0.62;
  ctx.fillStyle = theme === 'neon' ? '#140826' : '#c81e2b';
  ctx.fillRect(W / 2 - pw / 2, H / 2 - ph / 2, pw, ph);
  ctx.strokeStyle = css(accent);
  ctx.lineWidth = 6;
  ctx.strokeRect(W / 2 - pw / 2 + 4, H / 2 - ph / 2 + 4, pw - 8, ph - 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 84px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
  ctx.fillStyle = theme === 'neon' ? css(accent) : '#fff7d6';
  if (theme === 'neon') {
    ctx.shadowColor = css(accent);
    ctx.shadowBlur = 24;
  }
  ctx.fillText('START  ·  FINISH', W / 2, H / 2 + 4);
  ctx.shadowBlur = 0;
  return finishTexture(canvas, { repeat: false });
}

/** Text label wrapped around a cylinder (water tower / silo). */
export function makeLabelTexture(text: string, bg: number, fg: number): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = css(bg);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css(fg, 0.9);
  ctx.fillRect(0, 12, W, 10);
  ctx.fillRect(0, H - 22, W, 10);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 120px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
  ctx.fillStyle = css(fg);
  // text occupies the front third of the cylinder only
  ctx.fillText(text, W * 0.5, H / 2 + 6);
  return finishTexture(canvas);
}

/** Skyscraper facade: emissive window grid (used as emissiveMap + map). */
export function makeWindowTexture(seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256;
  const a = makeCanvas(S, S);
  const e = makeCanvas(S, S);
  a.ctx.fillStyle = '#141420';
  a.ctx.fillRect(0, 0, S, S);
  e.ctx.fillStyle = '#000';
  e.ctx.fillRect(0, 0, S, S);
  const rng = seededRandom(seed);
  const cols = 8;
  const rows = 12;
  const cw = S / cols;
  const ch = S / rows;
  const colours = ['#ffe9a8', '#9fe8ff', '#ff9ad6', '#c9b8ff', '#ffffff'];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = rng() < 0.62;
      const px = x * cw + cw * 0.2;
      const py = y * ch + ch * 0.2;
      const w = cw * 0.6;
      const h = ch * 0.55;
      a.ctx.fillStyle = lit ? '#2a2a3a' : '#0c0c14';
      a.ctx.fillRect(px, py, w, h);
      if (lit) {
        const col = colours[Math.floor(rng() * colours.length)];
        e.ctx.fillStyle = col;
        e.ctx.globalAlpha = 0.5 + rng() * 0.5;
        e.ctx.fillRect(px, py, w, h);
        e.ctx.globalAlpha = 1;
      }
    }
  }
  return { map: finishTexture(a.canvas), emissive: finishTexture(e.canvas) };
}

/** Holographic billboard designs for the neon city. */
export function makeBillboardTexture(variant: number): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const themes = [
    { bg: '#12042a', a: '#ff2fd6', b: '#00e5ff', text: 'TURBO' },
    { bg: '#031a2a', a: '#00e5ff', b: '#ffe83a', text: 'NEXUS' },
    { bg: '#1a0410', a: '#ff5a5a', b: '#ffffff', text: 'RUSH' },
  ];
  const t = themes[variant % themes.length];
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = t.b;
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, W - 20, H - 20);
  // scanlines
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = t.b;
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 150px "Arial Black", Impact, Arial, sans-serif';
  ctx.shadowColor = t.a;
  ctx.shadowBlur = 30;
  ctx.fillStyle = t.a;
  ctx.fillText(t.text, W / 2, H / 2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = t.b;
  ctx.font = '700 30px Arial, sans-serif';
  ctx.fillText(variant % 2 === 0 ? 'KART  •  RUSH  •  NIGHT' : 'DRIFT  •  BOOST  •  WIN', W / 2, H - 40);
  return finishTexture(canvas, { repeat: false });
}

/** Sandstone strata for the desert barrier blocks. */
export function makeSandstoneTexture(base: number): THREE.CanvasTexture {
  const S = 256;
  const { canvas, ctx } = makeCanvas(S, S);
  fillNoise(ctx, S, S, base, 0.22, 1.1, 4.4, { color: 0x8a5a30, strength: 0.3 });
  ctx.globalAlpha = 0.25;
  const rng = seededRandom(5);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(80,40,20,1)' : 'rgba(255,230,190,1)';
    const y = rng() * S;
    ctx.fillRect(0, y, S, 2 + rng() * 4);
  }
  ctx.globalAlpha = 1;
  return finishTexture(canvas);
}

/** Soft radial glow sprite (sun / neon halos). */
export function makeGlowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const S = 128;
  const { canvas, ctx } = makeCanvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finishTexture(canvas, { repeat: false });
}
