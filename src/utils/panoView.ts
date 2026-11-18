import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ScenePano } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';

/**
 * The site's 360 degree photo, to compare with the reconstruction from the very point it was taken at.
 *
 * The drone took one panorama at the site. The splat pipeline registers it in the site's reconstruction
 * (tools/pano_register.py: where it was taken and how it is turned), so here the camera is put at that point and the
 * photo is drawn on a sphere around it, turned as registered: every stone in the photo then lies over the same stone
 * of the scene, and switching between the two shows what the reconstruction keeps and loses.
 *
 * Three views from that point:
 * - 'photo': the photo itself. The camera only turns and zooms, since a photo has no other viewpoint.
 * - 'relief': the photo with depth. A depth model (Depth Any Panoramas) estimated how far every pixel is, and the
 *   pipeline scaled that to the reconstruction's metres (tools/pano_depth_fit.py). The photo is drawn on a mesh with
 *   each pixel at its distance, so the camera can move a little and near things slide over far ones. It is one photo
 *   pushed into shape, not a reconstruction: what the photo didn't see (behind a wall, under an overhang) is the
 *   photo's nearest colours stretched across the gap, which is why the camera stays within `depth.reach`.
 * - 'scene': the reconstruction, which the camera can move in the same way.
 *
 * The photo and the relief are drawn in a pass of their own after the scene's (meshes, then splats), so they cover
 * both and the photo can fade over them; while they cover everything the scene isn't drawn at all.
 */

export type PanoMode = 'photo' | 'relief' | 'scene';

export type PanoView = {
  /** The camera is at the photo's viewpoint (or on its way): the viewer's own controls are off */
  readonly active: boolean;
  /** The photo or its relief covers the whole frame, so the scene needn't be drawn */
  readonly covers: boolean;
  /** Goes to the viewpoint if the camera isn't there and shows that view; resolves when what it needs is loaded */
  show: (mode: PanoMode) => Promise<void>;
  /** The relief in colours by distance (red near, blue far) instead of the photo's */
  setDepthColours: (on: boolean) => void;
  /** Back to where the camera was */
  exit: () => void;
  /** Every frame while active, instead of the orbit controls' update */
  update: (deltaSeconds: number) => void;
  /** Draws the photo or the relief over the frame (or alone, when it covers it) */
  render: () => void;
  dispose: () => void;
};

const FLY_SECONDS = 1.1;
const FADE_SECONDS = 0.35;
const DEFAULT_FOV = 50;
const MIN_FOV = 15;
const MAX_FOV = 85;
const MAX_PITCH = THREE.MathUtils.degToRad(88);
// A viewpoint nearer than this to the site's centre (viewer units, on the ground) has no side to look at it from:
// the view keeps the camera's heading
const OVERHEAD_RADIUS = 1.5;
// Where the relief's sky and its farthest land are put (metres): far enough not to move as the camera does
const SKY_DISTANCE = 9000;
// How far the camera may move in the scene from a viewpoint without a depth map (metres)
const DEFAULT_REACH = 2;
// Moving with the keys covers the reach in this many seconds; the camera eases to where it is sent
const KEY_SECONDS = 1.6;
const MOVE_EASE = 10;
// On opening the relief the camera makes one slow loop by itself, so the depth shows before anything is touched
const SWAY_SECONDS = 5;
const SWAY_SIZE = 0.3;

