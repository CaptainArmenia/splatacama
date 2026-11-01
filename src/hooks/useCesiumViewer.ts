import { useState, useRef, useEffect } from 'react';
import { HeightReference, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { DEFAULT_CAMERA_CONFIG, VIEWER_CONFIG, SCENE_CONFIG, MARKER_CONFIG } from '@/constants/cesiumConfig';
import { createFallbackMarker } from '@/utils/cesiumMarkers';
import { setupPinClusters } from '@/utils/cesiumPinClusters';
import type { MapLandmark } from '@/types/cesium';

/**
 * Custom hook to manage Cesium viewer initialization and configuration
 */
export const useCesiumViewer = (
  containerRef: React.RefObject<HTMLDivElement | null>,
  landmarks: MapLandmark[],
  setErrorState: (error: string | null) => void,
  setSelectedLandmark: (landmark: MapLandmark | null) => void,
  setHoveredLandmark: (landmark: MapLandmark | null) => void,
  preventPinOcclusion: boolean
) => {
  const [cesium, setCesium] = useState<any>(null);
  // State rather than a ref, so components re-render with the viewer once it exists
  const [viewer, setViewer] = useState<any>(null);
  const entityRefs = useRef<{ [id: string]: any }>({});

  // Load Cesium
  useEffect(() => {
    async function initCesium() {
      try {
        const cesiumModule = await import('cesium');
        setCesium(cesiumModule);
      } catch (error) {
        console.error('Failed to load Cesium:', error);
        setErrorState('No se pudieron cargar los componentes del mapa 3D');
      }
    }

    if (typeof window !== 'undefined') {
      initCesium();
    }
  }, [setErrorState]);

  // Create viewer once Cesium is loaded, and destroy it on unmount
  useEffect(() => {
    const container = containerRef.current;
    if (!cesium || !container) return;

    if (!process.env.NEXT_PUBLIC_CESIUM_TOKEN) {
      console.error("Cesium Ion Token is missing. Check .env.local and restart the server.");
      setErrorState("Falta el token de Cesium ion (NEXT_PUBLIC_CESIUM_TOKEN).");
      return;
    }

    let built: ReturnType<typeof createViewer> | undefined;
    try {
      built = createViewer(cesium, container, landmarks, entityRefs, setSelectedLandmark, setHoveredLandmark, preventPinOcclusion);
      setViewer(built.viewer);
    } catch (error) {
      console.error("Error initializing Cesium viewer:", error);
      setErrorState("No se pudo iniciar el mapa 3D");
    }

    return () => {
      built?.destroy();
      entityRefs.current = {};
      setViewer(null);
    };
  }, [cesium, containerRef, landmarks, setErrorState, setSelectedLandmark, setHoveredLandmark, preventPinOcclusion]);

  return {
    mapLoaded: viewer !== null,
    cesium,
    viewer,
    entityRefs
  };
};

/**
 * Builds the viewer with its pins, clusters and input handlers. Returns it with a function that tears it all down.
 */
function createViewer(
  cesium: any,
  container: HTMLDivElement,
  landmarks: MapLandmark[],
  entityRefs: React.MutableRefObject<{ [id: string]: any }>,
  setSelectedLandmark: (landmark: MapLandmark | null) => void,
  setHoveredLandmark: (landmark: MapLandmark | null) => void,
  preventPinOcclusion: boolean
): { viewer: any; destroy: () => void } {
  cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN;

  // Start on ArcGIS World Imagery and Cesium World Terrain. Choosing them here, rather than switching the
  // base layer picker after creation, avoids loading a first set of imagery and terrain only to replace it.
  const imageryProviderViewModels = cesium.createDefaultImageryProviderViewModels();
  const terrainProviderViewModels = cesium.createDefaultTerrainProviderViewModels();

  const viewer = new cesium.Viewer(container, {
    ...VIEWER_CONFIG,
    imageryProviderViewModels,
    selectedImageryProviderViewModel: imageryProviderViewModels.find((model: any) => model.name === 'ArcGIS World Imagery'),
    terrainProviderViewModels,
    selectedTerrainProviderViewModel: terrainProviderViewModels.find((model: any) => model.name === 'Cesium World Terrain'),
    creditContainer: document.createElement('div'), // Hide credits
  });

  // Configure viewer settings
  setupViewerSettings(viewer, preventPinOcclusion);

  // Restyle the base layer picker
  const pickerTimeout = customizeBaseLayerPickerUI(container);

  // Add landmarks as billboards
  addLandmarkBillboards(viewer, cesium, landmarks, preventPinOcclusion, entityRefs);

  // Merge overlapping pins into cluster markers
  const pinClusters = setupPinClusters(viewer, cesium, entityRefs, preventPinOcclusion);

  // Setup event handlers
  const handlers = setupEventHandlers(viewer, cesium, landmarks, setSelectedLandmark, setHoveredLandmark, pinClusters);

  // Set initial camera position
  setInitialCameraPosition(viewer, cesium);

  const destroy = () => {
    clearTimeout(pickerTimeout);
    handlers.forEach(handler => handler.destroy());
    pinClusters.destroy();
    document.body.style.cursor = 'default';
    viewer.destroy();
  };
  return { viewer, destroy };
}

// Helper functions
function setupViewerSettings(viewer: any, preventPinOcclusion: boolean) {
  // Render at the screen's real pixel density instead of CSS pixels, so pins and terrain aren't upscaled
  // (and blurry) on high-density screens. Capped at 2x to keep phones with 3x screens fast.
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2) / (window.devicePixelRatio || 1);

  viewer.scene.globe.enableLighting = SCENE_CONFIG.enableLighting;
  viewer.scene.skyBox = undefined;
  viewer.scene.sun = undefined;
  viewer.scene.moon = undefined;
  viewer.scene.globe.depthTestAgainstTerrain = !preventPinOcclusion;
  viewer.scene.verticalExaggeration = SCENE_CONFIG.verticalExaggeration;
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = SCENE_CONFIG.enableCollisionDetection;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = SCENE_CONFIG.minimumZoomDistance;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = SCENE_CONFIG.maximumZoomDistance;
}

