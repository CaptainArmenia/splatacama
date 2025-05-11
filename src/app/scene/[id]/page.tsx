import React from 'react';
import GSplatViewer from "@/components/GSplatViewer";
import Link from "next/link";
import landmarks from '@/data/landmarks.json';

// Update to use the correct landmark interface 
interface Landmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  height: number;
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
}

// Updated to handle params as a Promise
export default async function ScenePage({ params }: { params: Promise<{ id: string }> }) {
  // Await the params Promise to get the actual params object
  const resolvedParams = await params;
  const { id } = resolvedParams;

  // Type assertion using the correct interface
  const landmark = landmarks.find((l) => l.id === id) as Landmark | undefined;

  if (!landmark) {
    return (
      <div className="flex h-screen w-screen items-center justify-center flex-col">
        <h1 className="text-2xl font-bold mb-4">Landmark not found</h1>
        <Link href="/" className="text-blue-500 hover:underline">
          Volver al mapa
        </Link>
      </div>
    );
  }

  return (
    <main className="h-screen w-screen relative">
      {/* Pass showLoadingPercentage prop to see loading progress */}
      <GSplatViewer 
        url={landmark.gsplatUrl} 
        showLoadingPercentage={true}
      />
      
      <div className="absolute top-4 left-4 bg-black bg-opacity-70 p-4 rounded text-white max-w-md">
        <h1 className="text-xl font-bold mb-2">{landmark.name}</h1>
        <p className="mb-4 text-sm opacity-90">{landmark.description}</p>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-blue-400 hover:underline text-sm flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Volver al mapa
          </Link>
        </div>
      </div>

    </main>
  );
}
