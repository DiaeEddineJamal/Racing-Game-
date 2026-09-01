import * as THREE from 'three';
import type { TrackDefinition } from '../../core/types';

/**
 * Dev-only sanity check for track definitions: the centerline must be a simple closed
 * curve with adequate spacing between non-adjacent sections (so barriers of different
 * sections never overlap) and no kinks tighter than a kart can reasonably drive.
 *
 * Two points with arc separation `a` may legitimately be close when they sit on the two legs
 * of a hairpin. The tightest allowed hairpin has legs 3.5 * halfWidth apart (radius
 * r = 1.75 * halfWidth), so the minimum legitimate chord for arc separation `a` is
 * 2r * sin(min(a / 2r, PI/2)). Anything below ~95% of that is reported.
 */
export function validateTrackDefinition(def: TrackDefinition): string[] {
  const warnings: string[] = [];
  const n = def.controlPoints.length;
  if (n < 14 || n > 26) warnings.push(`has ${n} control points (expected 14..26)`);
  if (def.halfWidths && def.halfWidths.length !== n) {
    warnings.push(`halfWidths length ${def.halfWidths.length} != controlPoints length ${n}`);
  }
  if (def.halfWidth < 7 || def.halfWidth > 9) warnings.push(`halfWidth ${def.halfWidth} outside 7..9`);
  if (def.wallHalfWidthFactor < 1) warnings.push('wallHalfWidthFactor must be >= 1');
  for (const t of [...def.itemBoxRows, ...def.boostPads]) {
    if (t < 0 || t >= 1) warnings.push(`t value ${t} outside [0,1)`);
  }

  const pts = def.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  curve.arcLengthDivisions = 1000;
  const length = curve.getLength();
  if (length < 850 || length > 1450) warnings.push(`length ${length.toFixed(0)} m outside 850..1450`);

  const N = 400;
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) samples.push(curve.getPointAt(i / N));
  const ds = length / N;
  const hw = def.halfWidth;
  const r = 1.75 * hw;
  let worst = Infinity;
  let worstInfo = '';
  for (let i = 0; i < N; i++) {
    const a = samples[i];
    for (let j = i + 1; j < N; j++) {
      let k = j - i;
      if (k > N / 2) k = N - k;
      const arc = k * ds;
      if (arc < 2 * hw) continue;
      const b = samples[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const need = 2 * r * Math.sin(Math.min(arc / (2 * r), Math.PI / 2));
      const ratio = d / need;
      if (ratio < worst) {
        worst = ratio;
        worstInfo = `t=${(i / N).toFixed(3)} and t=${(j / N).toFixed(3)} are ${d.toFixed(1)} m apart (need ${need.toFixed(1)} m)`;
      }
    }
  }
  if (worst < 0.95) warnings.push(`sections approach each other: ${worstInfo}`);

  // Kink / minimum radius check using a 3-point circle over a ~9 m baseline.
  let minR = Infinity;
  let minRt = 0;
  const step = Math.max(1, Math.round(4.5 / ds));
  for (let i = 0; i < N; i++) {
    const a = samples[(i - step + N) % N];
    const b = samples[i];
    const c = samples[(i + step) % N];
    const D = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
    if (Math.abs(D) < 1e-6) continue;
    const a2 = a.x * a.x + a.z * a.z;
    const b2 = b.x * b.x + b.z * b.z;
    const c2 = c.x * c.x + c.z * c.z;
    const ux = (a2 * (b.z - c.z) + b2 * (c.z - a.z) + c2 * (a.z - b.z)) / D;
    const uz = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / D;
    const R = Math.hypot(a.x - ux, a.z - uz);
    if (R < minR) {
      minR = R;
      minRt = i / N;
    }
  }
  if (minR < 10) warnings.push(`kink: radius ${minR.toFixed(1)} m at t=${minRt.toFixed(3)}`);

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const s of samples) {
    ymin = Math.min(ymin, s.y);
    ymax = Math.max(ymax, s.y);
  }
  if (ymax - ymin > 18) warnings.push(`elevation range ${(ymax - ymin).toFixed(1)} m is very large`);

  return warnings;
}

export function validateAllTracks(defs: readonly TrackDefinition[]): void {
  const ids = new Set<string>();
  for (const def of defs) {
    if (ids.has(def.id)) console.warn(`[track] duplicate track id '${def.id}'`);
    ids.add(def.id);
    const warnings = validateTrackDefinition(def);
    for (const w of warnings) console.warn(`[track] ${def.id}: ${w}`);
  }
}
