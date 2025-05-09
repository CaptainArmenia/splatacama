import React from 'react';
import GSplatViewer from "@/components/GSplatViewer";
import Link from "next/link";
import landmarks from "@/data/landmarks.json";

// Define a type for the landmarks
type Landmark = {
  id: string;
  name: string;
  description: string;
  lat: number;  // Changed from x
  lng: number;  // Changed from y
  height: number; // Added height property
  gsplatUrl: string;
  previewUrl?: string;
};

// Updated to handle params as a Promise
export default async function ScenePage({ params }: { params: Promise<{ id: string }> }) {
  // Await the params Promise to get the actual params object
  const resolvedParams = await params;
  const { id } = resolvedParams;

  // Type assertion to help TypeScript understand the structure
  const landmark = landmarks.find((l) => l.id === id) as Landmark | undefined;

  if (!landmark) {
    return (
      <div className="flex h-screen w-screen items-center justify-center flex-col">
        <h1 className="text-2xl font-bold mb-4">Landmark not found</h1>
        <Link href="/" className="text-blue-500 hover:underline">
          Back to map
        </Link>
      </div>
    );
  }

  return (
    <main className="h-screen w-screen relative">
      {/* Pass the gsplatUrl to the GSplatViewer */}
      <GSplatViewer url={landmark.gsplatUrl} />
      <div className="absolute top-4 left-4 bg-black bg-opacity-50 p-4 rounded text-white">
        <h1 className="text-xl font-bold mb-2">{landmark.name}</h1>
        <p className="mb-4">{landmark.description}</p>
        <Link href="/" className="text-blue-500 hover:underline">
          Back to map
        </Link>
      </div>
    </main>
  );
}
