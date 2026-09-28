import { useState, useRef, useEffect } from 'react';
import { getBlobUrl } from '@/utils/blobUtils';
import type { MapLandmark, PreviewUrlsState } from '@/types/cesium';

/**
 * Custom hook to manage preview URLs for landmarks (resolved to proxied R2 URLs by getBlobUrl)
 */
export const usePreviewUrls = (landmarks: MapLandmark[]) => {
  const [previewUrls, setPreviewUrls] = useState<PreviewUrlsState>({ urls: {}, pinUrls: {} });

  useEffect(() => {
    let cancelled = false;

    async function resolvePreviewUrls() {
      const urlMap: { [id: string]: string } = {};
      const pinUrlMap: { [id: string]: string } = {};
      for (const landmark of landmarks) {
        if (landmark.previewUrl) {
          urlMap[landmark.id] = await getBlobUrl(landmark.previewUrl);
        }
        const pinImage = landmark.thumbnailUrl || landmark.previewUrl;
        if (pinImage) {
          pinUrlMap[landmark.id] = await getBlobUrl(pinImage);
        }
      }
      if (!cancelled) setPreviewUrls({ urls: urlMap, pinUrls: pinUrlMap });
    }
    
    resolvePreviewUrls();
    return () => { cancelled = true; };
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
  return useRef<{ [key: string]: HTMLCanvasElement }>({});
};
