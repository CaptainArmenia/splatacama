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
  // Nacelle width, height and length; the rotor's centre is this far above the tower top and in front of its axis
  nacelle: [4.2, 4.4, 12],
  hubAbove: 1.8,
  hubAhead: 4.6,
  // The rotor's axis tilts up and the blades lean into the wind (degrees), as on real turbines: seen side-on, the
  // rotor isn't quite upright
  tilt: 5,
  cone: 2.5,
  // Blade pitch (degrees): in strong wind the blades turn out of the rotor's plane to shed power. This much matches
  // how wide they look side-on in pirca0's photo.
  pitch: 20,
  // Each turbine turns at its own speed in this range
  rpm: [11, 15],
  // Aviation marking, as in pirca0's photo: red, white and red bands this long from each blade tip inward
  tipBand: 6,
};

// The blade's shape from root to tip, at these distances from the rotor's centre (metres; the band edges are among
// them): [distance, chord, thickness as a share of the chord, twist in degrees]. Round where it leaves the hub,
// widest about a fifth of the way out, then tapering and flattening; the twist turns the inner part more into the
// wind. Seen from the side, as from pirca0, the blades are thin slivers.
const BLADE = [
  [1.6, 2.4, 1, 0],
  [2.8, 2.4, 1, 0],
  [4.5, 2.7, 0.8, 6],
  [7, 3.4, 0.55, 12],
  [10, 3.9, 0.42, 14],
  [13, 4, 0.36, 13],
  [17, 3.7, 0.3, 11],
  [22, 3.3, 0.25, 9],
  [28, 2.8, 0.21, 7],
  [33, 2.4, 0.19, 5],
  [39, 1.95, 0.17, 3.5],
  [45, 1.5, 0.16, 2],
  [48, 1.3, 0.15, 1.5],
  [51, 1.1, 0.15, 1],
  [54, 0.85, 0.15, 0.5],
  [57, 0.5, 0.15, 0],
];
const BLADE_SIDES = 10;

// Early-afternoon autumn sun, as in pirca0's photo (13:21 on 6 April 2025): north-northwest and high. The light is
// matched to the towers there: near white on the sunny side, a cool blue-grey in the shade (little warm bounce from
// the ground). At night only a trace of sky light is left.
const SUN = { bearing: 346, elevation: 53, color: '#fffaf2', intensity: 4 };
const SKY_LIGHT = { sky: '#c8def8', ground: '#8a857d', intensity: 2.2, night: 0.035 };

// Far turbines fade into the sky colour of pirca0's photo: by about 8% at 1 km and 37% at 5.6 km. On a terrain they
// fade like it instead: into the scene's background colour, over env_build.py's 8 km.
const HAZE = { color: '#cbd9e8', metres: 12000 };
const TERRAIN_HAZE_METRES = 8000;
const NIGHT_HAZE = '#06080d';

// Without a terrain, the turbines are a backdrop on a full splat's horizon. Its sky near the horizon sits closer than
// the edge of its ground, where the turbines are drawn, so it would paint over them. Backdrop turbines are
// depth-tested as if this far from the camera (viewer units) instead: walls and bushes nearer than that still cover
// them, the sky behind doesn't. (A scene with a terrain has its splat cropped, sky and all; there the turbines stand
// on the terrain at their real distances and keep their real depth, so its hills hide them.)
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

const WHITE = [1, 1, 1];
const RED = [0.75, 0.06, 0.05];

// Far away, the blades and towers are thinner than a pixel and would break up into dots. Each vertex of those parts
// carries its cross-section, so the shader can widen them to MIN_PIXELS and blend them into the sky as much as they
// fall short: `axisPoint`, the point on the part's centre line level with the vertex; `axisAlong`, the line's
// direction; and `halfChord` and `halfThick`, the cross-section's half axes. The other parts have zeros there.
const CROSS_SECTION = ['axisPoint', 'axisAlong', 'halfChord', 'halfThick'];
const MIN_PIXELS = 1.5;

