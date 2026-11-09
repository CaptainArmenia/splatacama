/**
 * The night sky over a site: about 5,000 real stars (magnitude 6 and brighter, from d3-celestial's stars.6.json)
 * placed for the site's latitude, longitude and local time, and a procedural Milky Way with its dark dust lanes,
 * all as splats. Checked against astropy: within 0.4 degrees (no precession applied).
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts) at `radius` metres, which should lie past
 * the terrain (so hills hide the stars behind them) and inside the camera's far plane.
 */
import * as THREE from 'three';
import { SplatMesh, dyno } from '@sparkjsdev/spark';

export const STARS_URL = '/data/stars.json';

const DEG = Math.PI / 180;

// Galactic -> equatorial (J2000) rotation
const GAL_TO_EQ = [
  [-0.0548755604, 0.4941094279, -0.867666149],
  [-0.8734370902, -0.44482963, -0.1980763734],
  [-0.4838350155, 0.7469822445, 0.4559837762],
];

function equatorial(raDeg: number, decDeg: number) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

function galacticToEquatorial(lDeg: number, bDeg: number) {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
  return new THREE.Vector3(
    GAL_TO_EQ[0][0] * g[0] + GAL_TO_EQ[0][1] * g[1] + GAL_TO_EQ[0][2] * g[2],
    GAL_TO_EQ[1][0] * g[0] + GAL_TO_EQ[1][1] * g[1] + GAL_TO_EQ[1][2] * g[2],
    GAL_TO_EQ[2][0] * g[0] + GAL_TO_EQ[2][1] * g[1] + GAL_TO_EQ[2][2] * g[2],
  );
}

