'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import * as SPLAT from 'gsplat';

type Props = { 
  url: string; 
  preview?: string;
  backgroundColor?: string;
  showLoadingPercentage?: boolean;
};

export default function GSplatViewer({ 
  url, 
  preview, 
  backgroundColor = '#f5f5f5', 
  showLoadingPercentage = false 
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Initialize SPLAT components - similar to vanilla viewer
    const scene = new SPLAT.Scene();
    const camera = new SPLAT.Camera();
    const renderer = new SPLAT.WebGLRenderer();
    const controls = new SPLAT.OrbitControls(camera, renderer.canvas);
    
    // Set up render loop - simplified to match vanilla viewer
    const frame = () => {
      controls.update();
      renderer.render(scene, camera);
      
      requestAnimationFrame(frame);
    };
    
    const animationFrameId = requestAnimationFrame(frame);

    // Handle resize to make canvas responsive
    const handleResize = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        renderer.setSize(width, height);
    
      }
    };
    
    // Initial sizing
    handleResize();
    
    // Set up resize observer
    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    // Add canvas to container
    containerRef.current.appendChild(renderer.canvas);
    
    // Load the splat file
    (async () => {
      try {
        setLoading(true);
        
        if (url.endsWith(".splat")) {
          await SPLAT.Loader.LoadAsync(url, scene, (progress: number) => {
              setLoadProgress(Math.round(progress * 100));
          });
      } else if (url.endsWith(".ply")) {
          await SPLAT.PLYLoader.LoadAsync(
              url,
              scene,
              (progress: number) => {
                  setLoadProgress(Math.round(progress * 100));
              },
              "",
          );
      }
        
        setLoading(false);
      } catch (err) {
        console.error("Error loading 3D model:", err);
        setError(err instanceof Error ? err.message : "Failed to load model");
        setLoading(false);
      }
    })();

    // Clean up
    return () => {
      cancelAnimationFrame(animationFrameId);
      if (containerRef.current && renderer.canvas.parentNode === containerRef.current) {
        containerRef.current.removeChild(renderer.canvas);
      }
      resizeObserver.disconnect(); // Uncomment this to properly clean up the observer
      renderer.dispose();
      controls.dispose();
    };
  }, [url]);

  return (
    <div 
      ref={containerRef}
      className="relative h-full w-full rounded-lg overflow-hidden shadow-lg"
      style={{ backgroundColor }}
    >
      {/* No need for canvas ref, renderer creates its own canvas */}
      
      {loading && (
        <div className="absolute inset-0 transition-opacity duration-500">
          {preview ? (
            <div className="relative h-full w-full">
              <Image 
                src={preview}
                alt="Vista previa del modelo 3D"
                fill
                priority
                className="object-cover transition-opacity duration-300"
              />
              <div className="absolute inset-0 bg-black bg-opacity-40" />
            </div>
          ) : (
            <div className="absolute inset-0 bg-gray-100" />
          )}
          
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="bg-white bg-opacity-90 backdrop-blur-sm text-gray-800 px-6 py-4 rounded-lg shadow-lg text-center">
              <div className="flex items-center justify-center mb-3">
                <svg className="animate-spin h-6 w-6 mr-2 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="font-medium">Cargando modelo 3D</span>
              </div>
              {showLoadingPercentage && (
                <div className="w-full bg-gray-200 rounded-full h-2.5 mb-1">
                  <div className="bg-blue-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${loadProgress}%` }}></div>
                  <p className="text-sm text-gray-600">{loadProgress}%</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-75 backdrop-blur-sm transition-all duration-300">
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
