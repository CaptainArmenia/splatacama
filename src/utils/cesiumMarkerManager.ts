import { MARKER_CONFIG } from '@/constants/cesiumConfig';
import { createCircularImageCanvas, createFallbackMarker, getCacheKey } from './cesiumMarkers';
import type { MapLandmark } from '@/types/cesium';

/**
 * Updates the visual state of a landmark marker using Cesium properties
 */
export const updateLandmarkVisualState = (
  landmark: MapLandmark,
  entityRefs: React.MutableRefObject<{ [id: string]: any }>,
  viewer: any,
  selectedLandmark: MapLandmark | null,
  hoveredLandmark: MapLandmark | null
) => {
  if (!viewer) return;
  
  const entity = entityRefs.current[landmark.id];
  if (!entity || !entity.billboard) return;

  const isSelected = selectedLandmark && selectedLandmark.id === landmark.id;
  const isHovered = hoveredLandmark && hoveredLandmark.id === landmark.id;

  // Use Cesium's built-in properties for visual feedback
  if (isSelected) {
    entity.billboard.scale = MARKER_CONFIG.selectedScale;
    viewer.selectedEntity = entity;
  } else if (isHovered) {
    entity.billboard.scale = MARKER_CONFIG.hoveredScale;
    if (viewer.selectedEntity === entity) {
      viewer.selectedEntity = undefined;
    }
  } else {
    entity.billboard.scale = MARKER_CONFIG.defaultScale;
    if (viewer.selectedEntity === entity) {
      viewer.selectedEntity = undefined;
    }
  }
};

/**
 * Updates a specific landmark marker with preview image or fallback
 */
export const updateSpecificLandmarkMarker = async (
  landmark: MapLandmark,
  entityRefs: React.MutableRefObject<{ [id: string]: any }>,
  previewUrls: { [id: string]: string },
  canvasCache: React.MutableRefObject<{ [key: string]: HTMLCanvasElement }>,
  selectedLandmark: MapLandmark | null,
  hoveredLandmark: MapLandmark | null,
  viewer: any
) => {
  if (!viewer) return;
  
  const entity = entityRefs.current[landmark.id];
  if (!entity || !entity.billboard) return;

  const hasPreviewImage = !!(landmark.previewUrl && previewUrls[landmark.id]);
  const cacheKey = getCacheKey(landmark.id, hasPreviewImage);

  // Check if we already have the base canvas cached
  if (canvasCache.current[cacheKey]) {
    entity.billboard.image = canvasCache.current[cacheKey];
    updateLandmarkVisualState(landmark, entityRefs, viewer, selectedLandmark, hoveredLandmark);
    return;
  }

  // Create new canvas only if not cached
  try {
    let markerCanvas: HTMLCanvasElement;
    
    if (hasPreviewImage) {
      markerCanvas = await createCircularImageCanvas(
        previewUrls[landmark.id], 
        MARKER_CONFIG.defaultSize
      );
    } else {
      markerCanvas = createFallbackMarker(MARKER_CONFIG.defaultSize);
    }

    // Cache the canvas
    canvasCache.current[cacheKey] = markerCanvas;
    
    // Only update if the entity still exists
    if (entity.billboard && entityRefs.current[landmark.id] === entity) {
      entity.billboard.image = markerCanvas;
      updateLandmarkVisualState(landmark, entityRefs, viewer, selectedLandmark, hoveredLandmark);
    }
  } catch (error) {
    console.error(`Error creating marker for ${landmark.id}:`, error);
    
    // Use fallback and cache it
    const fallbackKey = getCacheKey(landmark.id, false);
    if (!canvasCache.current[fallbackKey]) {
      canvasCache.current[fallbackKey] = createFallbackMarker(MARKER_CONFIG.defaultSize);
    }
    
    if (entity.billboard && entityRefs.current[landmark.id] === entity) {
      entity.billboard.image = canvasCache.current[fallbackKey];
      updateLandmarkVisualState(landmark, entityRefs, viewer, selectedLandmark, hoveredLandmark);
    }
  }
};

/**
 * Resets the camera view to the default position
 */
export const resetCameraView = (viewer: any, cesium: any, humboldtCenter: { lat: number; lng: number }) => {
  if (!viewer || !cesium) return;
  
  try {
    const { DEFAULT_CAMERA_CONFIG } = require('@/constants/cesiumConfig');
    
    const centerPoint = cesium.Cartesian3.fromDegrees(
      humboldtCenter.lng, 
      humboldtCenter.lat,
      DEFAULT_CAMERA_CONFIG.position.height
    );
    
    viewer.camera.flyTo({
      destination: centerPoint,
      orientation: {
        heading: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.heading),
        pitch: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.pitch),
        roll: DEFAULT_CAMERA_CONFIG.orientation.roll
      },
      duration: DEFAULT_CAMERA_CONFIG.animation.duration
    });
  } catch (error) {
    console.error("Error resetting view:", error);
  }
};