const SPHERE_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// The photo is equirectangular; its frame is a camera's looking at the image centre (x right, y up, z back). The
// lookup is per pixel, so the sphere's triangles don't bend it. The longitude jumps at the image's left and right
// edge, which would make the texture's level of detail jump there too (a visible seam): the gradients are taken from
// whichever of two longitudes, half a turn apart, is continuous at this pixel.
const SPHERE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float opacity;
  varying vec3 vDirection;
  void main() {
    vec3 d = normalize(vDirection);
    float u = atan(d.x, -d.z) / 6.28318530718 + 0.5;
    float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359;
    float uShifted = fract(u + 0.5) - 0.5;
    bool shifted = abs(dFdx(u)) + abs(dFdy(u)) > abs(dFdx(uShifted)) + abs(dFdy(uShifted));
    vec2 gradX = vec2(shifted ? dFdx(uShifted) : dFdx(u), dFdx(v));
    vec2 gradY = vec2(shifted ? dFdy(uShifted) : dFdy(u), dFdy(v));
    gl_FragColor = vec4(textureGrad(map, vec2(u, v), gradX, gradY).rgb, opacity);
    #include <colorspace_fragment>
  }`;

// The relief: the photo's pixels, each at its distance. Its vertices carry their place in the photo.
const RELIEF_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying float vDistance;
  void main() {
    vUv = uv;
    vDistance = length(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const RELIEF_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float depthColours;
  uniform float metersPerUnit;
  uniform float skyDistance;
  varying vec2 vUv;
  varying float vDistance;

  // Google's Turbo colour map (the polynomial fit by Anton Mikhailov)
  vec3 turbo(float t) {
    const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kR2 = vec2(-152.94239396, 59.28637943);
    const vec2 kG2 = vec2(4.27729857, 2.82956604);
    const vec2 kB2 = vec2(-89.90310912, 27.34824973);
    t = clamp(t, 0.0, 1.0);
    vec4 v4 = vec4(1.0, t, t * t, t * t * t);
    vec2 v2 = v4.zw * v4.z;
    return clamp(vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), 0.0, 1.0);
  }

  void main() {
    vec3 color = texture2D(map, vUv).rgb;
    if (depthColours > 0.0) {
      // Red at 1 m to blue at 1 km, evenly by ratio; the sky stays pale. The photo's light and dark show through,
      // so the stones can still be told apart.
      float metres = vDistance * metersPerUnit;
      vec3 byDistance = vDistance > skyDistance * 0.98
        ? vec3(0.9)
        : turbo(1.0 - log(max(metres, 1.0)) / log(1000.0));
      float light = sqrt(dot(color, vec3(0.2126, 0.7152, 0.0722)));
      byDistance = pow(byDistance * (0.5 + 0.7 * light), vec3(2.2));
      color = mix(color, byDistance, depthColours);
    }
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }`;

const easeInOut = (t: number) => t * t * (3 - 2 * t);

