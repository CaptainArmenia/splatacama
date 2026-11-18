/**
 * The scene effects the viewer's "Efectos" panel turns on: night (the real night sky over the site) and the
 * camanchaca (coastal fog), and its graphics settings. Each changes several parts of the scene at once: the splat, the terrain and sky around it, the wind turbines and the page background.
 *
 * The effects are built in a "metric" frame: metres, y up, the site at the origin (see siteAnalysis.ts). A group
 * inside the scene's world group turns and scales them into the viewer's frame (y down, viewer units), so in VR,
 * where the world is shown upright at real size, they come along.
 */
import * as THREE from 'three';
import { dyno, type SplatMesh } from '@sparkjsdev/spark';
import { createCamanchaca, FOG_WISPS, type Camanchaca } from '@/effects/camanchaca';
import { createDaylight, createSplatShadow, sunDirection, type Daylight } from '@/effects/daylight';
import { createSeabirds } from '@/effects/seabirds';
import { loadScrub, type Scrub } from '@/effects/scrub';
import { createNightSky, type NightSky } from '@/effects/nightSky';
import type { ParsedSplat, SiteAnalysis } from '@/effects/siteAnalysis';
import { terrainAnisotropy, type LoadedEnvironment } from '@/utils/sceneEnvironment';
import { createNpc, type Npc } from '@/effects/npc';
import type { SceneNpc, SiteSun } from '@/types/cesium';
import type { WindTurbines } from '@/utils/windTurbines';

const NIGHT = {
  // Everything lit by daylight is multiplied by this: moonless, a little blue
  tint: new THREE.Color(0.2, 0.24, 0.36),
  fogTint: new THREE.Color(0.16, 0.18, 0.26),
  background: new THREE.Color('#03050b'),
};

const FOG = {
  color: new THREE.Color('#cfd4d8'),
  nightColor: new THREE.Color('#14171d'),
  // Where the terrain starts to fade into the fog and where it's gone (metres)
  near: 15,
  far: 300,
};

// How much of the sky the clouds cover when they're on (0 to 1; see sceneEnvironment.ts): fair-weather cumulus
const CLOUD_COVER = 0.62;

// Which way the Pacific's swell runs onto the coast (compass bearing): in from the south-west
const SWELL_BEARING = 60;

// Chile's coast keeps UTC-3 in the southern summer (and UTC-4 in winter; the night sky uses -3 all year)
const UTC_OFFSET_HOURS = -3;

export type SceneEffectsOptions = {
  // The scene in the viewer's frame; VR turns and scales it
  world: THREE.Group;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  // The scene's main splat mesh (in the .splat file's frame, inside `world`), and the file it came from
  splat: SplatMesh;
  file: ParsedSplat;
  site: { lat: number; lng: number; heading: number; metersPerUnit: number; sun?: SiteSun };
  analysis: SiteAnalysis;
  // Metres from the site centre where the splat starts to fade (its crop), or the edge of its detail
  splatRadius: number;
  environment: LoadedEnvironment | null;
  // The plants of the land around the site (SceneEnvironment.scrubUrl)
  scrubUrl?: string;
  scrubReach?: number;
  turbines: WindTurbines | null;
  // The page background by day
  background: THREE.Color;
  // Camera far plane, viewer units
  far: number;
  // People who walk the site
  npcs?: SceneNpc[];
};

export type SceneEffects = {
  readonly splat: SplatMesh;
  setNight: (on: boolean, hour: number) => void;
  setFog: (on: boolean) => void;
  /** Clouds in the sky, their shadows on the land and their reflection in the sea */
  setClouds: (on: boolean) => void;
  /** The sun's disc, and the haze brighter and warmer toward it */
  setAtmosphere: (on: boolean) => void;
  /** Gulls and pelicans flying round the site (by day) */
  setBirds: (on: boolean) => void;
  /** A light camanchaca, always about: wisps in drifting patches, and banks of mist low over the sea far off */
  setMist: (on: boolean) => void;
  /**
   * While a VR headset shows the scene: the terrain is shaded more simply (TerrainLight.lite) and the Bruma costera's
   * wisps aren't drawn. Thousands of large, faint splats over the whole view are costly for a headset's GPU, and in a
   * Quest 3 they showed as a wall of tiny dots around the site. Its banks of mist on the terrain stay.
   */
  setHeadset: (on: boolean) => void;
  /** Call every frame before rendering, with the camera */
  update: (seconds: number, deltaSeconds: number, camera: THREE.Camera) => void;
  dispose: () => void;
};

