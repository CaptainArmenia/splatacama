import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { SceneEnvironment } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';
import { isHeadsetBrowser } from '@/utils/vrWalk';

// Radius of the sky sphere, which follows the camera (inside the camera's far plane)
const SKY_RADIUS = 500;

// The terrain's detail texture, as the splat pipeline's env_build.py describes it in the terrain materials' extras
// (viewer units): a tiling texture of the site's real ground, `period` across, drawn between fade[0]-fade[1] (fading
// in under the splat's edge) and fade[2]-fade[3] (fading out). The sea, at the DEM's zero (seaZ metres in the splat's
// frame, curving down with the earth), stays plain.
interface TerrainDetail {
  texture: number;
  period: number;
  fade: number[];
  seaZ?: number;
  unitsPerMetre?: number;
  earthRadius?: number;
  // Where the terrain's texture is a mosaic of the site's own drone photos (env_build.py photo_mosaic): a texture
  // of its coverage, laid out as the terrain's. There the land already has its real plants, rocks and shading.
  photoMask?: number;
}

// How many samples a texture seen edge-on is filtered with. A headset's GPU pays for each (on a Quest 3 the full 16 took
// about 4 ms of the terrain's 26 a frame) and at its resolution 4 look the same.
export function terrainAnisotropy(renderer: THREE.WebGLRenderer) {
  return Math.min(renderer.capabilities.getMaxAnisotropy(), isHeadsetBrowser() ? 4 : 16);
}

