/**
 * A 2.5D reading of a splat scene, built from the .splat file when the scene loads: the top surface, the bare ground
 * under the walls, and which cells are standing structure (walls) or bushes. The effects build on it: flowers grow
 * on bare ground only, the fog sits on the ground, the earthquake cuts the walls into stones, and the camera stays
 * above the top surface.
 *
 * Everything here is in the "metric" frame the effects use: metres, y up, the site at the origin. The .splat file is
 * y down; turning it 180 degrees about x makes it y up: (x, y, z) -> (x, -y, -z), times metres per file unit. VR uses
 * the same frame (see walkArea.ts).
 */

// The .splat format: 32 bytes per splat. float32 x, y, z | float32 scale x, y, z | uint8 r, g, b, a | uint8 quat
export const SPLAT_RECORD_BYTES = 32;

export type ParsedSplat = {
  count: number;
  u8: Uint8Array;
  // Metres per file unit
  scale: number;
  x: (i: number) => number;
  y: (i: number) => number;
  z: (i: number) => number;
  maxScale: (i: number) => number;
  alpha: (i: number) => number;
  r: (i: number) => number;
  g: (i: number) => number;
  b: (i: number) => number;
};

export function parseSplat(bytes: Uint8Array, metersPerFileUnit: number): ParsedSplat {
  const count = Math.floor(bytes.byteLength / SPLAT_RECORD_BYTES);
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, count * 8);
  const u8 = bytes.subarray(0, count * SPLAT_RECORD_BYTES);
  const s = metersPerFileUnit;
  return {
    count,
    u8,
    scale: s,
    x: i => f32[i * 8] * s,
    y: i => -f32[i * 8 + 1] * s,
    z: i => -f32[i * 8 + 2] * s,
    maxScale: i => Math.max(f32[i * 8 + 3], f32[i * 8 + 4], f32[i * 8 + 5]) * s,
    alpha: i => u8[i * SPLAT_RECORD_BYTES + 27] / 255,
    r: i => u8[i * SPLAT_RECORD_BYTES + 24] / 255,
    g: i => u8[i * SPLAT_RECORD_BYTES + 25] / 255,
    b: i => u8[i * SPLAT_RECORD_BYTES + 26] / 255,
  };
}

/** A new .splat file with only the splats whose flag equals `keep` */
export function selectSplats(splat: ParsedSplat, flags: Uint8Array, keep: 0 | 1): Uint8Array {
  let n = 0;
  for (let i = 0; i < splat.count; i++) if (flags[i] === keep) n++;
  const out = new Uint8Array(n * SPLAT_RECORD_BYTES);
  let o = 0;
  for (let i = 0; i < splat.count; i++) {
    if (flags[i] !== keep) continue;
    out.set(splat.u8.subarray(i * SPLAT_RECORD_BYTES, (i + 1) * SPLAT_RECORD_BYTES), o);
    o += SPLAT_RECORD_BYTES;
  }
  return out;
}

const EMPTY = -1e9;

// Separable square min or max filter
function minMaxFilter(src: Float32Array, n: number, radius: number, useMin: boolean) {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const pick = useMin ? Math.min : Math.max;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let v = src[z * n + x];
      for (let k = Math.max(0, x - radius); k <= Math.min(n - 1, x + radius); k++) v = pick(v, src[z * n + k]);
      tmp[z * n + x] = v;
    }
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let v = tmp[z * n + x];
      for (let k = Math.max(0, z - radius); k <= Math.min(n - 1, z + radius); k++) v = pick(v, tmp[k * n + x]);
      out[z * n + x] = v;
    }
  }
  return out;
}

function boxBlur(src: Float32Array, n: number, radius: number) {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let c = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(n - 1, x + radius); k++) {
        sum += src[z * n + k];
        c++;
      }
      tmp[z * n + x] = sum / c;
    }
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let c = 0;
      for (let k = Math.max(0, z - radius); k <= Math.min(n - 1, z + radius); k++) {
        sum += tmp[k * n + x];
        c++;
      }
      out[z * n + x] = sum / c;
    }
  }
  return out;
}

