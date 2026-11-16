/**
 * The scrub around a site: the low, dry bushes and cactus clumps of the coastal desert, which the satellite's colours
 * on the terrain only average into brown.
 *
 * The plants (and loose stones) are the site's own, cut out of its photos by the splat pipeline's scrub_atlas.py into
 * one atlas image: a side view and a view from above of each kind, with a small JSON file giving each kind's size and
 * share, how thick they grow, and the colour of the bare ground at the splat's edge (SceneEnvironment.scrubUrl). One
 * pattern of plants, repeating every SCRUB.tile metres, feeds both halves:
 * - near the site, each plant stands as a cut-out card facing the site's centre (one instanced mesh), swaying
 *   a little, and leans back as the camera rises over it;
 * - on the terrain itself, a tiling map carries each plant as seen from above and its shadow (cast away from the sun
 *   of the site's photos), out to wherever the terrain's detail goes. At the splat's edge the bare ground between
 *   the plants is given the colour of the splat's own, so the two meet without a seam. Far away the map blurs to its
 *   mean, which the terrain shader divides out, so the land there keeps the satellite's colour.
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts).
 */
import * as THREE from 'three';
import type { SiteAnalysis } from '@/effects/siteAnalysis';
import { assetUrl } from '@/utils/assetUrl';
import type { LoadedEnvironment } from '@/utils/sceneEnvironment';

const SCRUB = {
  seed: 20250406,
  // The pattern's period (metres)
  tile: 64,
  // Plants stand as cards out to here from the site's centre (metres), thinning out over the last stretch
  reach: 120,
  thinOut: 70,
  // ... and each kind no further than this many metres per metre of its size (the square root of its width times
  // its height): a 1.3 m shrub to about 110 m, a stone or a mat to 40-60 m. A site can set less
  // (SceneEnvironment.scrubReach): the terrain's map carries the plants further out as specks and shadows.
  reachPerMetre: 130,
  // And they thin to nothing as the camera comes this near (metres)
  tooNear: [2, 4.5],
  // How far a card leans back toward facing a camera above it (1: all the way), about this height on the plant
  lean: 0.8,
  pivot: 0.3,
  // The atlas: side views in columns and rows over its top two thirds, then one row of views from above for the
  // ground map
  columns: 4,
  rows: 2,
  alphaTest: 0.45,
  // The ground map's side in pixels
  mapPixels: 1024,
  // The pebbles' own tile: its period (metres), side in pixels, and how many pebbles
  grainTile: 4,
  grainPixels: 512,
  pebbles: 2600,
  // What's left of the ground's light (linear) on bare sand and in a plant's shadow under a clear sky
  sand: [0.9, 0.8, 0.64],
  shadow: [0.2, 0.2, 0.23],
  // The bare ground is brought toward the splat's colour at the splat's edge, by at most this much either way, and by
  // here (metres) it is back to what the satellite's colour leaves it. Seen from eye height a shorter fade shows as a
  // line across the land.
  nearMost: 1.35,
  nearReach: 250,
  // Nothing grows less than this far above the sea (metres): the terrain lies at sea level over the water, and the
  // terrain shader's land starts here too. Sites by the shore (Pirka 9) had plants standing on the bay.
  aboveSea: 1.5,
};

// A kind of plant (or stone) in the atlas: its size in metres, its share of the plants that stand apart, and its share
// of the small things strewn between them (tufts, stones)
type Kind = { name: string; width: number; height: number; share: number; scatter: number };
// What scrub_atlas.py writes about a site's scrub: the atlas image (next to the JSON), the colour of the bare ground
// at the splat's edge (sRGB bytes), the grid the plants are scattered on (metres), how many cells get a plant where
// they grow thickest, strewn things and ground-only litter (twigs, stones and seedlings too small for a card) per
// cell, the plants' sizes against their kind's, and whether each plant is darkened to the land it stands on (for land
// much darker than the splat's edge; see `shade` in loadScrub)
type Description = {
  atlas: string;
  sand: number[];
  cell: number;
  density: number;
  tufts: number;
  litter: number;
  size: [number, number];
  kinds: Kind[];
  shade?: boolean;
};
type Plant = { x: number; z: number; kind: number; size: number; yaw: number };

export type Scrub = {
  mesh: THREE.InstancedMesh;
  /** Multiplies the plants' colours (night) */
  setTint: (tint: THREE.Color) => void;
  /** `eye` is the camera's position in the metric frame */
  update: (seconds: number, eye: THREE.Vector3) => void;
  dispose: () => void;
};

