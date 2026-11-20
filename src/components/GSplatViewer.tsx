'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isMobile, SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import type { MapLandmark, SceneTurbines, SceneVariant } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';
import { buildWalkArea } from '@/utils/walkArea';
import { isHeadsetBrowser, isVRSupported, VRWalk } from '@/utils/vrWalk';
import { loadSceneEnvironment, terrainAnisotropy, type LoadedEnvironment } from '@/utils/sceneEnvironment';
import { addWindTurbines, type WindTurbines } from '@/utils/windTurbines';
import { createMeshAntialias, type MeshAntialias } from '@/utils/meshAntialias';
import { analyzeSite, parseSplat, SPLAT_RECORD_BYTES, type SiteAnalysis } from '@/effects/siteAnalysis';
import { createSceneEffects, type SceneEffects } from '@/effects/sceneEffects';
import SceneEffectsPanel from '@/components/SceneEffectsPanel';
import { DEFAULT_GRAPHICS, loadGraphics, saveGraphics, type GraphicsSettings } from '@/utils/graphicsSettings';
import SceneSound from '@/components/SceneSound';
import { createSceneSound, type SceneSound as SceneSoundEngine } from '@/utils/sceneSound';
import { createPanoView, type PanoMode as PanoViewMode, type PanoView } from '@/utils/panoView';
import { createPhotoPoses, type PhotoPoses } from '@/utils/photoPoses';

type Props = {
  site: MapLandmark;
  // Real wind turbines near the site (windTurbines.json)
  turbines?: SceneTurbines;
  backgroundColor?: string;
  onError?: (errorMessage: string) => void;
};

// Where the camera starts, and where the reset button puts it back. Scenes are y-down (camera.up [0, -1, 0])
// and drawn at SCENE_SCALE.
const INITIAL_CAMERA_POSITION = [7, -2.5, 5];
const INITIAL_CAMERA_LOOK_AT = [0, 0, 0];
const SCENE_SCALE = 10;

// The site's main structure is about 8 viewer units across (see MapLandmark.metersPerUnit)
const SITE_RADIUS_UNITS = 4;

// The most splats drawn in a frame outside VR. A scene with more is drawn through Spark's level-of-detail tree, which
// picks them by distance: at a 2880 x 1800 window a 3.1 million splat scene ran at 52-58 frames a second whole and at
// 72-81 with this budget, for a start view about 13% softer. The tree takes about 4 s longer to come up sharp.
const SPLAT_BUDGET = 2_000_000;

// Camera limits for sites without their own (landmarks.json `view`). The camera may look from any angle, but away
// from where the photos were taken splat scenes turn to smears and needles, so it can't zoom out past maxDistance
// or leave the circle of `radius` around the site. The point it orbits stays within half that circle: close-ups of
// the circle's edge, where the splat fades out, look smeared.
const DEFAULT_VIEW = { maxDistance: 14, radius: 14 };
const MIN_DISTANCE = 1;
const MAX_TARGET_RADIUS = 0.5;
// How far the orbit centre may be panned up from the site's ground (viewer units; y points down)
const MAX_PAN_HEIGHT = 1.5;
// The camera stays at least at a standing visitor's eye height above the ground, and this far above anything
// standing on it (walls, bushes), in metres: lower, it ends up in the bushes or under the ground
const EYE_HEIGHT = 1.5;
const CAMERA_CLEARANCE = 0.5;

// Camera far plane without terrain (viewer units)
const DEFAULT_FAR = 1000;

// Spark's default splat footprint, and a smaller one for VR that draws faster at a small cost at splat edges
const SPLAT_STD_DEV = Math.sqrt(8);
const VR_SPLAT_STD_DEV = Math.sqrt(5);

type LoadProgress = { stage: 'downloading' | 'processing'; percent: number };

// The site's 360 degree photo: not in use, or the camera at its viewpoint showing the photo, the photo with depth
// or the scene
type PanoMode = 'off' | PanoViewMode;
const PANO_LABELS: Record<PanoViewMode, string> = { photo: 'Foto 360°', relief: 'Foto 3D', scene: 'Escena 3D' };

// The scene as the site has it (its splat with terrain and sky around), among the versions to compare it with
const SITE_VERSION = 'site';
const SITE_VERSION_LABEL = 'Con terreno';
const SITE_VERSION_DESCRIPTION = 'El sitio en splats y, alrededor, el terreno y el cielo dibujados aparte.';

