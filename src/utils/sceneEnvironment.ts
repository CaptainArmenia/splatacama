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
    diffuseColor.rgb *= max(1.0 + d * k, 0.0);
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
function addTerrainDetail(material: any, texture: any, detail: TerrainDetail, anisotropy: number, bloom: { value: number }) {
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

export type LoadedEnvironment = {
  // Terrain and sky, in the viewer's frame
  group: THREE.Group;
  // The terrain meshes, for finding heights on it (wind turbines) and darkening it at night
  terrain: THREE.Mesh[];
  sky: THREE.Mesh | null;
  // 0 to 1: how much of the land the desierto florido covers
  bloom: { value: number };
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
      camera.getWorldPosition(cameraPosition);
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
        .then((texture: any) => addTerrainDetail(object.material, texture, detail, anisotropy, bloom)));
    }
  });
  await Promise.all(details);
  group.add(gltf.scene);

  return { group, terrain, sky, bloom, dispose: () => disposeObject(group) };
}
