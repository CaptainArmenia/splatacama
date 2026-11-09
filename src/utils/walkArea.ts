/**
 * Where a visitor can walk in a splat scene in VR: the ground height everywhere, and which spots are free to
 * stand on. Built once per scene from the splats themselves.
 *
 * The scenes have no meshes or colliders, only splats, so the ground and the obstacles are read off the splats'
 * positions, on a grid seen from above:
 * - Ground: in each cell, a height near the bottom of the surface splats, then a morphological opening (lowest
 *   value nearby, then highest) so walls, bushes and rocks narrower than `openingWidth` are cut off the ground
 *   and the terrain's slope is kept.
 * - Obstacles: cells with many surface splats between knee and head height above that ground. Walls and bushes
 *   block; a few floating splats don't.
 * - Detail: cells with enough splats to look right up close. Away from where the drone flew, splats get sparse
 *   and stretched, so the walkable area stops there.
 * Walkable cells are the detailed ones away from obstacles, and only the largest connected group of them is kept.
 *
 * Everything here is in the upright frame used in VR: meters, y up. See toUprightMeters for the conversion from
 * the .splat file's frame. Checked by eye on top-down renders of all four sites (2026-11-02).
 */

// The .splat format: 32 bytes per splat. float32 x, y, z | float32 scale x, y, z | uint8 r, g, b, a | uint8 quat
const SPLAT_RECORD_BYTES = 32;

export const WALK_CONFIG = {
  cellSize: 0.2, // meters
  maxRadius: 20, // meters from the scene center covered by the grid
  // How far past the main structure's radius visitors may go. The drone orbited the structure, so detail fades
  // with distance even where the ground still has splats.
  maxDistanceFromSite: 6,
  // Splats that count as surface: opaque enough and not huge (big blobs are sky, haze and far-away terrain)
  minOpacity: 0.35,
  maxSplatSize: 0.5, // meters, longest axis
  // A cell is detailed when its surface splats per square meter reach this share of the typical density around
  // the main structure (the scenes differ about 2x in overall density), and at least minDetailDensity
  detailShare: 0.2,
  minDetailDensity: 100,
  // The ground in a cell is this far up its surface splats (0 = lowest), since some splats sit under the surface
  groundPercentile: 0.2,
  // Width of the opening that separates the ground from what stands on it (meters)
  openingWidth: 1.6,
  // Height band above the ground that has to be clear to walk through, and how many splats in it make a cell an
  // obstacle (per square meter, and as a share of the cell's splats). The step height lets visitors walk over
  // pebbles and low tufts; the share keeps a few floating splats over well-captured ground from blocking it.
  stepHeight: 0.35,
  bodyHeight: 1.8,
  minObstacleDensity: 150,
  minObstacleShare: 0.25,
  // Distance kept from obstacles and from the edge of the detailed area (meters)
  playerRadius: 0.25,
  edgeMargin: 0.4,
  // Room to move around the start point, and clear ground ahead of it toward the center (meters), so visitors
  // don't start boxed in among bushes
  spawnClearance: 1,
  spawnClearAhead: 3,
};

export type WalkArea = {
  cellSize: number;
  // World position of cell (0, 0)'s center, and the grid's size in cells. Row-major, x across, z down.
  originX: number;
  originZ: number;
  width: number;
  depth: number;
  // Ground height per cell (meters), filled in everywhere so it can be interpolated near the edges
  ground: Float32Array;
  // 1 where a visitor may stand
  walkable: Uint8Array;
  // Distance from each walkable cell to the nearest spot a visitor can't stand on (meters; 0 there)
  clearance: Float32Array;
  // Where a visitor starts: outside the main structure, facing its center (yaw in radians, 0 = looking along -z)
  spawn: { x: number; z: number; yaw: number };
};

/**
 * The .splat file's frame is y-down (the desktop viewer uses cameraUp [0, -1, 0]). Turning it 180 degrees about
 * x makes it y-up: (x, y, z) -> (x, -y, -z). The VR scene applies the same turn to the splat mesh.
 */
export function toUprightMeters(x: number, y: number, z: number, metersPerFileUnit: number) {
  return { x: x * metersPerFileUnit, y: -y * metersPerFileUnit, z: -z * metersPerFileUnit };
}