// Without texture coordinates, with cross-section attributes and painted white where not painted yet, so the parts
// merge. Parts keep their shared vertices: a site can have hundreds of turbines in view, all drawn every frame.
const prepare = (geometry: THREE.BufferGeometry) => {
  geometry.deleteAttribute('uv');
  const count = geometry.attributes.position.count;
  for (const name of CROSS_SECTION) {
    if (!geometry.attributes[name]) geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  }
  if (!geometry.attributes.color) {
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set(WHITE, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  return geometry;
};

// Turns a part and its cross-section attributes
const rotatePart = (geometry: THREE.BufferGeometry, rotation: THREE.Matrix4) => {
  geometry.applyMatrix4(rotation);
  geometry.attributes.axisPoint.applyMatrix4(rotation);
  const turn = new THREE.Matrix3().setFromMatrix4(rotation);
  for (const name of ['axisAlong', 'halfChord', 'halfThick']) (geometry.attributes[name] as THREE.BufferAttribute).applyMatrix3(turn);
  return geometry;
};

// One blade along -y from the rotor's centre, from the BLADE table: a ring of BLADE_SIDES points at each distance,
// an airfoil-like oval (round leading edge at -x, the side it moves toward; sharp trailing edge), turned by its twist
// and the pitch. Painted in bands: each segment by how far its middle is from the tip, red, white, red, then white to
// the root. Where the colour changes, the ring is doubled, one for each colour, so the bands have sharp edges.
function bladeGeometry() {
  const { rotorRadius, tipBand } = MODEL;
  const segmentColor = BLADE.slice(1).map(([r], s) => {
    const band = Math.floor((rotorRadius - (BLADE[s][0] + r) / 2) / tipBand);
    return band === 0 || band === 2 ? RED : WHITE;
  });
  const positions: number[] = [];
  const colors: number[] = [];
  const section: Record<string, number[]> = { axisPoint: [], axisAlong: [], halfChord: [], halfThick: [] };
  // Each station's rings: the one its lower segment uses, and the one its upper segment uses
  const ringsAt: number[][] = [];
  let rings = 0;
  BLADE.forEach(([r, chord, thickness, twist], station) => {
    const below = segmentColor[station - 1];
    const above = segmentColor[station];
    const ringColors = below && above && below !== above ? [below, above] : [below ?? above];
    ringsAt.push([rings, rings + ringColors.length - 1]);
    rings += ringColors.length;
    // A round root stays centred; further out the blade turns about a line a third of the way back from its leading edge
    const flatness = (1 - thickness) / (1 - BLADE[BLADE.length - 1][2]);
    const shift = 0.2 * flatness;
    const angle = toRadians(twist + MODEL.pitch);
    // Turning the leading edge (-x) toward the wind (+z)
    const twisted = (x: number, z: number) => [x * Math.cos(angle) + z * Math.sin(angle), -x * Math.sin(angle) + z * Math.cos(angle)];
    const [chordX, chordZ] = twisted(chord / 2, 0);
    const [thickX, thickZ] = twisted(0, (chord * thickness) / 2);
    for (const color of ringColors) {
      for (let j = 0; j < BLADE_SIDES; j++) {
        const a = (j / BLADE_SIDES) * 2 * Math.PI;
        const x = chord * (shift + 0.5 * Math.cos(a));
        const taper = Math.cos(a) > 0 ? 1 - 0.75 * flatness * Math.cos(a) ** 2 : 1;
        const [px, pz] = twisted(x, ((chord * thickness) / 2) * Math.sin(a) * taper);
        positions.push(px, -r, pz);
        colors.push(...color);
        section.axisPoint.push(0, -r, 0);
        section.axisAlong.push(0, -1, 0);
        section.halfChord.push(chordX, 0, chordZ);
        section.halfThick.push(thickX, 0, thickZ);
      }
    }
  });
  const index: number[] = [];
  for (let s = 0; s < BLADE.length - 1; s++) {
    const lower = ringsAt[s][1] * BLADE_SIDES;
    const upper = ringsAt[s + 1][0] * BLADE_SIDES;
    for (let j = 0; j < BLADE_SIDES; j++) {
      const a = lower + j;
      const b = upper + j;
      const c = lower + ((j + 1) % BLADE_SIDES);
      const d = upper + ((j + 1) % BLADE_SIDES);
      index.push(a, c, b, c, d, b);
    }
  }
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  blade.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  for (const name of CROSS_SECTION) blade.setAttribute(name, new THREE.Float32BufferAttribute(section[name], 3));
  blade.setIndex(index);
  blade.computeVertexNormals();
  // Leaning into the wind: the tip moves toward +z
  return rotatePart(blade, new THREE.Matrix4().makeRotationX(-toRadians(MODEL.cone)));
}

// The model in two parts, in metres and the scene's orientation (y points down): the body (tower and nacelle) with
// its base at the origin, and the rotor, centred on its hub and facing +z
function buildGeometries() {
  const { hubHeight, towerRadius, nacelle: [width, height, length], hubAbove } = MODEL;
  const tower = prepare(new THREE.CylinderGeometry(towerRadius[0], towerRadius[1], hubHeight, 20, 1, true)
    .translate(0, -hubHeight / 2, 0));
  const { position, axisPoint, axisAlong, halfChord, halfThick } = tower.attributes;
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getZ(i));
    axisPoint.setXYZ(i, 0, position.getY(i), 0);
    axisAlong.setXYZ(i, 0, -1, 0);
    halfChord.setXYZ(i, radius, 0, 0);
    halfThick.setXYZ(i, 0, 0, radius);
  }
  // The nacelle's front is just behind the hub
  const nacelle = new THREE.BoxGeometry(width, height, length);
  nacelle.translate(0, -hubHeight - hubAbove, MODEL.hubAhead - 1.2 - length / 2);

  // The hub's nose cone, from its back (z = -1.8) to its tip
  const cone = [[2.1, -1.8], [2.1, 0.4], [1.9, 1.6], [1.4, 2.7], [0.7, 3.4], [0, 3.7]]
    .map(([radius, z]) => new THREE.Vector2(radius, z));
  const hub = new THREE.LatheGeometry(cone, 16).rotateX(Math.PI / 2);

  const blade = bladeGeometry();
  const body = [tower, prepare(nacelle)];
  const rotor = [
    prepare(hub),
    ...[0, 1, 2].map(i => rotatePart(blade.clone(), new THREE.Matrix4().makeRotationZ((i * 2 * Math.PI) / 3))),
  ];
  const parts = { body: mergeGeometries(body), rotor: mergeGeometries(rotor) };
  for (const geometry of [blade, ...body, ...rotor]) geometry.dispose();
  return parts;
}