// Hides the splats far from the site (by `hide`, 0 to 1), in the .splat file's frame: at night and in fog they
// would show daytime sky. A cropped splat with terrain only keeps a dome of sky splats far out (crop_center.py); a
// full splat has its sky on a shell a few dozen metres out, above the horizon, and smears beyond.
// People standing on the site darken the splats in their shadow (`shadow`, from createSplatShadow).
function siteSplatModifier(hide: any, shadow: ReturnType<typeof createSplatShadow>, metersPerFileUnit: number, cropped: boolean) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }: any) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, hide: 'float', from: 'vec3', to: 'vec3', sun: 'vec3', strength: 'float' },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }: any) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        vec3 c = ${inputs.gsplat}.center * ${metersPerFileUnit.toFixed(4)};
        float far = length(c.xz);
        ${cropped
          ? 'float sky = smoothstep(300.0, 600.0, far);'
          : 'float sky = max(smoothstep(20.0, 35.0, far) * smoothstep(0.0, 0.04, -c.y / max(far, 1.0)), smoothstep(120.0, 200.0, far));'}
        ${outputs.gsplat}.rgba.a *= 1.0 - ${inputs.hide} * sky;
        ${shadow.glsl(outputs.gsplat, inputs, metersPerFileUnit.toFixed(4))}
      `),
    });
    return { gsplat: d.apply({ gsplat, hide, ...shadow.uniforms }).gsplat };
  });
}

export async function createSceneEffects(options: SceneEffectsOptions): Promise<SceneEffects> {
  const { world, scene, renderer, file, site, analysis, environment, turbines, splat } = options;

  const metric = new THREE.Group();
  metric.name = 'scene-effects';
  metric.quaternion.set(1, 0, 0, 0); // 180 degrees about x: y up becomes y down
  metric.scale.setScalar(1 / site.metersPerUnit);
  world.add(metric);

  // Compass directions in the metric frame (see MapLandmark.heading for the viewer's)
  const h = THREE.MathUtils.degToRad(site.heading);
  const compass = {
    east: new THREE.Vector3(Math.cos(h), 0, Math.sin(h)),
    north: new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)),
  };

  // The site's splat mesh: night recolours it, and night and fog thin it out far away
  const hideFar = dyno.dynoFloat(0);
  // The light the site's people stand in, and their shadows on the splats
  const daylight: Daylight | null = options.npcs?.length ? createDaylight(scene, metric, renderer, analysis, compass, site.sun) : null;
  const shadow = createSplatShadow(daylight?.sun ?? new THREE.Vector3(0, 1, 0));
  // The terrain's sun and swell, in its frame (the metric frame turned over: y and z flip)
  if (environment) {
    const toSun = daylight?.sun ?? sunDirection(compass, site.sun);
    environment.light.sun.value.set(toSun.x, -toSun.y, -toSun.z).normalize();
    const b = THREE.MathUtils.degToRad(SWELL_BEARING);
    const swell = compass.north.clone().multiplyScalar(Math.cos(b)).addScaledVector(compass.east, Math.sin(b));
    environment.light.swell.value.set(swell.x, -swell.z).normalize();
  }
  const shadowAt = new THREE.Vector3(0, -1000, 0);
  splat.objectModifier = siteSplatModifier(hideFar, shadow, file.scale, !!environment);
  splat.updateGenerator();

  // Stars past the terrain and inside the far plane
  const sky: NightSky = await createNightSky(site, compass, options.far * 0.9 * site.metersPerUnit);
  metric.add(sky.group);
  const fog: Camanchaca = createCamanchaca(analysis.groundAt(0, 0), compass);
  metric.add(fog.mesh);
  // The Bruma costera setting: a far lighter camanchaca, in patches, always about (and banks of mist on the terrain)
  const mist: Camanchaca = createCamanchaca(analysis.groundAt(0, 0), compass, FOG_WISPS);
  metric.add(mist.mesh);
  let mistOn = false;
  let headset = false;
  const birds = createSeabirds(analysis.groundAt(0, 0));
  metric.add(birds.mesh);
  let birdsOn = false;

  // People walking the site, on the splat's ground; they appear when their model has loaded
  const npcs: Npc[] = [];
  let disposed = false;

  // The plants of the land around, on the terrain; they appear when their atlas has loaded
  let scrub: Scrub | null = null;
  if (environment && options.scrubUrl) {
    loadScrub(options.scrubUrl, environment, metric, analysis, daylight?.sun ?? sunDirection(compass, site.sun),
      site.sun?.shadows ?? 1, site.metersPerUnit, terrainAnisotropy(renderer), options.scrubReach)
      .then(loaded => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        scrub = loaded;
        metric.add(loaded.mesh);
        apply();
      })
      .catch(error => console.warn('Scrub failed to load', error));
  }

  for (const spec of options.npcs ?? []) {
    createNpc(spec, metric, analysis, options.splatRadius, daylight!)
      .then(npc => {
        if (disposed) npc.dispose();
        else npcs.push(npc);
      })
      .catch((e: unknown) => console.error(`Error loading ${spec.name}:`, e));
  }

  // The terrain fades into the camanchaca with three.js fog. It's always set, far away when off, so turning it on
  // and off doesn't recompile the terrain's shaders.
  const unitsPerMetre = 1 / site.metersPerUnit;
  const sceneFog = new THREE.Fog(FOG.color.clone(), 1e8, 1e9);
  scene.fog = sceneFog;

  let night = false;
  let fogOn = false;

  // Night and fog both change the background, the terrain, the sky and the far splats
  const apply = () => {
    const tint = night ? NIGHT.tint : new THREE.Color(1, 1, 1);
    splat.recolor.copy(tint);
    fog.mesh.recolor.copy(night ? NIGHT.fogTint : new THREE.Color(1, 1, 1));
    fog.mesh.updateVersion();
    mist.mesh.recolor.copy(fog.mesh.recolor);
    mist.mesh.visible = mistOn && !fogOn && !headset;
    if (environment) environment.light.mist.value = mistOn && !fogOn ? 1 : 0;
    // The splats' colours are multiplied as they're stored, the meshes' as light: the same tint, decoded, for those
    const landTint = tint.clone().convertSRGBToLinear();
    for (const mesh of environment?.terrain ?? []) (mesh.material as THREE.MeshBasicMaterial).color.copy(landTint);
    scrub?.setTint(landTint);
    if (environment?.sky) environment.sky.visible = !night && !fogOn;
    if (environment) environment.light.day.value = night || fogOn ? 0 : 1;
    birds.mesh.visible = birdsOn && !night;
    sky.group.visible = night;
    daylight?.setNight(night);
    shadow.uniforms.strength.value = night || fogOn || !npcs.length ? 0 : 1;

    const fogColor = night ? FOG.nightColor : FOG.color;
    turbines?.setConditions(night, fogOn ? fogColor : night ? NIGHT.background : null);
    sceneFog.color.copy(fogColor);
    sceneFog.near = fogOn ? FOG.near * unitsPerMetre : 1e8;
    sceneFog.far = fogOn ? FOG.far * unitsPerMetre : 1e9;
    fog.mesh.visible = fogOn;
    renderer.setClearColor(fogOn ? fogColor : night ? NIGHT.background : options.background, 1);

    hideFar.value = night || fogOn ? 1 : 0;
    splat.updateVersion();
  };

  const metricCamera = new THREE.Vector3();

  return {
    splat,
    setNight(on, hour) {
      night = on;
      if (on) {
        // Tonight (or this morning, for hours past midnight) at the site
        const today = new Date();
        const utc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) + (hour - UTC_OFFSET_HOURS) * 3600e3;
        sky.setTime(new Date(utc));
      }
      apply();
    },
    setFog(on) {
      fogOn = on;
      apply();
    },
    setClouds(on) {
      if (environment) environment.light.clouds.value = on ? CLOUD_COVER : 0;
    },
    setAtmosphere(on) {
      if (environment) environment.light.glow.value = on ? 1 : 0;
    },
    setBirds(on) {
      birdsOn = on;
      apply();
    },
    setMist(on) {
      mistOn = on;
      apply();
    },
    setHeadset(on) {
      headset = on;
      if (environment) environment.light.lite.value = on ? 1 : 0;
      apply();
    },
    update(seconds, deltaSeconds, camera) {
      sky.update(seconds);
      if (birds.mesh.visible) birds.update(seconds);
      camera.getWorldPosition(metricCamera);
      fog.update(seconds, metric.worldToLocal(metricCamera));
      mist.update(seconds, metricCamera);
      for (const npc of npcs) npc.update(deltaSeconds, metricCamera);
      // Her shadow follows her: the splats are redrawn when she has moved a centimetre
      if (npcs.length && !night && !fogOn && npcs[0].feet.distanceToSquared(shadowAt) > 1e-4) {
        shadowAt.copy(npcs[0].feet);
        shadow.uniforms.from.value.copy(npcs[0].feet).setY(npcs[0].feet.y + 0.1);
        shadow.uniforms.to.value.copy(npcs[0].head).setY(npcs[0].head.y - 0.14);
        shadow.uniforms.strength.value = 1;
        splat.updateVersion();
      }
      turbines?.update(seconds);
      scrub?.update(seconds, metricCamera);
    },
    dispose() {
      disposed = true;
      for (const npc of npcs) npc.dispose();
      daylight?.dispose();
      scrub?.dispose();
      sky.dispose();
      fog.dispose();
      mist.dispose();
      birds.dispose();
      metric.removeFromParent();
      scene.fog = null;
      splat.removeFromParent();
      splat.dispose();
    },
  };
}
