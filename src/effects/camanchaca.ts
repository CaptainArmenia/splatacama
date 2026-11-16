/**
 * Camanchaca: the coastal fog bank of the Atacama, as a few thousand large, faint splats drifting inland on the
 * wind. They are sorted together with the scene's splats, so the fog passes between the walls. The terrain beyond
 * fades into the same grey (see sceneEffects.ts).
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts).
 */
import * as THREE from 'three';
import { SplatMesh, dyno } from '@sparkjsdev/spark';

const WIND_SPEED = 0.9; // metres per second

// How a fog looks: the square it wraps around in (metres: the site and a margin), how many splats, their opacity,
// how high they reach above the ground and how big they come (metres), and whether it gathers in patches that drift
// with the wind (thinning to nothing between them) or lies evenly
export type FogLook = { size: number; splats: number; opacity: number; height: number; scale: [number, number]; patchy: boolean };
// The Camanchaca effect: a bank you look into
export const FOG_BANK: FogLook = { size: 60, splats: 6000, opacity: 0.6, height: 3.2, scale: [0.9, 2.6], patchy: false };
// The Bruma costera setting: a much lighter camanchaca, wisps passing in irregular patches over a wider square
export const FOG_WISPS: FogLook = { size: 140, splats: 3500, opacity: 0.5, height: 5, scale: [2, 5.5], patchy: true };

export type Camanchaca = {
  mesh: SplatMesh;
  /** Drifts the fog; `camera` is the camera's position in the metric frame */
  update: (seconds: number, camera: THREE.Vector3) => void;
  dispose: () => void;
};

/** `groundY` is the ground's height at the site centre; the fog starts hidden (`mesh.visible`) */
export function createCamanchaca(groundY: number, compass: { east: THREE.Vector3; north: THREE.Vector3 },
  look: FogLook = FOG_BANK): Camanchaca {
  const SIZE = look.size;
  const time = dyno.dynoFloat(0);
  const cameraPosition = dyno.dynoVec3(new THREE.Vector3());
  // The camanchaca comes in from the Pacific, to the west: the wind blows east, a little north
  const { east, north } = compass;
  const wind = dyno.dynoVec3(new THREE.Vector3()
    .addScaledVector(east, 0.9).addScaledVector(north, 0.25).setY(0).multiplyScalar(WIND_SPEED));

  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mesh = new SplatMesh({
    constructSplats: splats => {
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < look.splats; i++) {
        const x = (rand() - 0.5) * SIZE;
        const z = (rand() - 0.5) * SIZE;
        // Denser near the ground
        const y = groundY - 0.3 + Math.pow(rand(), 1.6) * look.height;
        const s = look.scale[0] + rand() * (look.scale[1] - look.scale[0]);
        q.setFromAxisAngle(axis, rand() * Math.PI);
        const shade = 0.86 + rand() * 0.1;
        splats.pushSplat(new THREE.Vector3(x, y, z), new THREE.Vector3(s, s * 0.45, s * 0.8), q, 0.03 + rand() * 0.045,
          new THREE.Color(shade, shade + 0.01, shade + 0.03));
      }
    },
  });

  mesh.objectModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }: any) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: 'float', wind: 'vec3', cam: 'vec3' },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [dyno.unindent(`
        float fogHash(vec2 i) { return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453); }
        float fogNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
          return mix(mix(fogHash(i), fogHash(i + vec2(1.0, 0.0)), u.x), mix(fogHash(i + vec2(0.0, 1.0)), fogHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }`)],
      statements: ({ inputs, outputs }: any) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        float size = ${SIZE.toFixed(1)};
        float ph = fract(sin(float(${inputs.gsplat}.index) * 78.233) * 43758.5453) * 6.2831;
        vec3 p = ${inputs.gsplat}.center + ${inputs.wind} * ${inputs.t} * (0.8 + 0.4 * fract(ph));
        p.xz = mod(p.xz + 0.5 * size, size) - 0.5 * size;
        p.y += 0.25 * sin(${inputs.t} * 0.23 + ph);
        p.x += 0.6 * sin(${inputs.t} * 0.11 + ph * 1.7);
        // Fade out towards the edges of the square, so the wrap-around doesn't pop
        float edge = 1.0 - smoothstep(0.32 * size, 0.5 * size, max(abs(p.x), abs(p.z)));
        // Thin out the fog right around the camera, so it reads as a bank you look into, not a white wall
        float near = smoothstep(1.5, 7.0, distance(p, ${inputs.cam}));
        ${look.patchy ? `// Patches drifting with the wind (slower than the wisps) and slowly changing shape
        vec2 drift = (p.xz - ${inputs.wind}.xz * ${inputs.t} * 0.4) / 28.0;
        float fogPatch = smoothstep(0.38, 0.75, 0.65 * fogNoise(drift + ${inputs.t} * 0.004) + 0.35 * fogNoise(drift * 2.7 + 5.0));` : 'float fogPatch = 1.0;'}
        ${outputs.gsplat}.center = p;
        ${outputs.gsplat}.rgba.a *= ${look.opacity.toFixed(2)} * edge * near * fogPatch;
      `),
    });
    return { gsplat: d.apply({ gsplat, t: time, wind, cam: cameraPosition }).gsplat };
  });
  mesh.updateGenerator();
  mesh.visible = false;

  return {
    mesh,
    update(seconds, camera) {
      if (!mesh.visible) return;
      time.value = seconds;
      cameraPosition.value.copy(camera);
      mesh.updateVersion();
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
    },
  };
}
