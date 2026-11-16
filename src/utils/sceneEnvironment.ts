import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneEnvironment } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';

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
}

const TERRAIN_DETAIL_HEADER = `
  uniform sampler2D detailMap;
  uniform vec4 detailFade;
  uniform float detailPeriod;
  uniform vec3 detailSea;
  uniform float detailBloom;
  uniform sampler2D scrubMap;
  uniform vec4 scrubInfo;
  uniform vec3 scrubGain;
  uniform vec3 scrubNear;
  uniform vec2 scrubReach;
  uniform sampler2D scrubGrain;
  uniform float scrubGrainPeriod;
  varying vec3 vTerrainPosition;
  float detailHash(vec2 i) { return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453); }
  float detailNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(detailHash(i), detailHash(i + vec2(1.0, 0.0)), u.x),
               mix(detailHash(i + vec2(0.0, 1.0)), detailHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  uniform vec3 terrainSun;
  uniform vec2 terrainSwell;
  uniform float terrainDay;
  uniform vec3 terrainEye;
  uniform float terrainTime;
  uniform sampler2D terrainSky;
  uniform vec3 terrainAir;
  uniform vec3 terrainWater;
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
// Desierto florido (detailBloom): drifts of flowers in the colours of the splat's own (see desertBloom.ts) cover the
// land out to a few kilometres, thinning into the haze the colours have baked in (env_build.py --haze-km 8).
// env_build.py's aerial perspective: its e-folding distance (metres), its default (--haze-km 8) for every site
const HAZE_METRES = 8000;
// The share of the light on level ground that comes from the sky rather than the sun
const AMBIENT = 0.35;
// The sea's own colour, under the sky's reflection: the open sea in the second batch's drone photos looking down at it
// (sRGB 50-75, 95-110, 140-160), a little darker for the sky's share
const WATER_COLOUR = '#2f5884';
// How much darker rock outcrops are than the sand between, and how steeply they stand (see TERRAIN_LIGHT_FRAGMENT)
const ROCK_CONTRAST = 0.3;
const ROCK_RELIEF = 6;
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
// white water along it (vTerrainShore: metres from the land, and how much white water the satellite saw there).
const TERRAIN_LIGHT_FRAGMENT = `
    vec3 haze = diffuse * terrainAir * (1.0 - exp(-rm / ${HAZE_METRES.toFixed(1)}));
    vec3 slopeNormal = normalize(vTerrainNormal);
    slopeNormal *= slopeNormal.y > 0.0 ? -1.0 : 1.0;
    // Rock and sand at the few metres the satellite's 10 m pixels can't show, from past the splat's edge to a couple
    // of kilometres: outcrops darker and standing out of the sand (their sides lit or not), each scale fading out as
    // a pixel grows past it
    float rocky = land * smoothstep(detailFade.y, detailFade.y + 20.0 * detailSea.y, r) * (1.0 - smoothstep(1500.0, 3000.0, rm));
    if (rocky > 0.0) {
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
    float sunUp = max(-terrainSun.y, 0.1);
    float lit = (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * max(dot(slopeNormal, terrainSun), 0.0))
      / (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * sunUp);
    float shaded = terrainDay * land * smoothstep(detailFade.y, detailFade.y + 40.0 * detailSea.y, r);
    diffuseColor.rgb = haze + (diffuseColor.rgb - haze) * mix(1.0, clamp(lit, 0.3, 1.7), shaded);
    // Pale sand turned to the sun eases toward white instead of clipping
    vec3 over = max(diffuseColor.rgb - 0.7, 0.0) * shaded;
    diffuseColor.rgb -= over * over / (over + 0.3);
    if (land < 1.0) {
      // Patches of rougher and calmer water drift over the sea
      float gust = 0.55 + 0.9 * detailNoise(pm / 180.0 + terrainSwell * terrainTime * 0.01);
      vec2 slope = vec2(0.0);
      float rough = 0.012 * gust;
      for (int i = 0; i < 10; i++) {
        float fi = float(i);
        float lambda = 60.0 * pow(0.68, fi) * (0.85 + 0.3 * fract(fi * 0.754));
        float turn = (fract(fi * 0.618 + 0.3) - 0.5) * 2.0;
        vec2 dir = mat2(cos(turn), sin(turn), -sin(turn), cos(turn)) * terrainSwell;
        float k = 6.2832 / lambda;
        float seen = 1.0 - smoothstep(lambda / 12.0, lambda / 4.0, foot);
        slope += dir * 0.045 * gust * cos(k * dot(dir, pm) - sqrt(9.81 * k) * terrainTime + fi * 2.39) * seen;
        rough += 0.001 * gust * gust * (1.0 - seen);
      }
      vec3 waveNormal = normalize(vec3(-slope.x, -1.0, -slope.y));
      float facing = max(dot(waveNormal, toEye), 1e-3);
      // Seen from low down, the facets turned away hide behind the crests in front of them, and those too small to
      // see are mostly the ones that face the eye: a rough sea reflects much less of the sky than a mirror would
      float fresnel = terrainFresnel(max(cos(max(acos(facing) - atan(sqrt(rough)), 0.0)), 0.28));
      vec3 mirrored = reflect(-toEye, waveNormal);
      // (and those reflect the sky higher up)
      float skyUp = asin(clamp(-mirrored.y, 0.004, 1.0)) + atan(sqrt(rough));
      vec3 skyColour = textureLod(terrainSky, vec2(0.25, 0.5 + skyUp / 3.14159), 0.0).rgb;
      vec3 halfway = normalize(terrainSun + toEye);
      float nh = max(dot(waveNormal, halfway), 1e-3);
      float m2 = 2.0 * rough;
      float facets = exp(-(1.0 - nh * nh) / (nh * nh * m2)) / (3.14159 * m2 * nh * nh * nh * nh);
      // (over the sea's level, not the wave's: a wave's back seen edge-on would blow it up)
      float glitter = terrainDay * step(0.0, -terrainSun.y) * facets * terrainFresnel(dot(toEye, halfway))
        / (4.0 * max(-toEye.y, 0.1)) * 3.14159 / sunUp;
      vec3 water = terrainWater * (1.0 - fresnel) + skyColour * fresnel + min(glitter, 6.0);
      // Surf where the satellite saw white water (reefs, points), crests running through it toward the shore, and a
      // thin white edge along every shore
      float coast = vTerrainShore.x;
      float broken = 0.65 * detailNoise(pm / 8.0 + vec2(0.0, terrainTime * 0.05)) + 0.35 * detailNoise(pm / 2.5);
      float run = (coast + 2.5 * terrainTime) / 26.0 + 1.5 * detailNoise(pm / 70.0);
      float crest = mix(exp(-4.0 * fract(run)), 0.25, smoothstep(2.0, 7.0, foot));
      // (white water is lace: streaks and holes, which only blur together far off)
      float lace = mix(smoothstep(0.35, 0.7, detailNoise(mat2(0.8, 0.6, -0.6, 0.8) * pm / 1.7 * vec2(1.0, 0.35)
        + vec2(0.0, terrainTime * 0.15))), 0.5, smoothstep(0.5, 2.0, foot));
      float surf = vTerrainShore.y * mix(0.3, 1.0, crest) * smoothstep(0.2, 0.55, broken) * mix(0.35, 1.0, lace);
      float edge = 0.6 * (1.0 - smoothstep(1.0, 5.0, coast + 4.0 * (broken - 0.5)));
      water = mix(water, vec3(0.75), 0.8 * clamp(max(surf, edge), 0.0, 1.0));
      water = water * diffuse * exp(-rm / ${HAZE_METRES.toFixed(1)}) + haze;
      diffuseColor.rgb = mix(water, diffuseColor.rgb, land);
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
    vec3 a = texture2D(detailMap, p).rgb * 2.0 - 1.0;
    vec3 b = texture2D(detailMap, mat2(0.6, 0.8, -0.8, 0.6) * p * 0.73 + vec2(0.37, 0.61)).rgb * 2.0 - 1.0;
    float w = smoothstep(0.25, 0.75, detailNoise(p * 2.3));
    vec3 d = (a * (1.0 - w) + b * w) / sqrt((1.0 - w) * (1.0 - w) + w * w);
    // Where the scrub map draws the bushes, the detail's own blotches of them step back
    float ks = smoothstep(scrubInfo.y, scrubInfo.z, r) * land * level * scrubInfo.w;
    diffuseColor.rgb *= max(1.0 + d * k * (1.0 - 0.7 * ks), 0.0);
    if (ks > 0.0) {
      vec2 sm = vec2(vTerrainPosition.x, -vTerrainPosition.z) / (detailSea.y * scrubInfo.x);
      vec3 gain = mix(scrubNear, scrubGain, smoothstep(scrubReach.x, scrubReach.y, r));
      // The plants as seen from above would lie on the land like stickers where they're looked at from low down,
      // and beyond where they stand as cards: there they blur into its grain and pale
      float flatOn = 1.0 - smoothstep(0.06, 0.3, -toEye.y);
      float beyond = smoothstep(${SCRUB_CARDS.toFixed(1)}, ${(3 * SCRUB_CARDS).toFixed(1)}, rm);
      diffuseColor.rgb *= mix(vec3(1.0), texture2D(scrubMap, sm, max(3.5 * flatOn, 2.5 * beyond)).rgb * gain,
        ks * (1.0 - 0.6 * beyond));
      vec2 sg = sm * scrubInfo.x / scrubGrainPeriod;
      diffuseColor.rgb *= mix(vec3(1.0), texture2D(scrubGrain, sg).rgb / texture2D(scrubGrain, sg, 12.0).rgb, 0.6 * ks);
    }
    if (detailBloom > 0.0) {
      vec2 q = vTerrainPosition.xz / (detailSea.y * 40.0);
      float cover = smoothstep(0.42, 0.7, 0.65 * detailNoise(q) + 0.35 * detailNoise(q * 3.7 + 5.0));
      float kind = detailNoise(q * 0.23 + 11.0);
      vec3 flower = kind < 0.55 ? vec3(0.86, 0.3, 0.6) : kind < 0.78 ? vec3(0.95, 0.8, 0.25) : vec3(0.68, 0.6, 0.92);
      float amount = detailBloom * cover * land * smoothstep(0.4, 0.8, abs(normal.y))
        * smoothstep(detailFade.x, detailFade.y, r) * exp(-rm / 8000.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, pow(flower, vec3(2.2)) * 0.8, 0.6 * amount);
    }
    ${TERRAIN_LIGHT_FRAGMENT}
  }`;

// Multiplies the detail texture over a terrain material's colours (the meshes' positions are in the viewer's frame)
function addTerrainDetail(material: any, texture: any, detail: TerrainDetail, anisotropy: number, bloom: { value: number },
  scrub: TerrainScrub, light: TerrainLight) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  material.userData.detailMap = texture;
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.detailMap = { value: texture };
    shader.uniforms.detailFade = { value: new THREE.Vector4(...detail.fade) };
    shader.uniforms.detailPeriod = { value: detail.period };
    // Without the sea's height, every point counts as far above it
    shader.uniforms.detailSea = {
      value: new THREE.Vector3(detail.seaZ ?? -1e6, detail.unitsPerMetre ?? 1, detail.earthRadius ?? 6.4e6),
    };
    shader.uniforms.detailBloom = bloom;
    shader.uniforms.scrubMap = scrub.map;
    shader.uniforms.scrubInfo = scrub.info;
    shader.uniforms.scrubGain = scrub.gain;
    shader.uniforms.scrubNear = scrub.near;
    shader.uniforms.scrubReach = scrub.reach;
    shader.uniforms.scrubGrain = scrub.grain;
    shader.uniforms.scrubGrainPeriod = scrub.grainPeriod;
    shader.uniforms.terrainSun = light.sun;
    shader.uniforms.terrainSwell = light.swell;
    shader.uniforms.terrainDay = light.day;
    shader.uniforms.terrainEye = light.eye;
    shader.uniforms.terrainTime = light.time;
    shader.uniforms.terrainSky = light.sky;
    shader.uniforms.terrainAir = light.air;
    shader.uniforms.terrainWater = light.water;
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
      .replace('#include <common>', `#include <common>\n${TERRAIN_DETAIL_HEADER}`)
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
};

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
    const relax = (a: number, b: number) => {
      const da = coast[a];
      const db = coast[b];
      if (Math.abs(da - db) < 1e-3) return;
      const length = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]) / perMetre;
      if (da + length < db) coast[b] = da + length;
      else if (db + length < da) coast[a] = db + length;
    };
    for (let sweep = 0; sweep < 6; sweep++) {
      for (let k = 0; k < wet.length; k++) {
        const t = wet[sweep % 2 ? wet.length - 1 - k : k];
        relax(index[t], index[t + 1]);
        relax(index[t + 1], index[t + 2]);
        relax(index[t + 2], index[t]);
      }
    }
    const white = whiteWater(geometry, coast, perMetre, texture?.image);
    for (let i = 0; i < count; i++) {
      shore[2 * i] = coast[i];
      shore[2 * i + 1] = white[i];
    }
  }
  geometry.setAttribute('terrainShore', new THREE.BufferAttribute(shore, 2));
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
};

