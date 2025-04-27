'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import * as SPLAT from 'gsplat';

type Props = { url: string; preview?: string };

export default function GSplatViewer({ url, preview }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Initialize SPLAT components
    const scene = new SPLAT.Scene();
    const camera = new SPLAT.Camera();
    const renderer = new SPLAT.WebGLRenderer(canvasRef.current);
    const controls = new SPLAT.OrbitControls(camera, renderer.canvas);

    // Load the splat file
    (async () => {
      try {
        setLoading(true);
        
        // Use the official loader
        await SPLAT.Loader.LoadAsync(url, scene, (progress) => {
          // Optional: Handle progress updates
          console.log(`Loading: ${Math.round(progress * 100)}%`);
        });
        
        setLoading(false);
      } catch (err) {
        console.error("Error loading 3D model:", err);
        setError(err instanceof Error ? err.message : "Failed to load model");
        setLoading(false);
      }
    })();

    // Set up render loop
    let animationFrameId: number;
    const renderLoop = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrameId = requestAnimationFrame(renderLoop);
    };
    
    renderLoop();

    // Clean up
    return () => {
      cancelAnimationFrame(animationFrameId);
      renderer.dispose();
      controls.dispose();
    };
  }, [url]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        aria-label="3-D reconstruction"
      />
      
      {loading && preview && (
        <div className="absolute inset-0">
          <div className="relative h-full w-full">
            <Image 
              src={preview}
              alt="Preview of 3D model"
              fill
              priority
              style={{ objectFit: 'cover' }}
            />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-black bg-opacity-70 text-white px-4 py-2 rounded">
              Loading 3D model...
            </div>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800 bg-opacity-75">
          <div className="bg-white p-4 rounded shadow-lg">
            <h3 className="text-red-500 font-bold mb-2">Error</h3>
            <p>{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
