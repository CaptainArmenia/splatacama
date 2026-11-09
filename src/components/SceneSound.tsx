'use client';
import { useEffect, useRef, useState } from 'react';
import PanelToggle from '@/components/PanelToggle';
import type { SceneSound as SceneSoundEngine, SoundChoice } from '@/utils/sceneSound';

// Remembered in this browser, so a visitor's choice holds on the next scene. (Before there was one switch for all of
// it, under OLD_MUTED_KEY: muted then means everything off.)
const STORAGE_KEY = 'splatacama.sounds';
const OLD_MUTED_KEY = 'splatacama.soundMuted';

const readStoredChoice = (): SoundChoice => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (stored && typeof stored.wind === 'boolean' && typeof stored.turbines === 'boolean') return stored;
    const off = localStorage.getItem(OLD_MUTED_KEY) === '1';
    return { wind: !off, turbines: !off };
  } catch {
    return { wind: true, turbines: true };
  }
};

/**
 * The scene's sound button and the panel it opens, with a switch for each sound (sceneSound.ts): the wind, and the
 * wind turbines' on scenes that have them. The first click or key press anywhere starts the sound.
 */
export default function SceneSound({ sound, hasTurbines }: { sound: SceneSoundEngine | null; hasTurbines: boolean }) {
  const [choice, setChoice] = useState<SoundChoice>({ wind: true, turbines: true });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sound) return;
    const stored = readStoredChoice();
    setChoice(stored);
    sound.setSounds(stored);

    // Browsers block sound until the visitor interacts, so the first click or key press anywhere starts it
    const unlock = () => sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [sound]);

  // A click anywhere else closes the panel
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const change = (next: SoundChoice) => {
    setChoice(next);
    sound?.setSounds(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the choice just isn't remembered
    }
  };

  // Silent when every sound this scene has is off
  const silent = !choice.wind && (!hasTurbines || !choice.turbines);
  const label = silent ? 'Sonido: apagado' : 'Sonido';

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center bg-black/70 hover:bg-black/80 transition-all p-2 rounded-full text-white"
        title={label}
        aria-label={label}
        aria-expanded={open}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          {silent ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
          )}
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-lg border border-gray-700 bg-gray-900/90 p-2 text-white shadow-lg backdrop-blur-sm">
          <PanelToggle
            label="Viento"
            description="La brisa sobre el terreno abierto."
            on={choice.wind}
            onChange={(on) => change({ ...choice, wind: on })}
          />
          {hasTurbines && (
            <PanelToggle
              label="Aerogeneradores"
              description="El zumbido y el giro de los más cercanos, desde donde están."
              on={choice.turbines}
              onChange={(on) => change({ ...choice, turbines: on })}
            />
          )}
        </div>
      )}
    </div>
  );
}