function median3(src: Float32Array, n: number) {
  const out = new Float32Array(src);
  const window = new Float32Array(9);
  for (let z = 1; z < n - 1; z++) {
    for (let x = 1; x < n - 1; x++) {
      if (src[z * n + x] === EMPTY) continue;
      let c = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = src[(z + dz) * n + x + dx];
          if (v !== EMPTY) window[c++] = v;
        }
      }
      out[z * n + x] = window.subarray(0, c).sort()[c >> 1];
    }
  }
  return out;
}

// Fills empty cells from their neighbours, ring by ring
function fillEmpty(grid: Float32Array, n: number) {
  let remaining = true;
  for (let pass = 0; pass < 400 && remaining; pass++) {
    remaining = false;
    const next = new Float32Array(grid);
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        if (grid[z * n + x] !== EMPTY) continue;
        let sum = 0;
        let c = 0;
        if (x > 0 && grid[z * n + x - 1] !== EMPTY) { sum += grid[z * n + x - 1]; c++; }
        if (x < n - 1 && grid[z * n + x + 1] !== EMPTY) { sum += grid[z * n + x + 1]; c++; }
        if (z > 0 && grid[(z - 1) * n + x] !== EMPTY) { sum += grid[(z - 1) * n + x]; c++; }
        if (z < n - 1 && grid[(z + 1) * n + x] !== EMPTY) { sum += grid[(z + 1) * n + x]; c++; }
        if (c) next[z * n + x] = sum / c;
        else remaining = true;
      }
    }
    grid.set(next);
  }
}

export type SiteAnalysis = {
  // Grid of n x n cells of `cell` metres, covering -half to half in x and z
  n: number;
  cell: number;
  half: number;
  // Heights (metres, y up) of the top surface and of the bare ground, and the top's height above the ground
  top: Float32Array;
  ground: Float32Array;
  rel: Float32Array;
  // 1 where the splats cover the cell, where it is part of a wall, where it is a bush
  captured: Uint8Array;
  wall: Uint8Array;
  bush: Uint8Array;
  // Cell index at a point, or -1 outside the grid
  cellOf: (x: number, z: number) => number;
  groundAt: (x: number, z: number) => number;
  topAt: (x: number, z: number) => number;
};

/**
 * Reads the site off the splats. `siteRadius` (metres) is the main structure's: walls are looked for within it
 * (plus 2.5 m), so a rock outcrop farther out doesn't count. The grid covers `half` metres each way.
 */
