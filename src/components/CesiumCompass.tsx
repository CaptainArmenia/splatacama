'use client';
import React, { useEffect, useRef } from 'react';

interface CesiumCompassProps {
  viewer: any;
  cesium: any;
}

export default function CesiumCompass({ viewer, cesium }: CesiumCompassProps) {
  const compassRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!viewer || !cesium || !compassRef.current) return;
    
    // Set initial compass rotation
    updateCompassRotation();
    
    // Update compass rotation when camera changes
    viewer.camera.changed.addEventListener(updateCompassRotation);
    viewer.camera.percentageChanged = 0.01; // Make it more responsive
    
    function updateCompassRotation() {
      if (!compassRef.current) return;
      
      // Get the camera heading in degrees
      const heading = cesium.Math.toDegrees(viewer.camera.heading);
      
      // Apply rotation to the compass
      compassRef.current.style.transform = `rotate(${-heading}deg)`;
    }
    
    return () => {
      viewer?.camera?.changed?.removeEventListener(updateCompassRotation);
    };
  }, [viewer, cesium]);
  
  return (
    <div className="absolute top-4 right-4 z-10 bg-gray-900 bg-opacity-70 rounded-full p-2 shadow-lg pointer-events-auto">
      <div 
        ref={compassRef} 
        className="relative w-14 h-14 transition-transform duration-100"
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
          <span className="absolute bottom-2 left-1/2 transform -translate-x-1/2 text-xs font-bold text-white-500">S</span>
          <span className="absolute top-1/2 right-2 transform -translate-y-1/2 text-xs font-bold text-white-500">E</span>
          <span className="absolute top-1/2 left-2 transform -translate-y-1/2 text-xs font-bold text-white-500">O</span>
        </div>
      </div>
    </div>
  );
}