// The shaders' smooth noise as a texture: random values on a grid NOISE_CELLS across (it repeats beyond), eased between
// with the usual smoothstep, stored at NOISE_STEPS texels a cell so that the GPU's own linear filtering (which has only
// 256 steps between texels) doesn't show as bands where one cell fills the screen
const NOISE_CELLS = 256;
const NOISE_STEPS = 4;
function noiseTexture() {
  const cells = NOISE_CELLS;
  const size = cells * NOISE_STEPS;
  const lattice = new Float32Array(cells * cells);
  let seed = 20261116;
  for (let i = 0; i < lattice.length; i++) {
    seed = (seed * 16807) % 2147483647;
    lattice[i] = seed / 2147483647;
  }
  const data = new Uint8Array(size * size);
  const ease = new Float32Array(NOISE_STEPS);
  for (let k = 0; k < NOISE_STEPS; k++) {
    const f = (k + 0.5) / NOISE_STEPS;
    ease[k] = f * f * (3 - 2 * f);
  }
  for (let y = 0; y < size; y++) {
    const j = Math.floor(y / NOISE_STEPS);
    const j1 = (j + 1) % cells;
    const v = ease[y % NOISE_STEPS];
    for (let x = 0; x < size; x++) {
      const i = Math.floor(x / NOISE_STEPS);
      const i1 = (i + 1) % cells;
      const u = ease[x % NOISE_STEPS];
      const top = lattice[j * cells + i] * (1 - u) + lattice[j * cells + i1] * u;
      const bottom = lattice[j1 * cells + i] * (1 - u) + lattice[j1 * cells + i1] * u;
      data[y * size + x] = Math.round(255 * (top * (1 - v) + bottom * v));
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  // (kept for working the same noise out on the CPU: cloudFieldAt)
  texture.userData.lattice = lattice;
  return texture;
}

// The clouds: their base (metres above the site), how big they come (metres), the wind (metres a second), how far
// off they fade into the haze, and how far from the site their shadows start (metres)
const CLOUD_HEIGHT = 1400;
const CLOUD_SIZE = 1600;
const CLOUD_WIND = 7;
const CLOUD_FADE = 45000;
const CLOUD_SHADOW_FROM = 80;
// How sharply the layer's noise turns from clear sky into cloud (see cloudCover)
const CLOUD_EDGE_WIDTH = 0.13;
// In the high-quality mode the clouds have depth (cloudVolume): how thick the layer is (metres), how far each way from
// the site the map of where they stand reaches (metres) and its size (pixels), the size of the billows that eat into
// their sides (metres), and how many steps a ray takes through the layer and toward the sun
const CLOUD_THICK = 1100;
const CLOUD_MAP_HALF = 64000;
const CLOUD_MAP_SIZE = 2048;
const CLOUD_BILLOW = 1300;
const CLOUD_STEPS = 48;
const CLOUD_SUN_STEPS = 5;
// They are drawn to an image of their own with at most this many pixels, whatever the screen's size (each pixel is
// some hundreds of texture lookups), and the sky enlarges it: clouds are soft enough not to show it
const CLOUD_IMAGE_PIXELS = 560000;

// Bruma costera's banks of mist on the terrain: how fast they drift (metres a second), how big they come and how deep
// they lie above the sea (metres), how far one must look through them to see them whole, and their most
const MIST_WIND = 3;
const MIST_BANK = 900;
const MIST_DEPTH = 70;
const MIST_THROUGH = 1500;
const MIST_MOST = 0.7;

// Clouds and the light of the air, shared by the sky and the terrain (TerrainLight's uniforms): a layer of fair-weather
// cumulus CLOUD_HEIGHT up, smooth noise bent by itself, drifting with the wind (from the south-west, as the swell),
// covering more or less of the sky with terrainClouds (0: none). The haze toward the horizon is brighter and warmer
// toward the sun's side (terrainGlow: 0 leaves it the same all around).
// terrainLite (1 in a VR headset, whose GPU draws each pixel many times slower than a computer's): the terrain leaves
// out what costs most for what it shows -- the gullies, the rock mottling -- and the clouds' shadows and the mist take
// the clouds' large shapes without their small ones. Measured on a Quest 3, the full terrain and sky took about as
// long to draw as the splats themselves.
const SKY_LIGHT_GLSL = `
  uniform vec3 terrainSun;
  uniform vec2 terrainSwell;
  uniform float terrainTime;
  uniform float terrainClouds;
  uniform float terrainGlow;
  uniform float terrainLite;
  uniform float terrainQuality;
  uniform float terrainSiteShadow;
  uniform sampler2D terrainNoiseMap;
  // Smooth noise (0 to 1; one random value per unit of p, eased between), read from a texture (noiseTexture): worked
  // out in the shader from four hashed corners, the clouds, the mist and the shore together cost a headset's GPU more
  // than the splats
  float cloudNoise(vec2 p) { return textureLod(terrainNoiseMap, p / ${NOISE_CELLS.toFixed(1)}, 0.0).r; }
  // (the first \`octaves\` of five; the rest count as their mean, so the sum keeps its level)
  float cloudFbm(vec2 p, int octaves) {
    float sum = 0.0, weight = 0.5;
    for (int i = 0; i < octaves; i++) {
      sum += weight * cloudNoise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1;
      weight *= 0.5;
    }
    return sum + (octaves < 5 ? weight - 0.015625 : 0.0);
  }
  float cloudFbm(vec2 p) { return cloudFbm(p, 5); }
  // How much cloud covers a point of the layer (metres across the viewer's frame from the site); \`soft\`: only the
  // clouds' large shapes, for where they are seen blurred anyway (their shadows, their reflection in the sea)
  // (the layer's noise there, and the level above which it is cloud)
  float cloudField(vec2 p, bool soft) {
    vec2 q = (p - terrainSwell * ${CLOUD_WIND.toFixed(1)} * terrainTime) / ${CLOUD_SIZE.toFixed(1)};
    return soft ? cloudFbm(q + 0.7 * cloudFbm(q * 0.5 + 1.7, 2), 3) : cloudFbm(q + 0.7 * cloudFbm(q * 0.5 + 1.7));
  }
  float cloudEdge() { return mix(0.7, 0.48, terrainClouds); }
  float cloudCover(vec2 p, bool soft) {
    float edge = cloudEdge();
    return smoothstep(edge, edge + ${CLOUD_EDGE_WIDTH.toFixed(2)}, cloudField(p, soft));
  }
  float cloudCover(vec2 p) { return cloudCover(p, false); }
  // The haze's colour along a direction, over its colour all around (1: the same)
  vec3 terrainHazeTint(vec3 toward) {
    vec2 a = normalize(toward.xz + 1e-5), b = normalize(terrainSun.xz + 1e-5);
    float side = 0.5 + 0.5 * dot(a, b);
    return mix(vec3(1.0), mix(vec3(0.8, 0.87, 0.98), vec3(1.32, 1.18, 0.97), side * side), terrainGlow);
  }`;

// The high-quality mode's clouds (terrainQuality): the same layer given depth, and lit. Each cloud stands on a flat
// base at CLOUD_HEIGHT and rises the higher the further inside its outline (cloudFieldMap: the layer's noise for
// CLOUD_MAP_HALF around the site, drawn each frame by createVolumeClouds, so a point costs one lookup instead of ten),
// with billows eaten out of its sides (cloudDetailMap, a tiling 3D texture). A ray from the eye steps through the
// layer; at each step inside a cloud a few steps toward the sun find how much cloud the light has come through, so
// the sunward sides are bright, the far sides and the bases grey, and thin edges before the sun glow.
// createVolumeClouds draws them to an image (cloudImage) that the sky lays over the panorama.
const SKY_VOLUME_GLSL = `
  uniform sampler2D cloudFieldMap;
  uniform highp sampler3D cloudDetailMap;
  uniform float cloudSkyTone;
  // How much cloud at a point (0 to 1): p metres across from the site, h from the layer's base (0) to its top (1)
  float cloudDensity(vec2 p, float h, bool fine) {
    if (h <= 0.0 || h >= 1.0) return 0.0;
    float s = (textureLod(cloudFieldMap, p / ${(2 * CLOUD_MAP_HALF).toFixed(1)} + 0.5, 0.0).r - cloudEdge()) / ${CLOUD_EDGE_WIDTH.toFixed(2)};
    if (s <= 0.0) return 0.0;
    // (small clouds stay low, large ones tower; flat underneath, rounded on top)
    float top = min(0.22 + 0.36 * s, 1.0);
    float body = min(0.8 * s, 1.0) * smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(0.3 * top, top, h));
    if (fine && body > 0.0) {
      vec2 drift = p - terrainSwell * ${CLOUD_WIND.toFixed(1)} * terrainTime;
      vec3 q = vec3(drift.x, h * ${CLOUD_THICK.toFixed(1)}, drift.y) / ${CLOUD_BILLOW.toFixed(1)};
      float billow = 0.55 * textureLod(cloudDetailMap, q, 0.0).r + 0.3 * textureLod(cloudDetailMap, q * 2.9 + 0.37, 0.0).r
        + 0.15 * textureLod(cloudDetailMap, q * 7.3 + 0.71, 0.0).r;
      // (more from the tops and sides than from the flat base)
      float eaten = 0.8 * (1.0 - billow) * (0.35 + 0.65 * smoothstep(0.0, 0.4, h));
      body = max(body - eaten * (1.0 - 0.6 * body), 0.0);
    }
    // (the middle of a cloud is as thick as its sides, only wider)
    return smoothstep(0.0, 0.3, body);
  }
  // The clouds along a direction from the site (d, with \`up\` its height): their colour, how much of the sky behind
  // they hide, and (far) about how far off they are
  vec4 cloudVolume(vec3 d, float up, out float far) {
    float enter = ${CLOUD_HEIGHT.toFixed(1)} / up;
    far = enter;
    if (enter > ${(0.95 * CLOUD_MAP_HALF).toFixed(1)}) return vec4(0.0);
    float leave = min(${(CLOUD_HEIGHT + CLOUD_THICK).toFixed(1)} / up, ${(0.95 * CLOUD_MAP_HALF).toFixed(1)});
    // Long steps through clear air; on meeting a cloud, back one step and on through it in short ones
    float stride = (leave - enter) / ${CLOUD_STEPS.toFixed(1)};
    // (each pixel starts a little further along than its neighbour, so the steps don't show as bands)
    float t = enter + stride * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float sunUp = max(-terrainSun.y, 0.1);
    float towardSun = dot(d, terrainSun);
    // What a metre of cloud takes from the light passing through
    const float thick = 0.011;
    float through = 1.0, farSum = 0.0;
    vec3 colour = vec3(0.0);
    bool inCloud = false;
    int clear = 0;
    for (int i = 0; i < ${Math.round(3.5 * CLOUD_STEPS)}; i++) {
      if (t > leave) break;
      // (short steps: a quarter of a long one, or less far off, where a long one is hundreds of metres)
      float fine = min(0.25 * stride, max(20.0, 0.004 * t));
      vec2 p = d.xz * t;
      float h = (t * up - ${CLOUD_HEIGHT.toFixed(1)}) / ${CLOUD_THICK.toFixed(1)};
      float density = cloudDensity(p, h, true);
      if (density > 0.002) {
        if (!inCloud) {
          inCloud = true;
          clear = 0;
          t = max(t - stride, enter);
          continue;
        }
        clear = 0;
        float before = 0.0, reach = 40.0, along = 0.0;
        for (int j = 0; j < ${CLOUD_SUN_STEPS}; j++) {
          along += 0.5 * reach;
          before += reach * cloudDensity(p + terrainSun.xz * along, h + sunUp * along / ${CLOUD_THICK.toFixed(1)}, j < 1);
          along += 0.5 * reach;
          reach *= 1.7;
        }
        // (light scattered many times inside the cloud still gets through where the direct beam doesn't)
        float sunlight = max(exp(-thick * before), 0.3 * exp(-0.15 * thick * before));
        // The cloud's own colour: grey-blue in its shade and underneath, white in the sun
        // (against a blue sky; under a white one, photographed on an overcast day, only a little darker than it)
        vec3 shade = mix(vec3(0.2, 0.22, 0.27), vec3(0.42, 0.47, 0.57), smoothstep(0.0, 0.7, h));
        shade = mix(shade, vec3(0.62, 0.64, 0.68) + 0.22 * h, smoothstep(0.45, 0.8, cloudSkyTone));
        vec3 lit = mix(shade, vec3(1.02, 1.0, 0.97), sunlight);
        // Thin cloud before the sun shines through
        lit += vec3(1.0, 0.94, 0.82) * 1.4 * pow(max(towardSun, 0.0), 12.0) * sunlight * sunlight;
        float taken = 1.0 - exp(-thick * density * fine);
        colour += through * taken * lit;
        farSum += through * taken * t;
        through *= 1.0 - taken;
        if (through < 0.03) break;
      } else if (inCloud && ++clear > 6) {
        inCloud = false;
      }
      t += inCloud ? fine : stride;
    }
    float hidden = 1.0 - through;
    if (hidden < 1e-4) return vec4(0.0);
    far = farSum / hidden;
    return vec4(colour / hidden, hidden);
  }`;

// The sky: below the clouds, the haze near the horizon tinted toward the sun's side; the clouds, their side toward the
// sun lit and their far side grey, thin edges near the sun shining through, fading into the haze far off; the sun's
// disc and its glow, which the clouds hide
const SKY_HEADER = `
  uniform sampler2D cloudImage;
  uniform vec2 cloudImagePixel;`;
const SKY_FRAGMENT = `{
    // The panorama's gradient, smoothed up and down: the photos' sky has a kink where they stop looking up, which
    // showed as a pale arc across the sky
    vec3 smoothSky = vec3(0.0);
    for (int i = -3; i <= 3; i++) smoothSky += texture2D(map, vMapUv + vec2(0.0, float(i) * 0.014)).rgb;
    diffuseColor.rgb = diffuse * smoothSky / 7.0;
    vec3 d = normalize(vSkyDirection);
    float up = -d.y;
    diffuseColor.rgb *= mix(terrainHazeTint(d), vec3(1.0), smoothstep(0.0, 0.45, up));
    float cover = 0.0;
    if (terrainClouds > 0.0 && up > 0.0 && terrainQuality > 0.5) {
      // The high-quality clouds, from their image (their colour times how much of the sky they hide, and that)
      vec4 volume = texture2D(cloudImage, gl_FragCoord.xy * cloudImagePixel);
      diffuseColor.rgb = diffuseColor.rgb * (1.0 - volume.a) + volume.rgb;
      cover = volume.a;
    } else if (terrainClouds > 0.0 && up > 0.0) {
      float far = ${CLOUD_HEIGHT.toFixed(1)} / max(up, 0.015);
      vec2 p = d.xz * far;
      cover = cloudCover(p);
      float sunward = cloudCover(p + normalize(terrainSun.xz + 1e-5) * 220.0, terrainLite > 0.5);
      float lit = clamp(0.7 + 2.2 * (cover - sunward), 0.0, 1.0);
      vec3 cloud = mix(vec3(0.5, 0.55, 0.63), vec3(1.0, 0.98, 0.95), lit);
      cloud += vec3(1.0, 0.95, 0.85) * pow(max(dot(d, terrainSun), 0.0), 10.0) * (1.0 - cover) * 1.2;
      cloud = mix(diffuseColor.rgb, cloud, 0.45 + 0.55 * exp(-far / 15000.0));
      cover *= smoothstep(0.0, 0.07, up) * exp(-far / ${CLOUD_FADE.toFixed(1)});
      diffuseColor.rgb = mix(diffuseColor.rgb, cloud, cover);
    }
    float toSun = max(dot(d, terrainSun), 0.0);
    diffuseColor.rgb += terrainGlow * (1.0 - cover) * (vec3(1.0, 0.93, 0.8) * (0.55 * pow(toSun, 60.0) + 0.22 * pow(toSun, 6.0))
      + vec3(6.0) * smoothstep(0.99996, 0.99999, toSun));
  }`;

const TERRAIN_DETAIL_HEADER = `
  uniform sampler2D detailMap;
  uniform vec4 detailFade;
  uniform float detailPeriod;
  uniform float detailPhoto;
  uniform sampler2D photoMask;
  uniform vec3 detailSea;
  uniform sampler2D scrubMap;
  uniform vec4 scrubInfo;
  uniform vec3 scrubGain;
  uniform vec3 scrubNear;
  uniform vec2 scrubReach;
  uniform sampler2D scrubGrain;
  uniform float scrubGrainPeriod;
  varying vec3 vTerrainPosition;
  float detailHash(vec2 i) { return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453); }
  float detailNoise(vec2 p) { return cloudNoise(p); }
  uniform float terrainDay;
  uniform float terrainSand;
  uniform float terrainMist;
  uniform vec3 terrainEye;
  uniform sampler2D terrainSky;
  uniform vec3 terrainAir;
  uniform vec3 terrainWater;
  uniform sampler2D seaNormals;
  uniform sampler2D seaFoam;
  uniform vec3 scrubBare;
  varying vec3 vTerrainNormal;
  varying vec2 vTerrainShore;
  // detailNoise and its slope
  vec3 terrainNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    float a = detailHash(i), b = detailHash(i + vec2(1.0, 0.0));
    float c = detailHash(i + vec2(0.0, 1.0)), d = detailHash(i + vec2(1.0, 1.0));
    return vec3(mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
                du.x * (b - a + (a - b - c + d) * u.y), du.y * (c - a + (a - b - c + d) * u.x));
  }
  // Gullies down the hillsides: stripes running down the fall line (\`down\`), in jittered cells blended smoothly, so
  // they bend with the slope without seams. The height (-1 to 1) and its slope per cell.
  vec3 terrainGullies(vec2 p, vec2 down) {
    vec2 across = vec2(-down.y, down.x);
    vec2 i = floor(p), f = fract(p);
    vec3 sum = vec3(0.0);
    float weights = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 cell = vec2(float(x), float(y));
        vec2 r = f - cell - vec2(detailHash(i + cell), detailHash(i + cell + 31.7));
        float w = exp(-1.6 * dot(r, r));
        float phase = 6.2832 * (2.0 * dot(r, across) + detailHash(i + cell + 7.1));
        sum += w * vec3(cos(phase), -12.566 * sin(phase) * across);
        weights += w;
      }
    }
    return sum / weights;
  }
  float terrainFresnel(float c) { return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }`;

// The texture holds colour over its mean, halved, so mipmaps fade it to no change far off. Two samplings at different
// scales and angles, chosen by smooth noise (keeping the contrast where they blend), hide its repeats. Steep slopes
// get none, since it is projected from above and would streak there.
// Scrub (scrubMap, see effects/scrub.ts): the plants that stand on the land near the site, seen from above, and
// their shadows, as a tiling map of what's left of the ground's light (scrubInfo: its period in metres, where it
// fades in from the site's centre in viewer units, and its strength). Far off it is divided by its mean (scrubGain),
// so the land there, where the map blurs to its mean, is unchanged. At the splat's edge it is scaled instead so its
// bare ground has the colour of the splat's own (scrubNear), easing to the other over scrubReach (viewer units):
// from close by one looks down on the sand between the plants, which far off hide it. A second, much smaller tile
// (scrubGrain, its period in metres) is the pebbles seen from up close, divided by its own mean.
// env_build.py's aerial perspective: its e-folding distance (metres), its default (--haze-km 8) for every site
const HAZE_METRES = 8000;
// The share of the light on level ground that comes from the sky rather than the sun
const AMBIENT = 0.35;
// The sea's own colour, under the sky's reflection: the open sea in the second batch's drone photos looking down at it
// (sRGB 50-75, 95-110, 140-160), a little darker for the sky's share
const WATER_COLOUR = '#2f5884';
const SEA_NORMALS_URL = '/textures/sea_normals.png';
const SEA_FOAM_URL = '/textures/sea_foam.png';
// The sea's slopes: their spread in each of the four layers of seaNormals (a wind sea of 4-5 m/s overall), and the
// water's colour over rocks and sand by the shore, from the second batch's drone photos
const SEA_SLOPE = 0.045;
const SEA_SHALLOW = 'vec3(0.02, 0.085, 0.1)';
// How much darker rock outcrops are than the sand between, and how steeply they stand (see TERRAIN_LIGHT_FRAGMENT)
const ROCK_CONTRAST = 0.2;
const ROCK_RELIEF = 6;
// Gullies on the hillsides: their cells (metres; two gullies a cell) and depth (metres)
const GULLY_CELL = 44;
const GULLY_DEPTH = 2;
// With the atmosphere, how much more sea air the far land is seen through, and over what distance (metres)
const DEPTH_HAZE = 0.4;
const DEPTH_HAZE_METRES = 4000;
// The shoreline: the land's height above the sea where the still water ends (metres; above the heights the pipeline
// squeezes toward sea level, so the baked colours there are the land's), how far a wave runs up the shore, and how
// far out the sand shows through the water (metres along the ground)
const SHORE_HEIGHT = 1.15;
const SWASH_REACH = 2.5;
const SHALLOW_METRES = 5;
// Plants stand as cards out to about here (metres; effects/scrub.ts SCRUB.reach)
const SCRUB_CARDS = 120;
// Sea vertices further than this from the land (metres) count as this far, for the surf
const COAST_FAR = 1000;
// White water the satellite saw counts as surf this near the land (metres): further out it's a boat's wake or glare
const SURF_REACH = 200;

// Sunlight and the sea (TerrainLight's uniforms). The baked colours are of level ground under the photos' sun, hazed
// toward the horizon colour with distance from the site (env_build.py --haze-km); here the land's slopes are lit by
// that sun (smooth normals, relative to level ground, so level land keeps its colour), beyond the splat's edge, before
// the haze. The sea is drawn here instead of baked: waves (trains around the swell's direction and drifting ripples,
// each fading out as it shrinks under a few pixels, what's lost becoming roughness), the sky reflected off them by
// Fresnel, the sun's glitter, the water's own dark colour, and surf: crests running in to the shore and a band of
// white water along it (vTerrainShore: metres from the land, and how much white water the satellite saw there),
// and the shoreline itself: a sharp, moving water's edge with wet sand above it and the sand showing through the
// shallows.
const TERRAIN_LIGHT_FRAGMENT = `
    vec3 haze = diffuse * terrainAir * (1.0 - exp(-rm / ${HAZE_METRES.toFixed(1)}));
    vec3 slopeNormal = normalize(vTerrainNormal);
    slopeNormal *= slopeNormal.y > 0.0 ? -1.0 : 1.0;
    vec3 smoothNormal = slopeNormal;
    // Rock and sand at the few metres the satellite's 10 m pixels can't show, from past the splat's edge to a couple
    // of kilometres: outcrops darker and standing out of the sand (their sides lit or not), each scale fading out as
    // a pixel grows past it
    float rocky = land * smoothstep(detailFade.y, detailFade.y + 20.0 * detailSea.y, r) * (1.0 - smoothstep(1500.0, 3000.0, rm))
      * beyondPhoto * (1.0 - terrainLite);
    if (rocky > 0.0 && foot < 24.0) {
      vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * pm;
      float big = 1.0 - smoothstep(6.0, 24.0, foot);
      float small = 1.0 - smoothstep(2.0, 8.0, foot);
      vec3 large = terrainNoise(q / 26.0), fine = terrainNoise(q / 8.0 + 7.3);
      float outcrop = (large.x - 0.5) * big + 0.6 * (fine.x - 0.5) * small;
      diffuseColor.rgb *= 1.0 - ${ROCK_CONTRAST.toFixed(2)} * rocky * clamp(outcrop * 3.0, -1.0, 1.0);
      vec2 bump = large.yz * big / 26.0 + 0.6 * fine.yz * small / 8.0;
      bump = mat2(0.8, 0.6, -0.6, 0.8) * bump * ${ROCK_RELIEF.toFixed(1)} * rocky;
      slopeNormal = normalize(slopeNormal + vec3(-bump.x, 0.0, -bump.y));
    }
    // Gullies down the slopes, which the elevation data's 30 m can't hold: two sizes, lit by the sun, their bottoms a
    // little darker, each fading as a pixel grows past it. Not on level land, nor near the site, where the
    // reconstruction has the real ones.
    float steep = length(smoothNormal.xz);
    float gullied = land * smoothstep(0.06, 0.3, steep) * smoothstep(detailFade.y, detailFade.y + 15.0 * detailSea.y, r)
      * (1.0 - smoothstep(2500.0, 5000.0, rm)) * beyondPhoto * (1.0 - terrainLite);
    float seeWide = 1.0 - smoothstep(${(GULLY_CELL / 10).toFixed(1)}, ${(GULLY_CELL / 3).toFixed(1)}, foot);
    float seeNarrow = 1.0 - smoothstep(${(GULLY_CELL / 30).toFixed(2)}, ${(GULLY_CELL / 9).toFixed(2)}, foot);
    if (gullied > 0.0 && seeWide > 0.0) {
      vec2 down = normalize(smoothNormal.xz);
      vec3 wide = terrainGullies(pm / ${GULLY_CELL.toFixed(1)}, down);
      vec3 narrow = seeNarrow > 0.0 ? terrainGullies(pm / ${(GULLY_CELL / 3).toFixed(1)} + 13.0, down) : vec3(0.0);
      vec2 grad = ${GULLY_DEPTH.toFixed(2)} * gullied * (wide.yz * seeWide / ${GULLY_CELL.toFixed(1)}
        + 0.25 * narrow.yz * seeNarrow / ${(GULLY_CELL / 3).toFixed(1)});
      slopeNormal = normalize(slopeNormal + vec3(-grad.x, 0.0, -grad.y));
      diffuseColor.rgb *= 1.0 - 0.14 * gullied * (seeWide * max(-wide.x, 0.0) + 0.5 * seeNarrow * max(-narrow.x, 0.0));
    }
    // The shoreline. The mesh's shore is one row of triangles tens of metres wide, from a vertex at sea level to one
    // on land, and blending water into land by height over it gave a smooth smear instead of a shore. Here the
    // water's edge is a sharp line: where the land stands SHORE_HEIGHT above the sea, measured in metres along the
    // ground (height over the smooth slope, so it is continuous across triangles), bent by noise so it isn't the
    // mesh's polyline, and moved by the swash: every few seconds a wave runs a couple of metres up the shore and
    // drains back, at its own moment along each stretch. Above it the sand is wet and dark as far as the waves reach.
    float shoreSlope = max(length(smoothNormal.xz) / max(abs(smoothNormal.y), 0.05), 2e-3);
    float shoreGentle = min(1.0, 0.25 / shoreSlope);
    float fromShore = (aboveSea - ${SHORE_HEIGHT.toFixed(2)}) / shoreSlope;
    float edgeBlur = max(0.75 * foot, 0.04);
    float swashWave = 1.0, fromWater = fromShore, shoreLand = 1.0;
    // (only near the water's height: the bends, the swash and the wet sand together reach under 16 m up the shore,
    // and most of the land is far above that)
    if (fromShore < 16.0 + edgeBlur) {
      fromShore += shoreGentle * (10.0 * (detailNoise(pm / 55.0 + 4.0) - 0.5) + 4.0 * (detailNoise(pm / 14.0) - 0.5)
        + 1.5 * (detailNoise(pm / 3.5 + 9.0) - 0.5));
      swashWave = fract(terrainTime / 9.0 + 2.0 * detailNoise(pm / 40.0));
      float swash = swashWave < 0.25 ? smoothstep(0.0, 0.25, swashWave) : 1.0 - smoothstep(0.25, 1.0, swashWave);
      fromWater = fromShore - ${SWASH_REACH.toFixed(1)} * shoreGentle * swash;
      shoreLand = smoothstep(-edgeBlur, edgeBlur, fromWater);
      float wetSand = 1.0 - smoothstep(${SWASH_REACH.toFixed(1)} * shoreGentle + 0.3, ${SWASH_REACH.toFixed(1)} * shoreGentle + 3.0,
        fromShore + 1.5 * (detailNoise(pm / 6.0) - 0.5));
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.6, 0.63, 0.68), wetSand);
    }
    float sunUp = max(-terrainSun.y, 0.1);
    // With the atmosphere the sun's light is warm and the sky's cool
    vec3 sunColour = mix(vec3(1.0), vec3(1.07, 1.0, 0.9), terrainGlow);
    vec3 skyLight = mix(vec3(1.0), vec3(0.86, 0.95, 1.14), terrainGlow);
    vec3 lit = (${AMBIENT.toFixed(2)} * skyLight + ${(1 - AMBIENT).toFixed(2)} * max(dot(slopeNormal, terrainSun), 0.0) * sunColour)
      / (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * sunUp);
    float shaded = terrainDay * land * smoothstep(detailFade.y, detailFade.y + 40.0 * detailSea.y, r) * beyondPhoto;
    // The clouds' shadows drift over the land (not near the site: the splat's own light is fixed). Where the sun is
    // hidden only the sky's light is left, a little bluer.
    float shadowed = 0.0;
    // (in the high-quality mode they cross the site too: sceneEffects.ts shades the splats to match)
    // (as strongly as the site's own shadows are, terrainSiteShadow: weakly where it was photographed under cloud)
    float shadowsFall = terrainDay * max(terrainQuality * terrainSiteShadow, smoothstep(${CLOUD_SHADOW_FROM.toFixed(1)}, ${(2.5 * CLOUD_SHADOW_FROM).toFixed(1)}, rm));
    if (terrainClouds > 0.0 && shadowsFall > 0.0) {
      float aboveSite = -vTerrainPosition.y / detailSea.y;
      vec2 underCloud = pm + terrainSun.xz / sunUp * (${CLOUD_HEIGHT.toFixed(1)} - aboveSite);
      shadowed = cloudCover(underCloud, terrainLite > 0.5) * shadowsFall;
    }
    vec3 shadowLight = mix(vec3(1.0), vec3(0.92, 0.97, 1.12) * ${AMBIENT.toFixed(2)}
      / (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * sunUp), shadowed);
    // The land itself, out of the haze baked over it, lit
    // (taken out only as far as the haze leaves a quarter of it: further, dividing by it blew up the texture's noise)
    float transmit = max(exp(-rm / ${HAZE_METRES.toFixed(1)}), 0.25);
    vec3 ground = max(diffuseColor.rgb - haze, 0.0) / transmit;
    ground *= mix(vec3(1.0), clamp(lit, 0.3, 1.7), shaded) * mix(vec3(1.0), shadowLight, land);
    // Pale sand (the dunes inland of the bays) keeps a sand colour, its brightness eased and warm: plain, it came out
    // a colourless white that read as snow
    float bright = dot(ground, vec3(0.2126, 0.7152, 0.0722));
    float overBright = max(bright - 0.45, 0.0);
    float keptBright = bright - overBright * overBright / (overBright + 0.3);
    vec3 sand = ground * keptBright / max(bright, 1e-4);
    // (by terrainSand: slight where the site's own sand is as pale and the land must meet the splat's, strong where a
    // far dune, bluish in the haze, read as snow)
    sand = mix(sand, keptBright * vec3(1.2, 1.0, 0.72), terrainSand * smoothstep(0.24, 0.5, bright));
    ground = mix(ground, sand, shaded);
    // The haze is brighter and warmer toward the sun and bluer away from it, not the same all around, and with the
    // atmosphere the sea air thickens with distance, so ridge after ridge steps back
    vec3 hazeTint = terrainHazeTint(-toEye);
    diffuseColor.rgb = haze * mix(vec3(1.0), hazeTint, land) + ground * transmit;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * terrainAir * hazeTint,
      land * terrainGlow * ${DEPTH_HAZE.toFixed(2)} * (1.0 - exp(-rm / ${DEPTH_HAZE_METRES.toFixed(1)})));
    if (shoreLand < 1.0) {
      // Patches of rougher and calmer water drift over the sea
      float gust = 0.6 + 0.8 * detailNoise(pm / 180.0 + terrainSwell * terrainTime * 0.01);
      // The waves: the sea's slopes (seaNormals) at four scales, each turned a little off the swell and drifting at
      // its waves' own speed. What a pixel can't show is averaged away in the texture's smaller copies and comes
      // back as roughness (B holds the slopes' squared length, which averages to their spread).
      vec2 slope = vec2(0.0);
      float rough = 0.006;
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float size = 52.0 * pow(0.36, fi);
        float turn = (fi - 1.5) * 0.22;
        vec2 dir = mat2(cos(turn), sin(turn), -sin(turn), cos(turn)) * terrainSwell;
        vec2 across = vec2(-dir.y, dir.x);
        vec2 uv = vec2(dot(pm, dir), dot(pm, across)) / size + vec2(fi * 0.37, fi * 0.61)
          - vec2(terrainTime * sqrt(9.81 * size / 37.7) / size, 0.0);
        vec3 t = texture2D(seaNormals, uv).rgb;
        vec2 st = t.rg * 2.0 - 1.0;
        float spread = ${SEA_SLOPE.toFixed(3)} * 3.0 * gust;
        slope += (dir * st.x + across * st.y) * spread;
        rough += max(2.0 * t.b - dot(st, st), 0.0) * 0.5 * spread * spread;
      }
      vec3 waveNormal = normalize(vec3(-slope.x, -1.0, -slope.y));
      float facing = max(dot(waveNormal, toEye), 1e-3);
      // Seen from low down, the facets turned away hide behind the crests in front of them, and those too small to
      // see are mostly the ones that face the eye: a rough sea reflects much less of the sky than a mirror would
      float fresnel = terrainFresnel(max(cos(max(acos(facing) - atan(sqrt(rough)), 0.0)), 0.28));
      vec3 mirrored = reflect(-toEye, waveNormal);
      // (and those reflect the sky higher up)
      float skyUp = asin(clamp(-mirrored.y, 0.004, 1.0)) + atan(sqrt(rough));
      vec3 skyColour = textureLod(terrainSky, vec2(0.25, 0.5 + skyUp / 3.14159), 0.0).rgb * terrainHazeTint(mirrored);
      // ... and the clouds in it
      if (terrainClouds > 0.0) {
        float mirroredUp = max(-mirrored.y, 0.02);
        float far = ${CLOUD_HEIGHT.toFixed(1)} / mirroredUp;
        float reflected = cloudCover(pm + mirrored.xz * far, terrainLite > 0.5) * smoothstep(0.0, 0.08, mirroredUp) * exp(-far / ${CLOUD_FADE.toFixed(1)});
        skyColour = mix(skyColour, vec3(0.8, 0.82, 0.86), reflected);
      }
      vec3 halfway = normalize(terrainSun + toEye);
      float nh = max(dot(waveNormal, halfway), 1e-3);
      float m2 = 2.0 * rough;
      float facets = exp(-(1.0 - nh * nh) / (nh * nh * m2)) / (3.14159 * m2 * nh * nh * nh * nh);
      // (over the sea's level, not the wave's: a wave's back seen edge-on would blow it up)
      float glitter = terrainDay * step(0.0, -terrainSun.y) * facets * terrainFresnel(dot(toEye, halfway))
        / (4.0 * max(-toEye.y, 0.1)) * 3.14159 / sunUp;
      // The water's own colour: turquoise over the rocks and sand by the shore, deep blue out from it
      float coast = vTerrainShore.x;
      vec3 body = mix(${SEA_SHALLOW}, terrainWater, smoothstep(2.0, 14.0, coast + 8.0 * (detailNoise(pm / 25.0) - 0.5)));
      // At the edge the water is a few centimetres deep and the sand shows through it, wet and greenish, deepening
      // into the water's own colour over a few metres
      body = mix(diffuseColor.rgb * vec3(0.6, 0.78, 0.76), body, 1.0 - exp(-max(-fromWater, 0.0) / ${SHALLOW_METRES.toFixed(1)}));
      vec3 water = body * (1.0 - 0.3 * shadowed) * (1.0 - fresnel) + skyColour * fresnel
        + min(0.5 * glitter, 2.5) * (1.0 - shadowed);
      // White water where it would be: breaking waves where the satellite saw white water (reefs, points) and,
      // gentler, along every shore -- lines running in parallel to the shore, each a bright front with foam trailing
      // out behind it, thinning into lace (seaFoam) -- and a few
      // whitecaps out at sea where the wind gusts. Soft-edged and never quite opaque: hard white flakes over the
      // whole surf zone looked like broken ice. Far off, where a pixel spans a line, it blurs into its average.
      float lace = 0.6 * texture2D(seaFoam, pm / 11.0 + vec2(terrainTime * 0.012, 0.0)).r
        + 0.4 * texture2D(seaFoam, mat2(0.8, 0.6, -0.6, 0.8) * pm / 3.7 - vec2(0.0, terrainTime * 0.02)).r;
      // (the satellite's white water fades out away from the shore: further out it's a reef's or a boat's)
      float breaking = max(vTerrainShore.y * (1.0 - smoothstep(50.0, 140.0, coast)),
        0.4 * (1.0 - smoothstep(4.0, 18.0, coast)));
      float behind = fract((coast + 2.2 * terrainTime) / 24.0 + 1.2 * detailNoise(pm / 60.0));
      float front = 1.0 - smoothstep(0.0, 0.06, behind) + smoothstep(0.97, 1.0, behind);
      // The foam's density: a breaking front, broken along its length, and the lace it leaves behind
      float density = breaking * (front * (0.35 + 0.65 * lace) + exp(-4.0 * behind) * lace);
      // (on open water only: over a flat beach's shallows the mesh gives no distance to run the fronts along, and
      // they pulsed in place)
      float openWater = 1.0 - smoothstep(0.15, 0.3, aboveSea);
      float surf = smoothstep(0.3, 0.65, density) * openWater;
      // (No foam drawn along the water's edge itself. As lace wherever the mesh was within 2 m of land it covered
      // flat shores with a still, cracked white sheet, "like broken ice"; as a thin line at the water's height it was
      // a static white line out in the shallows. The moving fronts are the shore's foam.)
      float caps = 0.015 * smoothstep(0.85, 1.3, gust);
      float whitecaps = smoothstep(1.0 - caps, 1.0 - caps + 0.1, lace) * step(0.002, caps);
      float foam = mix(max(surf, whitecaps), 0.12 * breaking * openWater + 0.5 * caps, smoothstep(1.0, 5.0, foot));
      // The swash's own foam: lace at the edge of the water while a wave runs up, gone as it drains; only from
      // near enough to see it move (from far off it would be a still white line again)
      float rushing = 1.0 - smoothstep(0.2, 0.45, swashWave);
      foam = max(foam, 0.7 * rushing * (1.0 - smoothstep(0.0, 1.5, -fromWater)) * smoothstep(0.3, 0.6, lace)
        * (1.0 - smoothstep(0.4, 1.2, foot)));
      // The water churned up inside the surf, a little milky
      water = mix(water, water * 0.85 + vec3(0.04, 0.05, 0.05), 0.4 * breaking * openWater * exp(-3.0 * behind));
      water = mix(water, vec3(0.7, 0.72, 0.72), 0.8 * clamp(foam, 0.0, 1.0));
      water = water * diffuse * exp(-rm / ${HAZE_METRES.toFixed(1)}) + haze * hazeTint;
      diffuseColor.rgb = mix(water, diffuseColor.rgb, shoreLand);
    }
    // Bruma costera: thin mist lying low over the sea and the coast in banks that drift in with the wind and slowly
    // change shape, thicker the further one looks through it
    if (terrainMist > 0.0) {
      float throughMetres = length(terrainEye - vTerrainPosition) / detailSea.y;
      float mist = terrainMist * exp(-max(aboveSea, 0.0) / ${MIST_DEPTH.toFixed(1)})
        * (1.0 - exp(-throughMetres / ${MIST_THROUGH.toFixed(1)}));
      // (not where even a whole bank would change the colour by less than a step: close by, and high up)
      if (mist > 0.006) {
        vec2 drift = (pm - terrainSwell * ${MIST_WIND.toFixed(1)} * terrainTime) / ${MIST_BANK.toFixed(1)};
        float banks = smoothstep(0.38, 0.72, 0.7 * cloudFbm(drift + terrainTime * 0.002, terrainLite > 0.5 ? 2 : 5)
          + 0.3 * cloudNoise(drift * 4.3 + 2.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * vec3(0.72, 0.75, 0.78) * mix(0.3, 1.0, terrainDay),
          ${MIST_MOST.toFixed(2)} * mist * banks);
      }
    }`;

const TERRAIN_DETAIL_FRAGMENT = `{
    // The eye, and about how big a pixel is on the water (metres)
    vec3 toEye = normalize(terrainEye - vTerrainPosition);
    vec2 pm = vTerrainPosition.xz / detailSea.y;
    float foot = max(length(fwidth(pm)), 1e-3);
    float r = length(vTerrainPosition.xz);
    float rm = r / detailSea.y;
    float aboveSea = -vTerrainPosition.y / detailSea.y - detailSea.x + rm * rm / (2.0 * detailSea.z);
    vec3 normal = normalize(cross(dFdx(vTerrainPosition), dFdy(vTerrainPosition)));
    float land = smoothstep(0.3, 1.5, aboveSea);
    float level = smoothstep(0.6, 0.85, abs(normal.y));
    float k = smoothstep(detailFade.x, detailFade.y, r) * (1.0 - smoothstep(detailFade.z, detailFade.w, r)) * land * level;
    vec2 p = vTerrainPosition.xz / detailPeriod;
    vec2 pb = mat2(0.6, 0.8, -0.8, 0.6) * p * 0.73 + vec2(0.37, 0.61);
    vec3 a = texture2D(detailMap, p).rgb * 2.0 - 1.0;
    vec3 b = texture2D(detailMap, pb).rgb * 2.0 - 1.0;
    float w = smoothstep(0.25, 0.75, detailNoise(p * 2.3));
    vec3 d = (a * (1.0 - w) + b * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
    // The grain is the ground round the site as its photos saw it from above. Laid over land seen from low down or
    // from far off it is a flat print stretched into streaks, and every hill wears the site's own stones: there it
    // fades to a trace (by how far it is from the eye, and by how much ground a pixel covers, between its long and
    // short sides)
    vec2 px = dFdx(pm), py = dFdy(pm);
    float covered = sqrt(foot * sqrt(max(abs(px.x * py.y - px.y * py.x), 1e-8)));
    float fromEye = length(terrainEye - vTerrainPosition) / detailSea.y;
    k *= mix(0.12, 1.0, (1.0 - smoothstep(0.05, 0.3, covered)) * (1.0 - smoothstep(20.0, 55.0, fromEye)));
    // Where the texture is the drone photos' own mosaic, the land has its real plants, rocks, gullies and sunlight:
    // the scrub map, the mottling, the gullies and the slopes' shading only come in beyond it
    float beyondPhoto = 1.0 - detailPhoto * texture2D(photoMask, vMapUv).r;
    float ks = smoothstep(scrubInfo.y, scrubInfo.z, r) * land * level * scrubInfo.w * beyondPhoto;
    // The scrub map's plants as seen from above only show when the eye looks down steeply onto them: from lower
    // down they'd lie on the land like stickers (the cut-out cards stand there instead). Beyond the cards, the map
    // pales and blurs into the land's grain.
    float fromAbove = smoothstep(0.3, 0.6, -toEye.y);
    float beyond = smoothstep(${SCRUB_CARDS.toFixed(1)}, ${(3 * SCRUB_CARDS).toFixed(1)}, rm);
    // Where the map draws the bushes, the detail's own blotches of them step back
    diffuseColor.rgb *= max(1.0 + d * k * (1.0 - 0.7 * ks * fromAbove), 0.0);
    if (ks > 0.0) {
      vec2 sm = vec2(vTerrainPosition.x, -vTerrainPosition.z) / (detailSea.y * scrubInfo.x);
      vec3 gain = mix(scrubNear, scrubGain, smoothstep(scrubReach.x, scrubReach.y, r));
      // (seen from low down: the bare ground between the cards near the site, the map's mean beyond them, so the
      // colours still meet the splat's at its edge and keep the satellite's far off)
      vec3 plants = texture2D(scrubMap, sm, 2.5 * beyond).rgb;
      // (from above too, past the nearest plants they show at half strength: at full they read as a dotted carpet)
      float shown = fromAbove * mix(1.0, 0.5, smoothstep(30.0, 120.0, rm)) * (1.0 - 0.6 * beyond);
      // From lower down, the plants and their shadows only darken the land, in its own colour: specks of scrub on
      // the slopes rather than coloured stickers
      vec3 specks = scrubBare * dot(texture2D(scrubMap, sm, 1.0 + 2.5 * beyond + 2.0 * smoothstep(0.05, 0.3, covered)).rgb, vec3(0.3, 0.59, 0.11))
        / dot(scrubBare, vec3(0.3, 0.59, 0.11));
      vec3 low = mix(scrubBare, specks, 0.7 * (1.0 - beyond));
      vec3 mapped = mix(mix(low, texture2D(scrubMap, sm, 12.0).rgb, max(beyond, fromAbove)), plants, shown);
      diffuseColor.rgb *= mix(vec3(1.0), mapped * gain, ks);
      vec2 sg = sm * scrubInfo.x / scrubGrainPeriod;
      diffuseColor.rgb *= mix(vec3(1.0), texture2D(scrubGrain, sg).rgb / texture2D(scrubGrain, sg, 12.0).rgb, 0.6 * ks);
    }
    ${TERRAIN_LIGHT_FRAGMENT}
  }`;

// Multiplies the detail texture over a terrain material's colours (the meshes' positions are in the viewer's frame)
function addTerrainDetail(material: any, texture: any, photoMask: any, detail: TerrainDetail, anisotropy: number,
  scrub: TerrainScrub, light: TerrainLight) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  material.userData.detailMap = texture;
  material.userData.photoMask = photoMask;
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.detailMap = { value: texture };
    shader.uniforms.detailFade = { value: new THREE.Vector4(...detail.fade) };
    shader.uniforms.detailPeriod = { value: detail.period };
    shader.uniforms.detailPhoto = { value: photoMask ? 1 : 0 };
    shader.uniforms.photoMask = { value: photoMask ?? texture };
    // Without the sea's height, every point counts as far above it
    shader.uniforms.detailSea = {
      value: new THREE.Vector3(detail.seaZ ?? -1e6, detail.unitsPerMetre ?? 1, detail.earthRadius ?? 6.4e6),
    };
    shader.uniforms.scrubMap = scrub.map;
    shader.uniforms.scrubInfo = scrub.info;
    shader.uniforms.scrubGain = scrub.gain;
    shader.uniforms.scrubNear = scrub.near;
    shader.uniforms.scrubReach = scrub.reach;
    shader.uniforms.scrubGrain = scrub.grain;
    shader.uniforms.scrubGrainPeriod = scrub.grainPeriod;
    shader.uniforms.scrubBare = scrub.bare;
    shader.uniforms.seaNormals = light.seaNormals;
    shader.uniforms.seaFoam = light.seaFoam;
    shader.uniforms.terrainSun = light.sun;
    shader.uniforms.terrainSwell = light.swell;
    shader.uniforms.terrainDay = light.day;
    shader.uniforms.terrainEye = light.eye;
    shader.uniforms.terrainTime = light.time;
    shader.uniforms.terrainSky = light.sky;
    shader.uniforms.terrainAir = light.air;
    shader.uniforms.terrainWater = light.water;
    shader.uniforms.terrainClouds = light.clouds;
    shader.uniforms.terrainLite = light.lite;
    shader.uniforms.terrainQuality = light.quality;
    shader.uniforms.terrainSiteShadow = light.siteShadow;
    shader.uniforms.terrainNoiseMap = light.noise;
    shader.uniforms.terrainMist = light.mist;
    shader.uniforms.terrainSand = light.sand;
    shader.uniforms.terrainGlow = light.glow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 terrainShore;
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying vec2 vTerrainShore;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTerrainPosition = position;
        vTerrainNormal = normal;
        vTerrainShore = terrainShore;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SKY_LIGHT_GLSL}\n${TERRAIN_DETAIL_HEADER}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${TERRAIN_DETAIL_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'terrain-detail';
  material.needsUpdate = true;
}

// Frees the GPU resources of a three.js object tree
export function disposeObject(root: THREE.Object3D) {
  root.traverse((object: any) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    for (const material of [object.material].flat()) {
      material.map?.dispose();
      material.userData.detailMap?.dispose();
      material.userData.photoMask?.dispose();
      material.dispose();
    }
  });
}

