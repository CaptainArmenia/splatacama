'use client';
// Import React using the default import syntax
import React from 'react';
// Then import individual hooks separately
import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { MapLandmark } from '@/types/cesium';
// Imported statically so the list is there on the first render. The viewer is built from it, and a list that
// arrived later would make the viewer rebuild.
import landmarkData from '@/data/landmarks.json';

const landmarks: MapLandmark[] = landmarkData;

// Draw pins on top of terrain instead of letting hills hide them
const PREVENT_PIN_OCCLUSION = true;

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
        selectedLandmark={selectedLandmark}
        setSelectedLandmark={setSelectedLandmark}
        setErrorState={setErrorState}
        showCameraPosition={false}
        preventPinOcclusion={PREVENT_PIN_OCCLUSION}
      />
    </div>
  );
}