// What the turbines' material adds to three.js's: thin parts widened to MIN_PIXELS on screen (see CROSS_SECTION) and
// blended into the sky behind them (`skyColors`, at 0, 4 and 8 degrees above their bases) as much as they fall short;
// per-instance haze (`instanceHaze`, 0 to 1) toward `hazeColor`; and for a backdrop, a depth as if DEPTH_DISTANCE from
// the camera along the same line of sight. `instanceBase` is where each turbine stands.
function turbineShader(uniforms: Record<string, { value: unknown }>, backdrop: boolean) {
  return (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.depthDistance = { value: DEPTH_DISTANCE };
    shader.uniforms.minPixels = { value: MIN_PIXELS };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float instanceHaze;
attribute vec3 instanceBase;
attribute vec3 axisPoint;
attribute vec3 axisAlong;
attribute vec3 halfChord;
attribute vec3 halfThick;
uniform float viewportHeight;
uniform float minPixels;
varying float vHaze;
varying float vCoverage;
varying float vElevation;
// A view-space vector at the view-space point p as it shows on screen, in tangents of the view angle
vec2 onScreen(vec3 v, vec3 p) { return (v.xy * -p.z + p.xy * v.z) / (p.z * p.z); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vHaze = instanceHaze;
// Degrees above the turbine's base (y points down)
vElevation = degrees((instanceBase.y - (instanceMatrix * vec4(transformed, 1.0)).y) / length(instanceBase.xz));`)
      .replace('#include <project_vertex>', `mat4 toView = modelViewMatrix * instanceMatrix;
vec4 mvPosition = toView * vec4(axisPoint, 1.0);
vec3 offset = (toView * vec4(transformed - axisPoint, 0.0)).xyz;
vCoverage = 1.0;
if (dot(halfChord, halfChord) > 0.0) {
  // The cross-section's width on screen, across the centre line, in pixels
  vec2 along = onScreen((toView * vec4(axisAlong, 0.0)).xyz, mvPosition.xyz);
  vec2 across = dot(along, along) > 0.0 ? normalize(vec2(-along.y, along.x)) : vec2(1.0, 0.0);
  float chordPart = dot(onScreen((toView * vec4(halfChord, 0.0)).xyz, mvPosition.xyz), across);
  float thickPart = dot(onScreen((toView * vec4(halfThick, 0.0)).xyz, mvPosition.xyz), across);
  float pixels = sqrt(chordPart * chordPart + thickPart * thickPart) * projectionMatrix[1][1] * viewportHeight;
  if (pixels < minPixels) {
    offset *= minPixels / max(pixels, 1e-4);
    vCoverage = pixels / minPixels;
  }
}
mvPosition.xyz += offset;
gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 hazeColor;
uniform vec3 skyColors[3];
varying float vHaze;
varying float vCoverage;
varying float vElevation;
uniform mat4 projectionMatrix;
uniform float depthDistance;`)
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, hazeColor, vHaze);
vec3 sky = mix(mix(skyColors[0], skyColors[1], clamp(vElevation / 4.0, 0.0, 1.0)), skyColors[2], clamp(vElevation / 4.0 - 1.0, 0.0, 1.0));
outgoingLight = mix(sky, outgoingLight, vCoverage);
#include <opaque_fragment>`);
    if (backdrop) {
      shader.fragmentShader = shader.fragmentShader.replace(/}\s*$/, `
  vec4 pulled = projectionMatrix * vec4(-normalize(vViewPosition) * depthDistance, 1.0);
  gl_FragDepth = 0.5 + 0.5 * pulled.z / pulled.w;
}`);
    }
  };
}


