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

  // Reset camera to initial position
  const resetCamera = () => {
    if (viewerRef.current) {
      try {
        // Define initial positions from the initialization parameters
        const initialPosition = new THREE.Vector3(7, -2.5, 5);
        const initialLookAt = new THREE.Vector3(0, 0, 0);
        
        // Access the camera and controls directly
        if (viewerRef.current.camera) {
          // Set camera position
          viewerRef.current.camera.position.copy(initialPosition);
          
          // Update the controls if they exist
          if (viewerRef.current.controls) {
            // Set the target for OrbitControls
            viewerRef.current.controls.target.copy(initialLookAt);
            viewerRef.current.controls.update();
          } else {
            // If no controls, use lookAt directly
            viewerRef.current.camera.lookAt(initialLookAt);
          }
        }
      } catch (e) {
        console.error("Error resetting camera:", e);
      }
    }
  };

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
    
    // Create a dedicated container element that won't be managed by React
    // This helps prevent conflicts between React's DOM management and the library's
    const viewerContainer = document.createElement('div');
    viewerContainer.style.width = '100%';
    viewerContainer.style.height = '100%';
    viewerContainer.setAttribute('data-gsplat-container', 'true');
    
    // Append it to our React-managed container
    containerRef.current.appendChild(viewerContainer);

    const initViewer = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get the signed Blob URL if needed
        const splatFileUrl = await getBlobUrl(url);
        
        // Parse hex color to RGB
        const color = new THREE.Color(backgroundColor);
        
        // Create the viewer with minimal options - using our dedicated container
        viewer = new GaussianSplats3D.Viewer({
          selfDrivenMode: true,
          cameraUp: [0, -1, 0],
          initialCameraPosition: [7, -2.5, 5],
          initialCameraLookAt: [0, 0, 0],
          rootElement: viewerContainer, // Use our dedicated container
          backgroundColor: color,
          // Enable the library's built-in loading indicator
          showLoadingSpinner: true,
          showLoadingProgressBar: true,
          gpuAcceleratedSort: false,
          sharedMemoryForWorkers: false,
          // Enable touch controls for mobile
          enablePointerLock: false,
          // Only enable WebXR if the environment is compatible
          webXRMode: GaussianSplats3D.WebXRMode.NONE,
        });
        
        // Store reference to viewer
        viewerRef.current = viewer;

        // Array of scene definitions
        const sceneDefinitions = [
          {
            path: splatFileUrl,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],// isXRCompatible ? new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)).toArray() :  [0, 0, 0, 1],  // Quaternion format [x,y,z,w]
            scale: [10, 10, 10]//isXRCompatible ? [4, 4, 4] : [10, 10, 10],
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
      
      // Stop the viewer's rendering loop if possible
      if (viewerRef.current) {
        try {
          // First, disconnect any resize observers
          if (viewerRef.current.resizeObserver) {
            try {
              viewerRef.current.resizeObserver.disconnect();
              viewerRef.current.resizeObserver = null;
            } catch (e) {
              console.error("Error disconnecting resize observer:", e);
            }
          }
          
          // Stop rendering loop
          if (typeof viewerRef.current.stop === 'function') {
            try {
              viewerRef.current.stop();
            } catch (e) {
              console.error("Error stopping viewer:", e);
            }
          }
          
          // Remove any event listeners
          if (typeof viewerRef.current.removeEventHandlers === 'function') {
            try {
              // Set domElement to a dummy element to avoid errors
              if (viewerRef.current.renderer && viewerRef.current.renderer.domElement === null) {
                viewerRef.current.renderer.domElement = document.createElement('div');
              }
              viewerRef.current.removeEventHandlers();
            } catch (e) {
              console.error("Error removing event handlers:", e);
            }
          }
          
          // Clear all internal state of the viewer without relying on its dispose method
          if (viewerRef.current.renderer) {
            try {
              // Remove any WebGL resources
              viewerRef.current.renderer.dispose();
              viewerRef.current.renderer.forceContextLoss();
              viewerRef.current.renderer = null;
            } catch (e) {
              console.error("Error disposing renderer:", e);
            }
          }
          
          // Clear all other major properties to help garbage collection
          if (viewerRef.current.camera) viewerRef.current.camera = null;
          if (viewerRef.current.scene) viewerRef.current.scene = null;
          if (viewerRef.current.controls) viewerRef.current.controls = null;
          
          // Nullify the viewer reference
          viewerRef.current = null;
        } catch (e) {
          console.error("Error during manual cleanup:", e);
        }
      }
      
      // Clear the container's contents
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [url, backgroundColor, onError, isXRCompatible]);

  return (
    <div 
      ref={containerRef}
      className="relative h-full w-full rounded-lg overflow-hidden shadow-lg max-h-screen md:max-h-full"
      style={{ 
        backgroundColor,
        height: 'min(100%, 100vh)',
        maxHeight: '100vh',
        touchAction: 'none', // Prevent default touch behaviors that interfere with camera controls
        userSelect: 'none',  // Prevent text selection on touch
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
    >
      {/* Remove our custom loading indicator, we're using the library's built-in one */}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-75 backdrop-blur-sm transition-all duration-300 z-50">
          <div className="bg-white p-4 sm:p-6 rounded-lg shadow-xl w-[85%] sm:w-auto sm:max-w-md mx-auto">
            <div className="flex items-center mb-4 text-red-500">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="font-bold text-base sm:text-lg">Error de carga</h3>
            </div>
            <p className="text-sm sm:text-base text-gray-700">{error}</p>
            <button 
              onClick={() => window.location.reload()} 
              className="mt-4 w-full bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors duration-300"
            >
              Intentar de nuevo
            </button>
          </div>
        </div>
      )}
      
      {/* Show instructions and reset button */}
      <div className="absolute bottom-2 sm:bottom-4 right-2 sm:right-4 flex items-center gap-2">
        <button 
          onClick={resetCamera}
          className="bg-white bg-opacity-70 backdrop-blur-sm rounded-full p-1 sm:p-2 shadow-md hover:bg-opacity-90 transition-all"
          title="Reset camera position"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>
  );
}
