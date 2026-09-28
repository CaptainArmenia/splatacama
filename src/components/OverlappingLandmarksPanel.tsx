import React from 'react';
import type { MapLandmark, PreviewUrlsState } from '@/types/cesium';

interface OverlappingLandmarksPanelProps {
  landmarks: MapLandmark[];
  previewUrls: PreviewUrlsState;
  onSelect: (landmark: MapLandmark) => void;
  onClose: () => void;
}

/**
 * Shown when a click lands on several pins stacked on top of each other, so the user can pick one.
 */
export const OverlappingLandmarksPanel: React.FC<OverlappingLandmarksPanelProps> = ({
  landmarks,
  previewUrls,
  onSelect,
  onClose
}) => {
  return (
    <div className="absolute top-4 left-4 z-30 bg-gray-900 bg-opacity-90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden max-w-xs md:max-w-sm">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 z-50 bg-black bg-opacity-60 hover:bg-opacity-80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
        aria-label="Cerrar"
      >
        <span className="sr-only">Cerrar</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>

      <div className="p-3 pr-10">
        <h3 className="font-bold text-lg text-orange-400">{landmarks.length} sitios en este punto</h3>
        <p className="text-gray-300 text-sm">Elige uno para ver su información.</p>
      </div>

      {/* One row per stacked site */}
      <ul className="border-t border-gray-700">
        {landmarks.map((landmark, index) => {
          const previewUrl = previewUrls.urls[landmark.id];
          return (
            <li key={landmark.id} className="border-b border-gray-700 last:border-b-0">
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-800 transition-colors"
                onClick={() => onSelect(landmark)}
                aria-label={`${landmark.name} ${index + 1} de ${landmarks.length}`}
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt=""
                    className="w-12 h-12 rounded-full object-cover border-2 border-white flex-shrink-0"
                  />
                ) : (
                  <span className="w-12 h-12 rounded-full bg-orange-600 border-2 border-white flex-shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block font-medium text-sm">{landmark.name}</span>
                  <span className="block font-mono text-xs text-gray-400">
                    {landmark.lat.toFixed(5)}°, {landmark.lng.toFixed(5)}°
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