/**
 * Builds the walk area from a .splat file's bytes, or returns null if nothing in the scene is walkable.
 * @param metersPerFileUnit meters per unit of the .splat file (the desktop viewer draws it 10x larger)
 * @param startDirection horizontal direction, in the upright frame, from the scene center toward where visitors
 *   should start; they start just outside the main structure on that side
 * @param siteRadius radius of the main structure in meters
 */
export function buildWalkArea(
  splatBytes: Uint8Array,
  metersPerFileUnit: number,
  startDirection: { x: number; z: number },
  siteRadius: number,
  config = WALK_CONFIG
): WalkArea | null {
  const count = Math.floor(splatBytes.byteLength / SPLAT_RECORD_BYTES);
  // Float views need 4-byte alignment; a Uint8Array into a larger buffer may not have it
  const aligned = splatBytes.byteOffset % 4 === 0 ? splatBytes : splatBytes.slice();
  const floats = new Float32Array(aligned.buffer, aligned.byteOffset, count * 8);
  const bytes = aligned;

  const cell = config.cellSize;
  const half = Math.ceil(config.maxRadius / cell);
  const width = half * 2 + 1;
  const depth = width;
  const originX = -half * cell;
  const originZ = -half * cell;
  const cells = width * depth;
  const cellArea = cell * cell;

  // Surface splats, as (cell, height) pairs
  const minAlpha = Math.round(config.minOpacity * 255);
  const maxSize = config.maxSplatSize / metersPerFileUnit;
  const splatCell = new Int32Array(count).fill(-1);
  const splatHeight = new Float32Array(count);
  const perCell = new Int32Array(cells);
  for (let i = 0; i < count; i++) {
    if (bytes[i * SPLAT_RECORD_BYTES + 27] < minAlpha) continue;
    const f = i * 8;
    if (Math.max(floats[f + 3], floats[f + 4], floats[f + 5]) > maxSize) continue;
    const p = toUprightMeters(floats[f], floats[f + 1], floats[f + 2], metersPerFileUnit);
    const cx = Math.round((p.x - originX) / cell);
    const cz = Math.round((p.z - originZ) / cell);
    if (cx < 0 || cz < 0 || cx >= width || cz >= depth) continue;
    const c = cz * width + cx;
    splatCell[i] = c;
    splatHeight[i] = p.y;
    perCell[c]++;
  }

  // Group the heights by cell (counting sort), then take a low percentile in each as the cell's ground
  const start = new Int32Array(cells + 1);
  for (let c = 0; c < cells; c++) start[c + 1] = start[c] + perCell[c];
  const heights = new Float32Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let i = 0; i < count; i++) {
    const c = splatCell[i];
    if (c >= 0) heights[fill[c]++] = splatHeight[i];
  }
  // Typical density around the main structure: the median of the occupied cells within siteRadius
  const nearCounts: number[] = [];
  const siteCells = Math.round(siteRadius / cell);
  for (let cz = half - siteCells; cz <= half + siteCells; cz++) {
    for (let cx = half - siteCells; cx <= half + siteCells; cx++) {
      if (cx < 0 || cz < 0 || cx >= width || cz >= depth) continue;
      if ((cx - half) ** 2 + (cz - half) ** 2 > siteCells ** 2) continue;
      if (perCell[cz * width + cx] > 0) nearCounts.push(perCell[cz * width + cx]);
    }
  }
  nearCounts.sort((a, b) => a - b);
  const typicalCount = nearCounts.length ? nearCounts[nearCounts.length >> 1] : 0;
  const minDetailCount = Math.max(config.minDetailDensity * cellArea, config.detailShare * typicalCount);
  const low = new Float32Array(cells).fill(NaN);
  for (let c = 0; c < cells; c++) {
    const n = perCell[c];
    if (n < Math.max(4, minDetailCount / 4)) continue;
    const sorted = heights.subarray(start[c], start[c + 1]).sort();
    low[c] = sorted[Math.floor(n * config.groundPercentile)];
  }

  // Opening: remove everything narrower than openingWidth that sticks up from the ground. An opening keeps pits,
  // so a median filter first removes cells pulled down by stray splats under the ground.
  const openRadius = Math.max(1, Math.round(config.openingWidth / 2 / cell));
  let ground = minFilter(medianFilter(low, width, depth, 2), width, depth, openRadius);
  ground = maxFilter(ground, width, depth, openRadius);
  ground = meanFilter(ground, width, depth, 2);
  fillGaps(ground, width, depth);

  // Obstacles: enough surface splats between step and body height above the ground
  const blockedCount = new Int32Array(cells);
  for (let i = 0; i < count; i++) {
    const c = splatCell[i];
    if (c < 0) continue;
    const above = splatHeight[i] - ground[c];
    if (above > config.stepHeight && above < config.bodyHeight) blockedCount[c]++;
  }
  const minObstacleCount = config.minObstacleDensity * cellArea;
  const obstacle = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    const enough = blockedCount[c] >= minObstacleCount && blockedCount[c] >= config.minObstacleShare * perCell[c];
    obstacle[c] = enough ? 1 : 0;
  }

  // Detailed area: dense enough, small gaps closed, not too far from the main structure
  const reach = Math.min(config.maxRadius, siteRadius + config.maxDistanceFromSite);
  let detail = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    const cx = (c % width) - half;
    const cz = Math.floor(c / width) - half;
    detail[c] = perCell[c] >= minDetailCount && Math.hypot(cx, cz) * cell <= reach ? 1 : 0;
  }
  const closeRadius = Math.round(0.6 / cell);
  detail = erode(dilate(detail, width, depth, closeRadius), width, depth, closeRadius);
  detail = erode(detail, width, depth, Math.round(config.edgeMargin / cell));

  const blocked = dilate(obstacle, width, depth, Math.round(config.playerRadius / cell));
  let walkable = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) walkable[c] = detail[c] && !blocked[c] ? 1 : 0;

  // Keep the largest connected area: specks cut off by walls or bushes can't be reached anyway. Visitors start
  // in it, as close as possible to a point just outside the main structure on the chosen side, with some room
  // around them (or as much as the area has).
  walkable = largestRegion(walkable, width, depth);
  const clearance = distanceToEdge(walkable, width, depth);
  for (let c = 0; c < cells; c++) clearance[c] *= cell;
  const area: WalkArea = {
    cellSize: cell, originX, originZ, width, depth, ground, walkable, clearance, spawn: { x: 0, z: 0, yaw: 0 },
  };

  const dirLength = Math.hypot(startDirection.x, startDirection.z) || 1;
  const preferredX = (startDirection.x / dirLength) * (siteRadius + 1.5);
  const preferredZ = (startDirection.z / dirLength) * (siteRadius + 1.5);
  let mostClearance = 0;
  for (let c = 0; c < cells; c++) mostClearance = Math.max(mostClearance, clearance[c]);
  const minClearance = Math.min(config.spawnClearance, mostClearance * 0.6);
  const candidates: { x: number; z: number; distance: number }[] = [];
  for (let c = 0; c < cells; c++) {
    if (!walkable[c] || clearance[c] < minClearance) continue;
    const x = originX + (c % width) * cell;
    const z = originZ + Math.floor(c / width) * cell;
    candidates.push({ x, z, distance: Math.hypot(x - preferredX, z - preferredZ) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const clearAhead = ({ x, z }: { x: number; z: number }) => {
    const toCentre = Math.hypot(x, z) || 1;
    for (let d = cell / 2; d <= Math.min(config.spawnClearAhead, toCentre); d += cell / 2) {
      if (!isWalkable(area, x - (x / toCentre) * d, z - (z / toCentre) * d)) return false;
    }
    return true;
  };
  const spawn = candidates.find(clearAhead) ?? candidates[0];
  if (!spawn) return null;
  // Face the center. Yaw 0 looks along -z, and positive yaw turns left (counter-clockwise seen from above).
  area.spawn = { x: spawn.x, z: spawn.z, yaw: Math.atan2(spawn.x, spawn.z) };
  return area;
}

/** Ground height at (x, z), interpolated between cells */
export function groundHeight(area: WalkArea, x: number, z: number): number {
  return sample(area, area.ground, x, z);
}

// A per-cell value at (x, z), interpolated between cells
function sample(area: WalkArea, grid: Float32Array, x: number, z: number): number {
  const gx = Math.min(Math.max((x - area.originX) / area.cellSize, 0), area.width - 1.001);
  const gz = Math.min(Math.max((z - area.originZ) / area.cellSize, 0), area.depth - 1.001);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const i = z0 * area.width + x0;
  const top = grid[i] * (1 - fx) + grid[i + 1] * fx;
  const bottom = grid[i + area.width] * (1 - fx) + grid[i + area.width + 1] * fx;
  return top * (1 - fz) + bottom * fz;
}

export function isWalkable(area: WalkArea, x: number, z: number): boolean {
  const cx = Math.round((x - area.originX) / area.cellSize);
  const cz = Math.round((z - area.originZ) / area.cellSize);
  if (cx < 0 || cz < 0 || cx >= area.width || cz >= area.depth) return false;
  return area.walkable[cz * area.width + cx] === 1;
}

/**
 * Moves from (fromX, fromZ) toward (toX, toZ) as far as the walk area allows, sliding along walls and edges
 * instead of stopping dead. Short steps, so a fast move can't skip over a thin wall.
 */
export function walk(area: WalkArea, fromX: number, fromZ: number, toX: number, toZ: number) {
  let x = fromX;
  let z = fromZ;
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toZ - fromZ) / (area.cellSize / 2)));
  const stepX = (toX - fromX) / steps;
  const stepZ = (toZ - fromZ) / steps;
  for (let s = 0; s < steps; s++) {
    if (isWalkable(area, x + stepX, z + stepZ)) {
      x += stepX;
      z += stepZ;
      continue;
    }
    // Slide along the edge: keep only the part of the step that runs along it. The direction away from the edge
    // is the way the clearance grows.
    const h = area.cellSize;
    let awayX = sample(area, area.clearance, x + h, z) - sample(area, area.clearance, x - h, z);
    let awayZ = sample(area, area.clearance, x, z + h) - sample(area, area.clearance, x, z - h);
    const awayLength = Math.hypot(awayX, awayZ);
    if (awayLength > 1e-6) {
      awayX /= awayLength;
      awayZ /= awayLength;
      const into = stepX * awayX + stepZ * awayZ;
      if (into < 0 && isWalkable(area, x + stepX - into * awayX, z + stepZ - into * awayZ)) {
        x += stepX - into * awayX;
        z += stepZ - into * awayZ;
        continue;
      }
    }
    // Or along whichever axis is free
    if (stepX !== 0 && isWalkable(area, x + stepX, z)) {
      x += stepX;
    } else if (stepZ !== 0 && isWalkable(area, x, z + stepZ)) {
      z += stepZ;
    } else {
      break;
    }
  }
  return { x, z };
}