// Star colour from its B-V colour index
const STAR_COLORS: [number, number[]][] = [
  [-0.3, [0.62, 0.72, 1.0]], [0.0, [0.8, 0.86, 1.0]], [0.4, [1.0, 0.98, 0.95]], [0.8, [1.0, 0.9, 0.72]],
  [1.2, [1.0, 0.78, 0.5]], [2.0, [1.0, 0.6, 0.35]],
];
function starColor(bv: number) {
  if (bv <= STAR_COLORS[0][0]) return new THREE.Color(...STAR_COLORS[0][1]);
  for (let i = 1; i < STAR_COLORS.length; i++) {
    if (bv <= STAR_COLORS[i][0]) {
      const t = (bv - STAR_COLORS[i - 1][0]) / (STAR_COLORS[i][0] - STAR_COLORS[i - 1][0]);
      const a = STAR_COLORS[i - 1][1];
      const b = STAR_COLORS[i][1];
      return new THREE.Color(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    }
  }
  return new THREE.Color(...STAR_COLORS[STAR_COLORS.length - 1][1]);
}

// Small deterministic noise for the Milky Way's clumps and dust
function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x: number, y: number) {
  return 0.5 * valueNoise(x, y) + 0.25 * valueNoise(2 * x, 2 * y) + 0.125 * valueNoise(4 * x, 4 * y)
    + 0.0625 * valueNoise(8 * x, 8 * y);
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// How much dust dims the band at galactic (l, b): the Great Rift from Cygnus to Sagittarius, the dark lanes near the
// bulge, and the Coalsack beside the Southern Cross (the Andean "dark constellations" live here)
function dust(l: number, b: number) {
  const L = wrap180(l);
  let d = 0;
  if (L > -40 && L < 70) d += 0.8 * Math.exp(-(((b - 1.5 - 0.02 * L) / 2.2) ** 2)) * (0.5 + 0.5 * fbm(l * 0.15, b * 0.4));
  d += 0.9 * Math.exp(-((wrap180(l - 301.5) ** 2 + (b + 1) ** 2) / (2 * 2.5 ** 2)));
  d += 0.6 * Math.max(0, fbm(l * 0.25 + 40, b * 0.6) - 0.45) * 2;
  return Math.min(1, d);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

// Fades below the horizon, dims near it (extinction), and makes the stars twinkle there. `up` is the local vertical
// in the equatorial frame the splats are stored in.
function skyModifier(time: any, up: any, twinkle: boolean) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }: any) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: 'float', up: 'vec3' },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }: any) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        float up = dot(normalize(${inputs.gsplat}.center), ${inputs.up});
        ${outputs.gsplat}.rgba.a *= smoothstep(-0.005, 0.12, up);
        ${twinkle ? `
        float ph = fract(sin(float(${inputs.gsplat}.index) * 12.9898) * 43758.5453) * 6.2831;
        float tw = 0.82 + 0.18 * sin(${inputs.t} * (2.0 + 3.0 * fract(ph)) + ph);
        ${outputs.gsplat}.rgba.a *= mix(1.0, tw, 1.0 - smoothstep(0.1, 0.8, up));
        ` : ''}
      `),
    });
    return { gsplat: d.apply({ gsplat, t: time, up }).gsplat };
  });
}

export type NightSky = {
  group: THREE.Group;
  setTime: (date: Date) => void;
  update: (seconds: number) => void;
  dispose: () => void;
};

/**
 * `east` and `north` are the compass directions in the metric frame. The sky starts hidden (`group.visible`).
 */
export async function createNightSky(
  site: { lat: number; lng: number },
  compass: { east: THREE.Vector3; north: THREE.Vector3 },
  radius: number,
): Promise<NightSky> {
  const rows: number[][] = await fetch(STARS_URL).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const time = dyno.dynoFloat(0);
  const up = dyno.dynoVec3(new THREE.Vector3(0, 0, 1));

  // Stars: angular size and opacity from magnitude, so the brightest read as points of light
  const stars = new SplatMesh({
    constructSplats: splats => {
      const q = new THREE.Quaternion();
      for (const [ra, dec, mag, bv] of rows) {
        const p = equatorial(ra, dec).multiplyScalar(radius);
        const size = radius * 0.001 * (0.75 + 0.42 * Math.max(0, 6.5 - mag));
        const flux = Math.pow(10, -0.4 * (mag - 1.0));
        const opacity = Math.min(1, 0.22 + 0.9 * Math.sqrt(flux));
        splats.pushSplat(p, new THREE.Vector3(size, size, size), q, opacity, starColor(bv));
      }
    },
  });
  stars.objectModifier = skyModifier(time, up, true);
  stars.updateGenerator();

  // Milky Way: soft splats spread about the galactic plane, a wide bulge towards Sagittarius, and dust
  const rand = mulberry32(7);
  const milkyWay = new SplatMesh({
    constructSplats: splats => {
      const q = new THREE.Quaternion();
      const warm = new THREE.Color(1.0, 0.86, 0.68);
      const cool = new THREE.Color(0.78, 0.85, 1.0);
      for (let i = 0; i < 70000; i++) {
        const l = rand() * 360;
        const L = wrap180(l);
        const bulge = Math.exp(-((L / 28) ** 2));
        const b = gaussian(rand) * (3.2 + 7 * bulge);
        const brightness = (0.32 + 0.68 * Math.exp(-((L / 75) ** 2))) * (0.55 + 0.9 * fbm(l * 0.12, b * 0.35))
          * (1 - 0.92 * dust(l, b));
        if (brightness <= 0.02) continue;
        const p = galacticToEquatorial(l, b).multiplyScalar(radius);
        // Many tiny "unresolved stars" over a few soft glows
        const fine = rand() < 0.55;
        const angle = fine ? (0.022 + 0.035 * rand()) * DEG : (0.5 + 1.2 * rand()) * DEG;
        const size = radius * angle;
        const opacity = fine ? Math.min(1, 0.3 + 0.5 * brightness) * (rand() < 0.5 ? 1 : 0.5) : 0.035 * brightness;
        const color = cool.clone().lerp(warm, 0.25 + 0.6 * bulge).multiplyScalar(fine ? 0.75 : 1);
        splats.pushSplat(p, new THREE.Vector3(size, size, size), q, opacity, color);
      }
    },
  });
  milkyWay.objectModifier = skyModifier(time, up, false);
  milkyWay.updateGenerator();

  group.add(stars, milkyWay);
  group.visible = false;

  // Equatorial -> metric frame at a given moment: rotate by local sidereal time, tilt by latitude, then turn east,
  // north and up into the frame's axes
  const phi = site.lat * DEG;
  const { east, north } = compass;
  const rotation = new THREE.Matrix3();
  return {
    group,
    setTime(date) {
      const jd = date.getTime() / 86400000 + 2440587.5;
      const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
      const lst = ((gmst + site.lng) % 360) * DEG;
      const rz = new THREE.Matrix3().set(Math.cos(lst), Math.sin(lst), 0, -Math.sin(lst), Math.cos(lst), 0, 0, 0, 1);
      const tilt = new THREE.Matrix3().set(0, 1, 0, -Math.sin(phi), 0, Math.cos(phi), Math.cos(phi), 0, Math.sin(phi));
      const axes = new THREE.Matrix3().set(east.x, north.x, 0, east.y, north.y, 1, east.z, north.z, 0);
      rotation.copy(axes).multiply(tilt).multiply(rz);
      group.matrix.setFromMatrix3(rotation);
      group.matrixWorldNeedsUpdate = true;
      // The frame's up (y), in the stars' frame: the rotation's inverse is its transpose
      up.value.set(0, 1, 0).applyMatrix3(rotation.clone().transpose());
      stars.updateVersion();
      milkyWay.updateVersion();
    },
    update(seconds) {
      if (!group.visible) return;
      time.value = seconds;
      stars.updateVersion();
    },
    dispose() {
      group.removeFromParent();
      stars.dispose();
      milkyWay.dispose();
    },
  };
}
