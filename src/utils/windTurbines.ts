import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneTurbines } from '@/types/cesium';

// The model: a generic three-blade turbine, in metres. Each turbine is scaled to its own hub height and rotor
// diameter (windTurbines.json).
const MODEL = {
  hubHeight: 95,
  rotorRadius: 57,
  // Tower radius at the ground and at the top
  towerRadius: [2.2, 1.4],
  // Each turbine turns at its own speed in this range
  rpm: [11, 15],
  // Red band at the blade tips (aviation marking)
  tipBand: 6,
};

// Early-afternoon autumn sun, as in pirca0's photo (13:21 on 6 April 2025): north-northwest and high
const SUN = { bearing: 346, elevation: 53 };

// Far turbines fade into the sky colour of pirca0's photo: by about 8% at 1 km and 37% at 5.6 km
const HAZE = { color: '#cbd9e8', metres: 12000 };
const NIGHT_HAZE = '#06080d';

// The splat's sky near the horizon sits closer than the edge of its ground, where the turbines are drawn, so it
// would paint over them. Turbines are depth-tested as if this far from the camera (viewer units) instead: walls and
// bushes nearer than that still cover them, the sky behind doesn't.
const DEPTH_DISTANCE = 40;

// Red obstruction lights on the nacelles, at night: wind farms flash them together, about 30 times a minute
const LIGHT_PERIOD_SECONDS = 2;

const METRES_PER_DEGREE = 111_320;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

// Compass bearing (degrees) and distance (metres) from one [lat, lng] to another, on a flat local approximation
function bearingAndDistance([lat0, lng0]: number[], [lat, lng]: number[]) {
  const north = (lat - lat0) * METRES_PER_DEGREE;
  const east = (lng - lng0) * METRES_PER_DEGREE * Math.cos(toRadians(lat0));
  return { bearing: (Math.atan2(east, north) * 180) / Math.PI, metres: Math.hypot(east, north) };
}

// Repeatable per-turbine variation (speed, start angle, yaw), so every visit looks the same
const jitter = (index: number, salt: number) => {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const paint = (geometry: THREE.BufferGeometry, colorAt: (y: number) => number[]) => {
  const position = geometry.attributes.position;
  const colors: number[] = [];
  for (let i = 0; i < position.count; i++) colors.push(...colorAt(position.getY(i)));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
};
const WHITE = [1, 1, 1];
const RED = [0.75, 0.06, 0.05];

// The model in two parts, in metres and the scene's orientation (y points down): the body (tower and nacelle) with
// its base at the origin, and the rotor, centred on its hub and facing +z
function buildGeometries() {
  const { hubHeight, rotorRadius, towerRadius, tipBand } = MODEL;
  const tower = new THREE.CylinderGeometry(towerRadius[0], towerRadius[1], hubHeight, 16, 1, true);
  tower.translate(0, -hubHeight / 2, 0);
  const nacelle = new THREE.BoxGeometry(3.6, 3.6, 10);
  nacelle.translate(0, -hubHeight - 1.2, -2.5);

  const hub = new THREE.SphereGeometry(1.9, 16, 12);
  hub.scale(1, 1, 1.5);

  // One blade along -y from the hub: widest (4 m) a fifth of the way out, narrowing to 0.8 m at the tip
  const blade = new THREE.BoxGeometry(1, rotorRadius, 1, 1, 12, 1);
  blade.translate(0, -rotorRadius / 2 - 1.5, 0);
  const position = blade.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const t = Math.min(1, (-position.getY(i) - 1.5) / rotorRadius);
    const chord = t < 0.2 ? 2.5 + 7.5 * t : 4 - (3.2 * (t - 0.2)) / 0.8;
    position.setX(i, position.getX(i) * chord);
    position.setZ(i, position.getZ(i) * (1.6 * (1 - t) + 0.25));
  }
  blade.computeVertexNormals();
  paint(blade, y => (-y > rotorRadius + 1.5 - tipBand ? RED : WHITE));

  for (const geometry of [tower, nacelle, hub]) paint(geometry, () => WHITE);
  const blades = [0, 1, 2].map(i => blade.clone().rotateZ((i * 2 * Math.PI) / 3));
  const parts = { body: mergeGeometries([tower, nacelle]), rotor: mergeGeometries([hub, ...blades]) };
  for (const geometry of [tower, nacelle, hub, blade, ...blades]) geometry.dispose();
  return parts;
}