// Grid helpers. NaN marks cells without data; the filters skip them.

function minFilter(src: Float32Array, w: number, h: number, r: number) {
  return separable(src, w, h, r, (a, b) => (b < a ? b : a), Infinity);
}

function maxFilter(src: Float32Array, w: number, h: number, r: number) {
  return separable(src, w, h, r, (a, b) => (b > a ? b : a), -Infinity);
}

// Square-window filter done as a row pass then a column pass. Cells that were NaN stay NaN.
function separable(src: Float32Array, w: number, h: number, r: number, pick: (a: number, b: number) => number,
  empty: number) {
  const rows = new Float32Array(src.length);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let v = empty;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const s = src[z * w + k];
        if (!Number.isNaN(s)) v = pick(v, s);
      }
      rows[z * w + x] = v;
    }
  }
  const out = new Float32Array(src.length);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (Number.isNaN(src[z * w + x])) {
        out[z * w + x] = NaN;
        continue;
      }
      let v = empty;
      for (let k = Math.max(0, z - r); k <= Math.min(h - 1, z + r); k++) {
        const s = rows[k * w + x];
        if (s !== empty) v = pick(v, s);
      }
      out[z * w + x] = v;
    }
  }
  return out;
}

function medianFilter(src: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(src.length).fill(NaN);
  const window = new Float32Array((2 * r + 1) ** 2);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (Number.isNaN(src[z * w + x])) continue;
      let n = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
          const s = src[zz * w + xx];
          if (!Number.isNaN(s)) window[n++] = s;
        }
      }
      out[z * w + x] = window.subarray(0, n).sort()[n >> 1];
    }
  }
  return out;
}

