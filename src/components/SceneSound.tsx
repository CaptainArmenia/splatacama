'use client';
import { useEffect, useState } from 'react';
import type { SceneSound as SceneSoundEngine } from '@/utils/sceneSound';

// Remembered in this browser, so a visitor who muted the sound doesn't hear it again on the next scene
const MUTED_STORAGE_KEY = 'splatacama.soundMuted';

const readStoredMuted = () => {
  try {
    return localStorage.getItem(MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

/** The button that mutes a scene's sound (sceneSound.ts), which the first click or key press anywhere starts */
export default function SceneSound({ sound }: { sound: SceneSoundEngine | null }) {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!sound) return;
    const storedMuted = readStoredMuted();
    setMuted(storedMuted);
    sound.setMuted(storedMuted);

    // Browsers block sound until the visitor interacts, so the first click or key press anywhere starts it
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [sound]);

  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    sound?.setMuted(next);
    try {
      localStorage.setItem(MUTED_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Storage blocked: the choice just isn't remembered
    }
  };

  const label = muted ? 'Activar sonido' : 'Silenciar sonido';

  return (
    <button
      onClick={toggleMuted}
      className="flex items-center justify-center bg-black/70 hover:bg-black/80 transition-all p-2 rounded-full text-white"
      title={label}
      aria-label={label}
      aria-pressed={muted}
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {muted ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
        )}
      </svg>
    </button>
  );
}