// Downloads a file, reporting the bytes received and the total when the server sends its length
async function download(url: string, signal: AbortSignal, onProgress: (received: number, total: number) => void) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar la escena (HTTP ${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Lets the loading panel repaint before a long synchronous step
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

export default function GSplatViewer({ site, turbines, backgroundColor = '#f5f5f5', onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls; start: THREE.Vector3 } | null>(null);
  const vrRef = useRef<VRWalk | null>(null);
  const effectsRef = useRef<SceneEffects | null>(null);
  const panoRef = useRef<PanoView | null>(null);
  const [panoReady, setPanoReady] = useState(false);
  const [panoMode, setPanoMode] = useState<PanoMode>('off');
  const [panoLoading, setPanoLoading] = useState(false);
  const [panoError, setPanoError] = useState(false);
  const [depthColours, setDepthColours] = useState(false);
  // Which version of the scene shows, at a site with others to compare (landmarks.json `variants`)
  const versionRef = useRef<((id: string) => Promise<void>) | null>(null);
  const versionRequest = useRef(0);
  const [version, setVersion] = useState(SITE_VERSION);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState(false);
  const versions = site.variants?.length
    ? [{ id: SITE_VERSION, label: SITE_VERSION_LABEL, description: SITE_VERSION_DESCRIPTION }, ...site.variants]
    : [];
  const changeVersion = (id: string) => {
    const show = versionRef.current;
    if (!show) return;
    setVersion(id);
    setVersionError(false);
    setVersionLoading(true);
    const request = ++versionRequest.current;
    show(id)
      .catch((e: unknown) => {
        console.error('Error loading the scene version:', e);
        if (request === versionRequest.current) setVersionError(true);
      })
      .finally(() => {
        if (request === versionRequest.current) setVersionLoading(false);
      });
  };

  // The pyramids showing where each photo of the site was taken from
  const posesRef = useRef<PhotoPoses | null>(null);
  const [showPoses, setShowPoses] = useState(false);
  // Counts the views asked for, so a slow download's end doesn't change the label of a later choice
  const panoRequest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>({ stage: 'downloading', percent: 0 });
  const [vrReady, setVrReady] = useState(false);
  const [vrError, setVrError] = useState(false);

  const [effectsReady, setEffectsReady] = useState(false);
  useEffect(() => {
    posesRef.current?.setVisible(showPoses);
  }, [showPoses, effectsReady]);
  const [night, setNight] = useState(false);
  const [hour, setHour] = useState(22);
  const [fog, setFog] = useState(false);
  // The graphics settings, remembered in this browser
  const [graphics, setGraphics] = useState<GraphicsSettings>(DEFAULT_GRAPHICS);
  const graphicsRef = useRef(graphics);
  const meshAntialiasRef = useRef<MeshAntialias | null>(null);
  useEffect(() => {
    setGraphics(loadGraphics());
  }, []);
  const changeGraphics = (change: Partial<GraphicsSettings>) => {
    setGraphics(previous => {
      const next = { ...previous, ...change };
      saveGraphics(next);
      return next;
    });
  };

  // The wind and the turbines' sound: one for the page, kept across scene changes
  const [sound, setSound] = useState<SceneSoundEngine | null>(null);
  const soundRef = useRef<SceneSoundEngine | null>(null);
  useEffect(() => {
    const engine = createSceneSound();
    soundRef.current = engine;
    setSound(engine);
    return () => {
      engine.dispose();
      soundRef.current = null;
    };
  }, []);

  // What the viewer is built from, as a string, so new but equal objects don't restart it
  const sceneKey = JSON.stringify({
    url: site.gsplatUrl, lightUrl: site.gsplatLightUrl, view: site.view, environment: site.environment, turbines, npcs: site.npcs,
    lat: site.lat, lng: site.lng, heading: site.heading, metersPerUnit: site.metersPerUnit, sun: site.sun,
    pano: site.pano, photoPosesUrl: site.photoPosesUrl, variants: site.variants, plainBlur: site.plainBlur,
    lightPlainBlur: site.lightPlainBlur,
  });

  // Keep the latest onError without making it restart the viewer
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    effectsRef.current?.setNight(night, hour);
  }, [effectsReady, night, hour]);
  useEffect(() => {
    effectsRef.current?.setFog(fog);
  }, [effectsReady, fog]);
  useEffect(() => {
    graphicsRef.current = graphics;
    effectsRef.current?.setClouds(graphics.clouds);
    effectsRef.current?.setAtmosphere(graphics.atmosphere);
    effectsRef.current?.setBirds(graphics.birds);
    effectsRef.current?.setMist(graphics.mist);
    effectsRef.current?.setQuality(graphics.quality);
    meshAntialiasRef.current?.setSamples(graphics.quality ? 4 : 0);
  }, [effectsReady, graphics]);

  // The 360 degree photo: go to its viewpoint (showing the photo, or the scene from there), or leave it
  const changePanoMode = (mode: PanoMode) => {
    const pano = panoRef.current;
    if (!pano) return;
    setPanoMode(mode);
    const request = ++panoRequest.current;
    setPanoError(false);
    if (mode === 'off') {
      setPanoLoading(false);
      pano.exit();
      return;
    }
    setPanoLoading(true);
    pano.show(mode)
      .catch((e: unknown) => {
        console.error('Error loading the 360 photo:', e);
        if (request === panoRequest.current) setPanoError(true);
      })
      .finally(() => {
        // Only the latest choice decides what the label says
        if (request === panoRequest.current) setPanoLoading(false);
      });
  };
  useEffect(() => {
    panoRef.current?.setDepthColours(depthColours);
  }, [depthColours, panoReady]);
  // Escape leaves the photo's viewpoint
  useEffect(() => {
    if (panoMode === 'off') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      panoRef.current?.exit();
      setPanoMode('off');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panoMode]);

  // Reset camera to initial position
  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    panoRef.current?.exit();
    setPanoMode('off');
    viewer.camera.position.copy(viewer.start);
    viewer.controls.target.fromArray(INITIAL_CAMERA_LOOK_AT);
    viewer.controls.update();
  };

  const enterVR = () => {
    setVrError(false);
    // VR walks the scene as the site has it
    if (version !== SITE_VERSION) changeVersion(SITE_VERSION);
    panoRef.current?.exit();
    setPanoMode('off');
    vrRef.current?.enter().catch((e: unknown) => {
      console.error('Error starting VR:', e);
      setVrError(true);
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { url, lightUrl, view, environment: env, turbines: turbineConfig, npcs, lat, lng, heading, metersPerUnit, sun, pano: panoConfig, photoPosesUrl, variants, plainBlur, lightPlainBlur } = JSON.parse(sceneKey);
    const limits = { ...DEFAULT_VIEW, ...view };
    const background = new THREE.Color(env?.background ?? backgroundColor);
    const far = env?.far ?? DEFAULT_FAR;

    // On trial, for comparing versions of a scene on the live site without changing it for visitors:
    // ?splat=<file in the bucket> loads that splat instead of the site's, and ?noenv leaves out the terrain mesh, the
    // sky and the plants, to see a splat that carries its own surroundings.
    const trial = new URLSearchParams(window.location.search);
    const trialSplat = trial.get('splat');
    // Phones, tablets and headsets load the site's lighter scene, where it has one
    const usesLightScene = Boolean(lightUrl) && (isMobile() || isHeadsetBrowser());
    const siteSplatUrl = usesLightScene ? lightUrl : url;
    // The lighter scene can be an older model that needs the other blur (see usePlainBlur below)
    const sitePlainBlur = usesLightScene && lightPlainBlur !== undefined ? lightPlainBlur : plainBlur;
    const splatUrl = trialSplat && /^[\w.-]+\.splat$/.test(trialSplat) ? trialSplat : siteSplatUrl;
    // ?lod=<splats> draws at most that many splats a frame on any device, to try a budget (see SPLAT_BUDGET)
    const trialBudget = Number(trial.get('lod')) || 0;
    const splatOnly = trial.has('noenv');

    let cancelled = false;
    const downloadAbort = new AbortController();

    // A container React doesn't manage, for the canvas
    const viewerContainer = document.createElement('div');
    viewerContainer.style.width = '100%';
    viewerContainer.style.height = '100%';
    viewerContainer.setAttribute('data-gsplat-container', 'true');
    container.appendChild(viewerContainer);

    // Multisampling is off, as Spark advises (it multiplies the cost of every splat on a computer's GPU), and the
    // meshes' edges are smoothed by createMeshAntialias instead. But that pass doesn't run in VR, where the horizon and
    // the hills' outlines then showed as stair-steps crawling with every move of the head. A headset's GPU resolves
    // multisampling tile by tile at little cost, and three.js gives the VR image 4 samples when the context has it on,
    // so a headset's own browser gets it.
    //
    // On trial, with ?vrmesh in the address: multisampling only the meshes in VR too (meshAntialias.renderXR), which
    // should cost less, since the splats are then blended into one sample instead of four. It is not the default
    // until it has been seen working on a headset: its first version drew no splats at all on the Meta Quest.
    const meshPassInVR = new URLSearchParams(window.location.search).has('vrmesh');
    const renderer = new THREE.WebGLRenderer({ antialias: isHeadsetBrowser() && !meshPassInVR });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(background, 1);
    renderer.domElement.style.display = 'block';
    viewerContainer.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, far);
    camera.up.set(0, -1, 0);
    // The start view: from the usual side and distance, raised to the site's own angle if it gives one
    const start = new THREE.Vector3().fromArray(INITIAL_CAMERA_POSITION);
    if (limits.startElevation) {
      const distance = start.length();
      const elevation = THREE.MathUtils.degToRad(limits.startElevation);
      const level = Math.hypot(start.x, start.z);
      start.set((start.x / level) * distance * Math.cos(elevation), -distance * Math.sin(elevation),
        (start.z / level) * distance * Math.cos(elevation));
    }
    camera.position.copy(start);
    camera.lookAt(new THREE.Vector3().fromArray(INITIAL_CAMERA_LOOK_AT));
    // VR moves the visitor by moving this rig; on the desktop it stays put
    const rig = new THREE.Group();
    rig.add(camera);
    scene.add(rig);
    // Everything drawn for the site, in the viewer's frame. VR shows it upright and at real size.
    const world = new THREE.Group();
    world.name = 'site';
    scene.add(world);
    // Brush, which trains the splats, widens each one by 0.3 px on screen and leaves its opacity alone. Spark by
    // default widens it and lowers its opacity to match (anti-aliasing), which fades the small splats: a model
    // that draws its dark detail with small splats over large pale ones then comes out washed. `plainBlur` in
    // landmarks.json draws a site as it was trained; ?blur=plain or ?blur=aa tries the other on any site.
    const blurTrial = new URLSearchParams(window.location.search).get('blur');
    const usePlainBlur = blurTrial === 'plain' || (blurTrial !== 'aa' && sitePlainBlur === true);
    const spark = new SparkRenderer({
      renderer, maxStdDev: SPLAT_STD_DEV, ...(usePlainBlur ? { preBlurAmount: 0.3, blurAmount: 0 } : {}),
    });
    // Smooths the meshes' edges (terrain, turbines) without touching the splats; in VR only on trial (see above)
    const meshAntialias = createMeshAntialias(renderer);
    meshAntialiasRef.current = meshAntialias;
    meshAntialias.setSamples(graphicsRef.current.quality ? 4 : 0);
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.rotateSpeed = 0.5;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.keys = { LEFT: 'KeyA', UP: 'KeyW', RIGHT: 'KeyD', BOTTOM: 'KeyS' };
    controls.listenToKeyEvents(window);
    controls.target.fromArray(INITIAL_CAMERA_LOOK_AT);
    // The camera is limited in distance only (and kept above the ground, below): never in angle
    controls.minDistance = limits.minDistance ?? MIN_DISTANCE;
    controls.maxDistance = limits.maxDistance;
    viewerRef.current = { camera, controls, start };

    // Keep the camera above what's under it; true if it had to move
    let analysis: SiteAnalysis | null = null;
    const liftAboveGround = () => {
      const position = camera.position;
      // The site analysis is in metres with y up (see siteAnalysis.ts); before it's ready, the site's ground level
      const x = position.x * metersPerUnit;
      const z = -position.z * metersPerUnit;
      const lowest = analysis
        ? Math.max(analysis.groundAt(x, z) + EYE_HEIGHT, analysis.topAt(x, z) + CAMERA_CLEARANCE)
        : EYE_HEIGHT;
      const floor = -lowest / metersPerUnit;
      if (position.y <= floor) return false;
      position.y = floor;
      return true;
    };
    // Keep the camera inside the site's circle and above what's under it, and the orbit centre near the ground
    const keepCameraInLimits = () => {
      const target = controls.target;
      const targetRadius = Math.hypot(target.x, target.z);
      const maxTargetRadius = limits.radius * MAX_TARGET_RADIUS;
      if (targetRadius > maxTargetRadius) {
        target.x *= maxTargetRadius / targetRadius;
        target.z *= maxTargetRadius / targetRadius;
      }
      target.y = THREE.MathUtils.clamp(target.y, -MAX_PAN_HEIGHT, 0);

      const position = camera.position;
      const radius = Math.hypot(position.x, position.z);
      let moved = false;
      if (radius > limits.radius) {
        const scale = limits.radius / radius;
        position.x *= scale;
        position.z *= scale;
        moved = true;
      }
      if (liftAboveGround()) moved = true;
      if (moved) camera.lookAt(target);
    };
    controls.addEventListener('change', keepCameraInLimits);
    controls.update();

    const resize = () => {
      const width = viewerContainer.clientWidth;
      const height = viewerContainer.clientHeight;
      // The headset sets the size while VR is on
      if (!width || !height || renderer.xr.isPresenting) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewerContainer);

    // Where each photo of the site was taken from, drawn when asked for
    const photoPoses = photoPosesUrl
      ? createPhotoPoses({ url: photoPosesUrl, world, metersPerUnit, pano: panoConfig?.position })
      : null;
    posesRef.current = photoPoses;

    // The site's 360 degree photo, shown from the point it was taken at
    const pano = panoConfig ? createPanoView({ pano: panoConfig, renderer, camera, controls, metersPerUnit }) : null;
    panoRef.current = pano;

    // setAnimationLoop rather than requestAnimationFrame: in VR the headset drives the frames
    let vr: VRWalk | null = null;
    let effects: SceneEffects | null = null;
    let lastTime = 0;
    renderer.setAnimationLoop((time: number) => {
      const deltaSeconds = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;
      if (vr?.active) vr.update(deltaSeconds);
      else if (pano?.active) pano.update(deltaSeconds);
      else controls.update();
      effects?.update(time / 1000, deltaSeconds, camera);
      soundRef.current?.setListener(camera, world);
      if (renderer.xr.isPresenting) {
        if (meshPassInVR) meshAntialias.renderXR(scene, camera, spark);
        else renderer.render(scene, camera);
      }
      else {
        // The photo is drawn over the scene; while it covers the frame the scene isn't drawn
        if (!pano?.covers) meshAntialias.render(scene, camera, spark);
        pano?.render();
      }
    });

    let mesh: SplatMesh | null = null;
    const variantMeshes = new Map<string, SplatMesh>();
    const variantLoads = new Map<string, Promise<void>>();
    let shownVersion = SITE_VERSION;
    let environment: LoadedEnvironment | null = null;
    let windTurbines: WindTurbines | null = null;
    const load = async () => {
      try {
        setError(null);
        setLoadProgress({ stage: 'downloading', percent: 0 });

        // The splat and the terrain download together; the bar shows both once their sizes are known
        const received = { splat: 0, terrain: 0 };
        const totals = { splat: 0, terrain: 0 };
        const showProgress = () => {
          if (cancelled || !totals.splat || (env && !splatOnly && !totals.terrain)) return;
          const percent = Math.min(100, Math.floor(((received.splat + received.terrain) / (totals.splat + totals.terrain)) * 100));
          // Only re-render when the shown number changes
          setLoadProgress(prev => (prev?.percent === percent ? prev : { stage: 'downloading', percent }));
        };
        // Without it the scene still works, cut off at the edge of the site
        const environmentLoaded = env && !splatOnly
          ? loadSceneEnvironment(env, terrainAnisotropy(renderer), (loaded, total) => {
            received.terrain = loaded;
            totals.terrain = total;
            showProgress();
          }).catch((e: unknown) => {
            console.error('Error loading scene environment:', e);
            totals.terrain = 1;
            return null;
          })
          : Promise.resolve(null);
        const bytes = await download(assetUrl(splatUrl), downloadAbort.signal, (got, total) => {
          received.splat = got;
          totals.splat = total;
          showProgress();
        });
        if (cancelled) return;
        setLoadProgress({ stage: 'processing', percent: 100 });
        await nextFrame();

        // The site read off the splats, for the effects and the camera's floor (metres, y up)
        const metersPerFileUnit = metersPerUnit * SCENE_SCALE;
        const file = parseSplat(bytes, metersPerFileUnit);
        const siteAnalysis = analyzeSite(file, SITE_RADIUS_UNITS * metersPerUnit, (limits.radius + 2) * metersPerUnit);
        // Where a visitor can walk in VR, read off the splats; only headsets need it, and only at sites that hold up at
        // eye level
        const walkArea = (limits.vr !== false && await isVRSupported())
          ? buildWalkArea(bytes, metersPerFileUnit, { x: INITIAL_CAMERA_POSITION[0], z: -INITIAL_CAMERA_POSITION[2] },
            SITE_RADIUS_UNITS * metersPerUnit)
          : null;
        if (cancelled) return;

        // lod: Spark builds a level-of-detail tree in a worker and then draws at most a budget of splats per frame.
        // Headsets need it: Spark's budget for them (500k splats on a Quest) is below a scene's splat count (about
        // 1M). So does a scene above SPLAT_BUDGET anywhere else. Under the budget the whole scene is drawn, and
        // building the tree would only add seconds to loading. Spark keeps the bytes it's given (they move to its
        // worker), so it gets a copy: the site analysis reads the original.
        const splatBudget = trialBudget || SPLAT_BUDGET;
        const overBudget = bytes.byteLength / SPLAT_RECORD_BYTES > splatBudget;
        if (walkArea === null && overBudget) spark.lodSplatCount = splatBudget;
        mesh = new SplatMesh({ fileBytes: bytes.slice(), fileType: SplatFileType.SPLAT, lod: walkArea !== null || overBudget });
        mesh.scale.setScalar(SCENE_SCALE);
        world.add(mesh);
        const [, loadedEnvironment] = await Promise.all([mesh.initialized, environmentLoaded]);
        environment = loadedEnvironment;
        if (cancelled) {
          environment?.dispose();
          return;
        }
        if (environment) world.add(environment.group);
        analysis = siteAnalysis;
        // Lift the start camera out of the ground now that it's known: on a slope it can start below it
        if (liftAboveGround()) camera.lookAt(controls.target);

        if (turbineConfig) {
          windTurbines = addWindTurbines(world, turbineConfig, heading, environment ? { haze: background } : null);
          soundRef.current?.setTurbines(windTurbines.voices, 1 / metersPerUnit);
        }

        effects = await createSceneEffects({
          world, scene, renderer, splat: mesh, file, analysis: siteAnalysis, environment, turbines: windTurbines,
          site: { lat, lng, heading, metersPerUnit, sun },
          splatRadius: limits.radius * metersPerUnit,
          background, far, npcs, scrubUrl: splatOnly ? undefined : env?.scrubUrl, scrubReach: env?.scrubReach,
        });
        if (cancelled) {
          effects.dispose();
          return;
        }
        mesh = null; // the effects own it now
        effectsRef.current = effects;

        // The other versions of the scene: each a splat of its own, downloaded when first asked for and shown in
        // place of the site's splat, terrain, sky and plants
        versionRef.current = async (id: string) => {
          shownVersion = id;
          const variant = ((variants ?? []) as SceneVariant[]).find(candidate => candidate.id === id);
          if (variant && !variantLoads.has(id)) {
            const loading = (async () => {
              const variantBytes = await download(assetUrl(variant.splatUrl), downloadAbort.signal, () => {});
              const variantMesh = new SplatMesh({ fileBytes: variantBytes, fileType: SplatFileType.SPLAT });
              variantMesh.scale.setScalar(SCENE_SCALE);
              variantMesh.visible = false;
              world.add(variantMesh);
              variantMeshes.set(id, variantMesh);
              await variantMesh.initialized;
            })();
            variantLoads.set(id, loading);
            loading.catch(() => variantLoads.delete(id));
          }
          if (variant) await variantLoads.get(id);
          if (cancelled) return;
          // Whatever was asked for last, in case another choice came while this one loaded
          const ready = shownVersion !== SITE_VERSION && variantMeshes.get(shownVersion)?.isInitialized;
          effects?.setSiteShown(!ready);
          for (const [key, variantMesh] of variantMeshes) variantMesh.visible = ready === true && key === shownVersion;
        };
        setEffectsReady(true);
        setLoadProgress(null);
        setPanoReady(pano !== null);

        if (walkArea) {
          vr = new VRWalk(renderer, camera, rig, world, walkArea, metersPerUnit, far * metersPerUnit, (active) => {
            spark.maxStdDev = active ? VR_SPLAT_STD_DEV : SPLAT_STD_DEV;
            effects?.setHeadset(active);
          });
          vrRef.current = vr;
          setVrReady(true);
        }
      } catch (err) {
        // Unmounting aborts the download, which lands here too
        if (cancelled) return;
        console.error("Error initializing splat viewer:", err);
        const errorMsg = err instanceof Error ? err.message : 'Error desconocido';
        setLoadProgress(null);
        setError(errorMsg);
        onErrorRef.current?.(errorMsg);
      }
    };

    load();

    return () => {
      cancelled = true;
      downloadAbort.abort();
      viewerRef.current = null;
      vrRef.current = null;
      effectsRef.current = null;
      panoRef.current = null;
      versionRef.current = null;
      setVersion(SITE_VERSION);
      setVersionLoading(false);
      for (const variantMesh of variantMeshes.values()) {
        world.remove(variantMesh);
        variantMesh.dispose();
      }
      posesRef.current = null;
      photoPoses?.dispose();
      setPanoReady(false);
      setPanoMode('off');
      setDepthColours(false);
      setVrReady(false);
      setEffectsReady(false);
      vr?.dispose();
      renderer.setAnimationLoop(null);
      pano?.dispose();
      resizeObserver.disconnect();
      controls.removeEventListener('change', keepCameraInLimits);
      controls.stopListenToKeyEvents();
      controls.dispose();
      effects?.dispose();
      mesh?.dispose();
      if (windTurbines) soundRef.current?.setTurbines(null, 1);
      windTurbines?.dispose();
      environment?.dispose();
      spark.dispose();
      meshAntialias.dispose();
      meshAntialiasRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
      viewerContainer.remove();
    };
  }, [sceneKey, backgroundColor]);

  const versionStatus = (versionLoading || versionError) && version !== SITE_VERSION ? (
    <span className="rounded-full bg-gray-900/90 px-3 py-1 text-xs text-white shadow-md" role="status">
      {versionError ? 'No se pudo cargar esta versión' : 'Cargando esta versión…'}
    </span>
  ) : null;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full rounded-lg overflow-hidden shadow-lg max-h-screen md:max-h-full"
      style={{
        backgroundColor,
        height: 'min(100%, 100vh)',
        maxHeight: '100vh',
        touchAction: 'none', // Prevent default touch behaviors that interfere with camera controls
        userSelect: 'none',  // Prevent text selection on touch
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
    >
      {loadProgress && !error && (
        <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none" role="status" aria-live="polite">
          <div className="w-64 max-w-[80vw] rounded-lg border border-gray-700 bg-gray-900/85 px-4 py-3 text-white shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-solid border-orange-500 border-r-transparent" />
              <p className="text-sm font-medium">
                {loadProgress.stage === 'downloading' ? 'Descargando escena 3D' : 'Preparando escena 3D'}
              </p>
              {loadProgress.stage === 'downloading' && (
                <span className="ml-auto font-mono text-xs text-gray-300">{loadProgress.percent}%</span>
              )}
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
              <div
                className={`h-full rounded-full bg-orange-500 transition-[width] duration-200 ${loadProgress.stage === 'processing' ? 'animate-pulse' : ''}`}
                style={{ width: `${loadProgress.percent}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800/75 backdrop-blur-sm transition-all duration-300 z-50">
          <div className="bg-white p-4 sm:p-6 rounded-lg shadow-xl w-[85%] sm:w-auto sm:max-w-md mx-auto">
            <div className="flex items-center mb-4 text-red-500">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="font-bold text-base sm:text-lg">Error de carga</h3>
            </div>
            <p className="text-sm sm:text-base text-gray-700">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors duration-300"
            >
              Intentar de nuevo
            </button>
          </div>
        </div>
      )}

      {/* Effects and sound, top right */}
      <div className="absolute top-4 right-4 z-50 flex items-start gap-2">
        {effectsReady && (
          <SceneEffectsPanel
            night={night} onNightChange={setNight}
            hour={hour} onHourChange={setHour}
            fog={fog} onFogChange={setFog}
            graphics={graphics} onGraphicsChange={changeGraphics}
            photoPoses={site.photoPosesUrl ? showPoses : undefined} onPhotoPosesChange={setShowPoses}
          />
        )}
        <SceneSound sound={sound} hasTurbines={!!turbines} />
      </div>

      {/* At the 360 degree photo's viewpoint: the photo or the scene, and the way out */}
      {panoMode !== 'off' && (
        <div className="absolute bottom-14 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5">
          {(panoLoading || panoError) && (
            <span className="rounded-full bg-gray-900/90 px-3 py-1 text-xs text-white shadow-md" role="status">
              {panoError ? 'No se pudo cargar la foto 360°' : 'Cargando foto 360°…'}
            </span>
          )}
          {versionStatus}
          {panoMode === 'relief' && !panoLoading && !panoError && (
            <button
              onClick={() => setDepthColours(!depthColours)}
              aria-pressed={depthColours}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-white shadow-md transition-colors ${depthColours ? 'bg-orange-600' : 'bg-gray-900/90 hover:bg-gray-700'}`}
              title="Colores según la distancia: rojo lo cercano, azul lo lejano"
            >
              <span className="h-2.5 w-6 rounded-full bg-gradient-to-r from-red-600 via-yellow-300 to-blue-600" aria-hidden="true" />
              Mapa de profundidad
            </button>
          )}
          {panoMode !== 'photo' && !panoLoading && (
            <span className="hidden rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-white/80 sm:block">
              Arrastra para mirar · rueda o teclas W A S D para moverte
            </span>
          )}
          <div className="flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto rounded-full border border-gray-700 bg-gray-900/90 p-1 text-xs font-medium text-white shadow-lg backdrop-blur-sm sm:text-sm">
            {(['photo', 'relief', 'scene'] as const)
              .filter(mode => (mode !== 'relief' || site.pano?.depth) && (mode !== 'scene' || !versions.length))
              .map(mode => (
                <button
                  key={mode}
                  onClick={() => changePanoMode(mode)}
                  aria-pressed={panoMode === mode}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 transition-colors ${panoMode === mode ? 'bg-orange-600' : 'hover:bg-white/10'}`}
                  title={mode === 'relief' ? 'La foto con relieve: su profundidad, estimada por un modelo, deja moverse un poco dentro de ella' : undefined}
                >
                  {PANO_LABELS[mode]}
                </button>
              ))}
            {/* With versions of the scene to compare, each has its own button here in place of "Escena 3D" */}
            {versions.map(item => (
              <button
                key={item.id}
                onClick={() => {
                  changeVersion(item.id);
                  changePanoMode('scene');
                }}
                aria-pressed={panoMode === 'scene' && version === item.id}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 transition-colors ${panoMode === 'scene' && version === item.id ? 'bg-orange-600' : 'hover:bg-white/10'}`}
                title={item.description}
              >
                {item.label}
              </button>
            ))}
            <button
              onClick={() => changePanoMode('off')}
              className="rounded-full p-1.5 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
              title="Salir del punto de vista de la foto"
              aria-label="Salir del punto de vista de la foto"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* In the free view, at a site with versions of its scene to compare: which one shows */}
      {panoMode === 'off' && versions.length > 0 && effectsReady && (
        <div className="absolute bottom-14 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5">
          {versionStatus}
          <div className="flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto rounded-full border border-gray-700 bg-gray-900/90 p-1 text-xs font-medium text-white shadow-lg backdrop-blur-sm sm:text-sm">
            {versions.map(item => (
              <button
                key={item.id}
                onClick={() => changeVersion(item.id)}
                aria-pressed={version === item.id}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 transition-colors ${version === item.id ? 'bg-orange-600' : 'hover:bg-white/10'}`}
                title={item.description}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="absolute bottom-2 sm:bottom-4 right-2 sm:right-4 flex items-center gap-2">
        {/* OpenStreetMap's and Copernicus' licences ask for these credits, and the CMU motion capture database asks
            to be acknowledged */}
        {(turbines || site.environment || site.npcs?.length || site.pano?.depth) && (
          <span className="hidden sm:flex max-w-md flex-col items-end rounded bg-black/40 px-1.5 py-0.5 text-right text-[10px] leading-tight text-white/80">
            {turbines && (
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="hover:text-white">
                Aerogeneradores © colaboradores de OpenStreetMap
              </a>
            )}
            {site.environment && (
              <span>Terreno: Copernicus DEM © DLR e.V., © Airbus; contiene datos Copernicus Sentinel modificados (2026)</span>
            )}
            {site.pano?.depth && (
              <a href="https://github.com/Insta360-Research-Team/DAP" target="_blank" rel="noopener noreferrer" className="hover:text-white">
                Profundidad de la foto 360°: Depth Any Panoramas (Insta360 Research)
              </a>
            )}
            {site.npcs?.length ? (
              <a href="http://mocap.cs.cmu.edu" target="_blank" rel="noopener noreferrer" className="hover:text-white">
                Movimiento: CMU Graphics Lab Motion Capture Database
              </a>
            ) : null}
          </span>
        )}
        {vrError && (
          <span className="rounded-full bg-gray-900/90 px-3 py-1.5 text-xs text-white shadow-md">
            No se pudo iniciar la realidad virtual
          </span>
        )}
        {/* The drone's 360 degree photo of the site, at sites that have one */}
        {panoReady && panoMode === 'off' && (
          <button
            onClick={() => changePanoMode('photo')}
            className="flex items-center gap-1.5 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs sm:text-sm font-medium text-white shadow-md transition-colors hover:bg-orange-600"
            title="Compara la foto 360° del dron con la reconstrucción, desde el mismo punto"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <circle cx="12" cy="12" r="9" strokeWidth={1.75} />
              <path strokeLinecap="round" strokeWidth={1.75} d="M3 12c2.5 2 5.5 3 9 3s6.5-1 9-3M12 3c-2 2.5-3 5.5-3 9s1 6.5 3 9" />
            </svg>
            Foto 360°
          </button>
        )}
        {/* Only on devices with a VR headset, once the scene is ready */}
        {vrReady && (
          <button
            onClick={enterVR}
            className="flex items-center gap-1.5 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs sm:text-sm font-medium text-white shadow-md transition-colors hover:bg-orange-600"
            title="Stick izquierdo: caminar. Stick derecho: girar."
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h14a2 2 0 012 2v6a2 2 0 01-2 2h-4l-2-3h-2l-2 3H5a2 2 0 01-2-2V9z" />
            </svg>
            Ver en VR
          </button>
        )}

        {/* Reset camera button */}
        <button
          onClick={resetCamera}
          className="bg-white/70 backdrop-blur-sm rounded-full p-1 sm:p-2 shadow-md hover:bg-white/90 transition-all"
          title="Restablecer cámara"
          aria-label="Restablecer cámara"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>
  );
}
