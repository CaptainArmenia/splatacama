'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import type { MapLandmark, SceneTurbines } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';
import { buildWalkArea } from '@/utils/walkArea';
import { isVRSupported, VRWalk } from '@/utils/vrWalk';
import { loadSceneEnvironment, type LoadedEnvironment } from '@/utils/sceneEnvironment';
import { addWindTurbines, type WindTurbines } from '@/utils/windTurbines';
import { analyzeSite, parseSplat, type SiteAnalysis } from '@/effects/siteAnalysis';
import { createSceneEffects, type SceneEffects } from '@/effects/sceneEffects';
import SceneEffectsPanel, { type QuakeState } from '@/components/SceneEffectsPanel';
import SceneSound from '@/components/SceneSound';
import { createSceneSound, type SceneSound as SceneSoundEngine } from '@/utils/sceneSound';

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
  const viewerRef = useRef<{ camera: THREE.PerspectiveCamera; controls: OrbitControls } | null>(null);
  const vrRef = useRef<VRWalk | null>(null);
  const effectsRef = useRef<SceneEffects | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>({ stage: 'downloading', percent: 0 });
  const [vrReady, setVrReady] = useState(false);
  const [vrError, setVrError] = useState(false);

  const [effectsReady, setEffectsReady] = useState(false);
  const [night, setNight] = useState(false);
  const [hour, setHour] = useState(22);
  const [fog, setFog] = useState(false);
  const [bloom, setBloom] = useState(false);
  const [quake, setQuake] = useState<QuakeState>('idle');

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
    url: site.gsplatUrl, view: site.view, environment: site.environment, turbines,
    lat: site.lat, lng: site.lng, heading: site.heading, metersPerUnit: site.metersPerUnit,
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
    effectsRef.current?.setBloom(bloom);
  }, [effectsReady, bloom]);

  const startQuake = () => {
    const effects = effectsRef.current;
    if (!effects) return;
    setQuake('preparing');
    effects.startQuake()
      .then(ready => setQuake(ready ? 'shaken' : 'unavailable'))
      .catch((e: unknown) => {
        console.error('Error starting the earthquake:', e);
        setQuake('unavailable');
      });
  };
  const resetQuake = () => {
    effectsRef.current?.resetQuake();
    setQuake('idle');
  };

  // Reset camera to initial position
  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.camera.position.fromArray(INITIAL_CAMERA_POSITION);
    viewer.controls.target.fromArray(INITIAL_CAMERA_LOOK_AT);
    viewer.controls.update();
  };

  const enterVR = () => {
    setVrError(false);
    vrRef.current?.enter().catch((e: unknown) => {
      console.error('Error starting VR:', e);
      setVrError(true);
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { url, view, environment: env, turbines: turbineConfig, lat, lng, heading, metersPerUnit } = JSON.parse(sceneKey);
    const limits = { ...DEFAULT_VIEW, ...view };
    const background = new THREE.Color(env?.background ?? backgroundColor);
    const far = env?.far ?? DEFAULT_FAR;

    let cancelled = false;
    const downloadAbort = new AbortController();

    // A container React doesn't manage, for the canvas
    const viewerContainer = document.createElement('div');
    viewerContainer.style.width = '100%';
    viewerContainer.style.height = '100%';
    viewerContainer.setAttribute('data-gsplat-container', 'true');
    container.appendChild(viewerContainer);

    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(background, 1);
    renderer.domElement.style.display = 'block';
    viewerContainer.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, far);
    camera.up.set(0, -1, 0);
    camera.position.fromArray(INITIAL_CAMERA_POSITION);
    camera.lookAt(new THREE.Vector3().fromArray(INITIAL_CAMERA_LOOK_AT));
    // VR moves the visitor by moving this rig; on the desktop it stays put
    const rig = new THREE.Group();
    rig.add(camera);
    scene.add(rig);
    // Everything drawn for the site, in the viewer's frame. VR shows it upright and at real size.
    const world = new THREE.Group();
    world.name = 'site';
    scene.add(world);
    const spark = new SparkRenderer({ renderer, maxStdDev: SPLAT_STD_DEV });
    scene.add(spark);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.rotateSpeed = 0.5;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.keys = { LEFT: 'KeyA', UP: 'KeyW', RIGHT: 'KeyD', BOTTOM: 'KeyS' };
    controls.listenToKeyEvents(window);
    controls.target.fromArray(INITIAL_CAMERA_LOOK_AT);
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = limits.maxDistance;
    viewerRef.current = { camera, controls };

    // Keep the camera inside the site's circle and above what's under it, and the orbit centre near the ground
    let analysis: SiteAnalysis | null = null;
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
      // The site analysis is in metres with y up (see siteAnalysis.ts); before it's ready, the site's ground level
      const x = position.x * metersPerUnit;
      const z = -position.z * metersPerUnit;
      const lowest = analysis
        ? Math.max(analysis.groundAt(x, z) + EYE_HEIGHT, analysis.topAt(x, z) + CAMERA_CLEARANCE)
        : EYE_HEIGHT;
      const floor = -lowest / metersPerUnit;
      if (position.y > floor) {
        position.y = floor;
        moved = true;
      }
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

    // setAnimationLoop rather than requestAnimationFrame: in VR the headset drives the frames
    let vr: VRWalk | null = null;
    let effects: SceneEffects | null = null;
    let lastTime = 0;
    renderer.setAnimationLoop((time: number) => {
      const deltaSeconds = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;
      if (vr?.active) vr.update(deltaSeconds);
      else controls.update();
      const shake = effects?.update(time / 1000, deltaSeconds, camera);
      if (shake) camera.position.add(shake);
      soundRef.current?.setListener(camera, world);
      renderer.render(scene, camera);
      if (shake) camera.position.sub(shake);
    });

    let mesh: SplatMesh | null = null;
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
          if (cancelled || !totals.splat || (env && !totals.terrain)) return;
          const percent = Math.min(100, Math.floor(((received.splat + received.terrain) / (totals.splat + totals.terrain)) * 100));
          // Only re-render when the shown number changes
          setLoadProgress(prev => (prev?.percent === percent ? prev : { stage: 'downloading', percent }));
        };
        // Without it the scene still works, cut off at the edge of the site
        const environmentLoaded = env
          ? loadSceneEnvironment(env, renderer.capabilities.getMaxAnisotropy(), (loaded, total) => {
            received.terrain = loaded;
            totals.terrain = total;
            showProgress();
          }).catch((e: unknown) => {
            console.error('Error loading scene environment:', e);
            totals.terrain = 1;
            return null;
          })
          : Promise.resolve(null);
        const bytes = await download(assetUrl(url), downloadAbort.signal, (got, total) => {
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
        // Where a visitor can walk in VR, read off the splats; only headsets need it
        const walkArea = (await isVRSupported())
          ? buildWalkArea(bytes, metersPerFileUnit, { x: INITIAL_CAMERA_POSITION[0], z: -INITIAL_CAMERA_POSITION[2] },
            SITE_RADIUS_UNITS * metersPerUnit)
          : null;
        if (cancelled) return;

        // lod: Spark builds a level-of-detail tree in a worker and then draws at most a budget of splats per frame.
        // Only headsets need it: Spark's budget for them (500k splats on a Quest) is below a scene's splat count
        // (about 1M). Elsewhere the budget covers the whole scene, and building the tree would add over a second to
        // loading. Spark keeps the bytes it's given (they move to its worker), so it gets a copy: the effects cut
        // the walls out of the file later.
        mesh = new SplatMesh({ fileBytes: bytes.slice(), fileType: SplatFileType.SPLAT, lod: walkArea !== null });
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

        if (turbineConfig) {
          windTurbines = addWindTurbines(world, turbineConfig, heading, environment ? { haze: background } : null);
          soundRef.current?.setTurbines(windTurbines.voices, 1 / metersPerUnit);
        }

        effects = await createSceneEffects({
          world, scene, renderer, splat: mesh, file, analysis: siteAnalysis, environment, turbines: windTurbines,
          site: { lat, lng, heading, metersPerUnit },
          splatRadius: limits.radius * metersPerUnit,
          background, far,
        });
        if (cancelled) {
          effects.dispose();
          return;
        }
        mesh = null; // the effects own it now (the earthquake can replace it)
        effectsRef.current = effects;
        setEffectsReady(true);
        setLoadProgress(null);

        if (walkArea) {
          vr = new VRWalk(renderer, camera, rig, world, walkArea, metersPerUnit, far * metersPerUnit, (active) => {
            spark.maxStdDev = active ? VR_SPLAT_STD_DEV : SPLAT_STD_DEV;
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
      setVrReady(false);
      setEffectsReady(false);
      vr?.dispose();
      renderer.setAnimationLoop(null);
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
      renderer.dispose();
      renderer.forceContextLoss();
      viewerContainer.remove();
    };
  }, [sceneKey, backgroundColor]);

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
            bloom={bloom} onBloomChange={setBloom}
            quake={quake} onStartQuake={startQuake} onResetQuake={resetQuake}
          />
        )}
        <SceneSound sound={sound} />
      </div>

      <div className="absolute bottom-2 sm:bottom-4 right-2 sm:right-4 flex items-center gap-2">
        {/* OpenStreetMap's and Copernicus' licences ask for these credits */}
        {(turbines || site.environment) && (
          <span className="hidden sm:flex max-w-md flex-col items-end rounded bg-black/40 px-1.5 py-0.5 text-right text-[10px] leading-tight text-white/80">
            {turbines && (
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="hover:text-white">
                Aerogeneradores © colaboradores de OpenStreetMap
              </a>
            )}
            {site.environment && (
              <span>Terreno: Copernicus DEM © DLR e.V., © Airbus; contiene datos Copernicus Sentinel modificados (2026)</span>
            )}
          </span>
        )}
        {vrError && (
          <span className="rounded-full bg-gray-900/90 px-3 py-1.5 text-xs text-white shadow-md">
            No se pudo iniciar la realidad virtual
          </span>
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