// A small seeded generator (mulberry32): the same scrub on every visit
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (c: number[], scale = 1) =>
  `rgb(${c.map(v => Math.round(THREE.MathUtils.clamp(v * scale, 0, 1) * 255)).join(',')})`;
const rgba = (c: number[], alpha: number) =>
  `rgba(${c.map(v => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255)).join(',')},${alpha})`;

// One tile of plants: thick in drifts, sparse between them (smooth noise that wraps with the tile)
function plantTile(described: Description, random: () => number): Plant[] {
  const { kinds } = described;
  const cells = Math.round(SCRUB.tile / described.cell);
  const size = SCRUB.tile / cells;
  const lattice = 8;
  const values = Array.from({ length: lattice * lattice }, random);
  const drift = (x: number, z: number) => {
    const u = (x / SCRUB.tile) * lattice;
    const v = (z / SCRUB.tile) * lattice;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = THREE.MathUtils.smoothstep(u - i, 0, 1);
    const fv = THREE.MathUtils.smoothstep(v - j, 0, 1);
    const at = (a: number, b: number) => values[(((b % lattice) + lattice) % lattice) * lattice + (((a % lattice) + lattice) % lattice)];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(at(i, j), at(i + 1, j), fu), THREE.MathUtils.lerp(at(i, j + 1), at(i + 1, j + 1), fu), fv);
  };
  const pick = (by: 'share' | 'scatter') => {
    let at = random() * kinds.reduce((sum, kind) => sum + kind[by], 0);
    return Math.max(kinds.findIndex(kind => (at -= kind[by]) < 0), 0);
  };
  const apart = (a: number, b: number) => Math.abs(a - b) > SCRUB.tile / 2 ? SCRUB.tile - Math.abs(a - b) : Math.abs(a - b);
  const [small, large] = described.size;
  const plants: Plant[] = [];
  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const x = (cx + random()) * size;
      const z = (cz + random()) * size;
      const thick = 0.25 + 0.75 * THREE.MathUtils.smoothstep(drift(x, z), 0.25, 0.7);
      if (random() < described.density * thick) {
        const kind = pick('share');
        const plant = { x, z, kind, size: small + (large - small) * random() ** 1.4, yaw: random() * Math.PI * 2 };
        // Plants crowd each other but don't stand inside one another
        const room = (other: Plant) => 0.3 * (kinds[kind].width * plant.size + kinds[other.kind].width * other.size);
        if (!plants.some(other => Math.hypot(apart(other.x, x), apart(other.z, z)) < room(other))) plants.push(plant);
      }
    }
  }
  if (kinds.some(kind => kind.scatter > 0)) {
    for (let i = 0; i < cells * cells * described.tufts; i++) {
      plants.push({
        x: random() * SCRUB.tile, z: random() * SCRUB.tile, kind: pick('scatter'), size: 0.5 + 1.1 * random() ** 2,
        yaw: random() * Math.PI * 2,
      });
    }
  }
  return plants;
}

// Each kind's view from above, out of the atlas, as the ground map holds it: what's left of the ground's light where
// the plant covers it, and the plant's outline in its shadow's tone
function groundStamps(image: HTMLImageElement, described: Description, shadows: number) {
  const side = image.width / (2 * SCRUB.columns);
  const linear = (byte: number) => ((byte / 255 + 0.055) / 1.055) ** 2.4;
  const sand = described.sand.map(linear);
  // Under cloud a plant's shadow is the dimness under it, not a dark patch beside it
  const shade = SCRUB.shadow.map(v => THREE.MathUtils.lerp(0.55, v, shadows));
  return described.kinds.map((_, k) => {
    const plant = document.createElement('canvas');
    plant.width = plant.height = side;
    const ctx = plant.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, k * side, image.height - side, side, side, 0, 0, side, side);
    const pixels = ctx.getImageData(0, 0, side, side);
    const outline = document.createElement('canvas');
    outline.width = outline.height = side;
    const shadeCtx = outline.getContext('2d')!;
    const shadePixels = shadeCtx.createImageData(side, side);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const alpha = THREE.MathUtils.smoothstep(pixels.data[i + 3] / 255, 0.15, 0.55);
      for (let c = 0; c < 3; c++) {
        pixels.data[i + c] = Math.min((SCRUB.sand[c] * linear(pixels.data[i + c])) / sand[c], 1) * 255;
        shadePixels.data[i + c] = SCRUB.sand[c] * shade[c] * 255;
      }
      pixels.data[i + 3] = alpha * 255;
      shadePixels.data[i + 3] = alpha * 235;
    }
    ctx.putImageData(pixels, 0, 0);
    shadeCtx.putImageData(shadePixels, 0, 0);
    return { plant, shade: outline };
  });
}

