// "wind open field" by Globofonia, Freesound #553733, CC0 (no attribution required). Recorded on open ground in
// northern Mexico. Trimmed, high-passed at 180 Hz to remove the microphone's wind rumble, and normalized.
export const WIND_SOUND_URL = '/sounds/wind-open-field.mp3';

const WIND_CONFIG = {
  volume: 0.6,
  // Each pass of the recording fades into the next over this long, so the loop point can't be heard
  crossfadeSeconds: 4,
  // Fade when the sound starts, stops, or is muted
  fadeSeconds: 1.5,
  // Gusts: the volume and brightness drift toward a new random target every few seconds, on top of the
  // recording's own gusts, so the two-minute loop doesn't repeat exactly
  gustGain: [0.55, 1] as const,
  gustCutoffHz: [2500, 9000] as const,
  gustIntervalSeconds: [3, 9] as const,
};

const between = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);

// Equal-power fade curves, so two overlapping passes of the noise-like recording don't dip in loudness
const fadeCurve = (fadingIn: boolean) => {
  const curve = new Float32Array(64);
  for (let i = 0; i < curve.length; i++) {
    const t = i / (curve.length - 1);
    curve[i] = fadingIn ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
  }
  return curve;
};

/**
 * Background wind for the splat scenes, played with the Web Audio API.
 *
 * Browsers only let a page start sound after the visitor interacts with it, so the file is downloaded right away
 * but nothing plays until `unlock()` is called from a click or key press. Sound also pauses while the tab is hidden.
 */
export function createWindAmbience(url = WIND_SOUND_URL) {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let gust: GainNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let buffer: AudioBuffer | null = null;
  let muted = false;
  let unlocked = false;
  let disposed = false;
  let nextPassStart = 0;
  let passTimer: ReturnType<typeof setTimeout> | undefined;
  let gustTimer: ReturnType<typeof setTimeout> | undefined;
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;

  // Download now, decode once there is an audio context (decoding needs one, and creating one before an
  // interaction makes Chrome log a warning)
  const download = fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .catch(error => {
      console.error('Error loading wind sound:', error);
      return null;
    });

  const fadeIn = fadeCurve(true);
  const fadeOut = fadeCurve(false);

  // Schedules one pass of the recording, overlapping the end of the previous one, and comes back when it starts to
  // schedule the following pass. Passes are always queued a full pass ahead, so a background tab's slowed-down
  // timers can't leave a gap.
  const schedulePass = () => {
    if (!context || !buffer || !filter || disposed) return;
    const fade = WIND_CONFIG.crossfadeSeconds;
    const start = Math.max(nextPassStart, context.currentTime + 0.05);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const envelope = context.createGain();
    envelope.gain.setValueCurveAtTime(fadeIn, start, fade);
    envelope.gain.setValueCurveAtTime(fadeOut, start + buffer.duration - fade, fade);
    source.connect(envelope).connect(filter);
    source.start(start);
    source.stop(start + buffer.duration);
    source.onended = () => envelope.disconnect();
    nextPassStart = start + buffer.duration - fade;
    passTimer = setTimeout(schedulePass, Math.max(0, (start - context.currentTime) * 1000));
  };

  const scheduleGust = () => {
    if (!context || !gust || !filter || disposed) return;
    const now = context.currentTime;
    const seconds = between(WIND_CONFIG.gustIntervalSeconds);
    // Reach about 95% of the way to the new values by the next change
    gust.gain.setTargetAtTime(between(WIND_CONFIG.gustGain), now, seconds / 3);
    filter.frequency.setTargetAtTime(between(WIND_CONFIG.gustCutoffHz), now, seconds / 3);
    gustTimer = setTimeout(scheduleGust, seconds * 1000);
  };

  // Fades the master volume to match `muted`. A muted context is suspended after the fade, so it uses no CPU.
  const applyMuted = () => {
    if (!context || !master) return;
    const now = context.currentTime;
    const target = muted ? 0 : WIND_CONFIG.volume;
    clearTimeout(suspendTimer);
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(target, now + WIND_CONFIG.fadeSeconds);
    if (muted) {
      suspendTimer = setTimeout(() => context?.suspend(), WIND_CONFIG.fadeSeconds * 1000 + 100);
    } else if (!document.hidden) {
      context.resume();
    }
  };

  const start = async () => {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0;
    gust = context.createGain();
    filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = WIND_CONFIG.gustCutoffHz[1];
    filter.connect(gust).connect(master).connect(context.destination);

    const data = await download;
    if (!data || disposed) return;
    try {
      buffer = await context.decodeAudioData(data);
    } catch (error) {
      // Leaving the scene while decoding closes the context, which fails the decode too
      if (!disposed) console.error('Error decoding wind sound:', error);
      return;
    }
    if (disposed) return;
    schedulePass();
    scheduleGust();
    applyMuted();
  };

  const onVisibilityChange = () => {
    if (!context) return;
    if (document.hidden) context.suspend();
    else if (!muted) context.resume();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    /** Call from a click or key press handler: the first call starts the sound (unless muted) */
    unlock() {
      if (unlocked || disposed) return;
      unlocked = true;
      start();
    },
    setMuted(value: boolean) {
      muted = value;
      applyMuted();
    },
    dispose() {
      disposed = true;
      clearTimeout(passTimer);
      clearTimeout(gustTimer);
      clearTimeout(suspendTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      context?.close();
      context = null;
    },
  };
}
