'use client';
import React, { useEffect, useRef } from 'react';

interface CesiumCompassProps {
  viewer: any;
  cesium: any;
}

export default function CesiumCompass({ viewer, cesium }: CesiumCompassProps) {
  const compassRef = useRef<HTMLDivElement>(null);
  const prevHeadingRef = useRef<number | null>(null);
  const currentRotationRef = useRef<number>(0);
  
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
      
      // Normalize the heading to [0, 360] range
      const normalizedHeading = ((heading % 360) + 360) % 360;
      
      // If we have a previous heading, calculate shortest rotation path
      if (prevHeadingRef.current !== null) {
        // Calculate direct distance
        let directDiff = normalizedHeading - prevHeadingRef.current;
        
        // Check if rotating the other way is shorter
        if (Math.abs(directDiff) > 180) {
          // Take the shorter path around the circle
          directDiff = directDiff > 0 
            ? directDiff - 360  // Going clockwise, but counterclockwise is shorter
            : directDiff + 360; // Going counterclockwise, but clockwise is shorter
        }
        
        // Update the current rotation directly rather than calculating from scratch each time
        currentRotationRef.current = normalizeAngle(currentRotationRef.current + directDiff);
        
        // Apply the calculated rotation directly
        compassRef.current.style.transform = `rotate(${-currentRotationRef.current}deg)`;
      } else {
        // First time, just set the rotation directly
        currentRotationRef.current = normalizedHeading;
        compassRef.current.style.transform = `rotate(${-normalizedHeading}deg)`;
      }
      
      // Store this heading for next comparison
      prevHeadingRef.current = normalizedHeading;
    }
    
    // Helper to normalize an angle to [0, 360]
    function normalizeAngle(angle: number): number {
      return ((angle % 360) + 360) % 360;
    }
    
    return () => {
      viewer?.camera?.changed?.removeEventListener(updateCompassRotation);
    };
  }, [viewer, cesium]);
  
  return (
    <div className="absolute top-4 right-4 z-10 bg-gray-900/70 rounded-full p-2 shadow-lg pointer-events-auto">
      <div 
        ref={compassRef} 
        className="relative w-14 h-14"
        style={{ transition: 'none' }} // Remove transition to avoid animation jumps
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