// Per-instance haze (`instanceHaze`, 0 to 1) toward the `hazeColor` uniform, and a depth as if DEPTH_DISTANCE from
// the camera along the same line of sight
function hazeShader(hazeColor: { value: THREE.Color }) {
  return (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
    shader.uniforms.hazeColor = hazeColor;
    shader.uniforms.depthDistance = { value: DEPTH_DISTANCE };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float instanceHaze;\nvarying float vHaze;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHaze = instanceHaze;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 hazeColor;
varying float vHaze;
uniform mat4 projectionMatrix;
uniform float depthDistance;`)
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, hazeColor, vHaze);
#include <opaque_fragment>`)
      .replace(/}\s*$/, `
  vec4 pulled = projectionMatrix * vec4(-normalize(vViewPosition) * depthDistance, 1.0);
  gl_FragDepth = 0.5 + 0.5 * pulled.z / pulled.w;
}`);
  };
}


export type WindTurbines = {
  /** Turns the rotors and flashes the night lights; call every frame */
  update: (seconds: number) => void;
  setNight: (night: boolean) => void;
  dispose: () => void;
};

/**
 * Draws a site's real wind turbines (positions from OpenStreetMap) into the splat scene's backdrop, with turning
 * rotors, as two instanced meshes. Each turbine sits at its true compass direction from the site, `config.distance`
 * units out, scaled so it looks as big as the real one does from the site. `heading` is the site's (landmarks.json):
 * north is (sin h, 0, cos h) in the viewer's frame. Added to `parent`, which holds the scene in the viewer's frame.
 */
