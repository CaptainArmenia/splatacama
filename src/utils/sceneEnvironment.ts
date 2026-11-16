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

// The clouds: their base (metres above the site), how big they come (metres), the wind (metres a second), how far
// off they fade into the haze, and how far from the site their shadows start (metres)
const CLOUD_HEIGHT = 1400;
const CLOUD_SIZE = 1600;
const CLOUD_WIND = 7;
const CLOUD_FADE = 45000;
const CLOUD_SHADOW_FROM = 80;

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
const SKY_LIGHT_GLSL = `
  uniform vec3 terrainSun;
  uniform vec2 terrainSwell;
  uniform float terrainTime;
  uniform float terrainClouds;
  uniform float terrainGlow;
  float cloudHash(vec2 i) { return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453); }
  float cloudNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), u.x),
               mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float cloudFbm(vec2 p) {
    float sum = 0.0, weight = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += weight * cloudNoise(p);
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1;
      weight *= 0.5;
    }
    return sum;
  }
  // How much cloud covers a point of the layer (metres across the viewer's frame from the site)
  float cloudCover(vec2 p) {
    vec2 q = (p - terrainSwell * ${CLOUD_WIND.toFixed(1)} * terrainTime) / ${CLOUD_SIZE.toFixed(1)};
    float n = cloudFbm(q + 0.7 * cloudFbm(q * 0.5 + 1.7));
    float edge = mix(0.7, 0.48, terrainClouds);
    return smoothstep(edge, edge + 0.13, n);
  }
  // The haze's colour along a direction, over its colour all around (1: the same)
  vec3 terrainHazeTint(vec3 toward) {
    vec2 a = normalize(toward.xz + 1e-5), b = normalize(terrainSun.xz + 1e-5);
    float side = 0.5 + 0.5 * dot(a, b);
    return mix(vec3(1.0), mix(vec3(0.86, 0.9, 0.97), vec3(1.22, 1.14, 1.0), side * side), terrainGlow);
  }`;