function customizeBaseLayerPickerUI(viewerContainer: HTMLElement) {
  return setTimeout(() => {
    try {
      const baseLayerPickerContainer = viewerContainer.querySelector<HTMLElement>('.cesium-baseLayerPicker-dropDown');
      const layerButton = viewerContainer.querySelector<HTMLElement>('.cesium-toolbar-button');

      if (baseLayerPickerContainer && baseLayerPickerContainer.parentElement) {
        const container = baseLayerPickerContainer.parentElement as HTMLElement;
        Object.assign(container.style, {
          top: '15%',
          right: '20px',
          position: 'absolute',
          zIndex: '35',
          transition: 'transform 0.3s ease-in-out',
          maxHeight: '70vh',
          overflow: 'visible',
        });
      }

      if (baseLayerPickerContainer) {
        Object.assign(baseLayerPickerContainer.style, {
          maxHeight: '60vh',
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollbarWidth: 'thin',
        });
      }

      if (layerButton) {
        Object.assign(layerButton.style, {
          width: '50px',
          height: '50px',
          background: 'rgba(0, 0, 0, 0.6)',
          border: '2px solid rgba(255, 255, 255, 0.3)',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0',
          transition: 'all 0.2s ease',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        });

        layerButton.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        `;
      }
    } catch (error) {
      console.warn("Error customizing baseLayerPicker:", error);
    }
  }, 200);
}

function addLandmarkBillboards(
  viewer: any,
  cesium: any,
  landmarks: MapLandmark[],
  preventPinOcclusion: boolean,
  entityRefs: React.MutableRefObject<{ [id: string]: any }>
) {
  landmarks.forEach((landmark) => {
    const entity = new cesium.Entity({
      // Height is meters above the ground, so pins sit over their site even with terrain exaggeration
      position: cesium.Cartesian3.fromDegrees(landmark.lng, landmark.lat, landmark.height ?? 30),
      name: landmark.name,
      id: landmark.id,
      billboard: {
        image: createFallbackMarker(),
        width: MARKER_CONFIG.defaultSize,
        height: MARKER_CONFIG.defaultSize,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        // Never hidden behind hills when preventPinOcclusion is on
        disableDepthTestDistance: preventPinOcclusion ? Number.POSITIVE_INFINITY : undefined,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scale: MARKER_CONFIG.defaultScale,
        eyeOffset: new cesium.Cartesian3(0, 0, -50)
      }
    });

    entityRefs.current[landmark.id] = entity;
    viewer.entities.add(entity);
  });
}

function setupEventHandlers(
  viewer: any,
  cesium: any,
  landmarks: MapLandmark[],
  setSelectedLandmark: (landmark: MapLandmark | null) => void,
  setHoveredLandmark: (landmark: MapLandmark | null) => void,
  pinClusters: ReturnType<typeof setupPinClusters>
) {
  // Click handler
  const clickHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction((click: any) => {
    const pickedObject = viewer.scene.pick(click.position);
    const pickedEntity = cesium.defined(pickedObject) ? pickedObject.id : undefined;

    // Clicking a cluster fans its pins out
    const clusterMembers = pinClusters.getClusterMembers(pickedEntity);
    if (clusterMembers) {
      setSelectedLandmark(null);
      pinClusters.explode(clusterMembers);
      return;
    }

    const clickedLandmark = pickedEntity
      ? landmarks.find(landmark => landmark.id === pickedEntity.id)
      : undefined;

    if (clickedLandmark) {
      click.preventDefault?.();
      setSelectedLandmark(clickedLandmark);
    } else {
      pinClusters.collapse();
      setSelectedLandmark(null);
    }
  }, cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Hover handler. Picking renders an extra pass, so pick at most once per animation frame, at the latest
  // pointer position, rather than on every mouse-move event.
  const updateHover = (position: any) => {
    const pickedObject = viewer.scene.pick(position);

    if (cesium.defined(pickedObject) && pinClusters.getClusterMembers(pickedObject.id)) {
      setHoveredLandmark(null);
      document.body.style.cursor = 'pointer';
    } else if (cesium.defined(pickedObject) && pickedObject.id) {
      const hoveredLandmarkData = landmarks.find(landmark => landmark.id === pickedObject.id.id);

      if (hoveredLandmarkData) {
        setHoveredLandmark(hoveredLandmarkData);
        document.body.style.cursor = 'pointer';
      } else {
        setHoveredLandmark(null);
        document.body.style.cursor = 'default';
      }
    } else {
      setHoveredLandmark(null);
      document.body.style.cursor = 'default';
    }
  };

  let pendingHoverPosition: any = null;
  const hoverHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  hoverHandler.setInputAction((movement: any) => {
    const alreadyScheduled = pendingHoverPosition !== null;
    // Cesium reuses the movement object, so keep a copy
    pendingHoverPosition = cesium.Cartesian2.clone(movement.endPosition);
    if (alreadyScheduled) return;
    requestAnimationFrame(() => {
      const position = pendingHoverPosition;
      pendingHoverPosition = null;
      if (!viewer.isDestroyed()) updateHover(position);
    });
  }, cesium.ScreenSpaceEventType.MOUSE_MOVE);

  return [clickHandler, hoverHandler];
}

function setInitialCameraPosition(viewer: any, cesium: any) {
  const { center, position, orientation } = DEFAULT_CAMERA_CONFIG;
  viewer.camera.setView({
    destination: cesium.Cartesian3.fromDegrees(center.lng, center.lat, position.height),
    orientation: {
      heading: cesium.Math.toRadians(orientation.heading),
      pitch: cesium.Math.toRadians(orientation.pitch),
      roll: orientation.roll
    }
  });
}
