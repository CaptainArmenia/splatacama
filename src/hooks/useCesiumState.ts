import { useState, useRef, useEffect } from 'react';
import { getBlobUrl } from '@/utils/blobUtils';
import type { MapLandmark, PreviewUrlsState } from '@/types/cesium';

/**
 * Custom hook to manage preview URLs for landmarks
 */
export const usePreviewUrls = (landmarks: MapLandmark[]) => {
  const [previewUrls, setPreviewUrls] = useState<PreviewUrlsState>({
    urls: {},
    loading: {},
    errors: {}
  });

  useEffect(() => {
    async function fetchPreviewUrls() {
      const urlMap: { [id: string]: string } = {};
      const loadingMap: { [id: string]: boolean } = {};
      const errorMap: { [id: string]: boolean } = {};
      
      for (const landmark of landmarks) {
        if (landmark.previewUrl) {
          try {
            loadingMap[landmark.id] = true;
            const url = await getBlobUrl(landmark.previewUrl);
            
            urlMap[landmark.id] = url;
            errorMap[landmark.id] = false;
          } catch (error) {
            console.error(`Error constructing preview URL for ${landmark.id}:`, error);
            errorMap[landmark.id] = true;
            
            // Fall back to original URL if blob URL construction fails
            if (landmark.previewUrl) {
              urlMap[landmark.id] = landmark.previewUrl;
            }
          } finally {
            loadingMap[landmark.id] = false;
          }
        }
      }
      
      setPreviewUrls({
        urls: urlMap,
        loading: loadingMap,
        errors: errorMap
      });
    }
    
    fetchPreviewUrls();
  }, [landmarks]);

  return previewUrls;
};

/**
 * Custom hook to manage camera position tracking
 */
export const useCameraPosition = (viewer: any, cesium: any, showCameraPosition: boolean) => {
  const [cameraPosition, setCameraPosition] = useState({
    latitude: 0,
    longitude: 0,
    height: 0,
    heading: 0,
    pitch: 0
  });

  useEffect(() => {
    if (!showCameraPosition || !viewer || !cesium) return;
    
    const updateCameraPosition = () => {
      const camera = viewer.camera;
      const position = camera.positionCartographic;
      
      setCameraPosition({
        latitude: cesium.Math.toDegrees(position.latitude),
        longitude: cesium.Math.toDegrees(position.longitude),
        height: position.height,
        heading: cesium.Math.toDegrees(camera.heading),
        pitch: cesium.Math.toDegrees(camera.pitch)
      });
    };

    // Initial update
    updateCameraPosition();
    
    // Add camera changed event listener
    const cameraMoveEndHandler = viewer.camera.moveEnd.addEventListener(updateCameraPosition);
    
    // Cleanup function
    return () => {
      if (cameraMoveEndHandler) {
        cameraMoveEndHandler();
      }
    };
  }, [showCameraPosition, viewer, cesium]);

  return cameraPosition;
};

/**
 * Custom hook to manage canvas cache
 */
export const useCanvasCache = () => {
  const canvasCache = useRef<{ [key: string]: HTMLCanvasElement }>({});

  // Clear canvas cache when component mounts/remounts
  useEffect(() => {
    canvasCache.current = {};
  }, []);

  return canvasCache;
};