export function addWindTurbines(parent: THREE.Object3D, config: SceneTurbines, heading: number): WindTurbines {
  const group = new THREE.Group();
  group.name = 'wind-turbines';

  // A compass bearing as a horizontal direction in the viewer's frame
  const h = toRadians(heading);
  const direction = (bearing: number, elevation = 0) => {
    const b = toRadians(bearing);
    const level = Math.cos(toRadians(elevation));
    return new THREE.Vector3(Math.sin(b + h) * level, -Math.sin(toRadians(elevation)), Math.cos(b + h) * level);
  };

  const sun = new THREE.DirectionalLight('#fff6e8', 2.4);
  sun.position.copy(direction(SUN.bearing, SUN.elevation));
  // y points down, so the sky side of the hemisphere light is -y
  const skyLight = new THREE.HemisphereLight('#e6eef8', '#b9a98f', 1.9);
  skyLight.position.set(0, -1, 0);
  group.add(sun, skyLight);

  // Where each turbine stands, and its size (viewer units per model metre)
  const placed = config.turbines.map(([lat, lng, hub, rotor]) => {
    const { bearing, metres } = bearingAndDistance(config.origin, [lat, lng]);
    const hubScale = hub / MODEL.hubHeight;
    const base = direction(bearing, config.baseElevation)
      .multiplyScalar(config.distance / Math.cos(toRadians(config.baseElevation)));
    return { base, scale: (config.distance / metres) * hubScale, rotorScale: rotor / 2 / MODEL.rotorRadius / hubScale, metres };
  });

  const geometries = buildGeometries();
  const haze = new Float32Array(placed.length);
  placed.forEach(({ metres }, index) => {
    haze[index] = 1 - Math.exp(-metres / HAZE.metres);
  });
  for (const geometry of Object.values(geometries)) {
    geometry.setAttribute('instanceHaze', new THREE.InstancedBufferAttribute(haze, 1));
  }
  const dayHaze = new THREE.Color(HAZE.color);
  const hazeColor = { value: dayHaze.clone() };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = hazeShader(hazeColor);
  material.customProgramCacheKey = () => 'wind-turbine';

  const bodies = new THREE.InstancedMesh(geometries.body, material, placed.length);
  const rotors = new THREE.InstancedMesh(geometries.rotor, material, placed.length);
  // The rotors face the wind (which blows from windFrom), so their front (+z) points that way
  const windward = direction(config.windFrom);
  const yaw = Math.atan2(windward.x, windward.z);
  const matrix = new THREE.Matrix4();
  const turbineMatrices: THREE.Matrix4[] = [];
  const rotorOffset = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  placed.forEach(({ base, scale }, index) => {
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + toRadians((jitter(index, 1) - 0.5) * 8));
    const turbineMatrix = new THREE.Matrix4().compose(base, quaternion, new THREE.Vector3(scale, scale, scale));
    turbineMatrices.push(turbineMatrix);
    bodies.setMatrixAt(index, turbineMatrix);
  });

  const speeds = placed.map((_, index) => {
    const [minRpm, maxRpm] = MODEL.rpm;
    // Clockwise seen from the front, as real turbines turn
    return -((minRpm + (maxRpm - minRpm) * jitter(index, 2)) * 2 * Math.PI) / 60;
  });
  const rotation = new THREE.Matrix4();
  const rotorScaling = new THREE.Matrix4();
  const turn = (seconds: number) => {
    placed.forEach(({ rotorScale }, index) => {
      rotorOffset.makeTranslation(0, -MODEL.hubHeight - 1.2, 4.2);
      rotation.makeRotationZ(jitter(index, 3) * 2 * Math.PI + speeds[index] * seconds);
      rotorScaling.makeScale(rotorScale, rotorScale, rotorScale);
      matrix.copy(turbineMatrices[index]).multiply(rotorOffset).multiply(rotation).multiply(rotorScaling);
      rotors.setMatrixAt(index, matrix);
    });
    rotors.instanceMatrix.needsUpdate = true;
  };
  turn(0);
  bodies.computeBoundingSphere();
  rotors.computeBoundingSphere();
  group.add(bodies, rotors);

  // Night lights: one point on each nacelle, a few pixels across at any distance
  const lightPositions = new Float32Array(placed.length * 3);
  placed.forEach(({ base, scale }, index) => {
    lightPositions.set([base.x, base.y - (MODEL.hubHeight + 3.4) * scale, base.z], index * 3);
  });
  const lightGeometry = new THREE.BufferGeometry();
  lightGeometry.setAttribute('position', new THREE.BufferAttribute(lightPositions, 3));
  const lightMaterial = new THREE.PointsMaterial({ color: '#ff2a1a', size: 3, sizeAttenuation: false });
  const lights = new THREE.Points(lightGeometry, lightMaterial);
  lights.visible = false;
  lights.frustumCulled = false;
  group.add(lights);

  parent.add(group);

  // Visitors who ask for reduced motion get still rotors and steady lights
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let night = false;

  return {
    update(seconds) {
      if (!still) turn(seconds);
      if (night) lights.visible = still || seconds % LIGHT_PERIOD_SECONDS < LIGHT_PERIOD_SECONDS / 2;
    },
    setNight(value) {
      night = value;
      lights.visible = value;
      sun.intensity = value ? 0 : 2.4;
      skyLight.intensity = value ? 0.035 : 1.9;
      hazeColor.value.copy(value ? new THREE.Color(NIGHT_HAZE) : dayHaze);
    },
    dispose() {
      group.removeFromParent();
      Object.values(geometries).forEach(geometry => geometry.dispose());
      lightGeometry.dispose();
      material.dispose();
      lightMaterial.dispose();
      bodies.dispose();
      rotors.dispose();
    },
  };
}
