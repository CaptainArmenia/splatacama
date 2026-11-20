'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { LoadingMessage } from './LoadingMessage';
import type { MapLandmark } from '@/types/cesium';
// Imported statically so the list is there on the first render. The viewer is built from it, and a list that
// arrived later would make the viewer rebuild.
import { sites } from '@/data/sites';

const landmarks: MapLandmark[] = sites;

// Draw pins on top of terrain instead of letting hills hide them
const PREVENT_PIN_OCCLUSION = true;

// Dynamically import the CesiumMap component with SSR disabled
const CesiumMapComponent = dynamic(
  () => import('./CesiumMapComponent'),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full flex items-center justify-center bg-white">
        <LoadingMessage message="Cargando mapa 3D..." />
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