export type LoadedEnvironment = {
  // Terrain and sky, in the viewer's frame
  group: THREE.Group;
  // The terrain meshes, for finding heights on it (wind turbines) and darkening it at night
  terrain: THREE.Mesh[];
  sky: THREE.Mesh | null;
  // 0 to 1: how much of the land the desierto florido covers
  bloom: { value: number };
  scrub: TerrainScrub;
  light: TerrainLight;
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
  const [gltf, skyTexture] = await Promise.all([
    new GLTFLoader().loadAsync(assetUrl(env.terrainUrl), event => onProgress?.(event.loaded, event.total)),
    env.skyUrl ? new THREE.TextureLoader().loadAsync(assetUrl(env.skyUrl)) : null,
  ]);
  const group = new THREE.Group();
  group.name = 'scene-environment';
  const bloom = { value: 0 };
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
  };
  const eye = new THREE.Vector3();

  let sky: THREE.Mesh | null = null;
  if (skyTexture) {
    skyTexture.colorSpace = THREE.SRGBColorSpace;
    const skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 96, 48),
      new THREE.MeshBasicMaterial({
        map: skyTexture, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false
      })
    );
    skyMesh.rotation.x = Math.PI; // the panorama is upright; the scene is y-down
    skyMesh.renderOrder = -1;
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
      details.push(gltf.parser.getDependency('texture', detail.texture)
        .then((texture: any) => addTerrainDetail(object.material, texture, detail, anisotropy, bloom, scrub, light)));
    }
  });
  await Promise.all(details);
  group.add(gltf.scene);

  return {
    group, terrain, sky, bloom, scrub, light,
    dispose: () => {
      blank.dispose();
      disposeObject(group);
    },
  };
}
