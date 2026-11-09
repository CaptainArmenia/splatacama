import React from 'react';
import { notFound } from 'next/navigation';
import GSplatViewer from "@/components/GSplatViewer";
import Link from "next/link";
import landmarks from '@/data/landmarks.json';
import type { MapLandmark, SceneTurbines } from '@/types/cesium';
import ToggleableInfoPanel from '@/components/ToggleableInfoPanel';
import windTurbines from '@/data/windTurbines.json';

// The site list is static, so every scene page can be built ahead of time
export function generateStaticParams() {
  return landmarks.map((landmark) => ({ id: landmark.id }));
}

export default async function ScenePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const landmark: MapLandmark | undefined = landmarks.find((l) => l.id === id);
  const turbines: SceneTurbines | undefined = (windTurbines as Record<string, SceneTurbines>)[id];

  if (!landmark) {
    notFound();
  }

  return (
    <main className="h-[100dvh] w-screen relative overflow-hidden">
      <GSplatViewer site={landmark} turbines={turbines} />

      {/* Back to map button - moved to top-left corner */}
      <div className="absolute top-4 left-4 z-50">
        <Link href="/" className="flex items-center gap-2 bg-black/70 hover:bg-black/80 transition-all px-3 py-2 rounded-full text-white text-xs sm:text-sm">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Volver al mapa
        </Link>
      </div>

      {/* Info toggle, kept clear of the iPhone home indicator */}
      <div className="fixed bottom-4 left-4 z-50 pb-[env(safe-area-inset-bottom)]">
        <ToggleableInfoPanel landmark={landmark} />
      </div>
    </main>
  );
}