export type WindTurbines = {
  /** Turns the rotors and flashes the night lights; call every frame */
  update: (seconds: number) => void;
  /** At night the turbines go dark and their lights flash. `plainSky` is the colour behind them when the scene's sky
   * is hidden (at night and in fog), or null for the splat's own (SceneTurbines.sky). */
  setConditions: (night: boolean, plainSky: THREE.Color | null) => void;
  /** Where each turbine's sound comes from (its hub, in `parent`'s frame), how far away the real one is, and how often
   * a blade passes the tower; empty when the rotors are still (reduced motion) */
  voices: TurbineVoice[];
  dispose: () => void;
};

export type TurbineVoice = { position: THREE.Vector3; metres: number; bladePassHz: number };

/**
 * Draws a site's real wind turbines (positions from OpenStreetMap) with turning rotors, as two instanced meshes. Each
 * turbine sits at its true compass direction from the site, at the distance and base elevation in its entry, scaled so
 * it looks as big as the real one does from the site. With `terrain` (the scene's terrain mesh, whose haze colour is
 * the scene's background), that's on the terrain at its real distance; without, a backdrop on the splat's horizon (see
 * DEPTH_DISTANCE). `heading` is the site's (landmarks.json): north is (sin h, 0, cos h) in the viewer's frame. Added
 * to `parent`, which holds the scene in the viewer's frame.
 */