export function analyzeSite(splat: ParsedSplat, siteRadius: number, half: number): SiteAnalysis {
  const cell = half <= 16 ? 0.08 : 0.1;
  const n = Math.round((2 * half) / cell);
  const top1 = new Float32Array(n * n).fill(EMPTY);
  const top2 = new Float32Array(n * n).fill(EMPTY);
  const cellOf = (x: number, z: number) => {
    const cx = Math.floor((x + half) / cell);
    const cz = Math.floor((z + half) / cell);
    return cx < 0 || cz < 0 || cx >= n || cz >= n ? -1 : cz * n + cx;
  };

  // Top surface: the second-highest solid splat per cell, which ignores single floaters
  for (let i = 0; i < splat.count; i++) {
    if (splat.alpha(i) < 0.3 || splat.maxScale(i) > 0.3) continue;
    const k = cellOf(splat.x(i), splat.z(i));
    if (k < 0) continue;
    const y = splat.y(i);
    if (y > top1[k]) {
      top2[k] = top1[k];
      top1[k] = y;
    } else if (y > top2[k]) {
      top2[k] = y;
    }
  }
  const captured = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) captured[k] = top2[k] !== EMPTY ? 1 : 0;
  const top = median3(top2, n);
  fillEmpty(top, n);

  // Bare ground: a morphological opening removes anything narrower than about 2 m (walls, bushes, stones)
  const openRadius = Math.round(0.9 / cell);
  const blurRadius = Math.round(0.25 / cell);
  const ground = boxBlur(boxBlur(minMaxFilter(minMaxFilter(top, n, openRadius, true), n, openRadius, false), n, blurRadius),
    n, blurRadius);

  // Colour of the top layer per cell, to tell bushes from stone
  const colorSum = new Float32Array(n * n * 3);
  const colorCount = new Float32Array(n * n);
  for (let i = 0; i < splat.count; i++) {
    if (splat.alpha(i) < 0.2) continue;
    const k = cellOf(splat.x(i), splat.z(i));
    if (k < 0 || splat.y(i) < top[k] - 0.12) continue;
    colorSum[k * 3] += splat.r(i);
    colorSum[k * 3 + 1] += splat.g(i);
    colorSum[k * 3 + 2] += splat.b(i);
    colorCount[k]++;
  }

  // Structure: raised above the ground, near the site, not too tall (bedrock outcrops, big bushes), and not
  // greener or darker than stone
  const rel = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) rel[k] = top[k] - ground[k];
  const tooTall = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) tooTall[k] = rel[k] > 1.8 ? 1 : 0;
  const nearTall = minMaxFilter(tooTall, n, Math.round(0.4 / cell), false);
  // Ground slope (rise over run across about 0.5 m): pircas stand on fairly level ground, and a "wall" on a steep
  // slope is almost always the foot of a rock outcrop
  const slope = new Float32Array(n * n);
  const d = Math.max(1, Math.round(0.25 / cell));
  for (let z = d; z < n - d; z++) {
    for (let x = d; x < n - d; x++) {
      const gx = (ground[z * n + x + d] - ground[z * n + x - d]) / (2 * d * cell);
      const gz = (ground[(z + d) * n + x] - ground[(z - d) * n + x]) / (2 * d * cell);
      slope[z * n + x] = Math.hypot(gx, gz);
    }
  }
  const wallRadius = siteRadius + 2.5;
  const wall = new Uint8Array(n * n);
  const bush = new Uint8Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const k = z * n + x;
      if (!captured[k] || rel[k] < 0.18 || slope[k] > 0.4) continue;
      const c = colorCount[k] || 1;
      const r = colorSum[k * 3] / c;
      const g = colorSum[k * 3 + 1] / c;
      const b = colorSum[k * 3 + 2] / c;
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      if ((g > r * 1.03 && g > b * 1.05) || lum < 0.16) {
        bush[k] = 1;
        continue;
      }
      const wx = -half + (x + 0.5) * cell;
      const wz = -half + (z + 0.5) * cell;
      if (Math.hypot(wx, wz) > wallRadius || nearTall[k]) continue;
      wall[k] = 1;
    }
  }

  // Walls are long and thin; bushes and loose boulders are compact. Keep the long connected pieces only.
  const label = new Int32Array(n * n).fill(-1);
  const stack: number[] = [];
  for (let start = 0; start < n * n; start++) {
    if (!wall[start] || label[start] >= 0) continue;
    const cells: number[] = [];
    label[start] = start;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      cells.push(k);
      const x = k % n;
      const z = Math.floor(k / n);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
          const kk = zz * n + xx;
          if (wall[kk] && label[kk] < 0) {
            label[kk] = start;
            stack.push(kk);
          }
        }
      }
    }
    // Length and width from the principal axes of the piece
    let mx = 0;
    let mz = 0;
    for (const k of cells) {
      mx += k % n;
      mz += Math.floor(k / n);
    }
    mx /= cells.length;
    mz /= cells.length;
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const k of cells) {
      const dx = (k % n) - mx;
      const dz = Math.floor(k / n) - mz;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    sxx /= cells.length;
    szz /= cells.length;
    sxz /= cells.length;
    const tr = sxx + szz;
    const det = sxx * szz - sxz * sxz;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l2 = Math.max(1e-6, tr - l1);
    const length = Math.sqrt(12 * l1) * cell;
    const width = Math.sqrt(12 * l2) * cell;
    const isWall = length > 2.4 || (length > 1.3 && length / width > 2.5);
    if (!isWall) {
      for (const k of cells) {
        wall[k] = 0;
        bush[k] = 1;
      }
    }
  }

  const sample = (grid: Float32Array, x: number, z: number) => {
    const fx = (x + half) / cell - 0.5;
    const fz = (z + half) / cell - 0.5;
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const tz = Math.min(1, Math.max(0, fz - z0));
    const a = grid[z0 * n + x0];
    const b = grid[z0 * n + x0 + 1];
    const c = grid[(z0 + 1) * n + x0];
    const e = grid[(z0 + 1) * n + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };

  return {
    n, cell, half, top, ground, rel, captured, wall, bush, cellOf,
    groundAt: (x, z) => sample(ground, x, z),
    topAt: (x, z) => sample(top, x, z),
  };
}
