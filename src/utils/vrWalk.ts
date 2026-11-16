import * as THREE from 'three';
import { groundHeight, walk, type WalkArea } from '@/utils/walkArea';

export const VR_CONFIG = {
  walkSpeed: 1.4, // meters per second with the stick pushed all the way
  stickDeadZone: 0.15,
  // Turning is in steps, which is easier on the stomach than smooth turning. The stick has to come back toward the
  // middle before the next step.
  snapTurnDegrees: 30,
  snapTurnPush: 0.7,
  snapTurnRelease: 0.35,
  // How quickly the view follows the ground up and down slopes (seconds)
  heightSmoothing: 0.12,
  // Rendering resolution and fixed foveation for the headset. Splats are expensive to draw, so these trade some
  // sharpness for frame rate (Spark's own VR helper renders at 0.5).
  framebufferScale: 0.75,
  foveation: 1,
  // Eye height when the headset can't tell where the floor is
  fallbackEyeHeight: 1.6,
  // A bigger jump of the head in one frame is the headset recentering, not the visitor walking
  maxFrameJump: 0.5,
};

const UP = new THREE.Vector3(0, 1, 0);

// Headset browsers, which can say "Android" or "Mobile" in their user agent too
const HEADSET_BROWSER = /Quest|OculusBrowser|VisionOS|XRBrowser|Pico|Lynx|MagicLeap/i;

/** A VR headset's own browser: its GPU is a phone's, drawing two views */
export const isHeadsetBrowser = () => HEADSET_BROWSER.test(navigator.userAgent);

/**
 * Whether to offer VR: a headset, or a computer with one attached. Phones can report VR support too, but a phone
 * held to the face with no controllers is a poor way to walk a site, so they keep the normal view (Spark's own VR
 * helper skips phones the same way).
 */
export async function isVRSupported(): Promise<boolean> {
  const userAgent = navigator.userAgent;
  if (!HEADSET_BROWSER.test(userAgent) && /Android|Mobile/i.test(userAgent)) return false;
  try {
    return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
  } catch {
    return false;
  }
}

/**
 * Walking through a splat scene in a VR headset. The camera sits in a `rig` group; the headset moves the camera
 * inside the rig, and this moves the rig: the left stick walks, the right stick turns. The walk area keeps the
 * visitor on the ground, out of walls and bushes, and inside the part of the scene that was captured in detail.
 * Walking in the room is held to the same limits.
 *
 * While the session runs, the scene's world group (the splat and everything drawn with it) is shown upright and at
 * real size (see toUprightMeters in walkArea.ts); when it ends, it and the camera go back to how the desktop viewer
 * had them.
 */