// The terrain shader's light and sea uniforms (TERRAIN_LIGHT_FRAGMENT), in the terrain's frame (y down). sceneEffects.ts
// sets the sun, the swell and the day; the terrain meshes set the eye and the time as they're drawn.
export type TerrainLight = {
  // Toward the sun
  sun: { value: THREE.Vector3 };
  // Which way the swell runs (x, z)
  swell: { value: THREE.Vector2 };
  // 1 in sunlight, 0 at night or in fog: no slopes lit, no glitter
  day: { value: number };
  eye: { value: THREE.Vector3 };
  time: { value: number };
  // The sky panorama, which the sea reflects
  sky: { value: THREE.Texture };
  // The haze colour (linear) and the sea's own
  air: { value: THREE.Color };
  water: { value: THREE.Color };
  // The sea's tiling slopes and white water (public/textures, made by the pipeline's sea_textures.py)
  seaNormals: { value: THREE.Texture };
  seaFoam: { value: THREE.Texture };
  // How much of the sky the clouds cover (0: none) and how much the haze glows toward the sun (0 to 1)
  clouds: { value: number };
  glow: { value: number };
  // The Bruma costera setting's banks of mist low over the sea and the coast (0: none, 1: on)
  mist: { value: number };
  // How much bright sand is tinted a warm sand colour (SceneEnvironment.paleSand)
  sand: { value: number };
  // 1 in a VR headset: the costliest parts of the terrain's shading are left out or simplified (see SKY_LIGHT_GLSL)
  lite: { value: number };
  // The shaders' smooth noise (noiseTexture)
  noise: { value: THREE.Texture };
  // 1 in the high-quality mode (the "Calidad alta" graphics setting, for computers): clouds with depth, and their
  // shadows crossing the site
  quality: { value: number };
  // How strong the clouds' shadows are on the site itself, in that mode (the site's SiteSun.shadows)
  siteShadow: { value: number };
  // How bright the sky's panorama is overhead (linear, 0 to 1): the clouds' shaded sides are paler under a white sky
  skyTone: { value: number };
  // The high-quality clouds as the camera sees them (createVolumeClouds), and one over the size of the image the sky is
  // drawn into (pixels)
  cloudImage: { value: THREE.Texture };
  cloudImagePixel: { value: THREE.Vector2 };
};

