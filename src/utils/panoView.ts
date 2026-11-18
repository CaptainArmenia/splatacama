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
 * of the scene, and switching between the two shows what the reconstruction keeps and loses. At the viewpoint the
 * camera only turns and zooms, since a photo has no other viewpoint; leaving puts it back where it was.
 *
 * The photo is drawn in a pass of its own after the scene's (meshes, then splats), so it covers both and can fade
 * over them; while it covers everything the scene isn't drawn at all.
 */

export type PanoView = {
  /** The camera is at the photo's viewpoint (or on its way): the viewer's own controls are off */
  readonly active: boolean;
  /** The photo covers the whole frame, so the scene needn't be drawn */
  readonly covers: boolean;
  /** Moves the camera to the viewpoint; the photo is downloaded the first time and fades in when it's there */
  enter: () => Promise<void>;
  /** At the viewpoint: the photo, or the scene under it */
  showPhoto: (on: boolean) => void;
  /** Back to where the camera was */
  exit: () => void;
  /** Every frame while active, instead of the orbit controls' update */
  update: (deltaSeconds: number) => void;
  /** Draws the photo over the frame (or alone, when it covers it) */
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

const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// The photo is equirectangular; its frame is a camera's looking at the image centre (x right, y up, z back). The
// lookup is per pixel, so the sphere's triangles don't bend it. The longitude jumps at the image's left and right
// edge, which would make the texture's level of detail jump there too (a visible seam): the gradients are taken from
// whichever of two longitudes, half a turn apart, is continuous at this pixel.
const FRAGMENT = /* glsl */ `
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

const easeInOut = (t: number) => t * t * (3 - 2 * t);

export function createPanoView(options: {
  pano: ScenePano;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}): PanoView {
  const { pano, renderer, camera, controls } = options;
  const element = renderer.domElement;
  const viewpoint = new THREE.Vector3().fromArray(pano.position);

  // A scene of its own: the photo isn't part of the site's scene, it lies over its picture
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, opacity: { value: 0 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), material);
  sphere.quaternion.fromArray(pano.quaternion);
  sphere.frustumCulled = false;
  scene.add(sphere);

  let active = false;
  let disposed = false;
  let texture: THREE.Texture | null = null;
  let loading: Promise<void> | null = null;
  let wantPhoto = true;
  let opacity = 0;

  // The view at the viewpoint: which way the camera looks (the scene is y-down, so up is -y)
  let yaw = 0;
  let pitch = 0;
  let fov = DEFAULT_FOV;
  const direction = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const aim = () => {
    direction.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    camera.position.copy(viewpoint);
    camera.lookAt(lookAt.copy(viewpoint).add(direction));
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  };

  // The flight in, and what to put back on leaving
  const saved = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: DEFAULT_FOV };
  const flight = { from: new THREE.Vector3(), fromRotation: new THREE.Quaternion(), toRotation: new THREE.Quaternion(), t: 1 };

  const load = () => {
    loading ??= (async () => {
      // Phones get the smaller photo: the large one is 134 MB once decoded
      const small = renderer.capabilities.maxTextureSize < 8192
        || (window.matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 900);
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
      // An ImageBitmap's rows go top to bottom, and the shader reads them that way
      texture.flipY = false;
      texture.needsUpdate = true;
      material.uniforms.map.value = texture;
    })();
    // A failed download can be tried again
    loading.catch(() => {
      loading = null;
    });
    return loading;
  };

  // Looking around: dragging moves the photo with the pointer, the wheel or a pinch zooms
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  const zoom = (factor: number) => {
    fov = THREE.MathUtils.clamp(fov * factor, MIN_FOV, MAX_FOV);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!active) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
    if (pointers.size === 1) {
      const radiansPerPixel = THREE.MathUtils.degToRad(fov) / element.clientHeight;
      yaw -= dx * radiansPerPixel;
      pitch = THREE.MathUtils.clamp(pitch + dy * radiansPerPixel, -MAX_PITCH, MAX_PITCH);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance && distance) zoom(pinchDistance / distance);
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
    zoom(Math.exp(event.deltaY * 0.001));
  };
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('wheel', onWheel, { passive: false });

  return {
    get active() {
      return active;
    },
    get covers() {
      return active && texture !== null && opacity >= 1 && flight.t >= 1;
    },
    enter() {
      if (!active) {
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
        flight.from.copy(camera.position);
        flight.fromRotation.copy(camera.quaternion);
        aim();
        flight.toRotation.copy(camera.quaternion);
        camera.position.copy(flight.from);
        camera.quaternion.copy(flight.fromRotation);
        flight.t = 0;
        wantPhoto = true;
        opacity = 0;
      }
      return load();
    },
    showPhoto(on) {
      wantPhoto = on;
    },
    exit() {
      if (!active) return;
      active = false;
      pointers.clear();
      opacity = 0;
      flight.t = 1;
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
        aim();
      }
      // The photo fades in once the camera has arrived, so the scene is seen sliding into the photo's place
      const target = wantPhoto && texture && flight.t >= 1 ? 1 : 0;
      const step = deltaSeconds / FADE_SECONDS;
      opacity = target > opacity ? Math.min(target, opacity + step) : Math.max(target, opacity - step);
    },
    render() {
      if (!active || !texture || opacity <= 0) return;
      material.uniforms.opacity.value = opacity;
      camera.getWorldPosition(sphere.position);
      const autoClear = renderer.autoClear;
      renderer.autoClear = opacity >= 1;
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
      if (texture) {
        (texture.image as ImageBitmap).close?.();
        texture.dispose();
      }
      sphere.geometry.dispose();
      material.dispose();
    },
  };
}
