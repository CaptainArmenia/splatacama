'use client';
import React, { useState, useRef, useEffect } from 'react';
import CesiumCompass from './CesiumCompass';
import { LandmarkInfoPanel } from './LandmarkInfoPanel';
import { CameraPositionPanel } from './CameraPositionPanel';
import { MapControls } from './MapControls';
import { useCesiumViewer } from '@/hooks/useCesiumViewer';
import { usePreviewUrls, useCameraPosition } from '@/hooks/useCesiumState';
import { updateLandmarkVisualState, updateSpecificLandmarkMarker, resetCameraView } from '@/utils/cesiumMarkerManager';
import { getCacheKey } from '@/utils/cesiumMarkers';
import { LoadingMessage } from './LoadingMessage';
import type { CesiumMapProps, MapLandmark } from '@/types/cesium';

export default function CesiumMapComponent({
  landmarks,
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
    setErrorState,
    setSelectedLandmark,
    setHoveredLandmark,
    preventPinOcclusion
  );

  const previewUrls = usePreviewUrls(landmarks);
  const cameraPosition = useCameraPosition(viewer, cesium, showCameraPosition);
  // Pin canvases built so far, by getCacheKey()
  const canvasCache = useRef<{ [key: string]: HTMLCanvasElement }>({});

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

  // Put each landmark's photo on its pin once the map is ready, and again if its pin image URL changes.
  // Pins start with the orange fallback marker (see addLandmarkBillboards).
  useEffect(() => {
    if (!cesium || !viewer || !mapLoaded) return;
    
    const prevUrls = prevPreviewUrlsRef.current;
    const currentUrls = previewUrls.pinUrls;
    
    landmarks.forEach(landmark => {
      const currentUrl = currentUrls[landmark.id];
      if (!currentUrl || currentUrl === prevUrls[landmark.id]) return;

      // Drop the cached photo marker so it's rebuilt from the new URL
      delete canvasCache.current[getCacheKey(landmark.id, true)];
      updateSpecificLandmarkMarker(landmark, entityRefs, previewUrls, canvasCache, viewer);
    });
    
    prevPreviewUrlsRef.current = { ...currentUrls };
  }, [cesium, viewer, mapLoaded, landmarks, previewUrls, entityRefs, canvasCache]);

  // Event handlers
  const handleToggleCameraPosition = () => {
    setShowCameraPosition(prev => !prev);
  };

  const handleResetView = () => {
    resetCameraView(viewer, cesium);
  };

  const handleViewScene = (landmarkId: string) => {
    window.location.href = `/scene/${landmarkId}`;
  };

  // Same message as MapWithPins shows while this component's code loads. (This component only renders in the
  // browser: MapWithPins imports it with ssr: false.)
  if (!cesium) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-white">
        <LoadingMessage message="Cargando mapa 3D..." />
      </div>
    );
  }

  return (
    <>
      <div 
        ref={containerRef} 
        className="h-full w-full"
      />
      
      {/* Loading indicator */}
      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
          <LoadingMessage message="Cargando terreno 3D..." />
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
          previewUrl={previewUrls.urls[selectedLandmark.id]}
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