// The ground map: what's left of the ground's light at each spot of the tile (linear, straight in the bytes). `away`
// is the horizontal direction shadows fall in, `stretch` their length per metre of height and `shadows` how hard
// they are (0 under cloud: a dimness around the plant).
function drawGround(
  plants: Plant[], described: Description, stamps: ReturnType<typeof groundStamps>, away: THREE.Vector2,
  stretch: number, shadows: number, random: () => number,
) {
  const { kinds } = described;
  const pixels = SCRUB.mapPixels;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = pixels;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  const scale = pixels / SCRUB.tile;
  ctx.fillStyle = rgb(SCRUB.sand);
  ctx.fillRect(0, 0, pixels, pixels);

  // Sand: broad paler and darker patches, then pebbles
  for (let i = 0; i < 500; i++) {
    const tone = random() < 0.5 ? 0.78 : 1.1;
    const colour = SCRUB.sand.map(v => v * tone);
    const x = random() * pixels;
    const z = random() * pixels;
    const radius = (0.6 + 2.2 * random()) * scale;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx * pixels;
        const pz = z + dz * pixels;
        if (px + radius < 0 || pz + radius < 0 || px - radius > pixels || pz - radius > pixels) continue;
        const gradient = ctx.createRadialGradient(px, pz, radius * 0.2, px, pz, radius);
        gradient.addColorStop(0, rgba(colour, 0.22));
        gradient.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(px, pz, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const pebbles = [0.4, 0.5, 0.62, 0.72, 0.8, 1.08].map(tone => rgb(SCRUB.sand, tone));
  for (let i = 0; i < 20000; i++) {
    ctx.fillStyle = pebbles[Math.floor(random() * pebbles.length)];
    const side = random() < 0.85 ? 1 : 2;
    ctx.fillRect(Math.floor(random() * pixels), Math.floor(random() * pixels), side, side);
  }

  // A stamp across (metres) at a spot of the tile, turned as its plant is, repeated across the tile's edges
  const stamp = (image: HTMLCanvasElement, x: number, z: number, across: number, yaw: number) => {
    const half = (across * scale) / 2;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = (x + dx * SCRUB.tile) * scale;
        const pz = (z + dz * SCRUB.tile) * scale;
        if (px + 1.5 * half < 0 || pz + 1.5 * half < 0 || px - 1.5 * half > pixels || pz - 1.5 * half > pixels) continue;
        ctx.save();
        ctx.translate(px, pz);
        ctx.rotate(-yaw);
        ctx.drawImage(image, -half, -half, 2 * half, 2 * half);
        ctx.restore();
      }
    }
  };
  // Shadows first: each plant's outline, slid away from the sun as far as its height throws it; then the plants
  for (const plant of plants) {
    const kind = kinds[plant.kind];
    const length = kind.height * plant.size * stretch;
    for (const t of [0.45, 0.9]) {
      stamp(stamps[plant.kind].shade, plant.x + away.x * length * t, plant.z + away.y * length * t,
        FOOTPRINT * kind.width * plant.size * THREE.MathUtils.lerp(1.3, 1 - 0.3 * t, shadows), plant.yaw);
    }
  }
  for (const plant of plants) {
    stamp(stamps[plant.kind].plant, plant.x, plant.z, FOOTPRINT * kinds[plant.kind].width * plant.size, plant.yaw);
  }
  // Litter: the strewn kinds again, too small for a card
  const strewn = kinds.map((kind, k) => (kind.scatter > 0 ? k : -1)).filter(k => k >= 0);
  for (let i = 0; strewn.length && i < (SCRUB.tile / described.cell) ** 2 * described.litter; i++) {
    stamp(stamps[strewn[Math.floor(random() * strewn.length)]].plant, random() * SCRUB.tile, random() * SCRUB.tile,
      0.12 + 0.3 * random() ** 2, random() * Math.PI * 2);
  }

  // What the map's mean leaves of the ground's light, which the terrain shader divides out
  const data = ctx.getImageData(0, 0, pixels, pixels).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
  }
  const mean = sum.map(v => v / (255 * pixels * pixels));
  return { canvas, mean };
}

