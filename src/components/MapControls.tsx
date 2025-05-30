import React from 'react';
import { DEFAULT_CAMERA_CONFIG } from '@/constants/cesiumConfig';

interface MapControlsProps {
  mapLoaded: boolean;
  showCameraPosition: boolean;
  onToggleCameraPosition: () => void;
  onResetView: () => void;
}

export const MapControls: React.FC<MapControlsProps> = ({
  mapLoaded,
  showCameraPosition,
  onToggleCameraPosition,
  onResetView
}) => {
  if (!mapLoaded) return null;

  return (
    <>
      {/* Mobile controls */}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2 md:hidden">
        <button 
          className={`w-12 h-12 rounded-full shadow-lg border flex items-center justify-center transition-colors ${
            showCameraPosition 
              ? 'bg-orange-600 text-white border-orange-700' 
              : 'bg-gray-800 bg-opacity-90 text-white border-gray-700'
          }`}
          onClick={onToggleCameraPosition}
          aria-label={showCameraPosition ? 'Ocultar posición' : 'Mostrar posición'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
            <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clipRule="evenodd" />
          </svg>
        </button>
        
        <button 
          className="w-12 h-12 rounded-full shadow-lg bg-gray-800 bg-opacity-90 text-white border border-gray-700 flex items-center justify-center"
          onClick={onResetView}
          aria-label="Restablecer vista"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
            <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
      
      {/* Desktop controls */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10 hidden md:block">
        <button 
          className={`px-3 py-2 rounded-lg shadow-lg text-sm border flex items-center gap-2 transition-colors ${
            showCameraPosition 
              ? 'bg-orange-600 text-white border-orange-700' 
              : 'bg-gray-900 bg-opacity-90 text-white border-gray-700 hover:bg-gray-800'
          }`}
          onClick={onToggleCameraPosition}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clipRule="evenodd" />
          </svg>
          {showCameraPosition ? 'Ocultar Posición' : 'Mostrar Posición'}
        </button>
      </div>

      <div className="absolute bottom-4 right-4 z-10 hidden md:block">
        <button 
          className="px-3 py-2 rounded-lg shadow-lg text-sm border bg-gray-900 bg-opacity-90 text-white border-gray-700 hover:bg-gray-800 flex items-center gap-2 transition-colors"
          onClick={onResetView}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
          </svg>
          Restablecer Vista 3D
        </button>
      </div>
    </>
  );
};