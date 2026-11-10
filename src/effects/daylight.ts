/**
 * The site's daylight, for the meshes that stand in it (the people who walk it), so they sit in the light the splat
 * was photographed in: the sun where it was, the sky's blue fill from above and the sand's warm bounce from below
 * (in the photo's proportions: shadows there are deep), the shadows the site's walls and bushes cast on them, their
 * own shadows on themselves (a shadow map that follows them) and on the splat's ground (see shadowOnSplats), and a
 * camera-like roll-off instead of clipped highlights.
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts).
 */
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';
import type { SiteAnalysis } from '@/effects/siteAnalysis';

const DAYLIGHT = {
  // The sun of a site that gives none (MapLandmark.sun): compass bearing and elevation, degrees. An early
  // afternoon's, as in pirca0's photo.
  bearing: 346,
  elevation: 53,
  sun: '#fffaf2',
  sunIntensity: 4,
  // Light from the sky and off the ground, as fractions of the sun's on a surface facing it. A clear sky is about a
  // sixth of the sun; sand in full sun throws back about a third.
  sky: new THREE.Color(0.62, 0.78, 1.0).multiplyScalar(0.26),
  ground: new THREE.Color(1.0, 0.84, 0.62).multiplyScalar(0.34),
  night: 0.012,
  // The shadow map: its side on the ground (metres) and in pixels
  shadowSpan: 2.6,
  shadowPixels: 1024,
  // Shadows from the site (its top surface from the analysis), marched toward the sun: steps and their length (m)
  siteSteps: 10,
  siteStep: 0.17,
  // Shadows on the splats: what's left of their colour in full shadow (as the walls' own shadows on the sand)
  splatShadow: new THREE.Color(0.33, 0.35, 0.42),
};

const HEADER = `
  uniform vec3 daylightSky;
  uniform vec3 daylightGround;
  uniform vec3 daylightUp;
  uniform vec3 daylightSun;
  uniform float daylightLevel;
  uniform sampler2D daylightTops;
  uniform float daylightHalf;
  varying vec3 vDaylightPosition;
  // How much sun reaches a point (metric frame) past the site's walls and bushes
  float daylightSiteShadow(vec3 p) {
    float lit = 1.0;
    for (int i = 1; i <= ${DAYLIGHT.siteSteps}; i++) {
      vec3 q = p + daylightSun * (float(i) - 0.5) * ${DAYLIGHT.siteStep.toFixed(3)};
      vec2 uv = (q.xz + daylightHalf) / (2.0 * daylightHalf);
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      lit = min(lit, smoothstep(-0.05, 0.03, q.y - texture2D(daylightTops, uv).r));
    }
    return lit;
  }
  // A camera's shoulder: straight up to 0.6, then easing toward 1
  vec3 daylightTone(vec3 c) {
    vec3 over = max(c - 0.6, 0.0) / 0.4;
    return min(c, 0.6) + 0.4 * (1.0 - exp(-over));
  }`;

const AMBIENT = `{
    vec3 worldNormal = inverseTransformDirection(geometryNormal, viewMatrix);
    irradiance = mix(daylightGround, daylightSky, dot(worldNormal, daylightUp) * 0.5 + 0.5) * daylightLevel * PI;
  }`;

export type Daylight = {
  /** Unit vector toward the sun (metric frame) */
  sun: THREE.Vector3;
  /** Lights a mesh material as the site is lit, in place of the scene's sky light */
  light: (material: THREE.Material) => void;
  /** Aims the shadow map at whoever stands at `centre` (metric frame), `height` metres tall */
  follow: (centre: THREE.Vector3, height: number) => void;
  setNight: (night: boolean) => void;
  dispose: () => void;
};

