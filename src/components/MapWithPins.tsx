'use client';
// Import React using the default import syntax
import React from 'react';
// Then import individual hooks separately
import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import type { MapLandmark } from '@/types/cesium';

// Humboldt Archipelago coordinates (approximate center)
const humboldtCenter = { lat: -29.168210, lng: -71.599582 };

// Dynamically import the CesiumMap component with SSR disabled
const CesiumMapComponent = dynamic(
  () => import('./CesiumMapComponent'),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-orange-500 border-r-transparent align-[-0.125em]" />
          <p className="mt-2">Cargando mapa 3D...</p>
        </div>
      </div>
    )
  }
);

export default function MapWithPins() {
  const [landmarks, setLandmarks] = useState<MapLandmark[]>([]);
  const [selectedLandmark, setSelectedLandmark] = useState<MapLandmark | null>(null);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [showCameraPosition, setShowCameraPosition] = useState(false);
  const [preventPinOcclusion, setPreventPinOcclusion] = useState(true);
  
  useEffect(() => {
    // Only load on client side
    import('@/data/landmarks.json')
      .then((data) => {
        setLandmarks(data.default);
      })
      .catch(console.error);
  }, []);

  // Toggle camera position display
  const toggleCameraPosition = () => {
    setShowCameraPosition(prev => !prev);
  };

  // Render fallback map if there's an error
  if (errorState) {
    return (
      <div className="h-full w-full relative overflow-hidden">
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-gray-100">
          <h2 className="text-xl font-bold mb-4">No se pudo cargar el mapa 3D</h2>
          <p className="mb-4">{errorState}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative overflow-hidden">
      <CesiumMapComponent 
        landmarks={landmarks} 
        humboldtCenter={humboldtCenter}
        selectedLandmark={selectedLandmark}
        setSelectedLandmark={setSelectedLandmark}
        setErrorState={setErrorState}
        showCameraPosition={showCameraPosition}
        preventPinOcclusion={preventPinOcclusion}
      />
    </div>
  );
}