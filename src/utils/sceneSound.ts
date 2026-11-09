import * as THREE from 'three';
import { createTurbineSound, type TurbineSound } from '@/utils/turbineSound';
import { createWind, pinkNoise, type WindVoice } from '@/utils/windAmbience';
import type { TurbineVoice } from '@/utils/windTurbines';

const SOUND = {
  volume: 0.6,
  // Fade when a sound starts or is turned on or off
  fadeSeconds: 1.5,
  // The noise all voices share; the wind's gusts hide that it loops
  noiseSeconds: 12,
  // The wind's gusts are planned this far ahead, every `planEverySeconds`, so slow timers can't leave a gap
  planAheadSeconds: 3,
  planEverySeconds: 1,
};

/** Which of the scene's sounds play */
export type SoundChoice = { wind: boolean; turbines: boolean };

export type SceneSound = {
  /** Call from a click or key press handler: the first call starts the sound (unless all is off) */
  unlock: () => void;
  setSounds: (choice: SoundChoice) => void;
  /** The scene's wind turbines (positions in the frame setListener's `frame` holds), or null for none */
  setTurbines: (voices: TurbineVoice[] | null, unitsPerMetre: number) => void;
  /** Call every frame: the listener follows the camera, in `frame`'s coordinates (the scene's world group) */
  setListener: (camera: THREE.Camera, frame: THREE.Object3D) => void;
  dispose: () => void;
};

/**
 * The scenes' sound, with the Web Audio API: the wind, and the nearest wind turbines from where they stand.
 *
 * Browsers only let a page start sound after the visitor interacts with it, so nothing plays until `unlock()` is
 * called from a click or key press. Sound pauses while the tab is hidden, and with every sound off.
 */
export function createSceneSound(): SceneSound {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  // Each sound has its own volume under the master, so each can be turned off
  let windBus: GainNode | null = null;
  let turbineBus: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let wind: WindVoice | null = null;
  let turbines: TurbineSound | null = null;
  let turbineVoices: { voices: TurbineVoice[]; unitsPerMetre: number } | null = null;
  let choice: SoundChoice = { wind: true, turbines: true };
  let unlocked = false;
  let disposed = false;
  let planTimer: ReturnType<typeof setInterval> | undefined;
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;

  const startTurbines = () => {
    turbines?.dispose();
    turbines = null;
    if (context && turbineBus && noise && turbineVoices?.voices.length) {
      turbines = createTurbineSound(context, turbineBus, noise, turbineVoices.voices, turbineVoices.unitsPerMetre);
    }
  };

  const fade = (param: AudioParam, to: number) => {
    if (!context) return;
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(to, now + SOUND.fadeSeconds);
  };
  const silent = () => !choice.wind && !choice.turbines;

  // Fades each sound to match `choice`. With all off, the context is suspended after the fade, so it uses no CPU.
  const applyChoice = () => {
    if (!context || !master || !windBus || !turbineBus) return;
    clearTimeout(suspendTimer);
    fade(windBus.gain, choice.wind ? 1 : 0);
    fade(turbineBus.gain, choice.turbines ? 1 : 0);
    fade(master.gain, silent() ? 0 : SOUND.volume);
    if (silent()) {
      suspendTimer = setTimeout(() => context?.suspend(), SOUND.fadeSeconds * 1000 + 100);
    } else if (!document.hidden) {
      context.resume();
    }
  };

  const start = () => {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    windBus = context.createGain();
    windBus.gain.value = 0;
    windBus.connect(master);
    turbineBus = context.createGain();
    turbineBus.gain.value = 0;
    turbineBus.connect(master);
    noise = pinkNoise(context, SOUND.noiseSeconds);
    wind = createWind(context, windBus, noise);
    const plan = () => context && wind?.schedule(context.currentTime + SOUND.planAheadSeconds);
    plan();
    planTimer = setInterval(plan, SOUND.planEverySeconds * 1000);
    startTurbines();
    applyChoice();
  };

  const onVisibilityChange = () => {
    if (!context) return;
    if (document.hidden) context.suspend();
    else if (!silent()) context.resume();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const position = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const toFrame = new THREE.Matrix4();

  return {
    unlock() {
      if (unlocked || disposed) return;
      unlocked = true;
      start();
    },
    setSounds(value) {
      choice = { ...value };
      applyChoice();
    },
    setTurbines(voices, unitsPerMetre) {
      turbineVoices = voices ? { voices, unitsPerMetre } : null;
      startTurbines();
    },
    setListener(camera, frame) {
      if (!context || silent() || context.state !== 'running') return;
      // The camera's position and its forward and up directions, in the frame's coordinates (in VR the frame is
      // turned and scaled, and the camera is the headset's)
      toFrame.copy(frame.matrixWorld).invert().multiply(camera.matrixWorld);
      position.setFromMatrixPosition(toFrame);
      forward.set(0, 0, -1).transformDirection(toFrame);
      up.set(0, 1, 0).transformDirection(toFrame);
      const listener = context.listener;
      if (listener.positionX) {
        const t = context.currentTime;
        listener.positionX.setValueAtTime(position.x, t);
        listener.positionY.setValueAtTime(position.y, t);
        listener.positionZ.setValueAtTime(position.z, t);
        listener.forwardX.setValueAtTime(forward.x, t);
        listener.forwardY.setValueAtTime(forward.y, t);
        listener.forwardZ.setValueAtTime(forward.z, t);
        listener.upX.setValueAtTime(up.x, t);
        listener.upY.setValueAtTime(up.y, t);
        listener.upZ.setValueAtTime(up.z, t);
      } else {
        // Firefox has only the older calls
        listener.setPosition(position.x, position.y, position.z);
        listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    },
    dispose() {
      disposed = true;
      clearInterval(planTimer);
      clearTimeout(suspendTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      turbines?.dispose();
      wind?.dispose();
      context?.close();
      context = null;
    },
  };
}