/** Unit vector toward the sun of the site's photos (`sun`: its compass bearing and elevation), in the metric frame */
export function sunDirection(
  compass: { north: THREE.Vector3; east: THREE.Vector3 },
  sun?: { bearing: number; elevation: number },
) {
  const b = THREE.MathUtils.degToRad(sun?.bearing ?? DAYLIGHT.bearing);
  const e = THREE.MathUtils.degToRad(sun?.elevation ?? DAYLIGHT.elevation);
  return compass.north.clone().multiplyScalar(Math.cos(b) * Math.cos(e))
    .addScaledVector(compass.east, Math.sin(b) * Math.cos(e))
    .add(new THREE.Vector3(0, Math.sin(e), 0));
}

export function createDaylight(
  scene: THREE.Scene,
  metric: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  analysis: SiteAnalysis,
  compass: { north: THREE.Vector3; east: THREE.Vector3 },
  siteSun?: { bearing: number; elevation: number },
): Daylight {
  // The scene's sun, if it has one (the wind turbines bring theirs), or one of our own
  let found: THREE.DirectionalLight | null = null;
  scene.traverse(object => {
    if ((object as THREE.DirectionalLight).isDirectionalLight) found = object as THREE.DirectionalLight;
  });
  const own = !found;
  const sun = new THREE.Vector3();
  let sunLight: THREE.DirectionalLight;
  metric.updateWorldMatrix(true, false);
  const toMetric = new THREE.Matrix4().copy(metric.matrixWorld).invert();
  if (found) {
    sunLight = found;
    sunLight.updateWorldMatrix(true, false);
    sunLight.target.updateWorldMatrix(true, false);
    sun.setFromMatrixPosition(sunLight.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(sunLight.target.matrixWorld))
      .transformDirection(toMetric);
  } else {
    sun.copy(sunDirection(compass, siteSun));
    sunLight = new THREE.DirectionalLight(DAYLIGHT.sun, DAYLIGHT.sunIntensity);
    metric.add(sunLight);
  }
  const lightParent = sunLight.parent!;
  lightParent.add(sunLight.target);

  const shadowsWere = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(DAYLIGHT.shadowPixels, DAYLIGHT.shadowPixels);

  // The site's top surface, for the shadows its walls and bushes cast
  const tops = new THREE.DataTexture(analysis.top, analysis.n, analysis.n, THREE.RedFormat, THREE.FloatType);
  tops.minFilter = tops.magFilter = THREE.NearestFilter;
  tops.needsUpdate = true;

  const uniforms = {
    daylightSky: { value: DAYLIGHT.sky.clone() },
    daylightGround: { value: DAYLIGHT.ground.clone() },
    daylightUp: { value: new THREE.Vector3(0, -1, 0) },
    daylightSun: { value: sun },
    daylightLevel: { value: 1 },
    daylightTops: { value: tops },
    daylightHalf: { value: analysis.half },
    daylightMetric: { value: toMetric },
  };

  const worldCentre = new THREE.Vector3();
  const worldSun = new THREE.Vector3();
  const worldTarget = new THREE.Vector3();
  const scale = new THREE.Vector3();
  return {
    sun,
    light(material) {
      material.onBeforeCompile = (shader: any) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform mat4 daylightMetric;\nvarying vec3 vDaylightPosition;')
          .replace('#include <project_vertex>',
            '#include <project_vertex>\nvDaylightPosition = (daylightMetric * modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${HEADER}`)
          .replace('#include <lights_fragment_begin>', `${THREE.ShaderChunk.lights_fragment_begin
            .replace('getDirectionalLightInfo( directionalLight, directLight );',
              'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= daylightSiteShadow(vDaylightPosition);')}\n${AMBIENT}`)
          .replace('#include <opaque_fragment>', 'outgoingLight = daylightTone(outgoingLight);\n#include <opaque_fragment>');
      };
      material.customProgramCacheKey = () => 'daylight';
      material.needsUpdate = true;
    },
    follow(centre, height) {
      // The world may be turned and scaled (VR shows it upright at real size)
      metric.updateWorldMatrix(true, false);
      uniforms.daylightMetric.value.copy(metric.matrixWorld).invert();
      uniforms.daylightUp.value.set(0, 1, 0).transformDirection(metric.matrixWorld);
      const perMetre = metric.getWorldScale(scale).x;
      worldCentre.copy(centre);
      worldCentre.y += height / 2;
      metric.localToWorld(worldCentre);
      worldSun.copy(sun).transformDirection(metric.matrixWorld);
      const reach = 6 * perMetre;
      sunLight.target.position.copy(lightParent.worldToLocal(worldTarget.copy(worldCentre)));
      sunLight.position.copy(lightParent.worldToLocal(worldSun.multiplyScalar(reach).add(worldCentre)));
      const camera = sunLight.shadow.camera;
      const half = (DAYLIGHT.shadowSpan / 2) * perMetre;
      camera.left = camera.bottom = -half;
      camera.right = camera.top = half;
      camera.near = reach - 2 * perMetre;
      camera.far = reach + 2 * perMetre;
      camera.updateProjectionMatrix();
      sunLight.shadow.bias = -0.0004;
      sunLight.shadow.normalBias = 0.012 * perMetre;
    },
    setNight(night) {
      uniforms.daylightLevel.value = night ? DAYLIGHT.night : 1;
      if (own) sunLight.intensity = night ? 0 : DAYLIGHT.sunIntensity;
    },
    dispose() {
      tops.dispose();
      sunLight.castShadow = false;
      sunLight.shadow.dispose();
      renderer.shadowMap.enabled = shadowsWere;
      if (own) sunLight.removeFromParent();
    },
  };
}

