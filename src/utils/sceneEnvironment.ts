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
  }`;

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
const TERRAIN_DETAIL_FRAGMENT = `{
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
      diffuseColor.rgb *= mix(vec3(1.0), texture2D(scrubMap, sm).rgb * gain, ks);
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
  }`;

// Multiplies the detail texture over a terrain material's colours (the meshes' positions are in the viewer's frame)
function addTerrainDetail(material: any, texture: any, detail: TerrainDetail, anisotropy: number, bloom: { value: number },
  scrub: TerrainScrub) {
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainPosition = position;');
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
      details.push(gltf.parser.getDependency('texture', detail.texture)
        .then((texture: any) => addTerrainDetail(object.material, texture, detail, anisotropy, bloom, scrub)));
    }
  });
  await Promise.all(details);
  group.add(gltf.scene);

  return {
    group, terrain, sky, bloom, scrub,
    dispose: () => {
      blank.dispose();
      disposeObject(group);
    },
  };
}