function meanFilter(src: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(src.length).fill(NaN);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (Number.isNaN(src[z * w + x])) continue;
      let sum = 0;
      let n = 0;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
          const s = src[zz * w + xx];
          if (!Number.isNaN(s)) {
            sum += s;
            n++;
          }
        }
      }
      out[z * w + x] = sum / n;
    }
  }
  return out;
}

// Fills NaN cells from their filled neighbours, ring by ring, so the ground is defined everywhere
function fillGaps(grid: Float32Array, w: number, h: number) {
  let missing = true;
  let anyFilled = false;
  for (let c = 0; c < grid.length; c++) if (!Number.isNaN(grid[c])) anyFilled = true;
  if (!anyFilled) {
    grid.fill(0);
    return;
  }
  while (missing) {
    missing = false;
    const next = grid.slice();
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const c = z * w + x;
        if (!Number.isNaN(grid[c])) continue;
        let sum = 0;
        let n = 0;
        if (x > 0 && !Number.isNaN(grid[c - 1])) { sum += grid[c - 1]; n++; }
        if (x < w - 1 && !Number.isNaN(grid[c + 1])) { sum += grid[c + 1]; n++; }
        if (z > 0 && !Number.isNaN(grid[c - w])) { sum += grid[c - w]; n++; }
        if (z < h - 1 && !Number.isNaN(grid[c + w])) { sum += grid[c + w]; n++; }
        if (n > 0) next[c] = sum / n;
        else missing = true;
      }
    }
    grid.set(next);
  }
}

