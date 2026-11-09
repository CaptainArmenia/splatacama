/**
 * Wind over open ground, made in the browser from noise. (A recording did this before, but it was mostly the hum of
 * a road: its sound sat in one band and hardly changed.) Three layers follow one gust strength that drifts and
 * swells: the body of the wind, noise through a low-pass that opens in gusts; the hiss of the air in strong gusts; and
 * at the strongest, a faint whistle, as of wind over rocks. Nothing repeats, and nothing is downloaded.
 */

const WIND = {
  // Low-pass cutoff (Hz) and level of the body, from calm to the strongest gust
  bodyCutoffHz: [320, 2200] as const,
  bodyGain: [0.2, 1] as const,
  // The air's hiss: noise above this (Hz), at this level in the strongest gusts
  hissFromHz: 2000,
  hissGain: 0.3,
  // The whistle: two narrow bands that drift slowly within this range (Hz), heard above `whistleFrom` gust strength
  whistleHz: [480, 900] as const,
  whistleQ: 16,
  whistleGain: 0.05,
  whistleFrom: 0.6,
  // Below this (Hz, cut steeply) is rumble, which read as traffic
  highPassHz: 130,
  // Gust strength (0 to 1): drifts around `mean`, pulled back toward it over `returnSeconds`, with gusts on top
  mean: 0.4,
  returnSeconds: 7,
  drift: 0.22,
  gustEverySeconds: [6, 16] as const,
  gustRiseSeconds: [1.2, 3] as const,
  gustFallSeconds: [4, 9] as const,
  gustSize: [0.25, 0.55] as const,
  // How often the parameters get a new target (seconds); they glide there
  step: 0.25,
};

const between = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Stereo pink noise (Paul Kellet's filter), each channel its own, so the wind is wide */
export function pinkNoise(context: BaseAudioContext, seconds: number) {
  const buffer = context.createBuffer(2, Math.round(context.sampleRate * seconds), context.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
    }
  }
  return buffer;
}

export type WindVoice = {
  /** Plans the gusts up to `until` (the context's time, seconds); call ahead of time, as often as convenient */
  schedule: (until: number) => void;
  dispose: () => void;
};

/** The wind, into `output`. `noise` is a pinkNoise() buffer (a dozen seconds; the gusts hide that it loops). */
export function createWind(context: BaseAudioContext, output: AudioNode, noise: AudioBuffer): WindVoice {
  const source = context.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  const highPass = context.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = WIND.highPassHz;
  const highPass2 = context.createBiquadFilter();
  highPass2.type = 'highpass';
  highPass2.frequency.value = WIND.highPassHz;
  source.connect(highPass2).connect(highPass);

  const body = context.createBiquadFilter();
  body.type = 'lowpass';
  body.Q.value = 0.5;
  const bodyGain = context.createGain();
  highPass.connect(body).connect(bodyGain).connect(output);

  const hiss = context.createBiquadFilter();
  hiss.type = 'highpass';
  hiss.frequency.value = WIND.hissFromHz;
  const hissGain = context.createGain();
  hissGain.gain.value = 0;
  highPass.connect(hiss).connect(hissGain).connect(output);

  const whistles = [1, 1.6].map(ratio => {
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = WIND.whistleQ;
    const gain = context.createGain();
    gain.gain.value = 0;
    highPass.connect(band).connect(gain).connect(output);
    return { band, gain, ratio };
  });

  let gust = WIND.mean;
  let planned = context.currentTime;
  let nextGust = planned + between(WIND.gustEverySeconds);
  let bump = { start: -1, rise: 1, fall: 1, size: 0 };
  let whistlePitch = 0.5;
  source.start();

  return {
    schedule(until) {
      for (; planned < until; planned += WIND.step) {
        const t = planned;
        // Drift: back toward the mean, and a random nudge
        gust += ((WIND.mean - gust) * WIND.step) / WIND.returnSeconds + WIND.drift * Math.sqrt(WIND.step) * (Math.random() * 2 - 1);
        if (t >= nextGust) {
          bump = { start: t, rise: between(WIND.gustRiseSeconds), fall: between(WIND.gustFallSeconds), size: between(WIND.gustSize) };
          nextGust = t + between(WIND.gustEverySeconds);
        }
        const since = t - bump.start;
        const swell = bump.start < 0 ? 0 : since < bump.rise ? smoothstep(0, bump.rise, since) : Math.exp(-(since - bump.rise) / bump.fall);
        gust = Math.min(1, Math.max(0, gust));
        const g = Math.min(1, gust + bump.size * swell);
        whistlePitch = Math.min(1, Math.max(0, whistlePitch + 0.08 * (Math.random() * 2 - 1)));

        const glide = WIND.step * 1.5;
        const [lowHz, highHz] = WIND.bodyCutoffHz;
        body.frequency.setTargetAtTime(lowHz * (highHz / lowHz) ** g, t, glide);
        bodyGain.gain.setTargetAtTime(WIND.bodyGain[0] + (WIND.bodyGain[1] - WIND.bodyGain[0]) * g, t, glide);
        hissGain.gain.setTargetAtTime(WIND.hissGain * g ** 1.5, t, glide);
        const whistle = WIND.whistleGain * smoothstep(WIND.whistleFrom, 1, g);
        const pitch = WIND.whistleHz[0] + (WIND.whistleHz[1] - WIND.whistleHz[0]) * (0.7 * whistlePitch + 0.3 * g);
        for (const { band, gain, ratio } of whistles) {
          band.frequency.setTargetAtTime(pitch * ratio, t, glide * 2);
          gain.gain.setTargetAtTime(whistle / ratio, t, glide);
        }
      }
    },
    dispose() {
      source.stop();
      source.disconnect();
    },
  };
}