// What a cloud's shadow leaves of the light on level ground (the sky's share, a little bluer), under a sun `sunUp`
// high (the sine of its elevation); the terrain shader's own
export function cloudShadowLight(sunUp: number, out: THREE.Vector3) {
  return out.set(0.92, 0.97, 1.12).multiplyScalar(AMBIENT / (AMBIENT + (1 - AMBIENT) * Math.max(sunUp, 0.1)));
}

// The cloud layer's noise at a point of the land (metres across from the site, the terrain's frame) under the sun, as
// the terrain shader's cloudField finds it for the clouds' shadows, and the level above which it is cloud: the
// shadow is smoothstep(edge, edge + width, field). For shading the site's splats as the land around them.
export function cloudShadowField(light: TerrainLight, x: number, z: number) {
  const lattice: Float32Array = light.noise.value.userData.lattice;
  const noise = (px: number, pz: number) => {
    const i = Math.floor(px), j = Math.floor(pz);
    const fx = px - i, fz = pz - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const at = (a: number, b: number) =>
      lattice[(((b % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS) * NOISE_CELLS + (((a % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS)];
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
  const fbm = (px: number, pz: number) => {
    let sum = 0, weight = 0.5;
    for (let k = 0; k < 5; k++) {
      sum += weight * noise(px, pz);
      [px, pz] = [1.6 * px - 1.2 * pz + 7.1, 1.2 * px + 1.6 * pz + 7.1];
      weight *= 0.5;
    }
    return sum;
  };
  const sun = light.sun.value;
  const sunUp = Math.max(-sun.y, 0.1);
  const time = light.time.value;
  const qx = (x + (sun.x / sunUp) * CLOUD_HEIGHT - light.swell.value.x * CLOUD_WIND * time) / CLOUD_SIZE;
  const qz = (z + (sun.z / sunUp) * CLOUD_HEIGHT - light.swell.value.y * CLOUD_WIND * time) / CLOUD_SIZE;
  const warp = 0.7 * fbm(qx * 0.5 + 1.7, qz * 0.5 + 1.7);
  return fbm(qx + warp, qz + warp);
}
export const cloudShadowEdge = (light: TerrainLight) => ({
  edge: THREE.MathUtils.lerp(0.7, 0.48, light.clouds.value), width: CLOUD_EDGE_WIDTH,
});

// How bright a sky panorama is overhead (linear, 0 to 1): the mean of its upper third
function skyBrightness(image: any) {
  if (!image?.width || typeof document === 'undefined') return 0.4;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 0.4;
  context.drawImage(image, 0, 0, 64, 32);
  const pixels = context.getImageData(0, 0, 64, 10).data;
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const linear = (v: number) => (v / 255) ** 2.2;
    sum += 0.2126 * linear(pixels[i]) + 0.7152 * linear(pixels[i + 1]) + 0.0722 * linear(pixels[i + 2]);
  }
  return sum / (pixels.length / 4);
}

// The billows of the high-quality clouds: a 3D texture that repeats, bright in the middle of each billow (the distance
// to the nearest of a scatter of points, at three sizes)
function cloudDetailTexture() {
  const size = 48;
  const sums = new Float32Array(size * size * size);
  let seed = 48271;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const [cells, weight] of [[3, 0.55], [6, 0.3], [12, 0.15]]) {
    const points = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < points.length; i++) points[i] = random();
    const wrap = (c: number) => (c + cells) % cells;
    let o = 0;
    for (let z = 0; z < size; z++) {
      const pz = ((z + 0.5) / size) * cells, cz = Math.floor(pz);
      for (let y = 0; y < size; y++) {
        const py = ((y + 0.5) / size) * cells, cy = Math.floor(py);
        for (let x = 0; x < size; x++, o++) {
          const px = ((x + 0.5) / size) * cells, cx = Math.floor(px);
          let nearest = 4;
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const k = 3 * ((wrap(cz + dz) * cells + wrap(cy + dy)) * cells + wrap(cx + dx));
            const ex = cx + dx + points[k] - px, ey = cy + dy + points[k + 1] - py, ez = cz + dz + points[k + 2] - pz;
            nearest = Math.min(nearest, ex * ex + ey * ey + ez * ez);
          }
          sums[o] += weight * (1 - Math.min(Math.sqrt(nearest), 1));
        }
      }
    }
  }
  let low = Infinity, high = -Infinity;
  for (const v of sums) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  const data = new Uint8Array(sums.length);
  for (let i = 0; i < sums.length; i++) data[i] = Math.round((255 * (sums[i] - low)) / (high - low));
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

// The high-quality clouds, drawn before the scene each frame: first the map of the layer (SKY_VOLUME_GLSL's
// cloudFieldMap: its noise for CLOUD_MAP_HALF each way from the site, which the wind moves), then the clouds
// themselves as the camera sees them, into an image the sky shader lays over the panorama (light.cloudImage).
// `frame` is the object whose frame the terrain's light is in (the sky's directions: y down).
function createVolumeClouds(light: TerrainLight, frame: THREE.Object3D) {
  const field = new THREE.WebGLRenderTarget(CLOUD_MAP_SIZE, CLOUD_MAP_SIZE, { type: THREE.HalfFloatType, depthBuffer: false });
  const image = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  const detail = cloudDetailTexture();
  const vertexShader = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const shared = {
    cloudSkyTone: light.skyTone, terrainSun: light.sun, terrainSwell: light.swell, terrainTime: light.time, terrainClouds: light.clouds,
    terrainNoiseMap: light.noise,
  };
  const fieldMaterial = new THREE.ShaderMaterial({
    uniforms: shared,
    vertexShader,
    fragmentShader: `${SKY_LIGHT_GLSL}
      varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(cloudField((vUv - 0.5) * ${(2 * CLOUD_MAP_HALF).toFixed(1)}, false), 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  // The directions through the image's corners (not normalized: they are blended across it)
  const rays = [0, 1, 2, 3].map(() => ({ value: new THREE.Vector3() }));
  const imageMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...shared, cloudFieldMap: { value: field.texture }, cloudDetailMap: { value: detail },
      ray00: rays[0], ray10: rays[1], ray01: rays[2], ray11: rays[3],
    },
    vertexShader,
    fragmentShader: `${SKY_LIGHT_GLSL}\n${SKY_VOLUME_GLSL}
      uniform vec3 ray00, ray10, ray01, ray11;
      varying vec2 vUv;
      void main() {
        vec3 d = normalize(mix(mix(ray00, ray10, vUv.x), mix(ray01, ray11, vUv.x), vUv.y));
        float up = -d.y;
        gl_FragColor = vec4(0.0);
        if (up > 0.0) {
          float far;
          vec4 volume = cloudVolume(d, max(up, 0.015), far);
          // Fading into the haze far off and toward the horizon, as the flat clouds do
          float cover = volume.a * smoothstep(0.0, 0.05, up) * exp(-far / ${CLOUD_FADE.toFixed(1)})
            * (1.0 - smoothstep(${(0.7 * CLOUD_MAP_HALF).toFixed(1)}, ${(0.92 * CLOUD_MAP_HALF).toFixed(1)}, far))
            * (0.45 + 0.55 * exp(-far / 15000.0));
          gl_FragColor = vec4(volume.rgb * cover, cover);
        }
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const fieldQuad = new FullScreenQuad(fieldMaterial);
  const imageQuad = new FullScreenQuad(imageMaterial);
  const size = new THREE.Vector2();
  const eye = new THREE.Vector3();
  const toFrame = new THREE.Matrix4();
  let fieldTime = -1e9;
  light.cloudImage.value = image.texture;
  return {
    update(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
      renderer.getDrawingBufferSize(size);
      light.cloudImagePixel.value.set(1 / size.x, 1 / size.y);
      const scale = Math.min(1, Math.sqrt(CLOUD_IMAGE_PIXELS / (size.x * size.y)));
      const width = Math.max(1, Math.round(size.x * scale));
      const height = Math.max(1, Math.round(size.y * scale));
      if (image.width !== width || image.height !== height) image.setSize(width, height);

      camera.updateMatrixWorld();
      toFrame.copy(frame.matrixWorld).invert();
      eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toFrame);
      rays.forEach((ray, i) => {
        ray.value.set(i % 2 ? 1 : -1, i < 2 ? -1 : 1, 0.5).unproject(camera).applyMatrix4(toFrame).sub(eye);
      });

      const drawnTo = renderer.getRenderTarget();
      // (the wind takes seconds to move the layer by one of the map's pixels: it is drawn again twice a second)
      if (Math.abs(light.time.value - fieldTime) > 0.5) {
        fieldTime = light.time.value;
        renderer.setRenderTarget(field);
        fieldQuad.render(renderer);
      }
      renderer.setRenderTarget(image);
      imageQuad.render(renderer);
      renderer.setRenderTarget(drawnTo);
    },
    dispose() {
      field.dispose();
      image.dispose();
      detail.dispose();
      fieldMaterial.dispose();
      imageMaterial.dispose();
      fieldQuad.dispose();
      imageQuad.dispose();
    },
  };
}

// Smooth normals for the sunlight on the slopes, and for the surf, each vertex's distance from the land (metres; 0 on
// land) and how much white water the satellite saw there (0-1). The distance: shortest paths along the mesh's edges,
// by sweeps over the triangles that touch the sea, both ways in turn. The white water: how much brighter the terrain's
// texture is there than the sea around at that distance from the site (env_build.py bakes the sea from Sentinel-2,
// with a reflection and haze that only change with that distance), near the shore.
function prepareTerrainGeometry(geometry: THREE.BufferGeometry, detail: TerrainDetail, texture: any) {
  geometry.computeVertexNormals();
  const p = geometry.attributes.position.array as ArrayLike<number>;
  const count = geometry.attributes.position.count;
  const shore = new Float32Array(2 * count);
  const index = geometry.index?.array;
  if (detail.seaZ !== undefined && index) {
    const perMetre = detail.unitsPerMetre ?? 1;
    const earth = detail.earthRadius ?? 6.4e6;
    const coast = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = p[3 * i] / perMetre;
      const z = p[3 * i + 2] / perMetre;
      const aboveSea = -p[3 * i + 1] / perMetre - detail.seaZ + (x * x + z * z) / (2 * earth);
      coast[i] = aboveSea > 0.5 ? 0 : COAST_FAR;
    }
    const wet: number[] = [];
    for (let t = 0; t < index.length; t += 3) {
      if (coast[index[t]] || coast[index[t + 1]] || coast[index[t + 2]]) wet.push(t);
    }
    relaxAll(coast, wet, index, p, perMetre, 6);
    const white = whiteWater(geometry, coast, perMetre, texture?.image);
    for (let i = 0; i < count; i++) {
      shore[2 * i] = coast[i];
      shore[2 * i + 1] = white[i];
    }
  }
  geometry.setAttribute('terrainShore', new THREE.BufferAttribute(shore, 2));
}

// Shortest paths along the mesh's edges (metres) from the vertices at 0, by sweeps over the triangles both ways in turn
function relaxAll(distance: Float32Array, triangles: number[], index: ArrayLike<number>, p: ArrayLike<number>,
  perMetre: number, sweeps: number) {
  const relax = (a: number, b: number) => {
    const da = distance[a];
    const db = distance[b];
    if (Math.abs(da - db) < 1e-3) return;
    const length = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]) / perMetre;
    if (da + length < db) distance[b] = da + length;
    else if (db + length < da) distance[a] = db + length;
  };
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let k = 0; k < triangles.length; k++) {
      const t = triangles[sweep % 2 ? triangles.length - 1 - k : k];
      relax(index[t], index[t + 1]);
      relax(index[t + 1], index[t + 2]);
      relax(index[t + 2], index[t]);
    }
  }
}