export function addWindTurbines(
  parent: THREE.Object3D,
  config: SceneTurbines,
  heading: number,
  terrain: { haze: THREE.Color } | null,
): WindTurbines {
  const group = new THREE.Group();
  group.name = 'wind-turbines';

  // A compass bearing as a horizontal direction in the viewer's frame
  const h = toRadians(heading);
  const direction = (bearing: number, elevation = 0) => {
    const b = toRadians(bearing);
    const level = Math.cos(toRadians(elevation));
    return new THREE.Vector3(Math.sin(b + h) * level, -Math.sin(toRadians(elevation)), Math.cos(b + h) * level);
  };

  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.position.copy(direction(SUN.bearing, SUN.elevation));
  // y points down, so the sky side of the hemisphere light is -y
  const skyLight = new THREE.HemisphereLight(SKY_LIGHT.sky, SKY_LIGHT.ground, SKY_LIGHT.intensity);
  skyLight.position.set(0, -1, 0);
  group.add(sun, skyLight);

  // Where each turbine stands, and its size (viewer units per model metre)
  const placed = config.turbines.map(([lat, lng, hub, rotor, distance, baseElevation]) => {
    const { bearing, metres } = bearingAndDistance(config.origin, [lat, lng]);
    const hubScale = hub / MODEL.hubHeight;
    const base = direction(bearing, baseElevation).multiplyScalar(distance / Math.cos(toRadians(baseElevation)));
    return { base, scale: (distance / metres) * hubScale, rotorScale: rotor / 2 / MODEL.rotorRadius / hubScale, metres };
  });

  const geometries = buildGeometries();
  const haze = new Float32Array(placed.length);
  const bases = new Float32Array(placed.length * 3);
  placed.forEach(({ metres, base }, index) => {
    haze[index] = 1 - Math.exp(-metres / (terrain ? TERRAIN_HAZE_METRES : HAZE.metres));
    base.toArray(bases, index * 3);
  });
  for (const geometry of Object.values(geometries)) {
    geometry.setAttribute('instanceHaze', new THREE.InstancedBufferAttribute(haze, 1));
    geometry.setAttribute('instanceBase', new THREE.InstancedBufferAttribute(bases, 3));
  }
  const dayHaze = terrain ? terrain.haze.clone() : new THREE.Color(HAZE.color);
  const daySky = config.sky.map(color => new THREE.Color(color));
  const uniforms = {
    hazeColor: { value: dayHaze.clone() },
    skyColors: { value: daySky.map(color => color.clone()) },
    viewportHeight: { value: 1 },
  };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = turbineShader(uniforms, !terrain);
  material.customProgramCacheKey = () => (terrain ? 'wind-turbine' : 'wind-turbine-backdrop');

  const bodies = new THREE.InstancedMesh(geometries.body, material, placed.length);
  const rotors = new THREE.InstancedMesh(geometries.rotor, material, placed.length);
  // The widening needs the size of the image being drawn: the canvas, or one eye's in VR
  const viewport = new THREE.Vector4();
  bodies.onBeforeRender = (renderer) => {
    uniforms.viewportHeight.value = renderer.getCurrentViewport(viewport).w;
  };
  rotors.onBeforeRender = bodies.onBeforeRender;
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
  // The rotor's centre, its axis tilted up (y points down, so a positive turn about x lifts +z)
  rotorOffset.makeTranslation(0, -MODEL.hubHeight - MODEL.hubAbove, MODEL.hubAhead)
    .multiply(new THREE.Matrix4().makeRotationX(toRadians(MODEL.tilt)));
  const turn = (seconds: number) => {
    placed.forEach(({ rotorScale }, index) => {
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
    lightPositions.set([base.x, base.y - (MODEL.hubHeight + MODEL.hubAbove + MODEL.nacelle[1] / 2) * scale, base.z], index * 3);
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

  const voices = still ? [] : placed.map(({ base, scale, metres }, index) => ({
    position: base.clone().setY(base.y - (MODEL.hubHeight + MODEL.hubAbove) * scale),
    metres,
    // Three blades a turn
    bladePassHz: (3 * Math.abs(speeds[index])) / (2 * Math.PI),
  }));

  return {
    voices,
    update(seconds) {
      if (!still) turn(seconds);
      if (night) lights.visible = still || seconds % LIGHT_PERIOD_SECONDS < LIGHT_PERIOD_SECONDS / 2;
    },
    setConditions(value, plainSky) {
      night = value;
      lights.visible = value;
      sun.intensity = value ? 0 : SUN.intensity;
      skyLight.intensity = value ? SKY_LIGHT.night : SKY_LIGHT.intensity;
      uniforms.hazeColor.value.copy(value ? new THREE.Color(NIGHT_HAZE) : dayHaze);
      uniforms.skyColors.value.forEach((color, index) => color.copy(plainSky ?? daySky[index]));
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
