'use client';
import { useState, type ReactNode } from 'react';
import type { MapLandmark } from '@/types/cesium';

interface LandmarkDetailsProps {
  landmark: MapLandmark;
  previewUrl?: string;
  // Shown under the description, e.g. the map panel's "Ver Escena 3D" button
  children?: ReactNode;
}

/**
 * The body of a landmark info panel (the map's and the scene page's): the preview photo with the name over it,
 * then the description.
 */
export function LandmarkDetails({ landmark, previewUrl, children }: LandmarkDetailsProps) {
  // The URL whose image failed to load, if any; another landmark's photo gets a fresh try
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  return (
    <>
      {previewUrl && (
        <div className="w-full h-52 relative border-b border-gray-700">
          {failedUrl === previewUrl ? (
            <div className="w-full h-full flex items-center justify-center bg-gray-800 text-gray-300">
              <div className="text-center p-4">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mx-auto mb-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p>No se pudo cargar la imagen</p>
              </div>
            </div>
          ) : (
            <>
              <img
                src={previewUrl}
                alt={`Vista de ${landmark.name}`}
                className="w-full h-full object-cover bg-gray-800"
                onError={() => setFailedUrl(previewUrl)}
              />
              <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-start">
                <h3 className="font-bold text-xl text-white drop-shadow-md p-4">
                  {landmark.name}
                </h3>
              </div>
            </>
          )}
        </div>
      )}

      <div className="p-3">
        {/* With no photo, the name goes here instead */}
        {!previewUrl && (
          <h3 className="font-bold text-lg text-orange-400 mb-2">{landmark.name}</h3>
        )}
        <p className="text-gray-200 text-sm leading-relaxed mb-3">{landmark.description}</p>
        {children}
      </div>
    </>
  );
}

/** The round close button in an info panel's top-right corner. */
export function PanelCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute top-2 right-2 z-50 bg-black/60 hover:bg-black/80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
      aria-label="Cerrar"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5" aria-hidden="true">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
      </svg>
    </button>
  );
}
