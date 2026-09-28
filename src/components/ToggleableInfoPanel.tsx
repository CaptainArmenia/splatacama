'use client';
import { getBlobUrl } from '@/utils/blobUtils';
import { useState, useEffect } from 'react';
import type { MapLandmark } from '@/types/cesium';

interface ToggleableInfoPanelProps {
  landmark: MapLandmark;
}

export default function ToggleableInfoPanel({ landmark }: ToggleableInfoPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Fetch the preview image URL
  useEffect(() => {
    async function loadPreviewImage() {
      if (!landmark.previewUrl) return;
      
      setIsLoading(true);
      setHasError(false);
      
      try {
        const url = await getBlobUrl(landmark.previewUrl);
        setPreviewUrl(url);
      } catch (error) {
        console.error('Error loading preview image:', error);
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    }
    
    loadPreviewImage();
  }, [landmark]);

  if (!landmark) return null;

  return (
    <div>
      {/* Toggle button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 transition-all px-3 py-2 rounded-full text-white text-xs sm:text-sm ${isOpen ? 'bg-orange-600 hover:bg-orange-700' : 'bg-black/70 hover:bg-black/80'}`}
        aria-expanded={isOpen}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Información del lugar
      </button>

      {/* Info panel - using the same styling as the landmark panel in map view but wider */}
      {isOpen && (
        <div className="absolute bottom-14 left-0 z-30 bg-gray-900/90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden min-w-[280px] w-[90vw] max-w-sm md:max-w-md lg:max-w-lg lg:w-auto">
          {/* Close button - positioned absolutely in the corner */}
          <button 
            onClick={() => setIsOpen(false)}
            className="absolute top-2 right-2 z-50 bg-black/60 hover:bg-black/80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
            aria-label="Cerrar"
          >
            <span className="sr-only">Cerrar</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>

          {/* Preview image at the top - using the same style as in map panel */}
          {landmark.previewUrl && (
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
                    src={previewUrl || ''} 
                    alt={`Vista de ${landmark.name}`}
                    className="w-full h-full object-cover"
                    onError={() => setHasError(true)}
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
          
          {/* Content area */}
          <div className="p-3">
            {/* Show title only if no preview image */}
            {!landmark.previewUrl && (
              <h3 className="font-bold text-lg text-orange-400 mb-2">{landmark.name}</h3>
            )}
            
            {/* Description */}
            <p className="text-gray-200 text-sm leading-relaxed mb-3">{landmark.description}</p>
    
          </div>
        </div>
      )}
    </div>
  );
}