import { useState, useEffect, useMemo } from 'react';
import { assetUrl } from '@/utils/assetUrl';
import type { MapLandmark, PreviewUrlsState } from '@/types/cesium';

/**
 * The R2 URLs of each landmark's preview photo (for the info panel) and pin image (its thumbnail, or the preview
 * when it has none)
 */
export const usePreviewUrls = (landmarks: MapLandmark[]): PreviewUrlsState =>
  useMemo(() => {
    const urls: { [id: string]: string } = {};
    const pinUrls: { [id: string]: string } = {};
    for (const landmark of landmarks) {
      if (landmark.previewUrl) {
        urls[landmark.id] = assetUrl(landmark.previewUrl);
      }
      const pinImage = landmark.thumbnailUrl || landmark.previewUrl;
      if (pinImage) {
        pinUrls[landmark.id] = assetUrl(pinImage);
      }
    }
    return { urls, pinUrls };
  }, [landmarks]);

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