// The pebbles: a small tile of stones on sand, each with its shadow, for the ground seen from up close
function drawGrain(away: THREE.Vector2, random: () => number) {
  const pixels = SCRUB.grainPixels;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = pixels;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(pixels, pixels);
  for (let i = 0; i < image.data.length; i += 4) {
    const tone = 200 + 30 * (random() + random() - 1);
    image.data[i] = image.data[i + 1] = image.data[i + 2] = tone;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const grey = (tone: number, warm = 0) => `rgb(${Math.round(tone * (1 + warm))},${Math.round(tone)},${Math.round(tone * (1 - warm))})`;
  for (let i = 0; i < SCRUB.pebbles; i++) {
    const x = random() * pixels;
    const y = random() * pixels;
    const long = 1 + 3.8 * random() ** 3;
    const short = long * (0.55 + 0.4 * random());
    const turn = random() * Math.PI;
    const tone = random() < 0.15 ? 215 + 30 * random() : 95 + 80 * random();
    const warm = 0.06 * (random() - 0.3);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx * pixels;
        const py = y + dy * pixels;
        if (px < -16 || py < -16 || px > pixels + 16 || py > pixels + 16) continue;
        ctx.fillStyle = grey(70);
        ctx.beginPath();
        ctx.ellipse(px + away.x * short * 0.7, py + away.y * short * 0.7, long, short, turn, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = grey(tone, warm);
        ctx.beginPath();
        ctx.ellipse(px, py, long, short, turn, 0, Math.PI * 2);
        ctx.fill();
        // The side toward the sun catches it
        ctx.fillStyle = grey(Math.min(tone * 1.25, 250), warm);
        ctx.beginPath();
        ctx.ellipse(px - away.x * short * 0.3, py - away.y * short * 0.3, long * 0.6, short * 0.6, turn, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return canvas;
}

// How wide a plant is from above, against its side view
const FOOTPRINT = 0.85;

// A plant's card: x spans -1 to 1, y 0 to 1. The shader turns it to face the camera.
function cardGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

// The terrain's height (metric frame) on a one-metre grid out to `half` metres, read off its triangles
function terrainHeights(meshes: THREE.Mesh[], metric: THREE.Object3D, half: number) {
  const n = 2 * half + 1;
  const grid = new Float32Array(n * n).fill(NaN);
  metric.updateWorldMatrix(true, false);
  const inverse = metric.matrixWorld.clone().invert();
  const toMetric = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    toMetric.multiplyMatrices(inverse, mesh.matrixWorld);
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const p = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toMetric);
      p[3 * i] = v.x;
      p[3 * i + 1] = v.y;
      p[3 * i + 2] = v.z;
    }
    const triangles = (index ? index.count : position.count) / 3;
    for (let t = 0; t < triangles; t++) {
      const a = 3 * (index ? index.getX(3 * t) : 3 * t);
      const b = 3 * (index ? index.getX(3 * t + 1) : 3 * t + 1);
      const c = 3 * (index ? index.getX(3 * t + 2) : 3 * t + 2);
      const x0 = Math.max(Math.ceil(Math.min(p[a], p[b], p[c])), -half);
      const x1 = Math.min(Math.floor(Math.max(p[a], p[b], p[c])), half);
      const z0 = Math.max(Math.ceil(Math.min(p[a + 2], p[b + 2], p[c + 2])), -half);
      const z1 = Math.min(Math.floor(Math.max(p[a + 2], p[b + 2], p[c + 2])), half);
      if (x0 > x1 || z0 > z1) continue;
      const det = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
      if (Math.abs(det) < 1e-9) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const la = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / det;
          const lb = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / det;
          const lc = 1 - la - lb;
          if (la < -1e-4 || lb < -1e-4 || lc < -1e-4) continue;
          grid[(z + half) * n + x + half] = la * p[a + 1] + lb * p[b + 1] + lc * p[c + 1];
        }
      }
    }
  }
  return (x: number, z: number) => {
    const fx = THREE.MathUtils.clamp(x + half, 0, n - 1.001);
    const fz = THREE.MathUtils.clamp(z + half, 0, n - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const k = iz * n + ix;
    const u = fx - ix;
    const w = fz - iz;
    return (grid[k] * (1 - u) + grid[k + 1] * u) * (1 - w) + (grid[k + n] * (1 - u) + grid[k + n + 1] * u) * w;
  };
}

// The terrain's own colour (linear) in a ring around the site, `from` to `to` metres from its centre: its texture
// under the vertices there
/**
 * The terrain texture's colour (linear) averaged over square cells of `cell` metres out to `half` metres, in the
 * metric frame: a function of (x, z) giving a cell's colour, or null where no vertex fell.
 */
