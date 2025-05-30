import { useState, useRef, useEffect } from 'react';
import { HeightReference, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { DEFAULT_CAMERA_CONFIG, VIEWER_CONFIG, SCENE_CONFIG, MARKER_CONFIG } from '@/constants/cesiumConfig';
import { createFallbackMarker } from '@/utils/cesiumMarkers';
import type { MapLandmark } from '@/types/cesium';

/**
 * Custom hook to manage Cesium viewer initialization and configuration
 */
export const useCesiumViewer = (
  containerRef: React.RefObject<HTMLDivElement>,
  landmarks: MapLandmark[],
  humboldtCenter: { lat: number; lng: number },
  setErrorState: (error: string | null) => void,
  setSelectedLandmark: (landmark: MapLandmark | null) => void,
  setHoveredLandmark: (landmark: MapLandmark | null) => void,
  preventPinOcclusion: boolean
) => {
  const [mapLoaded, setMapLoaded] = useState(false);
  const [cesium, setCesium] = useState<any>(null);
  const viewerRef = useRef<any>(null);
  const entityRefs = useRef<{ [id: string]: any }>({});

  // Load Cesium
  useEffect(() => {
    async function initCesium() {
      try {
        const cesiumModule = await import('cesium');
        setCesium(cesiumModule);
      } catch (error) {
        console.error('Failed to load Cesium:', error);
        setErrorState('Error loading 3D map components');
      }
    }
    
    if (typeof window !== 'undefined') {
      initCesium();
    }
  }, [setErrorState]);

  // Create viewer once Cesium is loaded
  useEffect(() => {
    if (!cesium || !containerRef.current) return;

    async function createViewer() {
      try {
        // Configure Cesium Ion token
        if (!process.env.NEXT_PUBLIC_CESIUM_TOKEN) {
          console.error("Cesium Ion Token is missing. Check .env.local and restart the server.");
          setErrorState("Cesium Ion Token is missing. Please configure it in your environment variables.");
          return; 
        }
        
        cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN;
        
        // Create terrain provider
        const terrainProvider = await cesium.createWorldTerrainAsync();
        
        // Create Cesium viewer
        const viewer = new cesium.Viewer(containerRef.current, {
          ...VIEWER_CONFIG,
          terrainProvider: terrainProvider,
          baseLayer: new cesium.ImageryLayer.fromProviderAsync(cesium.IonImageryProvider.fromAssetId(3954)),
          creditContainer: document.createElement('div'), // Hide credits
        });

        viewerRef.current = viewer;

        // Configure viewer settings
        setupViewerSettings(viewer, cesium, preventPinOcclusion);
        
        // Setup base layer picker customization
        setupBaseLayerPicker(viewer);
        
        // Add landmarks as billboards
        addLandmarkBillboards(viewer, cesium, landmarks, preventPinOcclusion, entityRefs);
        
        // Setup event handlers
        setupEventHandlers(viewer, cesium, landmarks, setSelectedLandmark, setHoveredLandmark);
        
        // Setup resize handling
        const resizeObserver = setupResizeHandling(viewer, containerRef);
        
        // Set initial camera position
        setInitialCameraPosition(viewer, cesium, humboldtCenter);
        
        setMapLoaded(true);

        // Cleanup function
        return () => {
          if (resizeObserver) {
            resizeObserver.disconnect();
          }
          document.body.style.cursor = 'default';
          if (viewer) {
            viewer.destroy();
          }
        };
      } catch (error) {
        console.error("Error initializing Cesium viewer:", error);
        setErrorState("Failed to initialize 3D map viewer");
      }
    }
    
    createViewer();
  }, [cesium, containerRef, landmarks, humboldtCenter, setErrorState, setSelectedLandmark, setHoveredLandmark, preventPinOcclusion]);

  return {
    mapLoaded,
    cesium,
    viewer: viewerRef.current,
    entityRefs
  };
};

// Helper functions
function setupViewerSettings(viewer: any, cesium: any, preventPinOcclusion: boolean) {
  viewer.scene.globe.enableLighting = SCENE_CONFIG.enableLighting;
  viewer.scene.skyBox = undefined;
  viewer.scene.sun = undefined;
  viewer.scene.moon = undefined;
  viewer.scene.globe.depthTestAgainstTerrain = !preventPinOcclusion;
  viewer.scene.globe.terrainExaggeration = SCENE_CONFIG.terrainExaggeration;
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = SCENE_CONFIG.enableCollisionDetection;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = SCENE_CONFIG.minimumZoomDistance;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = SCENE_CONFIG.maximumZoomDistance;
}

function setupBaseLayerPicker(viewer: any) {
  // Set terrain and imagery defaults
  setTimeout(() => {
    if (viewer.baseLayerPicker) {
      const terrainProviderViewModels = viewer.baseLayerPicker.viewModel.terrainProviderViewModels;
      const cesiumWorldTerrainModel = terrainProviderViewModels.find(
        (model: any) => model.name === 'Cesium World Terrain'
      );
      
      if (cesiumWorldTerrainModel) {
        viewer.baseLayerPicker.viewModel.selectedTerrain = cesiumWorldTerrainModel;
      }

      const imageryProviderViewModels = viewer.baseLayerPicker.viewModel.imageryProviderViewModels;
      const arcGISWorldImageryModel = imageryProviderViewModels.find(
        (model: any) => model.name === 'ArcGIS World Imagery'
      );
      
      if (arcGISWorldImageryModel) {
        try {
          viewer.baseLayerPicker.viewModel.selectedImagery = arcGISWorldImageryModel;
        } catch (error) {
          console.warn('Error setting ArcGIS World Imagery:', error);
        }
      }
    }
  }, 300);

  // Customize UI
  customizeBaseLayerPickerUI();
}

function customizeBaseLayerPickerUI() {
  setTimeout(() => {
    try {
      const baseLayerPickerContainer = document.querySelector('.cesium-viewer .cesium-baseLayerPicker-dropDown') as HTMLElement;
      const layerButton = document.querySelector('.cesium-viewer .cesium-toolbar-button') as HTMLElement;
      
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
      position: cesium.Cartesian3.fromDegrees(landmark.lng, landmark.lat, landmark.height || 200),
      name: landmark.name,
      id: landmark.id,
      billboard: {
        image: createFallbackMarker(),
        width: MARKER_CONFIG.defaultSize,
        height: MARKER_CONFIG.defaultSize,
        heightReference: preventPinOcclusion ? HeightReference.NONE : HeightReference.RELATIVE_TO_GROUND,
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
  setHoveredLandmark: (landmark: MapLandmark | null) => void
) {
  // Click handler
  const clickHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction((click: any) => {
    const pickedObject = viewer.scene.pick(click.position);
    
    if (cesium.defined(pickedObject) && pickedObject.id) {
      const clickedLandmark = landmarks.find(landmark => landmark.id === pickedObject.id.id);
      
      if (clickedLandmark) {
        click.preventDefault?.();
        setSelectedLandmark(clickedLandmark);
      }
    } else {
      setSelectedLandmark(null);
    }
  }, cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Hover handler
  const hoverHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  hoverHandler.setInputAction((movement: any) => {
    const pickedObject = viewer.scene.pick(movement.endPosition);
    
    if (cesium.defined(pickedObject) && pickedObject.id) {
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
  }, cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function setupResizeHandling(viewer: any, containerRef: React.RefObject<HTMLDivElement>) {
  const handleResize = () => {
    if (containerRef.current && viewer) {
      viewer.resize();
      const { width, height } = containerRef.current.getBoundingClientRect();
      viewer.scene.camera.frustum.aspectRatio = width / height;
      viewer.scene.requestRender();
    }
  };
  
  const resizeObserver = new ResizeObserver(handleResize);
  if (containerRef.current) {
    resizeObserver.observe(containerRef.current);
  }
  
  return resizeObserver;
}

function setInitialCameraPosition(viewer: any, cesium: any, humboldtCenter: { lat: number; lng: number }) {
  const centerPoint = cesium.Cartesian3.fromDegrees(
    humboldtCenter.lng, 
    humboldtCenter.lat,
    DEFAULT_CAMERA_CONFIG.position.height
  );
  
  viewer.camera.setView({
    destination: centerPoint,
    orientation: {
      heading: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.heading),
      pitch: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.pitch),
      roll: DEFAULT_CAMERA_CONFIG.orientation.roll
    }
  });
}