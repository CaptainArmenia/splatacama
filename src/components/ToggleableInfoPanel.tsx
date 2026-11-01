'use client';
import { useState } from 'react';
import { assetUrl } from '@/utils/assetUrl';
import type { MapLandmark } from '@/types/cesium';
import { LandmarkDetails, PanelCloseButton } from './LandmarkDetails';

interface ToggleableInfoPanelProps {
  landmark: MapLandmark;
}

/** The scene page's "Información del lugar" button and the panel it opens: the map's info panel, but wider. */
export default function ToggleableInfoPanel({ landmark }: ToggleableInfoPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const previewUrl = landmark.previewUrl ? assetUrl(landmark.previewUrl) : undefined;

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 transition-all px-3 py-2 rounded-full text-white text-xs sm:text-sm ${isOpen ? 'bg-orange-600 hover:bg-orange-700' : 'bg-black/70 hover:bg-black/80'}`}
        aria-expanded={isOpen}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Información del lugar
      </button>

      {isOpen && (
        <div className="absolute bottom-14 left-0 z-30 bg-gray-900/90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden min-w-[280px] w-[90vw] max-w-sm md:max-w-md lg:max-w-lg lg:w-auto">
          <PanelCloseButton onClick={() => setIsOpen(false)} />
          <LandmarkDetails landmark={landmark} previewUrl={previewUrl} />
        </div>
      )}
    </div>
  );
}