// The sky: below the clouds, the haze near the horizon tinted toward the sun's side; the clouds, their side toward the
// sun lit and their far side grey, thin edges near the sun shining through, fading into the haze far off; the sun's
// disc and its glow, which the clouds hide
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
    if (terrainClouds > 0.0 && up > 0.0) {
      float far = ${CLOUD_HEIGHT.toFixed(1)} / max(up, 0.015);
      vec2 p = d.xz * far;
      cover = cloudCover(p);
      float sunward = cloudCover(p + normalize(terrainSun.xz + 1e-5) * 220.0);
      float lit = clamp(0.7 + 2.2 * (cover - sunward), 0.0, 1.0);
      vec3 cloud = mix(vec3(0.5, 0.55, 0.63), vec3(1.0, 0.98, 0.95), lit);
      cloud += vec3(1.0, 0.95, 0.85) * pow(max(dot(d, terrainSun), 0.0), 10.0) * (1.0 - cover) * 1.2;
      cloud = mix(diffuseColor.rgb, cloud, 0.45 + 0.55 * exp(-far / 15000.0));
      cover *= smoothstep(0.0, 0.07, up) * exp(-far / ${CLOUD_FADE.toFixed(1)});
      diffuseColor.rgb = mix(diffuseColor.rgb, cloud, cover);
    }
    float toSun = max(dot(d, terrainSun), 0.0);
    diffuseColor.rgb += terrainGlow * (1.0 - cover) * (vec3(1.0, 0.93, 0.8) * (0.35 * pow(toSun, 80.0) + 0.1 * pow(toSun, 8.0))
      + vec3(6.0) * smoothstep(0.99996, 0.99999, toSun));
  }`;

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
  uniform float terrainDay;
  uniform float terrainMist;
  uniform vec3 terrainEye;
  uniform sampler2D terrainSky;
  uniform vec3 terrainAir;
  uniform vec3 terrainWater;
  uniform sampler2D seaNormals;
  uniform sampler2D seaFoam;
  uniform vec3 scrubBare;
  varying vec3 vTerrainNormal;
  varying vec3 vTerrainShore;
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
const SEA_NORMALS_URL = '/textures/sea_normals.png';
const SEA_FOAM_URL = '/textures/sea_foam.png';
// The sea's slopes: their spread in each of the four layers of seaNormals (a wind sea of 4-5 m/s overall), and the
// water's colour over rocks and sand by the shore, from the second batch's drone photos
const SEA_SLOPE = 0.06;
const SEA_SHALLOW = 'vec3(0.035, 0.15, 0.2)';
// How much darker rock outcrops are than the sand between, and how steeply they stand (see TERRAIN_LIGHT_FRAGMENT)
const ROCK_CONTRAST = 0.3;
const ROCK_RELIEF = 6;
// Plants stand as cards out to about here (metres; effects/scrub.ts SCRUB.reach)
const SCRUB_CARDS = 120;
// Sea vertices further than this from the land (metres) count as this far, for the surf
const COAST_FAR = 1000;
// White water the satellite saw counts as surf this near the land (metres): further out it's a boat's wake or glare
const SURF_REACH = 200;
// Beaches get wet sand and waves running up them this far from the site (metres): beyond, they're under a pixel
const SHORE_REACH = 3000;

// Sunlight and the sea (TerrainLight's uniforms). The baked colours are of level ground under the photos' sun, hazed
// toward the horizon colour with distance from the site (env_build.py --haze-km); here the land's slopes are lit by
// that sun (smooth normals, relative to level ground, so level land keeps its colour), beyond the splat's edge, before
// the haze. The sea is drawn here instead of baked: waves (trains around the swell's direction and drifting ripples,
// each fading out as it shrinks under a few pixels, what's lost becoming roughness), the sky reflected off them by
// Fresnel, the sun's glitter, the water's own dark colour, and surf: crests running in to the shore and a band of
// white water along it, and on the beaches wet sand and the waves' run-up (vTerrainShore: metres from the land at
// sea, how much white water the satellite saw there, and metres from the water on land).
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
    // The beaches (low land by the water, not cliff tops): wet sand along the water's edge, and each wave running up
    // a few metres as a thin sheet of water with foam at its edge, then draining back
    float inland = vTerrainShore.z;
    float beach = land * (1.0 - smoothstep(1.5, 4.0, aboveSea)) * (1.0 - smoothstep(4.0, 12.0, foot));
    if (beach > 0.0 && inland < 20.0) {
      float wave = fract(terrainTime / 10.0 + 0.6 * detailNoise(pm / 50.0));
      float runup = (1.5 + 5.0 * detailNoise(pm / 18.0 + 3.0))
        * (wave < 0.2 ? smoothstep(0.0, 0.2, wave) : 1.0 - smoothstep(0.2, 1.0, wave));
      float wetSand = 1.0 - smoothstep(4.0, 9.0, inland + 3.0 * detailNoise(pm / 7.0));
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.6, 0.62, 0.66), wetSand * beach);
      float sheet = (1.0 - smoothstep(runup - 0.5, runup, inland)) * beach;
      float sheetEdge = sheet * smoothstep(runup - 1.5, runup - 0.3, inland)
        * smoothstep(0.35, 0.6, texture2D(seaFoam, pm / 3.7).r);
      vec3 film = diffuseColor.rgb * 0.7 + textureLod(terrainSky, vec2(0.25, 0.53), 0.0).rgb * 0.25;
      diffuseColor.rgb = mix(diffuseColor.rgb, film, 0.8 * sheet);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8), 0.8 * sheetEdge);
    }
    float sunUp = max(-terrainSun.y, 0.1);
    float lit = (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * max(dot(slopeNormal, terrainSun), 0.0))
      / (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * sunUp);
    float shaded = terrainDay * land * smoothstep(detailFade.y, detailFade.y + 40.0 * detailSea.y, r);
    // The clouds' shadows drift over the land (not near the site: the splat's own light is fixed). Where the sun is
    // hidden only the sky's light is left, a little bluer.
    float shadowed = 0.0;
    if (terrainClouds > 0.0) {
      float aboveSite = -vTerrainPosition.y / detailSea.y;
      vec2 underCloud = pm + terrainSun.xz / sunUp * (${CLOUD_HEIGHT.toFixed(1)} - aboveSite);
      shadowed = cloudCover(underCloud) * terrainDay * smoothstep(${CLOUD_SHADOW_FROM.toFixed(1)}, ${(2.5 * CLOUD_SHADOW_FROM).toFixed(1)}, rm);
    }
    vec3 shadowLight = mix(vec3(1.0), vec3(0.92, 0.97, 1.12) * ${AMBIENT.toFixed(2)}
      / (${AMBIENT.toFixed(2)} + ${(1 - AMBIENT).toFixed(2)} * sunUp), shadowed);
    diffuseColor.rgb = haze + (diffuseColor.rgb - haze) * mix(1.0, clamp(lit, 0.3, 1.7), shaded) * mix(vec3(1.0), shadowLight, land);
    // The haze is brighter and warmer toward the sun and bluer away from it, not the same all around
    vec3 hazeTint = terrainHazeTint(-toEye);
    diffuseColor.rgb += haze * (hazeTint - 1.0) * land;
    // Pale sand (the dunes inland of the bays) eases toward a bright sand colour instead of glaring white
    vec3 over = max(diffuseColor.rgb - 0.55, 0.0) * shaded;
    diffuseColor.rgb -= over * over / (over + 0.3);
    if (land < 1.0) {
      // Patches of rougher and calmer water drift over the sea
      float gust = 0.6 + 0.8 * detailNoise(pm / 180.0 + terrainSwell * terrainTime * 0.01);
      // The waves: the sea's slopes (seaNormals) at four scales, each turned a little off the swell and drifting at
      // its waves' own speed. What a pixel can't show is averaged away in the texture's smaller copies and comes
      // back as roughness (B holds the slopes' squared length, which averages to their spread).
      vec2 slope = vec2(0.0);
      float rough = 0.003;
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
        float reflected = cloudCover(pm + mirrored.xz * far) * smoothstep(0.0, 0.08, mirroredUp) * exp(-far / ${CLOUD_FADE.toFixed(1)});
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
      vec3 water = body * (1.0 - 0.3 * shadowed) * (1.0 - fresnel) + skyColour * fresnel + min(glitter, 6.0) * (1.0 - shadowed);
      // White water where it would be: breaking waves where the satellite saw white water (reefs, points) and,
      // gentler, along every shore -- lines running in parallel to the shore, each a bright front with foam trailing
      // out behind it, thinning into lace (seaFoam) -- a thin edge where the water meets the land, and a few
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
      float surf = smoothstep(0.3, 0.65, density);
      float waterline = (1.0 - smoothstep(0.0, 2.0, coast)) * smoothstep(0.35, 0.65, lace);
      float caps = 0.04 * smoothstep(0.75, 1.3, gust);
      float whitecaps = smoothstep(1.0 - caps, 1.0 - caps + 0.1, lace) * step(0.002, caps);
      float foam = mix(max(max(surf, waterline), whitecaps),
        0.12 * breaking + 0.15 * (1.0 - smoothstep(0.0, 2.0, coast)) + 0.5 * caps, smoothstep(1.0, 5.0, foot));
      // The water churned up inside the surf, paler and greener
      water = mix(water, water * 0.6 + vec3(0.1, 0.17, 0.17), 0.5 * breaking * exp(-3.0 * behind));
      water = mix(water, vec3(0.78, 0.8, 0.8), 0.85 * clamp(foam, 0.0, 1.0));
      water = water * diffuse * exp(-rm / ${HAZE_METRES.toFixed(1)}) + haze * hazeTint;
      diffuseColor.rgb = mix(water, diffuseColor.rgb, land);
    }
    // Bruma costera: thin mist lying low over the sea and the coast in banks that drift in with the wind and slowly
    // change shape, thicker the further one looks through it
    if (terrainMist > 0.0) {
      float throughMetres = length(terrainEye - vTerrainPosition) / detailSea.y;
      vec2 drift = (pm - terrainSwell * ${MIST_WIND.toFixed(1)} * terrainTime) / ${MIST_BANK.toFixed(1)};
      float banks = smoothstep(0.38, 0.72, 0.7 * cloudFbm(drift + terrainTime * 0.002) + 0.3 * cloudNoise(drift * 4.3 + 2.0));
      float mist = terrainMist * exp(-max(aboveSea, 0.0) / ${MIST_DEPTH.toFixed(1)}) * banks
        * (1.0 - exp(-throughMetres / ${MIST_THROUGH.toFixed(1)}));
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * vec3(0.72, 0.75, 0.78) * mix(0.3, 1.0, terrainDay), ${MIST_MOST.toFixed(2)} * mist);
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
    float ks = smoothstep(scrubInfo.y, scrubInfo.z, r) * land * level * scrubInfo.w;
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
      vec3 mapped = mix(mix(scrubBare, texture2D(scrubMap, sm, 12.0).rgb, max(beyond, fromAbove)), plants, shown);
      diffuseColor.rgb *= mix(vec3(1.0), mapped * gain, ks);
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
    shader.uniforms.terrainMist = light.mist;
    shader.uniforms.terrainGlow = light.glow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 terrainShore;
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying vec3 vTerrainShore;`)
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
  const shore = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) shore[3 * i + 2] = COAST_FAR;
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
    // And the other way: how far each land vertex lies from the water (for the beaches' wet sand and the waves
    // running up them), over the triangles within SHORE_REACH of the site
    const inland = new Float32Array(count);
    for (let i = 0; i < count; i++) inland[i] = coast[i] ? 0 : COAST_FAR;
    const near: number[] = [];
    const reach = (SHORE_REACH * perMetre) ** 2;
    for (let t = 0; t < index.length; t += 3) {
      const v = index[t];
      if (p[3 * v] ** 2 + p[3 * v + 2] ** 2 < reach) near.push(t);
    }
    relaxAll(inland, near, index, p, perMetre, 4);
    for (let i = 0; i < count; i++) {
      shore[3 * i] = coast[i];
      shore[3 * i + 1] = white[i];
      shore[3 * i + 2] = inland[i];
    }
  }
  geometry.setAttribute('terrainShore', new THREE.BufferAttribute(shore, 3));
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
    // The clouds, the sun and the haze's glow toward it, over the panorama (in the terrain's frame: the sphere is
    // turned over, so its points' y and z flip)
    const skyMaterial = skyMesh.material as THREE.MeshBasicMaterial;
    skyMaterial.onBeforeCompile = (shader: any) => {
      Object.assign(shader.uniforms, {
        terrainSun: light.sun, terrainSwell: light.swell, terrainTime: light.time,
        terrainClouds: light.clouds, terrainGlow: light.glow,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkyDirection;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkyDirection = vec3(position.x, -position.y, -position.z);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vSkyDirection;\n${SKY_LIGHT_GLSL}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${SKY_FRAGMENT}`);
    };
    skyMaterial.customProgramCacheKey = () => 'sky-light';
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
      seaNormals.dispose();
      seaFoam.dispose();
      disposeObject(group);
    },
  };
}
