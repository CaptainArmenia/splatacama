'use client';
import { assetUrl } from '@/utils/assetUrl';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

type Props = {
  url: string;
  backgroundColor?: string;
  onError?: (errorMessage: string) => void;
};

// Where the camera starts, and where the reset button puts it back. Scenes are y-down (cameraUp [0, -1, 0])
// and drawn at 10x scale (see the scene definition below).
const INITIAL_CAMERA_POSITION = [7, -2.5, 5];
const INITIAL_CAMERA_LOOK_AT = [0, 0, 0];

// The library's LoaderStatus.Downloading. The enum isn't exported; the other statuses mean processing.
const LOADER_STATUS_DOWNLOADING = 0;

type LoadProgress = { stage: 'downloading' | 'processing'; percent: number };

// Lowest the orbiting camera may go: 81 degrees from straight overhead, about 9 degrees above the ground
// (roughly 2 m up at the default distance, clear of the bushes)
const MAX_POLAR_ANGLE = Math.PI * 0.45;

export default function GSplatViewer({
  url,
  backgroundColor = '#f5f5f5',
  onError
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  // Our own loading indicator; the library's is turned off (its box is too small for its text, and in English)
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>({ stage: 'downloading', percent: 0 });

  // Keep the latest onError without making it restart the viewer
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Reset camera to initial position
  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer?.camera) return;

    const lookAt = new THREE.Vector3().fromArray(INITIAL_CAMERA_LOOK_AT);
    viewer.camera.position.fromArray(INITIAL_CAMERA_POSITION);
    if (viewer.controls) {
      viewer.controls.target.copy(lookAt);
      viewer.controls.update();
    } else {
      viewer.camera.lookAt(lookAt);
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    // A container React doesn't manage, so the library's DOM changes don't conflict with React's
    const viewerContainer = document.createElement('div');
    viewerContainer.style.width = '100%';
    viewerContainer.style.height = '100%';
    viewerContainer.setAttribute('data-gsplat-container', 'true');
    container.appendChild(viewerContainer);

    const viewer = new GaussianSplats3D.Viewer({
      selfDrivenMode: true,
      cameraUp: [0, -1, 0],
      initialCameraPosition: INITIAL_CAMERA_POSITION,
      initialCameraLookAt: INITIAL_CAMERA_LOOK_AT,
      rootElement: viewerContainer,
      backgroundColor: new THREE.Color(backgroundColor),
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false,
      // Enable touch controls for mobile
      enablePointerLock: false,
      webXRMode: GaussianSplats3D.WebXRMode.NONE,
    });
    viewerRef.current = viewer;

    // The library lets the camera orbit to 45 degrees below the horizon, i.e. under the ground. Stop it just
    // above the ground instead; low, eye-level views toward the horizon stay possible.
    if (viewer.controls) {
      viewer.controls.maxPolarAngle = MAX_POLAR_ANGLE;
    }

    const load = async () => {
      try {
        setError(null);
        setLoadProgress({ stage: 'downloading', percent: 0 });
        const splatFileUrl = assetUrl(url);

        const onProgress = (percent: number, _label: string, status: number) => {
          if (cancelled) return;
          const next: LoadProgress = status === LOADER_STATUS_DOWNLOADING
            ? { stage: 'downloading', percent: Math.floor(percent) }
            : { stage: 'processing', percent: 100 };
          // The library reports progress very often; only re-render when what we show changes
          setLoadProgress(prev => (prev && prev.stage === next.stage && prev.percent === next.percent ? prev : next));
        };

        await viewer.addSplatScenes([
          {
            path: splatFileUrl,
            // Don't let the library guess the format from the URL; a query string or other ending would break it
            format: GaussianSplats3D.SceneFormat.Splat,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1], // Quaternion format [x,y,z,w]
            scale: [10, 10, 10]
          }
        ], false, onProgress); // false: don't show the library's loading UI
        if (cancelled) return;

        setLoadProgress(null);
        viewer.start();
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
      viewerRef.current = null;
      // Hide right away so a replacement viewer doesn't sit below this one while it shuts down
      viewerContainer.style.display = 'none';
      // dispose() stops rendering, aborts a download in progress and ends the sorting worker
      Promise.resolve(viewer.dispose())
        .catch((e: unknown) => console.error('Error disposing splat viewer:', e))
        .finally(() => viewerContainer.remove());
    };
  }, [url, backgroundColor]);

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

      {/* Reset camera button */}
      <div className="absolute bottom-2 sm:bottom-4 right-2 sm:right-4 flex items-center gap-2">
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
