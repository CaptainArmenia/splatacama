/**
 * Desierto florido: in rainy years this stretch of the Atacama (Huasco to La Serena) carpets itself in flowers.
 * Each flower is a few splats scattered on the bare ground from the site analysis, never on the walls or bushes. A
 * shader opens them as `bloom` goes from 0 to 1 and sways them in the wind. The terrain beyond blooms too (see
 * sceneEnvironment.ts).
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts).
 */
import * as THREE from 'three';
import { SplatMesh, dyno } from '@sparkjsdev/spark';
import type { SiteAnalysis } from '@/effects/siteAnalysis';

const SPLATS_PER_FLOWER = 8; // 2 leaves, 5 petals, 1 centre

// Species shown (colours approximate): pata de guanaco (Cistanthe), añañuca amarilla (Rhodophiala), suspiro
// (Nolana), and a white one
const SPECIES = [
  { weight: 0.55, petal: [0.86, 0.12, 0.52], centre: [0.95, 0.85, 0.3], size: 0.045, stem: 0.12 },
  { weight: 0.2, petal: [0.98, 0.78, 0.08], centre: [0.85, 0.45, 0.05], size: 0.05, stem: 0.18 },
  { weight: 0.17, petal: [0.62, 0.55, 0.92], centre: [0.98, 0.95, 0.75], size: 0.035, stem: 0.06 },
  { weight: 0.08, petal: [0.97, 0.96, 0.92], centre: [0.95, 0.8, 0.2], size: 0.03, stem: 0.08 },
];

function pickSpecies(r: number) {
  let total = 0;
  for (const species of SPECIES) {
    total += species.weight;
    if (r < total) return species;
  }
  return SPECIES[0];
}

function hash(x: number, z: number) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth noise in metres, so flowers grow in drifts rather than evenly
function patchNoise(x: number, z: number) {
  const f = (x0: number, z0: number) => {
    const xi = Math.floor(x0);
    const zi = Math.floor(z0);
    const xf = x0 - xi;
    const zf = z0 - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);
    return (hash(xi, zi) * (1 - u) + hash(xi + 1, zi) * u) * (1 - v)
      + (hash(xi, zi + 1) * (1 - u) + hash(xi + 1, zi + 1) * u) * v;
  };
  return 0.6 * f(x / 3.5, z / 3.5) + 0.4 * f(x / 1.2 + 9, z / 1.2 + 4);
}

export type DesertBloom = {
  mesh: SplatMesh;
  /** 0: bare ground, 1: in full bloom */
  setBloom: (bloom: number) => void;
  update: (seconds: number) => void;
  dispose: () => void;
};

/** Flowers within `radius` metres of the site centre. They start hidden (`mesh.visible`). */
export function createDesertBloom(site: SiteAnalysis, radius: number, count = 16000): DesertBloom {
  let seed = 3;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const { n } = site;

  const mesh = new SplatMesh({
    constructSplats: splats => {
      const q = new THREE.Quaternion();
      const axisY = new THREE.Vector3(0, 1, 0);
      const axisZ = new THREE.Vector3(0, 0, 1);
      const tilt = new THREE.Quaternion();
      const leaf = new THREE.Color(0.36, 0.45, 0.24);
      let placed = 0;
      let tries = 0;
      while (placed < count && tries < count * 40) {
        tries++;
        const x = (rand() * 2 - 1) * radius;
        const z = (rand() * 2 - 1) * radius;
        if (Math.hypot(x, z) > radius) continue;
        const k = site.cellOf(x, z);
        if (k < 0 || !site.captured[k] || site.wall[k] || site.bush[k] || site.rel[k] > 0.07) continue;
        // Stay off the walls' rubble skirts too
        const cx = k % n;
        const cz = Math.floor(k / n);
        let nearWall = false;
        for (let dz = -3; dz <= 3 && !nearWall; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            const kk = (cz + dz) * n + cx + dx;
            if (kk >= 0 && kk < n * n && site.wall[kk]) {
              nearWall = true;
              break;
            }
          }
        }
        if (nearWall || rand() > Math.pow(patchNoise(x, z), 2.2) * 1.6) continue;

        const y = site.topAt(x, z);
        const species = pickSpecies(rand());
        const size = species.size * (0.8 + rand() * 0.5);
        const stem = species.stem * (0.6 + rand() * 0.7);
        const petal = new THREE.Color(...species.petal).multiplyScalar(0.72 + rand() * 0.25);
        // Leaves, flat on the ground
        for (let j = 0; j < 2; j++) {
          q.setFromAxisAngle(axisY, rand() * Math.PI);
          splats.pushSplat(new THREE.Vector3(x + (rand() - 0.5) * 0.06, y + 0.01, z + (rand() - 0.5) * 0.06),
            new THREE.Vector3(0.05, 0.006, 0.018), q, 0.9, leaf);
        }
        // Petals in a ring, tilted up like a cup
        const turn = rand() * Math.PI * 2;
        for (let j = 0; j < 5; j++) {
          const a = turn + (j / 5) * Math.PI * 2;
          q.setFromAxisAngle(axisY, -a);
          tilt.setFromAxisAngle(axisZ, 0.35);
          q.multiply(tilt);
          splats.pushSplat(new THREE.Vector3(x + Math.cos(a) * size * 0.75, y + stem, z + Math.sin(a) * size * 0.75),
            new THREE.Vector3(size * 0.75, size * 0.12, size * 0.42), q, 0.95, petal);
        }
        q.identity();
        splats.pushSplat(new THREE.Vector3(x, y + stem + 0.004, z), new THREE.Vector3(size * 0.3, size * 0.15, size * 0.3),
          q, 1, new THREE.Color(...species.centre));
        placed++;
      }
    },
  });

  const time = dyno.dynoFloat(0);
  const bloom = dyno.dynoFloat(0);
  mesh.objectModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }: any) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: 'float', bloom: 'float' },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }: any) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        int flower = ${inputs.gsplat}.index / ${SPLATS_PER_FLOWER};
        int part = ${inputs.gsplat}.index - flower * ${SPLATS_PER_FLOWER};
        float h = fract(sin(float(flower) * 12.9898) * 43758.5453);
        // Each flower opens at its own moment as bloom goes 0 -> 1; leaves come first
        float start = h * 0.75;
        float open = smoothstep(start, start + 0.25, ${inputs.bloom});
        float leaves = smoothstep(start * 0.5, start * 0.5 + 0.2, ${inputs.bloom});
        if (part < 2) {
          ${outputs.gsplat}.scales *= leaves;
          ${outputs.gsplat}.rgba.a *= step(0.01, leaves);
        } else {
          ${outputs.gsplat}.scales *= open;
          ${outputs.gsplat}.rgba.a *= step(0.01, open);
          // Sway in the breeze
          float ph = h * 6.2831;
          vec2 sway = 0.012 * vec2(sin(${inputs.t} * 1.7 + ph + ${inputs.gsplat}.center.x * 0.8), cos(${inputs.t} * 1.3 + ph));
          ${outputs.gsplat}.center.xz += sway;
        }
      `),
    });
    return { gsplat: d.apply({ gsplat, t: time, bloom }).gsplat };
  });
  mesh.updateGenerator();
  mesh.visible = false;

  return {
    mesh,
    setBloom(value) {
      bloom.value = value;
      mesh.updateVersion();
    },
    update(seconds) {
      if (!mesh.visible) return;
      time.value = seconds;
      mesh.updateVersion();
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
    },
  };
}
