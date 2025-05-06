'use client';
// Import React using the default import syntax
import React from 'react';
// Then import individual hooks separately
import { useState } from 'react';
import dynamic from 'next/dynamic';
import landmarks from '@/data/landmarks.json';

// Define interfaces and constants outside the component
interface MapLandmark {
  id: string;
  name: string;
  lat: number;   // Changed from x to lat
  lng: number;   // Changed from y to lng
  height: number; // Added height property
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
}

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
  const [selectedLandmark, setSelectedLandmark] = useState<MapLandmark | null>(null);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [showCameraPosition, setShowCameraPosition] = useState(false);
  const [preventPinOcclusion, setPreventPinOcclusion] = useState(true);
  
  // Use the original landmarks data and transform if needed
  const typedLandmarks = landmarks as unknown as MapLandmark[];

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
        landmarks={typedLandmarks} 
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