'use client';
import React, { useState, useRef, useEffect } from 'react';
import CesiumCompass from './CesiumCompass';
import { LandmarkInfoPanel } from './LandmarkInfoPanel';
import { CameraPositionPanel } from './CameraPositionPanel';
import { MapControls } from './MapControls';
import { useCesiumViewer } from '@/hooks/useCesiumViewer';
import { usePreviewUrls, useCameraPosition, useCanvasCache } from '@/hooks/useCesiumState';
import { updateLandmarkVisualState, updateSpecificLandmarkMarker, resetCameraView } from '@/utils/cesiumMarkerManager';
import type { CesiumMapProps, MapLandmark } from '@/types/cesium';

export default function CesiumMapComponent({
  landmarks,
  humboldtCenter,
  selectedLandmark,
  setSelectedLandmark,
  setErrorState,
  showCameraPosition: initialShowCameraPosition,
  preventPinOcclusion,
}: CesiumMapProps) {
  // Refs and state
  const containerRef = useRef<HTMLDivElement>(null);
  const [showCameraPosition, setShowCameraPosition] = useState(initialShowCameraPosition);
  const [hoveredLandmark, setHoveredLandmark] = useState<MapLandmark | null>(null);

  // Custom hooks
  const { mapLoaded, cesium, viewer, entityRefs } = useCesiumViewer(
    containerRef,
    landmarks,
    humboldtCenter,
    setErrorState,
    setSelectedLandmark,
    setHoveredLandmark,
    preventPinOcclusion
  );

  const previewUrls = usePreviewUrls(landmarks);
  const cameraPosition = useCameraPosition(viewer, cesium, showCameraPosition);
  const canvasCache = useCanvasCache();

  // Track previous states to detect changes
  const prevSelectedLandmarkRef = useRef<MapLandmark | null>(null);
  const prevHoveredLandmarkRef = useRef<MapLandmark | null>(null);
  const prevPreviewUrlsRef = useRef<{ [id: string]: string }>({});

  // Handle visual state updates
  useEffect(() => {
    if (!cesium || !viewer) return;

    const landmarksToUpdate = new Set<MapLandmark>();

    // Check if selected landmark changed
    if (prevSelectedLandmarkRef.current !== selectedLandmark) {
      if (prevSelectedLandmarkRef.current) {
        landmarksToUpdate.add(prevSelectedLandmarkRef.current);
      }
      if (selectedLandmark) {
        landmarksToUpdate.add(selectedLandmark);
      }
      prevSelectedLandmarkRef.current = selectedLandmark;
    }

    // Check if hovered landmark changed
    if (prevHoveredLandmarkRef.current !== hoveredLandmark) {
      if (prevHoveredLandmarkRef.current) {
        landmarksToUpdate.add(prevHoveredLandmarkRef.current);
      }
      if (hoveredLandmark) {
        landmarksToUpdate.add(hoveredLandmark);
      }
      prevHoveredLandmarkRef.current = hoveredLandmark;
    }

    // Update visual states immediately
    landmarksToUpdate.forEach(landmark => {
      updateLandmarkVisualState(landmark, entityRefs, viewer, selectedLandmark, hoveredLandmark);
    });
  }, [cesium, viewer, selectedLandmark, hoveredLandmark, entityRefs]);

  // Handle marker updates when preview URLs change
  useEffect(() => {
    if (!cesium || !viewer) return;
    
    const prevUrls = prevPreviewUrlsRef.current;
    const currentUrls = previewUrls.urls;
    
    // Only update landmarks whose preview URLs have actually changed
    landmarks.forEach(landmark => {
      const currentUrl = currentUrls[landmark.id];
      const prevUrl = prevUrls[landmark.id];
      
      // Update if URL changed (new URL appeared or existing URL changed)
      if (currentUrl && currentUrl !== prevUrl) {
        // Clear old cache entries for this landmark to force recreation with new image
        Object.keys(canvasCache.current).forEach(key => {
          if (key.startsWith(`${landmark.id}_`)) {
            delete canvasCache.current[key];
          }
        });
        updateSpecificLandmarkMarker(
          landmark,
          entityRefs,
          previewUrls.urls,
          canvasCache,
          selectedLandmark,
          hoveredLandmark,
          viewer
        );
      }
    });
    
    // Update the reference for next comparison
    prevPreviewUrlsRef.current = { ...currentUrls };
  }, [previewUrls.urls, landmarks, cesium, viewer, entityRefs, canvasCache, selectedLandmark, hoveredLandmark]);

  // Load initial markers after Cesium is ready
  useEffect(() => {
    if (!cesium || !viewer || !mapLoaded) return;
    
    landmarks.forEach(landmark => {
      updateSpecificLandmarkMarker(
        landmark,
        entityRefs,
        previewUrls.urls,
        canvasCache,
        selectedLandmark,
        hoveredLandmark,
        viewer
      );
    });
  }, [cesium, viewer, mapLoaded, landmarks, entityRefs, previewUrls.urls, canvasCache, selectedLandmark, hoveredLandmark]);

  // Event handlers
  const handleToggleCameraPosition = () => {
    setShowCameraPosition(prev => !prev);
  };

  const handleResetView = () => {
    resetCameraView(viewer, cesium, humboldtCenter);
  };

  const handleViewScene = (landmarkId: string) => {
    window.location.href = `/scene/${landmarkId}`;
  };

  // Return loading state or null if Cesium isn't ready
  if (!cesium && typeof window !== 'undefined') {
    return <div>Loading Cesium...</div>; 
  }
  
  if (typeof window === 'undefined') {
    return null; // Return nothing during SSR
  }
  
  return (
    <>
      <div 
        ref={containerRef} 
        className="h-full w-full"
      />
      
      {/* Loading indicator */}
      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-70">
          <div className="text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-orange-500 border-r-transparent align-[-0.125em]" />
            <p className="mt-2">Cargando terreno 3D...</p>
          </div>
        </div>
      )}
      
      {/* Cesium compass component */}
      {mapLoaded && cesium && viewer && (
        <CesiumCompass viewer={viewer} cesium={cesium} />
      )}
      
      {/* Landmark info panel */}
      {selectedLandmark && (
        <LandmarkInfoPanel
          selectedLandmark={selectedLandmark}
          previewUrls={previewUrls}
          onClose={() => setSelectedLandmark(null)}
          onViewScene={handleViewScene}
        />
      )}
      
      {/* Camera position display panel */}
      <CameraPositionPanel
        cameraPosition={cameraPosition}
        show={showCameraPosition}
      />
      
      {/* Map controls */}
      <MapControls
        mapLoaded={mapLoaded}
        showCameraPosition={showCameraPosition}
        onToggleCameraPosition={handleToggleCameraPosition}
        onResetView={handleResetView}
      />
    </>
  );
}