function terrainColours(meshes: THREE.Mesh[], metric: THREE.Object3D, half: number, cell: number) {
  const n = Math.ceil((2 * half) / cell);
  const sums = new Float32Array(n * n * 4);
  metric.updateWorldMatrix(true, false);
  const inverse = metric.matrixWorld.clone().invert();
  const toMetric = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const linear = (byte: number) => ((byte / 255 + 0.055) / 1.055) ** 2.4;
  const index = (x: number, z: number) => {
    const i = Math.floor((x + half) / cell);
    const k = Math.floor((z + half) / cell);
    return i < 0 || k < 0 || i >= n || k >= n ? -1 : k * n + i;
  };
  for (const mesh of meshes) {
    const map = (mesh.material as THREE.MeshBasicMaterial).map;
    const position = mesh.geometry.attributes.position;
    const uv = mesh.geometry.attributes.uv;
    if (!map?.image || !uv) continue;
    const side = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(map.image as CanvasImageSource, 0, 0, side, side);
    const pixels = ctx.getImageData(0, 0, side, side).data;
    mesh.updateWorldMatrix(true, false);
    toMetric.multiplyMatrices(inverse, mesh.matrixWorld);
    const wrap = (t: number) => Math.min(Math.floor((t - Math.floor(t)) * side), side - 1);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toMetric);
      const at = index(v.x, v.z);
      if (at < 0) continue;
      const px = 4 * ((map.flipY ? side - 1 - wrap(uv.getY(i)) : wrap(uv.getY(i))) * side + wrap(uv.getX(i)));
      for (let c = 0; c < 3; c++) sums[4 * at + c] += linear(pixels[px + c]);
      sums[4 * at + 3]++;
    }
  }
  return (x: number, z: number) => {
    const at = index(x, z);
    const count = at < 0 ? 0 : sums[4 * at + 3];
    return count ? [0, 1, 2].map(c => sums[4 * at + c] / count) : null;
  };
}

function terrainColour(meshes: THREE.Mesh[], metric: THREE.Object3D, from: number, to: number) {
  metric.updateWorldMatrix(true, false);
  const inverse = metric.matrixWorld.clone().invert();
  const toMetric = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const sum = [0, 0, 0];
  let count = 0;
  const linear = (byte: number) => ((byte / 255 + 0.055) / 1.055) ** 2.4;
  for (const mesh of meshes) {
    const map = (mesh.material as THREE.MeshBasicMaterial).map;
    const position = mesh.geometry.attributes.position;
    const uv = mesh.geometry.attributes.uv;
    if (!map?.image || !uv) continue;
    const side = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(map.image as CanvasImageSource, 0, 0, side, side);
    const pixels = ctx.getImageData(0, 0, side, side).data;
    mesh.updateWorldMatrix(true, false);
    toMetric.multiplyMatrices(inverse, mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toMetric);
      const distance = Math.hypot(v.x, v.z);
      if (distance < from || distance > to) continue;
      const wrap = (t: number) => Math.min(Math.floor((t - Math.floor(t)) * side), side - 1);
      const at = 4 * ((map.flipY ? side - 1 - wrap(uv.getY(i)) : wrap(uv.getY(i))) * side + wrap(uv.getX(i)));
      for (let c = 0; c < 3; c++) sum[c] += linear(pixels[at + c]);
      count++;
    }
  }
  return count ? sum.map(value => value / count) : null;
}

// Where the splat's own ground gives out (metres from the centre): the plants start there
function splatEdge(analysis: SiteAnalysis) {
  const rings = Math.ceil(analysis.half);
  const cells = new Float32Array(rings + 1);
  const captured = new Float32Array(rings + 1);
  for (let k = 0; k < analysis.n * analysis.n; k++) {
    const x = -analysis.half + ((k % analysis.n) + 0.5) * analysis.cell;
    const z = -analysis.half + (Math.floor(k / analysis.n) + 0.5) * analysis.cell;
    const ring = Math.floor(Math.hypot(x, z));
    if (ring > rings) continue;
    cells[ring]++;
    captured[ring] += analysis.captured[k];
  }
  let edge = 0;
  for (let ring = 0; ring <= rings; ring++) if (captured[ring] > 0.3 * cells[ring]) edge = ring + 1;
  return edge;
}

/**
 * Plants the scrub described at `url` around the site, on `environment`'s terrain. `sun` is the unit vector toward
 * the sun (metric frame) and `shadows` how hard its shadows are (1 under a clear sky, 0 under cloud),
 * `metersPerUnit` the viewer's scale. Add `mesh` to the metric frame.
 */
