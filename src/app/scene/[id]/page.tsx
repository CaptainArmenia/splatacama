import React from 'react';
import GSplatViewer from "@/components/GSplatViewer";
import Link from "next/link";
import landmarks from '@/data/landmarks.json';
import { Landmark } from '@/types/landmarkTypes';
import ToggleableInfoPanel from '@/components/ToggleableInfoPanel';

// Keep the component async to handle dynamic params correctly
export default async function ScenePage({ params }: { params: { id: string } }) {
  // Await params before accessing its properties
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
    <main className="h-[100dvh] w-screen relative overflow-hidden">
      {/* Pass showLoadingPercentage prop to see loading progress */}
      <GSplatViewer 
        url={landmark.gsplatUrl} 
        showLoadingPercentage={true}
      />
      
      {/* Back to map button - moved to top-left corner */}
      <div className="absolute top-4 left-4 z-50">
        <Link href="/" className="flex items-center gap-2 bg-black bg-opacity-70 hover:bg-opacity-80 transition-all px-3 py-2 rounded-full text-white text-xs sm:text-sm">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Volver al mapa
        </Link>
      </div>

      {/* Using the updated ToggleableInfoPanel with matching styling */}
      <div className="fixed bottom-4 left-4 z-50 pb-safe">
        <ToggleableInfoPanel landmark={landmark} />
      </div>
    </main>
  );
}