// How much white water the satellite saw at each sea vertex within SURF_REACH of the land (0-1; see
// prepareTerrainGeometry): its texel's brightness over the median of the sea's at about the same distance from the site
function whiteWater(geometry: THREE.BufferGeometry, coast: Float32Array, perMetre: number, image: any) {
  const count = coast.length;
  const white = new Float32Array(count);
  if (!image?.width || typeof document === 'undefined') return white;
  const width = Math.min(image.width, 1536);
  const height = Math.round((image.height * width) / image.width);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return white;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const p = geometry.attributes.position.array as ArrayLike<number>;
  const uv = geometry.attributes.uv?.array as ArrayLike<number> | undefined;
  if (!uv) return white;
  const brightness = new Float32Array(count);
  const band = new Int32Array(count);
  const bands = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    if (!coast[i]) continue;
    const x = Math.min(width - 1, Math.max(0, Math.floor(uv[2 * i] * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(uv[2 * i + 1] * height)));
    const o = 4 * (y * width + x);
    brightness[i] = (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3;
    band[i] = Math.round(Math.log(Math.max(Math.hypot(p[3 * i], p[3 * i + 2]) / perMetre, 1)) / Math.log(1.03));
    if (!bands.has(band[i])) bands.set(band[i], []);
    bands.get(band[i])!.push(brightness[i]);
  }
  const medians = new Map<number, number>();
  for (const [key, values] of bands) {
    values.sort((a, b) => a - b);
    medians.set(key, values[Math.floor(values.length / 2)]);
  }
  for (let i = 0; i < count; i++) {
    if (!coast[i] || coast[i] > SURF_REACH) continue;
    const over = brightness[i] - medians.get(band[i])!;
    white[i] = THREE.MathUtils.smoothstep(over, 12, 45) * (1 - THREE.MathUtils.smoothstep(coast[i], SURF_REACH / 2, SURF_REACH));
  }
  return white;
}

// The terrain shader's scrub uniforms; effects/scrub.ts fills them in
export type TerrainScrub = {
  map: { value: THREE.Texture };
  info: { value: THREE.Vector4 };
  gain: { value: THREE.Vector3 };
  near: { value: THREE.Vector3 };
  reach: { value: THREE.Vector2 };
  grain: { value: THREE.Texture };
  grainPeriod: { value: number };
  // The map's bare ground between the plants (linear)
  bare: { value: THREE.Vector3 };
};

export type LoadedEnvironment = {
  // Terrain and sky, in the viewer's frame
  group: THREE.Group;
  // The terrain meshes, for finding heights on it (wind turbines) and darkening it at night
  terrain: THREE.Mesh[];
  sky: THREE.Mesh | null;
  scrub: TerrainScrub;
  light: TerrainLight;
  /**
   * The high-quality mode's clouds: call before drawing each frame while they show (light.quality on, by day, with
   * clouds). The first call makes their textures, which takes a moment.
   */
  updateClouds: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void;
  dispose: () => void;
};

/**
 * Loads a site's terrain and sky (landmarks.json `environment`). The sky is a panorama on a sphere that follows the
 * camera and is drawn behind everything; the terrain's "terrain_under" nodes, under the splat, are drawn without
 * writing depth so the splat always covers them.
 */
export async function loadSceneEnvironment(
  env: SceneEnvironment,
  anisotropy: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedEnvironment> {
  const [gltf, skyTexture, seaNormals, seaFoam] = await Promise.all([
    new GLTFLoader().loadAsync(assetUrl(env.terrainUrl), event => onProgress?.(event.loaded, event.total)),
    env.skyUrl ? new THREE.TextureLoader().loadAsync(assetUrl(env.skyUrl)) : null,
    new THREE.TextureLoader().loadAsync(SEA_NORMALS_URL),
    new THREE.TextureLoader().loadAsync(SEA_FOAM_URL),
  ]);
  for (const texture of [seaNormals, seaFoam]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropy;
  }
  const group = new THREE.Group();
  group.name = 'scene-environment';
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const scrub: TerrainScrub = {
    map: { value: blank },
    info: { value: new THREE.Vector4(1, 0, 1, 0) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    near: { value: new THREE.Vector3(1, 1, 1) },
    reach: { value: new THREE.Vector2(0, 1) },
    grain: { value: blank },
    grainPeriod: { value: 1 },
    bare: { value: new THREE.Vector3(1, 1, 1) },
  };

  const light: TerrainLight = {
    sun: { value: new THREE.Vector3(0, -1, 0) },
    swell: { value: new THREE.Vector2(1, 0) },
    day: { value: 1 },
    eye: { value: new THREE.Vector3() },
    time: { value: 0 },
    sky: { value: skyTexture ?? blank },
    air: { value: new THREE.Color(env.background ?? '#dfe8ed') },
    water: { value: new THREE.Color(WATER_COLOUR) },
    seaNormals: { value: seaNormals },
    seaFoam: { value: seaFoam },
    clouds: { value: 0 },
    glow: { value: 0 },
    mist: { value: 0 },
    sand: { value: env.paleSand ?? 0.15 },
    lite: { value: 0 },
    noise: { value: noiseTexture() },
    quality: { value: 0 },
    siteShadow: { value: 1 },
    skyTone: { value: skyTexture ? skyBrightness(skyTexture.image) : 0.4 },
    cloudImage: { value: blank },
    cloudImagePixel: { value: new THREE.Vector2(1, 1) },
  };
  let volumeClouds: ReturnType<typeof createVolumeClouds> | null = null;
  const eye = new THREE.Vector3();

  let sky: THREE.Mesh | null = null;
  if (skyTexture) {
    skyTexture.colorSpace = THREE.SRGBColorSpace;
    const skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 96, 48),
      new THREE.MeshBasicMaterial({
        map: skyTexture, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false
      })
    );
    // The clouds, the sun and the haze's glow toward it, over the panorama (in the terrain's frame: the sphere is
    // turned over, so its points' y and z flip)
    const skyMaterial = skyMesh.material as THREE.MeshBasicMaterial;
    skyMaterial.onBeforeCompile = (shader: any) => {
      Object.assign(shader.uniforms, {
        terrainSun: light.sun, terrainSwell: light.swell, terrainTime: light.time,
        terrainClouds: light.clouds, terrainGlow: light.glow, terrainLite: light.lite,
        terrainNoiseMap: light.noise, terrainQuality: light.quality,
        cloudImage: light.cloudImage, cloudImagePixel: light.cloudImagePixel,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkyDirection;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkyDirection = vec3(position.x, -position.y, -position.z);')
        // (at the far plane, whatever the sphere's size: behind everything)
        .replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z = gl_Position.w;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vSkyDirection;\n${SKY_LIGHT_GLSL}\n${SKY_HEADER}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${SKY_FRAGMENT}`);
    };
    skyMaterial.customProgramCacheKey = () => 'sky-light';
    skyMesh.rotation.x = Math.PI; // the panorama is upright; the scene is y-down
    // Drawn after the land and what stands on it, depth-tested, so its clouds are only worked out for the pixels where
    // the sky shows (drawn first, they were worked out for every pixel of the screen); before the ground under the
    // splat, which writes no depth
    skyMesh.renderOrder = 0.5;
    skyMesh.frustumCulled = false;
    // Centred on the camera, wherever the scene is in the world (VR turns and scales it)
    const cameraPosition = new THREE.Vector3();
    skyMesh.onBeforeRender = (_renderer, _scene, camera) => {
      // Read matrixWorld as it is: in VR, `camera` is an eye whose matrixWorld three.js has already set to include
      // the rig. getWorldPosition would recompute it from the eye's pose alone, and everything drawn after the sky,
      // splats included, would be seen from the room's origin instead of where the visitor has walked.
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      skyMesh.position.copy(skyMesh.parent ? skyMesh.parent.worldToLocal(cameraPosition) : cameraPosition);
      skyMesh.updateMatrixWorld();
    };
    sky = skyMesh;
    group.add(skyMesh);
  }

  const terrain: THREE.Mesh[] = [];
  const details: Promise<void>[] = [];
  gltf.scene.traverse((object: any) => {
    if (!object.isMesh) return;
    terrain.push(object);
    // The ground far out is seen almost edge-on; without this it blurs to a smear
    if (object.material.map) object.material.map.anisotropy = anisotropy;
    // The ground under the splat doesn't write depth, so the splat (which Spark draws after all opaque meshes) always
    // covers it. It comes after the rest of the terrain, which would otherwise draw over it from behind.
    if (object.name.startsWith('terrain_under')) {
      object.material.depthWrite = false;
      object.renderOrder = 1;
    }
    const detail: TerrainDetail | undefined = object.material.userData.detail;
    if (detail) {
      prepareTerrainGeometry(object.geometry, detail, object.material.map);
      // The eye in the terrain's frame (read from matrixWorld as it is: see the sky), and the time, for the sea
      object.onBeforeRender = (_renderer: any, _scene: any, camera: any) => {
        light.eye.value.copy(object.worldToLocal(eye.setFromMatrixPosition(camera.matrixWorld)));
        light.time.value = performance.now() / 1000;
      };
      details.push(Promise.all([
        gltf.parser.getDependency('texture', detail.texture),
        detail.photoMask !== undefined ? gltf.parser.getDependency('texture', detail.photoMask) : null,
      ]).then(([texture, photoMask]: any[]) =>
        addTerrainDetail(object.material, texture, photoMask, detail, anisotropy, scrub, light)));
    }
  });
  await Promise.all(details);
  group.add(gltf.scene);

  return {
    group, terrain, sky, scrub, light,
    updateClouds(renderer, camera) {
      volumeClouds ??= createVolumeClouds(light, group);
      volumeClouds.update(renderer, camera);
    },
    dispose: () => {
      volumeClouds?.dispose();
      blank.dispose();
      light.noise.value.dispose();
      seaNormals.dispose();
      seaFoam.dispose();
      disposeObject(group);
    },
  };
}