export async function loadScrub(
  url: string,
  environment: LoadedEnvironment,
  metric: THREE.Object3D,
  analysis: SiteAnalysis,
  sun: THREE.Vector3,
  shadows: number,
  metersPerUnit: number,
  anisotropy: number,
  reachPerMetre: number = SCRUB.reachPerMetre,
): Promise<Scrub> {
  const described = new URL(assetUrl(url), window.location.href);
  const response = await fetch(described);
  if (!response.ok) throw new Error(`${described}: ${response.status}`);
  const scrub = (await response.json()) as Description;
  const { kinds } = scrub;
  const image: HTMLImageElement = await new THREE.ImageLoader().loadAsync(new URL(scrub.atlas, described).href);

  const random = seeded(SCRUB.seed);
  const plants = plantTile(scrub, random);
  const away = new THREE.Vector2(-sun.x, -sun.z).normalize();
  const stretch = (shadows * Math.hypot(sun.x, sun.z)) / Math.max(sun.y, 0.2);
  const ground = drawGround(plants, scrub, groundStamps(image, scrub, shadows), away, stretch, shadows, random);
  const map = new THREE.CanvasTexture(ground.canvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.flipY = false;
  map.anisotropy = anisotropy;
  const grain = new THREE.CanvasTexture(drawGrain(away, random));
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.flipY = false;
  grain.anisotropy = anisotropy;
  const edge = splatEdge(analysis);
  const blank = environment.scrub.map.value;
  environment.scrub.map.value = map;
  // Far off the map's mean leaves the terrain's colour as it is; at the splat's edge its bare ground has the colour of
  // the splat's own
  const linear = (byte: number) => ((byte / 255 + 0.055) / 1.055) ** 2.4;
  const terrains = environment.terrain.filter(mesh => mesh.name.startsWith('terrain'));
  const around = terrainColour(terrains, metric, edge + 1, edge + 12);
  const far = ground.mean.map(value => 1 / value);
  const near = around
    ? far.map((gain, c) => gain * THREE.MathUtils.clamp(
      linear(scrub.sand[c]) / (around[c] * SCRUB.sand[c] * gain), 1 / SCRUB.nearMost, SCRUB.nearMost))
    : far;
  environment.scrub.gain.value.set(far[0], far[1], far[2]);
  environment.scrub.near.value.set(near[0], near[1], near[2]);
  environment.scrub.reach.value.set(edge / metersPerUnit, SCRUB.nearReach / metersPerUnit);
  environment.scrub.grain.value = grain;
  environment.scrub.grainPeriod.value = SCRUB.grainTile;
  environment.scrub.bare.value.set(SCRUB.sand[0], SCRUB.sand[1], SCRUB.sand[2]);
  environment.scrub.info.value.set(SCRUB.tile, (edge - 1.5) / metersPerUnit, (edge + 0.5) / metersPerUnit, 1);

  // The image goes to the GPU as it is, not through a canvas: its see-through pixels carry their neighbours' colour,
  // which a canvas would blacken, darkening every edge once the texture is filtered
  const atlas = new THREE.Texture(image);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = anisotropy;
  atlas.needsUpdate = true;
  const time = { value: 0 };
  const eye = { value: new THREE.Vector3(0, 2, 0) };
  const toSun = { value: new THREE.Vector2(sun.x, sun.z).normalize() };
  const atlasSize = { value: new THREE.Vector2(image.width, image.height) };
  // The cut-outs' edges are blended over a pixel instead of cut with an alpha test, which left them jagged (worst in
  // VR, which has no other smoothing). So the cards are drawn after the land and the sky and before the splats; they
  // still write depth, and only pixels with nothing of the plant are dropped.
  const material = new THREE.MeshBasicMaterial({
    map: atlas, alphaTest: 0.02, transparent: true, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.scrubTime = time;
    shader.uniforms.scrubEye = eye;
    shader.uniforms.scrubSun = toSun;
    shader.uniforms.scrubAtlas = atlasSize;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSprite;
        uniform float scrubTime;
        uniform vec3 scrubEye;
        uniform vec2 scrubSun;
        varying float vScrubLight;
        varying float vScrubCover;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        // The kind's cell in the atlas, a little inside its edges (half the plants are mirrored, so a kind's plants
        // aren't all the one plant)
        float scrubKind = floor(aSprite);
        float scrubAcross = mix(0.008, 0.992, mix(uv.x, 1.0 - uv.x, step(0.5, fract(aSprite))));
        vMapUv = vec2((mod(scrubKind, ${SCRUB.columns}.0) + scrubAcross) / ${SCRUB.columns}.0,
          1.0 - (floor(scrubKind / ${SCRUB.columns}.0) + 1.0 - mix(0.01, 0.99, uv.y)) / ${SCRUB.rows + 1}.0);
        // The card faces the site's centre, which the camera circles, so from wherever the camera is it sees the card
        // nearly face on, and the card stays put as the camera goes round (cards turning to face the camera itself
        // spun round with it). Its side toward the sun is a little lighter.
        vec3 scrubToEye = scrubEye - instanceMatrix[3].xyz;
        vec2 scrubAhead = normalize(-instanceMatrix[3].xz + 1e-5);
        vec2 scrubRight = vec2(scrubAhead.y, -scrubAhead.x);
        // ... and its foot darker, in the plant's own shade, so it stands on the ground instead of on top of it
        vScrubLight = (0.96 + 0.1 * position.x * dot(scrubRight, scrubSun)) * mix(0.5, 1.0, smoothstep(0.0, 0.55, uv.y));
        // A card a step from the eye is plainly a card: the plant thins away as the eye comes up to it, and as the
        // eye passes beside it, where it would be seen edge on
        float scrubFacing = abs(dot(scrubAhead, normalize(scrubToEye.xz + 1e-5)));
        vScrubCover = smoothstep(${SCRUB.tooNear[0].toFixed(1)}, ${SCRUB.tooNear[1].toFixed(1)}, length(scrubToEye))
          * smoothstep(0.2, 0.5, scrubFacing);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Seen from above the card leans back about a point low on the plant, so it isn't looked at edge-on
        vec2 scrubX = normalize(instanceMatrix[0].xz);
        vec2 scrubZ = normalize(instanceMatrix[2].xz);
        float scrubLean = ${SCRUB.lean.toFixed(2)} * asin(clamp(scrubToEye.y / length(scrubToEye), 0.0, 1.0));
        float scrubUp = position.y - ${SCRUB.pivot.toFixed(2)};
        float scrubBack = -sin(scrubLean) * scrubUp * length(instanceMatrix[1].xyz) / length(instanceMatrix[0].xyz);
        transformed.y = ${SCRUB.pivot.toFixed(2)} + scrubUp * cos(scrubLean);
        transformed.xz = position.x * vec2(dot(scrubRight, scrubX), dot(scrubRight, scrubZ))
          + scrubBack * vec2(dot(scrubAhead, scrubX), dot(scrubAhead, scrubZ));
        if (vScrubCover <= 0.0) transformed *= 0.0;
        // The wind: twigs lean and spring back, more toward their tips, each plant in its own time
        float scrubPhase = instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 1.7;
        float scrubGust = sin(scrubTime * 1.9 + scrubPhase) + 0.5 * sin(scrubTime * 4.3 + scrubPhase * 1.7);
        transformed.x += position.y * position.y * 0.035 * scrubGust;
        transformed.z += position.y * position.y * 0.02 * cos(scrubTime * 2.6 + scrubPhase);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vScrubLight;
        varying float vScrubCover;
        uniform vec2 scrubAtlas;
        float scrubHash(vec2 i) { return fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453); }`)
      // Far away the texture's smaller copies average twigs and gaps into less than the cut-out's threshold, and the
      // plant would thin to nothing: its cover is raised with distance instead
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= vScrubLight;
        vec2 scrubTexel = vMapUv * scrubAtlas;
        float scrubSmaller = 0.5 * log2(max(dot(dFdx(scrubTexel), dFdx(scrubTexel)), dot(dFdy(scrubTexel), dFdy(scrubTexel))));
        diffuseColor.a *= (1.0 + 0.25 * max(scrubSmaller, 0.0)) * vScrubCover;
        // The cut-outs' outlines are smooth curves: near their edge, twigs and gaps break them up, and the edge is
        // in shade, so a plant reads as a clump, not a sticker
        float scrubInside = texture2D(map, vMapUv, 2.5).a;
        // (smooth noise, a few texels a bump: as square cells it gave the outline a sawtooth)
        vec2 scrubCell = floor(scrubTexel / 3.0), scrubIn = fract(scrubTexel / 3.0);
        scrubIn = scrubIn * scrubIn * (3.0 - 2.0 * scrubIn);
        float scrubRagged = mix(
          mix(scrubHash(scrubCell), scrubHash(scrubCell + vec2(1.0, 0.0)), scrubIn.x),
          mix(scrubHash(scrubCell + vec2(0.0, 1.0)), scrubHash(scrubCell + vec2(1.0, 1.0)), scrubIn.x), scrubIn.y);
        diffuseColor.a *= mix(0.3 + 1.4 * scrubRagged, 1.0, smoothstep(0.55, 0.95, scrubInside));
        diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.4, 0.9, scrubInside));
        // The plant's outline is where this passes the threshold: how much of the pixel it covers, over one pixel
        diffuseColor.a = clamp((diffuseColor.a - ${SCRUB.alphaTest.toFixed(2)}) / max(fwidth(diffuseColor.a), 1e-4) + 0.5, 0.0, 1.0);`);
  };
  material.customProgramCacheKey = () => 'scrub';

  // The tile's plants, repeated around the site
  const heightAt = terrainHeights(terrains, metric, Math.ceil(SCRUB.reach) + 2);
  // The sea's height in the metric frame, from the terrain's detail description (env_build.py); none inland
  const seaZ: number | undefined = terrains
    .map(mesh => (mesh.material as any).userData?.detail?.seaZ)
    .find(z => typeof z === 'number');
  const placed: { plant: Plant; x: number; y: number; z: number; size: number }[] = [];
  const tiles = Math.ceil(SCRUB.reach / SCRUB.tile);
  for (let tz = -tiles; tz < tiles; tz++) {
    for (let tx = -tiles; tx < tiles; tx++) {
      for (const plant of plants) {
        const x = plant.x + tx * SCRUB.tile;
        const z = plant.z + tz * SCRUB.tile;
        const distance = Math.hypot(x, z);
        const kind = kinds[plant.kind];
        const half = (kind.width * plant.size) / 2;
        // Each kind stands out to where it would still be a few pixels across: small things (tufts, stones, mats)
        // further out would only scatter confetti over the land
        const reach = Math.min(SCRUB.reach, reachPerMetre * Math.sqrt(kind.width * kind.height) * plant.size);
        if (distance - 0.6 * half < edge + 0.5 || distance > reach) continue;
        // Over the last stretch fewer and fewer stand, a little smaller: an edge where they all stopped would show
        // as a line across the land
        const fade = 1 - THREE.MathUtils.smoothstep(distance, reach - Math.min(SCRUB.thinOut, 0.6 * reach), reach);
        const y = heightAt(x, z);
        if (random() >= fade || Number.isNaN(y)) continue;
        if (seaZ !== undefined && y - seaZ < SCRUB.aboveSea) continue;
        placed.push({ plant, x, y, z, size: (0.6 + 0.4 * fade) * plant.size });
      }
    }
  }
  const geometry = cardGeometry();
  const sprites = new Float32Array(placed.length);
  const mesh = new THREE.InstancedMesh(geometry, material, placed.length);
  mesh.name = 'scrub';
  mesh.frustumCulled = false;
  // Before the splats, which are blended over everything else
  mesh.renderOrder = -1;
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const colour = new THREE.Color();
  // The plants were cut to the exposure of the bare ground at the splat's edge. Where the land is darker than that
  // (grey shingle, a backlit slope; the second batch's coast), each is darkened to match the ground it stands on, as
  // the terrain draws it there (its texture, the map's bare ground and the gain); bright cut-outs on dark ground read
  // as confetti. They are never brightened. Only where the site's scrub JSON asks for it (`shade`): on the earlier
  // sites' pale land it changed little, and darkened pirca0's far bushes, whose look was approved as it was.
  const landColour = terrainColours(terrains, metric, SCRUB.reach + 8, 8);
  const luma = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const bare = luma(scrub.sand.map(linear));
  const shade = (x: number, z: number) => {
    const texel = landColour(x, z);
    if (!scrub.shade || !texel || !bare) return 1;
    const t = THREE.MathUtils.smoothstep(Math.hypot(x, z), edge, SCRUB.nearReach);
    const drawn = [0, 1, 2].map(c => texel[c] * SCRUB.sand[c] * THREE.MathUtils.lerp(near[c], far[c], t));
    return THREE.MathUtils.clamp(luma(drawn) / bare, 0.35, 1);
  };
  placed.forEach(({ plant, x, y, z, size }, i) => {
    const kind = kinds[plant.kind];
    const height = kind.height * size;
    matrix.compose(
      new THREE.Vector3(x, y - 0.04 * height, z), turn.setFromAxisAngle(up, plant.yaw),
      new THREE.Vector3((kind.width * size) / 2, height, (kind.width * size) / 2));
    mesh.setMatrixAt(i, matrix);
    const light = (0.88 + 0.2 * random()) * shade(x, z);
    mesh.setColorAt(i, colour.setRGB(light * (1 + 0.04 * random()), light, light * (1 - 0.04 * random())));
    // The kind, and a half more for the plants drawn mirrored
    sprites[i] = plant.kind + (random() < 0.5 ? 0.5 : 0);
  });
  geometry.setAttribute('aSprite', new THREE.InstancedBufferAttribute(sprites, 1));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return {
    mesh,
    setTint(tint) {
      material.color.copy(tint);
    },
    update(seconds, at) {
      time.value = seconds;
      eye.value.copy(at);
    },
    dispose() {
      environment.scrub.map.value = blank;
      environment.scrub.grain.value = blank;
      grain.dispose();
      environment.scrub.info.value.w = 0;
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      atlas.dispose();
      map.dispose();
    },
  };
}
