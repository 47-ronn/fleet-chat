// Regenerates src/lib/brain-points.bin — the particle target cloud used by
// BrainField.svelte for the hero brain animation.
//
// Source mesh: brain-andre.obj (47k-vertex sculpted brain) from
// github.com/victors1681/3dbrain (MIT). The .obj is NOT vendored here; clone
// that repo to re-bake. Points are sampled UNIFORMLY over the mesh surface
// (area-weighted), so density is even regardless of tessellation.
//
// Output: int16-quantized, centered + unit-normalized XYZ (y-up, z = front-back).
// Dequantize in the loader with value / 32767.
//
//   node scripts/bake-brain.mjs [path/to/brain-andre.obj] [count]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = process.argv[2] || '/tmp/3dbrain/static/models/brain-andre.obj';
const COUNT = parseInt(process.argv[3] || '100000', 10);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'brain-points.bin');

// Deterministic PRNG so re-bakes are reproducible.
let seed = 1337;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const verts = [];
const tris = []; // [i0,i1,i2] zero-based into verts
for (const line of readFileSync(SRC, 'utf8').split('\n')) {
  if (line[1] !== ' ') continue;
  if (line[0] === 'v') {
    const p = line.split(/\s+/);
    verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
  } else if (line[0] === 'f') {
    // tokens like "12/7" or "12/7/3" — take the vertex index, 1-based.
    const idx = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
    // Fan-triangulate polygons (handles tris and quads).
    for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  }
}
console.log(`parsed ${verts.length} verts, ${tris.length} tris`);

// Cumulative triangle areas for area-weighted sampling.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cum = new Float64Array(tris.length);
let total = 0;
for (let i = 0; i < tris.length; i++) {
  const [a, b, c] = tris[i].map((j) => verts[j]);
  total += 0.5 * len(cross(sub(b, a), sub(c, a)));
  cum[i] = total;
}

// Binary-search a triangle by cumulative area, then a random barycentric point.
const pick = (target) => {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m + 1; else hi = m; }
  return lo;
};
const pts = new Array(COUNT);
for (let n = 0; n < COUNT; n++) {
  const [a, b, c] = tris[pick(rnd() * total)].map((j) => verts[j]);
  let u = rnd(), v = rnd();
  if (u + v > 1) { u = 1 - u; v = 1 - v; }
  pts[n] = [a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]),
            a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]),
            a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2])];
}

// Center + normalize to unit radius.
const ctr = [0, 0, 0];
for (const p of pts) for (let k = 0; k < 3; k++) ctr[k] += p[k];
for (let k = 0; k < 3; k++) ctr[k] /= pts.length;
let maxR = 0;
for (const p of pts) maxR = Math.max(maxR, Math.hypot(p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]));

const out = new Int16Array(pts.length * 3);
for (let i = 0; i < pts.length; i++)
  for (let k = 0; k < 3; k++)
    out[i * 3 + k] = Math.round(Math.max(-1, Math.min(1, (pts[i][k] - ctr[k]) / maxR)) * 32767);

writeFileSync(OUT, Buffer.from(out.buffer));
console.log(`wrote ${OUT}: ${pts.length} points, ${out.byteLength} bytes`);
