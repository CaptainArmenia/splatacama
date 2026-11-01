import React from 'react';
import type { MapLandmark } from '@/types/cesium';
import { LandmarkDetails, PanelCloseButton } from './LandmarkDetails';

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
}) => (
  <div className="absolute top-4 left-4 z-30 bg-gray-900/90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden max-w-xs md:max-w-sm">
    <PanelCloseButton onClick={onClose} />
    <LandmarkDetails landmark={selectedLandmark} previewUrl={previewUrl}>
      <button
        className="w-full mt-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors font-medium flex items-center justify-center gap-2 text-sm border border-orange-700"
        onClick={() => onViewScene(selectedLandmark.id)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5" aria-hidden="true">
          <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
          <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
        </svg>
        Ver Escena 3D
      </button>
    </LandmarkDetails>
  </div>
);