export class VRWalk {
  private session: XRSession | null = null;
  private eyeOffset = 0;
  private lastHead: { x: number; z: number } | null = null;
  private turnReady = true;
  private desktopState: {
    worldPosition: THREE.Vector3;
    worldQuaternion: THREE.Quaternion;
    worldScale: THREE.Vector3;
    cameraPosition: THREE.Vector3;
    cameraQuaternion: THREE.Quaternion;
    fov: number;
    near: number;
    far: number;
  } | null = null;
  private readonly head = new THREE.Vector3();
  private readonly headQuaternion = new THREE.Quaternion();
  private readonly headEuler = new THREE.Euler();
  private readonly move = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly rig: THREE.Group,
    private readonly world: THREE.Object3D,
    private readonly area: WalkArea,
    // Metres per unit of the world group, and the camera's far plane in VR (metres)
    private readonly metersPerWorldUnit: number,
    private readonly far: number,
    private readonly onActiveChange: (active: boolean) => void
  ) {}

  /** True while the headset shows the scene (not yet while the session is starting) */
  get active() {
    return this.session !== null && this.renderer.xr.isPresenting;
  }

  async enter() {
    if (this.session || !navigator.xr) return;
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });

    // 'local-floor' puts the reference space's origin on the floor, so the headset's height is the visitor's
    // real eye height. Without it, assume a typical one.
    let referenceSpaceType: XRReferenceSpaceType = 'local-floor';
    try {
      await session.requestReferenceSpace('local-floor');
    } catch {
      referenceSpaceType = 'local';
    }
    this.eyeOffset = referenceSpaceType === 'local' ? VR_CONFIG.fallbackEyeHeight : 0;

    const { world, camera } = this;
    this.desktopState = {
      worldPosition: world.position.clone(),
      worldQuaternion: world.quaternion.clone(),
      worldScale: world.scale.clone(),
      cameraPosition: camera.position.clone(),
      cameraQuaternion: camera.quaternion.clone(),
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    };
    world.position.set(0, 0, 0);
    world.quaternion.set(1, 0, 0, 0); // 180 degrees about x: y-down becomes y-up
    world.scale.setScalar(this.metersPerWorldUnit);
    camera.near = 0.05;
    camera.far = this.far;

    const { spawn } = this.area;
    this.rig.position.set(spawn.x, groundHeight(this.area, spawn.x, spawn.z) + this.eyeOffset, spawn.z);
    this.rig.quaternion.setFromAxisAngle(UP, spawn.yaw);
    this.lastHead = null;
    this.turnReady = true;

    const xr = this.renderer.xr;
    xr.enabled = true;
    xr.setReferenceSpaceType(referenceSpaceType);
    xr.setFramebufferScaleFactor(VR_CONFIG.framebufferScale);
    xr.setFoveation(VR_CONFIG.foveation);
    session.addEventListener('end', this.onSessionEnd);
    this.session = session;
    try {
      await xr.setSession(session);
    } catch (error) {
      session.removeEventListener('end', this.onSessionEnd);
      this.onSessionEnd();
      session.end().catch(() => {});
      throw error;
    }
    this.onActiveChange(true);
  }

  /** Call once per frame while the session runs, before rendering */
  update(deltaSeconds: number) {
    if (!this.active) return;
    const { rig, area, head } = this;

    // Where the head is in the scene: between the eyes, whose poses in the room three has already read from the
    // headset for this frame (the camera itself only gets this frame's pose when rendering)
    const xrCamera = this.renderer.xr.getCamera();
    const eyes = xrCamera.cameras;
    if (eyes.length >= 2) head.copy(eyes[0].position).add(eyes[1].position).multiplyScalar(0.5);
    else head.copy(xrCamera.position);
    rig.updateMatrixWorld();
    head.applyMatrix4(rig.matrixWorld);

    if (!this.lastHead) {
      // First frame: move the rig so the visitor's head is at the start point
      rig.position.x += area.spawn.x - head.x;
      rig.position.z += area.spawn.z - head.z;
      this.lastHead = { x: area.spawn.x, z: area.spawn.z };
      return;
    }
    if (Math.hypot(head.x - this.lastHead.x, head.z - this.lastHead.z) > VR_CONFIG.maxFrameJump) {
      // The headset recentered: keep the visitor where they were
      rig.position.x += this.lastHead.x - head.x;
      rig.position.z += this.lastHead.z - head.z;
      head.x = this.lastHead.x;
      head.z = this.lastHead.z;
    }

    const { moveX, moveY, turnX } = this.readSticks();

    if (this.turnReady && Math.abs(turnX) > VR_CONFIG.snapTurnPush) {
      // Turn the rig about the head, so the visitor turns on the spot
      this.turn.setFromAxisAngle(UP, (-Math.sign(turnX) * VR_CONFIG.snapTurnDegrees * Math.PI) / 180);
      rig.position.sub(head).applyQuaternion(this.turn).add(head);
      rig.quaternion.premultiply(this.turn);
      this.turnReady = false;
    } else if (Math.abs(turnX) < VR_CONFIG.snapTurnRelease) {
      this.turnReady = true;
    }

    // Walk where the head is facing, on the level. Stick y is negative when pushed forward.
    this.move.set(0, 0, 0);
    const push = Math.hypot(moveX, moveY);
    if (push > VR_CONFIG.stickDeadZone) {
      this.headQuaternion.copy(rig.quaternion).multiply(xrCamera.quaternion);
      this.headEuler.setFromQuaternion(this.headQuaternion, 'YXZ');
      const speed = (VR_CONFIG.walkSpeed * Math.min(1, (push - VR_CONFIG.stickDeadZone) / (1 - VR_CONFIG.stickDeadZone))) / push;
      this.move.set(moveX * speed * deltaSeconds, 0, moveY * speed * deltaSeconds).applyAxisAngle(UP, this.headEuler.y);
    }

    // Both kinds of movement, walking in the room and with the stick, go through the walk area from the last
    // allowed spot; the rig takes up whatever was refused, so the head stays where it may be
    const to = walk(area, this.lastHead.x, this.lastHead.z, head.x + this.move.x, head.z + this.move.z);
    rig.position.x += to.x - head.x;
    rig.position.z += to.z - head.z;
    this.lastHead = to;

    const floor = groundHeight(area, to.x, to.z) + this.eyeOffset;
    rig.position.y += (floor - rig.position.y) * (1 - Math.exp(-deltaSeconds / VR_CONFIG.heightSmoothing));
  }

  dispose() {
    if (this.session) {
      this.session.removeEventListener('end', this.onSessionEnd);
      this.session.end().catch(() => {});
      this.onSessionEnd();
    }
  }

  private readSticks() {
    let moveX = 0;
    let moveY = 0;
    let turnX = 0;
    for (const source of this.session?.inputSources ?? []) {
      const axes = source.gamepad?.axes;
      if (!axes) continue;
      // The 'xr-standard' layout puts the thumbstick on axes 2 and 3; some controllers only have 0 and 1
      const x = axes.length >= 4 ? axes[2] : (axes[0] ?? 0);
      const y = axes.length >= 4 ? axes[3] : (axes[1] ?? 0);
      if (source.handedness === 'right') {
        turnX = x;
      } else {
        moveX = x;
        moveY = y;
      }
    }
    return { moveX, moveY, turnX };
  }

  private onSessionEnd = () => {
    this.session = null;
    this.lastHead = null;
    this.renderer.xr.enabled = false;
    this.rig.position.set(0, 0, 0);
    this.rig.quaternion.identity();
    const state = this.desktopState;
    if (state) {
      this.world.position.copy(state.worldPosition);
      this.world.quaternion.copy(state.worldQuaternion);
      this.world.scale.copy(state.worldScale);
      this.camera.position.copy(state.cameraPosition);
      this.camera.quaternion.copy(state.cameraQuaternion);
      this.camera.scale.set(1, 1, 1);
      this.camera.fov = state.fov;
      this.camera.near = state.near;
      this.camera.far = state.far;
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
      this.desktopState = null;
    }
    this.onActiveChange(false);
  };
}
