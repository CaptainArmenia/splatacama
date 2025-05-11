'use client';
import { getBlobUrl } from '@/utils/blobUtils';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

type Props = { 
  url: string; 
  backgroundColor?: string;
  showLoadingPercentage?: boolean;
  onError?: (errorMessage: string) => void;
};

export default function GSplatViewer({ 
  url, 
  backgroundColor = '#f5f5f5',
  showLoadingPercentage = false,
  onError
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isXRCompatible, setIsXRCompatible] = useState(false);

  // Check for WebXR compatibility
  useEffect(() => {
    const checkXRCompatibility = async () => {
      // Check if the browser supports WebXR
      if ('xr' in navigator) {
        try {
          // Check if immersive-vr is supported
          const isSupported = await navigator.xr?.isSessionSupported('immersive-vr');
          setIsXRCompatible(!!isSupported);
          console.log("WebXR VR compatibility:", isSupported);
        } catch (err) {
          console.log("WebXR compatibility check failed:", err);
          setIsXRCompatible(false);
        }
      } else {
        console.log("WebXR not available in this browser");
        setIsXRCompatible(false);
      }
    };
    
    checkXRCompatibility();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    
    let isMounted = true;
    let viewer: any = null;

    const initViewer = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get the signed Blob URL if needed
        const splatFileUrl = await getBlobUrl(url);
        console.log("Loading splat from URL:", splatFileUrl);
        
        // Parse hex color to RGB
        const color = new THREE.Color(backgroundColor);
        
        // Create the viewer with minimal options
        viewer = new GaussianSplats3D.Viewer({
          selfDrivenMode: true,
          cameraUp: [0, -1, 0],
          initialCameraPosition: [-1, -4, 6],
          initialCameraLookAt: [0, 4, 0],
          rootElement: containerRef.current,
          backgroundColor: color,
          // Enable the library's built-in loading indicator
          showLoadingSpinner: true,
          showLoadingProgressBar: true,
          gpuAcceleratedSort: false,
          sharedMemoryForWorkers: false,
          // Only enable WebXR if the environment is compatible
          webXRMode: isXRCompatible ? GaussianSplats3D.WebXRMode.VR : GaussianSplats3D.WebXRMode.NONE,
        });
        
        // Store reference to viewer
        viewerRef.current = viewer;

        // Array of scene definitions
        const sceneDefinitions = [
          {
            path: splatFileUrl,
            position: [0, 0, 0],
            rotation: isXRCompatible ? new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)).toArray() :  [0, 0, 0, 1],  // Quaternion format [x,y,z,w]
            scale: isXRCompatible ? [4, 4, 4] : [10, 10, 10],
          }
        ];

        // Load the scene
        await viewer.addSplatScenes(sceneDefinitions);
        
        // Loading is complete
        if (isMounted) {
          setLoading(false);
        }

        // Start the viewer
        viewer.start();
      } catch (err) {
        console.error("Error initializing splat viewer:", err);
        const errorMsg = err instanceof Error ? err.message : 'An unknown error occurred';
        if (isMounted) {
          setError(errorMsg);
          onError?.(errorMsg);
          setLoading(false);
        }
      }
    };

    initViewer();

    // Clean up function
    return () => {
      isMounted = false;
      
      // Dispose viewer
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose();
        } catch (e) {
          console.error("Error disposing viewer:", e);
        }
        viewerRef.current = null;
      }
    };
  }, [url, backgroundColor, onError, isXRCompatible]);

  return (
    <div 
      ref={containerRef}
      className="relative h-full w-full rounded-lg overflow-hidden shadow-lg"
      style={{ backgroundColor }}
    >
      {/* Remove our custom loading indicator, we're using the library's built-in one */}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-75 backdrop-blur-sm transition-all duration-300 z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md">
            <div className="flex items-center mb-4 text-red-500">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="font-bold text-lg">Error de carga</h3>
            </div>
            <p className="text-gray-700">{error}</p>
            <button 
              onClick={() => window.location.reload()} 
              className="mt-4 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors duration-300"
            >
              Intentar de nuevo
            </button>
          </div>
        </div>
      )}
      
      <div className="absolute bottom-4 right-4 bg-white bg-opacity-70 backdrop-blur-sm rounded-full p-1 shadow-md">
        <div className="text-xs text-gray-500 px-2 select-none">
          Arrastrar: rotar | Scroll: zoom
        </div>
      </div>
    </div>
  );
}
