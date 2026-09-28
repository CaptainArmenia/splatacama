import React, { useState } from 'react';
import type { MapLandmark } from '@/types/cesium';

interface LandmarkInfoPanelProps {
  selectedLandmark: MapLandmark;
  previewUrl?: string;
  onClose: () => void;
  onViewScene: (landmarkId: string) => void;
}

export const LandmarkInfoPanel: React.FC<LandmarkInfoPanelProps> = ({
  selectedLandmark,
  previewUrl,
  onClose,
  onViewScene
}) => {
  // The URL whose image failed to load, if any; a new selection gets a fresh try
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isLoading = !previewUrl;
  const hasError = !!previewUrl && failedUrl === previewUrl;

  return (
    <div className="absolute top-4 left-4 z-30 bg-gray-900/90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden max-w-xs md:max-w-sm">
      {/* Close button */}
      <button 
        onClick={onClose}
        className="absolute top-2 right-2 z-50 bg-black/60 hover:bg-black/80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
        aria-label="Cerrar"
      >
        <span className="sr-only">Cerrar</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>

      {/* Preview image */}
      {selectedLandmark.previewUrl && (
        <div className="w-full h-52 relative border-b border-gray-700">
          {isLoading ? (
            <div className="w-full h-full flex items-center justify-center bg-gray-800">
              <div className="animate-pulse h-8 w-8 rounded-full border-4 border-orange-500 border-r-transparent" />
            </div>
          ) : hasError ? (
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
                alt={`Vista de ${selectedLandmark.name}`}
                className="w-full h-full object-cover"
                onError={() => {
                  console.error(`Error loading image for ${selectedLandmark.id}`);
                  setFailedUrl(previewUrl ?? null);
                }}
              />
              <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-start">
                <h3 className="font-bold text-xl text-white drop-shadow-md p-4">
                  {selectedLandmark.name}
                </h3>
              </div>
            </>
          )}
        </div>
      )}
      
      {/* Content area */}
      <div className="p-3">
        {/* Show title only if no preview image */}
        {!selectedLandmark.previewUrl && (
          <h3 className="font-bold text-lg text-orange-400 mb-2">{selectedLandmark.name}</h3>
        )}
        
        {/* Description */}
        <p className="text-gray-200 text-sm leading-relaxed mb-3">{selectedLandmark.description}</p>
        
        {/* View Scene Button */}
        <div className="mt-2">
          <button
            className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors font-medium flex items-center justify-center gap-2 text-sm border border-orange-700"
            onClick={() => onViewScene(selectedLandmark.id)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
              <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
            </svg>
            Ver Escena 3D
          </button>
        </div>
      </div>
    </div>
  );
};