/**
 * The shadow a standing person casts on the splats, for a splat mesh's modifier: the uniforms to set each frame
 * (`from` her feet and `to` her head, metric frame; `strength` 0 for none) and the GLSL that darkens `gsplat` inside
 * the shadow of the capsule between them, softer the farther it falls. `metres` turns a splat's centre into metres.
 */
export function createSplatShadow(sun: THREE.Vector3) {
  const uniforms = {
    from: dyno.dynoVec3(new THREE.Vector3(0, -1000, 0)),
    to: dyno.dynoVec3(new THREE.Vector3(0, -999, 0)),
    sun: dyno.dynoVec3(sun.clone()),
    strength: dyno.dynoFloat(0),
  };
  const tint = DAYLIGHT.splatShadow;
  const glsl = (gsplat: string, input: Record<string, string>, metres: string) => `
    if (${input.strength} > 0.0) {
      vec3 p = vec3(${gsplat}.center.x, -${gsplat}.center.y, -${gsplat}.center.z) * ${metres};
      vec3 ab = ${input.to} - ${input.from};
      vec3 w = p - ${input.from};
      float aa = dot(ab, ab);
      float b = dot(ab, ${input.sun});
      float den = aa - b * b;
      float u = den > 1e-5 ? clamp((dot(ab, w) - b * dot(${input.sun}, w)) / den, 0.0, 1.0) : 0.0;
      float t = max(dot(${input.from} + u * ab - p, ${input.sun}), 0.0);
      u = clamp(dot(p + t * ${input.sun} - ${input.from}, ab) / aa, 0.0, 1.0);
      float d = length(p + t * ${input.sun} - ${input.from} - u * ab);
      // Narrower at her legs than at her shoulders
      float radius = mix(0.12, 0.22, smoothstep(0.25, 0.7, u)) * (1.0 - 0.35 * smoothstep(0.85, 1.0, u));
      float soft = 0.02 + 0.05 * t;
      float shade = (1.0 - smoothstep(radius - soft * 0.5, radius + soft, d)) * ${input.strength};
      // Splats already in shade (dark ones) have little sun left to lose
      float luma = dot(${gsplat}.rgba.rgb, vec3(0.3, 0.59, 0.11));
      shade *= smoothstep(0.12, 0.4, luma);
      ${gsplat}.rgba.rgb *= mix(vec3(1.0), vec3(${tint.r.toFixed(3)}, ${tint.g.toFixed(3)}, ${tint.b.toFixed(3)}), shade);
    }`;
  return { uniforms, glsl };
}