// Reads the pipeline's depth image: 16 bits a pixel in the red and green bytes, the distance on a log scale
async function loadDepth(url: string, near: number, far: number) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar la profundidad de la foto (HTTP ${response.status})`);
  // The bytes as they are in the file: no colour conversion, which would change the distances
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No se pudo leer la profundidad de la foto');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const metres = new Float32Array(canvas.width * canvas.height);
  const ratio = Math.log(far / near);
  for (let i = 0; i < metres.length; i++) {
    const code = pixels[i * 4] * 256 + pixels[i * 4 + 1];
    metres[i] = code === 65535 ? Infinity : near * Math.exp((code / 65535) * ratio);
  }
  return { width: canvas.width, height: canvas.height, metres };
}

// The photo as a mesh: one vertex per `step` depth pixels, at its distance along its ray (viewer units, in the
// photo's frame). A column is repeated past the right edge to close the seam, and a row at each pole.
function buildRelief(depth: { width: number; height: number; metres: Float32Array }, step: number, metersPerUnit: number) {
  const columns = Math.floor(depth.width / step);
  const rows = Math.floor(depth.height / step);
  const perRow = columns + 1;
  const positions = new Float32Array(perRow * (rows + 2) * 3);
  const uvs = new Float32Array(perRow * (rows + 2) * 2);
  const farthest = SKY_DISTANCE / metersPerUnit;
  let vertex = 0;
  for (let row = -1; row <= rows; row++) {
    // The pole rows take the nearest row's distances
    const sourceRow = Math.min(rows - 1, Math.max(0, row)) * step + (step >> 1);
    const v = row < 0 ? 0 : row === rows ? 1 : (sourceRow + 0.5) / depth.height;
    const latitude = (0.5 - v) * Math.PI;
    for (let column = 0; column <= columns; column++) {
      const sourceColumn = (column % columns) * step + (step >> 1);
      const u = (sourceColumn + 0.5) / depth.width + (column === columns ? 1 : 0);
      const longitude = (u - 0.5) * 2 * Math.PI;
      const distance = Math.min(depth.metres[sourceRow * depth.width + sourceColumn] / metersPerUnit, farthest);
      positions[vertex * 3] = distance * Math.cos(latitude) * Math.sin(longitude);
      positions[vertex * 3 + 1] = distance * Math.sin(latitude);
      positions[vertex * 3 + 2] = -distance * Math.cos(latitude) * Math.cos(longitude);
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
      vertex++;
    }
  }
  const indices = new Uint32Array(columns * (rows + 1) * 6);
  let index = 0;
  for (let row = 0; row < rows + 1; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * perRow + column;
      const b = a + perRow;
      indices[index++] = a;
      indices[index++] = b;
      indices[index++] = a + 1;
      indices[index++] = a + 1;
      indices[index++] = b;
      indices[index++] = b + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return { geometry, farthest };
}

export function createPanoView(options: {
  pano: ScenePano;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  metersPerUnit: number;
}): PanoView {
  const { pano, renderer, camera, controls, metersPerUnit } = options;
  const element = renderer.domElement;
  const viewpoint = new THREE.Vector3().fromArray(pano.position);
  const reach = (pano.depth?.reach ?? DEFAULT_REACH) / metersPerUnit;
  // Phones get the smaller photo (the large one is 134 MB once decoded) and a coarser relief
  const small = renderer.capabilities.maxTextureSize < 8192
    || (window.matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 900);

  // A scene of its own: the photo isn't part of the site's scene, it lies over its picture
  const scene = new THREE.Scene();
  const sphereMaterial = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, opacity: { value: 0 } },
    vertexShader: SPHERE_VERTEX,
    fragmentShader: SPHERE_FRAGMENT,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), sphereMaterial);
  sphere.quaternion.fromArray(pano.quaternion);
  sphere.frustumCulled = false;
  scene.add(sphere);

  const reliefMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      depthColours: { value: 0 },
      metersPerUnit: { value: metersPerUnit },
      skyDistance: { value: SKY_DISTANCE / metersPerUnit },
    },
    vertexShader: RELIEF_VERTEX,
    fragmentShader: RELIEF_FRAGMENT,
    side: THREE.DoubleSide,
  });
  let relief: THREE.Mesh | null = null;

  let active = false;
  let disposed = false;
  let mode: PanoMode = 'photo';
  let texture: THREE.Texture | null = null;
  let photoLoading: Promise<void> | null = null;
  let reliefLoading: Promise<void> | null = null;
  let opacity = 0;
  let depthColours = false;

  // The view at the viewpoint: which way the camera looks (the scene is y-down, so up is -y), and how far it has
  // moved from the viewpoint (the relief and the scene only)
  let yaw = 0;
  let pitch = 0;
  let fov = DEFAULT_FOV;
  const offset = new THREE.Vector3();
  const offsetTarget = new THREE.Vector3();
  let swayTime = Infinity;
  let swayPlayed = false;
  const direction = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const aim = () => {
    direction.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    camera.position.copy(viewpoint).add(offset);
    camera.lookAt(lookAt.copy(camera.position).add(direction));
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  };
  // The camera's own right and up, for moving it sideways
  const readAxes = () => {
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
  };

  // The flight in, and what to put back on leaving
  const saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: DEFAULT_FOV };
  const flight = { from: new THREE.Vector3(), fromRotation: new THREE.Quaternion(), toRotation: new THREE.Quaternion(), t: 1 };

  const reliefReady = () => relief !== null && texture !== null;
  // The photo stands in for the relief until its depth has arrived: from the viewpoint they look the same
  const photoWanted = () => mode === 'photo' || (mode === 'relief' && !reliefReady());
  const reliefShown = () => mode === 'relief' && reliefReady() && flight.t >= 1;
  const canMove = () => flight.t >= 1 && (mode === 'scene' || reliefShown());
  const stopSway = () => {
    swayTime = Infinity;
  };
  const move = (x: number, y: number, z: number) => {
    stopSway();
    readAxes();
    offsetTarget.addScaledVector(right, x).addScaledVector(up, y).addScaledVector(direction, z);
    if (offsetTarget.length() > reach) offsetTarget.setLength(reach);
  };

  const loadPhoto = () => {
    photoLoading ??= (async () => {
      const response = await fetch(assetUrl(small && pano.smallUrl ? pano.smallUrl : pano.url));
      if (!response.ok) throw new Error(`No se pudo descargar la foto 360° (HTTP ${response.status})`);
      const bitmap = await createImageBitmap(await response.blob());
      if (disposed) {
        bitmap.close();
        return;
      }
      texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      // An ImageBitmap's rows go top to bottom, and the shaders read them that way
      texture.flipY = false;
      texture.needsUpdate = true;
      sphereMaterial.uniforms.map.value = texture;
      reliefMaterial.uniforms.map.value = texture;
    })();
    // A failed download can be tried again
    photoLoading.catch(() => {
      photoLoading = null;
    });
    return photoLoading;
  };
  const loadRelief = () => {
    const config = pano.depth;
    if (!config) return Promise.resolve();
    reliefLoading ??= (async () => {
      const depth = await loadDepth(assetUrl(config.url), config.near, config.far);
      if (disposed) return;
      const built = buildRelief(depth, small ? 2 : 1, metersPerUnit);
      relief = new THREE.Mesh(built.geometry, reliefMaterial);
      relief.position.copy(viewpoint);
      relief.quaternion.fromArray(pano.quaternion);
      relief.frustumCulled = false;
      relief.visible = false;
      scene.add(relief);
    })();
    reliefLoading.catch(() => {
      reliefLoading = null;
    });
    return reliefLoading;
  };

  // Looking around: dragging moves the picture with the pointer. In the photo the wheel or a pinch zooms; in the
  // relief and the scene they move the camera forward and back, and the right button or two fingers move it sideways.
  const pointers = new Map<number, { x: number; y: number; button: number }>();
  const keys = new Set<string>();
  let pinchDistance = 0;
  const zoom = (factor: number) => {
    fov = THREE.MathUtils.clamp(fov * factor, MIN_FOV, MAX_FOV);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!active) return;
    stopSway();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button });
    element.setPointerCapture(event.pointerId);
    pinchDistance = 0;
  };
  const onPointerMove = (event: PointerEvent) => {
    const last = pointers.get(event.pointerId);
    if (!active || !last) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    last.x = event.clientX;
    last.y = event.clientY;
    const perPixel = reach / (0.4 * element.clientHeight);
    if (pointers.size === 1 && last.button === 2) {
      if (canMove()) move(-dx * perPixel, dy * perPixel, 0);
    } else if (pointers.size === 1) {
      const radiansPerPixel = THREE.MathUtils.degToRad(fov) / element.clientHeight;
      yaw -= dx * radiansPerPixel;
      pitch = THREE.MathUtils.clamp(pitch + dy * radiansPerPixel, -MAX_PITCH, MAX_PITCH);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (canMove()) {
        // Each finger's move counts half: together they slide the camera, apart they push it forward
        move(-dx * perPixel / 2, dy * perPixel / 2, pinchDistance ? (distance - pinchDistance) * perPixel : 0);
      } else if (pinchDistance && distance) {
        zoom(pinchDistance / distance);
      }
      pinchDistance = distance;
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinchDistance = 0;
  };
  const onWheel = (event: WheelEvent) => {
    if (!active) return;
    event.preventDefault();
    if (canMove()) move(0, 0, -event.deltaY * 0.0015 * reach);
    else zoom(Math.exp(event.deltaY * 0.001));
  };
  const onContextMenu = (event: MouseEvent) => {
    if (active) event.preventDefault();
  };
  const MOVE_KEYS: Record<string, [number, number, number]> = {
    KeyW: [0, 0, 1], ArrowUp: [0, 0, 1], KeyS: [0, 0, -1], ArrowDown: [0, 0, -1],
    KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0], KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
    KeyE: [0, 1, 0], KeyQ: [0, -1, 0],
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!active || !(event.code in MOVE_KEYS) || event.metaKey || event.ctrlKey || event.altKey) return;
    keys.add(event.code);
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code);
  };
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const enter = () => {
    active = true;
    controls.enabled = false;
    saved.position.copy(camera.position);
    saved.target.copy(controls.target);
    saved.fov = camera.fov;

    // Look at the site from the viewpoint; from right above it, keep the camera's heading
    const level = Math.hypot(viewpoint.x, viewpoint.z);
    if (level > OVERHEAD_RADIUS) {
      yaw = Math.atan2(-viewpoint.x, -viewpoint.z);
      pitch = -Math.atan2(-viewpoint.y, level);
    } else {
      camera.getWorldDirection(direction);
      yaw = Math.atan2(direction.x, direction.z);
      pitch = THREE.MathUtils.degToRad(-12);
    }
    fov = DEFAULT_FOV;
    offset.set(0, 0, 0);
    offsetTarget.set(0, 0, 0);
    flight.from.copy(camera.position);
    flight.fromRotation.copy(camera.quaternion);
    aim();
    flight.toRotation.copy(camera.quaternion);
    camera.position.copy(flight.from);
    camera.quaternion.copy(flight.fromRotation);
    flight.t = 0;
    opacity = 0;
    swayPlayed = false;
  };

  return {
    get active() {
      return active;
    },
    get covers() {
      return active && flight.t >= 1 && (reliefShown() || (photoWanted() && texture !== null && opacity >= 1));
    },
    show(next) {
      if (!active) enter();
      mode = next;
      // A photo has one viewpoint: back to it
      if (mode === 'photo') offsetTarget.set(0, 0, 0);
      stopSway();
      const photo = loadPhoto();
      if (mode !== 'relief') return mode === 'photo' ? photo : Promise.resolve();
      const ready = Promise.all([photo, loadRelief()]).then(() => {
        // The loop that shows the depth: once per visit to the viewpoint (switching between the relief and the
        // scene to compare them must leave the camera still), and not if the visitor has moved on or moved it
        if (!swayPlayed && mode === 'relief' && offsetTarget.lengthSq() === 0) swayTime = 0;
        swayPlayed = true;
      });
      return ready;
    },
    setDepthColours(on) {
      depthColours = on;
    },
    exit() {
      if (!active) return;
      active = false;
      pointers.clear();
      keys.clear();
      stopSway();
      opacity = 0;
      flight.t = 1;
      offset.set(0, 0, 0);
      offsetTarget.set(0, 0, 0);
      camera.fov = saved.fov;
      camera.updateProjectionMatrix();
      camera.position.copy(saved.position);
      controls.target.copy(saved.target);
      controls.enabled = true;
      controls.update();
    },
    update(deltaSeconds) {
      if (!active) return;
      if (flight.t < 1) {
        flight.t = Math.min(1, flight.t + deltaSeconds / FLY_SECONDS);
        const k = easeInOut(flight.t);
        // Dragging during the flight changes where it ends
        aim();
        flight.toRotation.copy(camera.quaternion);
        camera.position.lerpVectors(flight.from, viewpoint, k);
        camera.quaternion.slerpQuaternions(flight.fromRotation, flight.toRotation, k);
      } else {
        if (canMove()) {
          if (swayTime < SWAY_SECONDS) {
            // One loop to the right and back, a little up and down, starting and ending at the viewpoint
            swayTime += deltaSeconds;
            const turn = Math.min(swayTime / SWAY_SECONDS, 1) * 2 * Math.PI;
            readAxes();
            offsetTarget.set(0, 0, 0)
              .addScaledVector(right, Math.sin(turn) * SWAY_SIZE * reach)
              .addScaledVector(up, (1 - Math.cos(turn)) * 0.4 * SWAY_SIZE * reach);
          }
          let x = 0, y = 0, z = 0;
          for (const key of keys) {
            x += MOVE_KEYS[key][0];
            y += MOVE_KEYS[key][1];
            z += MOVE_KEYS[key][2];
          }
          if (x || y || z) {
            const step = (reach / KEY_SECONDS) * deltaSeconds;
            move(x * step, y * step, z * step);
          }
        } else {
          offsetTarget.set(0, 0, 0);
        }
        offset.lerp(offsetTarget, 1 - Math.exp(-MOVE_EASE * deltaSeconds));
        if (offsetTarget.lengthSq() === 0 && offset.lengthSq() < 1e-8) offset.set(0, 0, 0);
        aim();
      }
      // The photo fades in once the camera is at the viewpoint, so the scene is seen sliding into the photo's place
      const target = photoWanted() && texture && flight.t >= 1 && offset.lengthSq() === 0 ? 1 : 0;
      const step = deltaSeconds / FADE_SECONDS;
      opacity = target > opacity ? Math.min(target, opacity + step) : Math.max(target, opacity - step);
      // From the viewpoint the relief looks exactly as the photo: it takes over at once
      if (reliefShown()) opacity = 0;
      const colours = reliefMaterial.uniforms.depthColours;
      colours.value = THREE.MathUtils.clamp(colours.value + (depthColours ? step : -step), 0, 1);
    },
    render() {
      if (!active) return;
      const showRelief = reliefShown();
      if (!showRelief && (!texture || opacity <= 0)) return;
      sphere.visible = !showRelief;
      if (relief) relief.visible = showRelief;
      sphereMaterial.uniforms.opacity.value = opacity;
      camera.getWorldPosition(sphere.position);
      const autoClear = renderer.autoClear;
      renderer.autoClear = showRelief || opacity >= 1;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    dispose() {
      disposed = true;
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (texture) {
        (texture.image as ImageBitmap).close?.();
        texture.dispose();
      }
      relief?.geometry.dispose();
      reliefMaterial.dispose();
      sphere.geometry.dispose();
      sphereMaterial.dispose();
    },
  };
}