// Binary dilation and erosion with a round brush of radius r cells
function dilate(src: Uint8Array, w: number, h: number, r: number) {
  return morph(src, w, h, r, 1);
}

function erode(src: Uint8Array, w: number, h: number, r: number) {
  return morph(src, w, h, r, 0);
}

function morph(src: Uint8Array, w: number, h: number, r: number, spreads: 0 | 1) {
  if (r <= 0) return src.slice();
  const offsets: number[][] = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) offsets.push([dx, dz]);
  const out = src.slice();
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (src[z * w + x] !== spreads) continue;
      for (const [dx, dz] of offsets) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx >= 0 && zz >= 0 && xx < w && zz < h) out[zz * w + xx] = spreads;
      }
    }
  }
  // Outside the grid counts as empty, so erosion eats in from the border too
  if (spreads === 0) {
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        if (x < r || z < r || x >= w - r || z >= h - r) out[z * w + x] = 0;
      }
    }
  }
  return out;
}

// Distance in cells from each walkable cell to the nearest cell that isn't (two-pass chamfer distance)
function distanceToEdge(walkable: Uint8Array, w: number, h: number) {
  const dist = new Float32Array(walkable.length);
  for (let c = 0; c < walkable.length; c++) dist[c] = walkable[c] ? Infinity : 0;
  const diagonal = Math.SQRT2;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = z * w + x;
      if (!dist[c]) continue;
      let d = dist[c];
      d = Math.min(d, x > 0 ? dist[c - 1] + 1 : 1);
      d = Math.min(d, z > 0 ? dist[c - w] + 1 : 1);
      if (x > 0 && z > 0) d = Math.min(d, dist[c - w - 1] + diagonal);
      if (x < w - 1 && z > 0) d = Math.min(d, dist[c - w + 1] + diagonal);
      dist[c] = d;
    }
  }
  for (let z = h - 1; z >= 0; z--) {
    for (let x = w - 1; x >= 0; x--) {
      const c = z * w + x;
      if (!dist[c]) continue;
      let d = dist[c];
      d = Math.min(d, x < w - 1 ? dist[c + 1] + 1 : 1);
      d = Math.min(d, z < h - 1 ? dist[c + w] + 1 : 1);
      if (x < w - 1 && z < h - 1) d = Math.min(d, dist[c + w + 1] + diagonal);
      if (x > 0 && z < h - 1) d = Math.min(d, dist[c + w - 1] + diagonal);
      dist[c] = d;
    }
  }
  return dist;
}

// The largest group of walkable cells connected side to side
function largestRegion(walkable: Uint8Array, w: number, h: number) {
  const label = new Int32Array(walkable.length);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < walkable.length; seed++) {
    if (!walkable[seed] || label[seed]) continue;
    next++;
    let size = 0;
    label[seed] = next;
    stack.push(seed);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % w;
      const z = Math.floor(c / w);
      const neighbours = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, z > 0 ? c - w : -1, z < h - 1 ? c + w : -1];
      for (const n of neighbours) {
        if (n >= 0 && walkable[n] && !label[n]) {
          label[n] = next;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(walkable.length);
  for (let c = 0; c < walkable.length; c++) out[c] = best && label[c] === best ? 1 : 0;
  return out;
}
