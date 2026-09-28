import { DEFAULT_CAMERA_CONFIG, MARKER_CONFIG } from '@/constants/cesiumConfig';
import { createCircularImageCanvas, createFallbackMarker, getCacheKey } from './cesiumMarkers';
import type { MapLandmark, PreviewUrlsState } from '@/types/cesium';

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

  // Pins fanned out of a cluster are drawn away from their true position, where Cesium would put the
  // selection indicator, so those rely on the scale change alone.
  const offset = entity.billboard.pixelOffset?.getValue?.(viewer.clock.currentTime);
  const isFannedOut = !!offset && (offset.x !== 0 || offset.y !== 0);

  // Use Cesium's built-in properties for visual feedback
  if (isSelected) {
    entity.billboard.scale = MARKER_CONFIG.selectedScale;
    viewer.selectedEntity = isFannedOut ? undefined : entity;
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

  // The map only redraws on request (VIEWER_CONFIG.requestRenderMode)
  viewer.scene.requestRender();
};

/**
 * Sets a pin's image only when it actually changed. Re-assigning the same canvas would still create a new
 * Cesium property; cluster markers pick up the change on their own (see cesiumPinClusters.ts).
 */
const setMarkerImage = (entity: any, image: HTMLCanvasElement, viewer: any) => {
  if (entity.billboard.image?.getValue(viewer.clock.currentTime) === image) return;
  entity.billboard.image = image;
  viewer.scene.requestRender();
};

/**
 * Updates a specific landmark marker with preview image or fallback
 */
export const updateSpecificLandmarkMarker = async (
  landmark: MapLandmark,
  entityRefs: React.MutableRefObject<{ [id: string]: any }>,
  previewUrls: PreviewUrlsState,
  canvasCache: React.MutableRefObject<{ [key: string]: HTMLCanvasElement }>,
  viewer: any
) => {
  if (!viewer) return;

  const entity = entityRefs.current[landmark.id];
  if (!entity || !entity.billboard) return;

  const pinUrl = previewUrls.pinUrls[landmark.id];
  const hasPreviewImage = !!pinUrl;
  const cacheKey = getCacheKey(landmark.id, hasPreviewImage);

  // Check if we already have the base canvas cached
  if (canvasCache.current[cacheKey]) {
    setMarkerImage(entity, canvasCache.current[cacheKey], viewer);
    return;
  }

  // Create new canvas only if not cached
  try {
    let markerCanvas: HTMLCanvasElement;

    if (hasPreviewImage) {
      // Thumbnail first, the full preview if the thumbnail can't be loaded
      markerCanvas = await createCircularImageCanvas(pinUrl, MARKER_CONFIG.defaultSize, previewUrls.urls[landmark.id]);
    } else {
      markerCanvas = createFallbackMarker(MARKER_CONFIG.defaultSize);
    }

    // Cache the canvas
    canvasCache.current[cacheKey] = markerCanvas;

    // Only update if the entity still exists
    if (entity.billboard && entityRefs.current[landmark.id] === entity && !viewer.isDestroyed()) {
      setMarkerImage(entity, markerCanvas, viewer);
    }
  } catch (error) {
    console.error(`Error creating marker for ${landmark.id}:`, error);

    // Use fallback and cache it
    const fallbackKey = getCacheKey(landmark.id, false);
    if (!canvasCache.current[fallbackKey]) {
      canvasCache.current[fallbackKey] = createFallbackMarker(MARKER_CONFIG.defaultSize);
    }

    if (entity.billboard && entityRefs.current[landmark.id] === entity && !viewer.isDestroyed()) {
      setMarkerImage(entity, canvasCache.current[fallbackKey], viewer);
    }
  }
};

/**
 * Flies the camera back to the starting view
 */
export const resetCameraView = (viewer: any, cesium: any) => {
  if (!viewer || !cesium) return;

  try {
    const { center, position, orientation, animation } = DEFAULT_CAMERA_CONFIG;
    viewer.camera.flyTo({
      destination: cesium.Cartesian3.fromDegrees(center.lng, center.lat, position.height),
      orientation: {
        heading: cesium.Math.toRadians(orientation.heading),
        pitch: cesium.Math.toRadians(orientation.pitch),
        roll: orientation.roll
      },
      duration: animation.duration
    });
  } catch (error) {
    console.error("Error resetting view:", error);
  }
};
