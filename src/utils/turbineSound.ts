import type { TurbineVoice } from '@/utils/windTurbines';

/**
 * The sound of the nearest wind turbines, each from where it stands: the whine of its gearbox and generator (a few
 * steady tones, wavering slightly) and the swish of its blades (noise around 700 Hz that swells each time a blade
 * passes the tower, at the rate the rotor turns on screen). Farther turbines are quieter and duller, as air absorbs
 * high sounds over distance; past the nearest few they're lost under the wind.
 */

const TURBINE = {
  // How many of the nearest turbines are heard
  voices: 8,
  // At this distance (metres) a turbine is as loud as `level`; twice as far, half as loud
  refMetres: 400,
  level: 0.3,
  // The swish: noise in a band around this (Hz), its level swinging this far each time a blade passes
  swishHz: 700,
  swishQ: 0.9,
  swishDepth: 0.6,
  // The whine: its lowest tone (Hz, each turbine its own in this range), and its tones as [multiple, level]
  whineHz: [520, 700] as const,
  whineTones: [[1, 1], [2, 0.4], [3, 0.15]] as const,
  whineGain: 0.3,
  // It wavers by this much (cents), this often (Hz)
  waverCents: 7,
  waverHz: 0.13,
  // Air absorption: the low-pass a turbine is heard through, from this cutoff at 300 m, falling with distance
  airCutoffHz: 9000,
};

export type TurbineSound = { dispose: () => void };

/** Sounds for the nearest turbines in `voices`, into `output`, placed in the same frame (and units) as the listener */
export function createTurbineSound(
  context: BaseAudioContext,
  output: AudioNode,
  noise: AudioBuffer,
  voices: TurbineVoice[],
  unitsPerMetre: number,
): TurbineSound {
  const nearest = [...voices].sort((a, b) => a.metres - b.metres).slice(0, TURBINE.voices);
  const nodes: AudioScheduledSourceNode[] = [];
  const all: AudioNode[] = [];
  const keep = <T extends AudioNode>(node: T) => {
    all.push(node);
    return node;
  };

  nearest.forEach(({ position, metres, bladePassHz }, index) => {
    const panner = keep(context.createPanner());
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = TURBINE.refMetres * unitsPerMetre;
    panner.rolloffFactor = 1;
    panner.maxDistance = 1e6;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    const air = keep(context.createBiquadFilter());
    air.type = 'lowpass';
    air.frequency.value = Math.max(700, TURBINE.airCutoffHz * Math.min(1, 300 / metres) ** 1.2);
    const level = keep(context.createGain());
    level.gain.value = TURBINE.level;
    air.connect(panner).connect(level).connect(output);

    // One beat per blade passing: the swish swells with it, the whine a little
    const beat = context.createOscillator();
    beat.frequency.value = bladePassHz;
    nodes.push(beat);

    const noiseSource = context.createBufferSource();
    noiseSource.buffer = noise;
    noiseSource.loop = true;
    nodes.push(noiseSource);
    const band = keep(context.createBiquadFilter());
    band.type = 'bandpass';
    band.frequency.value = TURBINE.swishHz * (0.9 + 0.2 * ((index * 0.618) % 1));
    band.Q.value = TURBINE.swishQ;
    const swish = keep(context.createGain());
    swish.gain.value = 1 - TURBINE.swishDepth / 2;
    const swishBeat = keep(context.createGain());
    swishBeat.gain.value = TURBINE.swishDepth / 2;
    beat.connect(swishBeat).connect(swish.gain);
    noiseSource.connect(band).connect(swish).connect(air);

    const whine = keep(context.createGain());
    whine.gain.value = TURBINE.whineGain * 0.9;
    const whineBeat = keep(context.createGain());
    whineBeat.gain.value = TURBINE.whineGain * 0.1;
    beat.connect(whineBeat).connect(whine.gain);
    whine.connect(air);
    const waver = context.createOscillator();
    waver.frequency.value = TURBINE.waverHz * (0.8 + 0.4 * ((index * 0.382) % 1));
    nodes.push(waver);
    const waverDepth = keep(context.createGain());
    waverDepth.gain.value = TURBINE.waverCents;
    waver.connect(waverDepth);
    const base = TURBINE.whineHz[0] + (TURBINE.whineHz[1] - TURBINE.whineHz[0]) * ((index * 0.754877) % 1);
    for (const [multiple, toneLevel] of TURBINE.whineTones) {
      const tone = context.createOscillator();
      tone.frequency.value = base * multiple;
      waverDepth.connect(tone.detune);
      nodes.push(tone);
      const gain = keep(context.createGain());
      gain.gain.value = toneLevel;
      tone.connect(gain).connect(whine);
    }
  });

  // Each noise source starts at its own point in the buffer, so no two turbines swish alike
  for (const node of nodes) {
    if (node instanceof AudioBufferSourceNode) node.start(0, Math.random() * (noise.duration - 1));
    else node.start();
  }

  return {
    dispose() {
      for (const node of nodes) {
        node.stop();
        node.disconnect();
      }
      for (const node of all) node.disconnect();
    },
  };
}
