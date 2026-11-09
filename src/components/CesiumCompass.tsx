'use client';
import { useEffect, useRef } from 'react';

interface CesiumCompassProps {
  viewer: any;
  cesium: any;
}

export default function CesiumCompass({ viewer, cesium }: CesiumCompassProps) {
  const compassRef = useRef<HTMLDivElement>(null);

  // Turn the dial against the camera heading so N points north. No CSS transition, so going from 359 to 0
  // degrees doesn't spin the dial around.
  useEffect(() => {
    const compass = compassRef.current;
    if (!viewer || !cesium || !compass) return;

    const updateRotation = () => {
      compass.style.transform = `rotate(${-cesium.Math.toDegrees(viewer.camera.heading)}deg)`;
    };
    updateRotation();

    // camera.changed fires after the view moves by this fraction (default 0.5), so the dial follows smoothly
    viewer.camera.percentageChanged = 0.01;
    return viewer.camera.changed.addEventListener(updateRotation);
  }, [viewer, cesium]);

  return (
    <div className="absolute top-4 right-4 z-10 bg-gray-900/70 rounded-full p-2 shadow-lg pointer-events-auto">
      <div 
        ref={compassRef} 
        className="relative w-14 h-14"
      >
        {/* Compass face */}
        <div className="absolute inset-0 rounded-full border-2 border-gray-400 bg-gray-700 flex items-center justify-center">
          {/* North marker */}
          <div className="absolute top-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-red-500 rounded-sm"></div>
          {/* South marker */}
          <div className="absolute bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-white rounded-sm"></div>
          {/* East marker */}
          <div className="absolute right-1 top-1/2 transform -translate-y-1/2 w-1 h-1 bg-white rounded-sm"></div>
          {/* West marker */}
          <div className="absolute left-1 top-1/2 transform -translate-y-1/2 w-1 h-1 bg-white rounded-sm"></div>
          {/* Cardinal directions */}
          <span className="absolute top-2 left-1/2 transform -translate-x-1/2 text-xs font-bold text-red-500">N</span>
          <span className="absolute bottom-2 left-1/2 transform -translate-x-1/2 text-xs font-bold text-white">S</span>
          <span className="absolute top-1/2 right-2 transform -translate-y-1/2 text-xs font-bold text-white">E</span>
          <span className="absolute top-1/2 left-2 transform -translate-y-1/2 text-xs font-bold text-white">O</span>
        </div>
      </div>
    </div>
  );
}
