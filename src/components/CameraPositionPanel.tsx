import React from 'react';
import type { CameraPosition } from '@/types/cesium';

interface CameraPositionPanelProps {
  cameraPosition: CameraPosition;
  show: boolean;
}

export const CameraPositionPanel: React.FC<CameraPositionPanelProps> = ({
  cameraPosition,
  show
}) => {
  if (!show) return null;

  return (
    <div className="absolute bottom-4 left-4 z-50 bg-gray-900/90 p-3 rounded-md shadow-md border border-gray-700 text-white max-w-[200px]">
      <h3 className="font-bold mb-1 text-orange-400">Posición de la cámara</h3>
      <div className="text-xs space-y-1">
        <p>Lat: <span className="font-mono">{cameraPosition.latitude.toFixed(6)}°</span></p>
        <p>Long: <span className="font-mono">{cameraPosition.longitude.toFixed(6)}°</span></p>
        <p>Altura: <span className="font-mono">{cameraPosition.height.toFixed(2)}m</span></p>
        <p>Dirección: <span className="font-mono">{cameraPosition.heading.toFixed(2)}°</span></p>
        <p>Inclinación: <span className="font-mono">{cameraPosition.pitch.toFixed(2)}°</span></p>
      </div>
    </div>
  );
};