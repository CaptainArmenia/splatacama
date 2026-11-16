'use client';
import { useState } from 'react';
import PanelToggle from '@/components/PanelToggle';
import type { GraphicsSettings } from '@/utils/graphicsSettings';

export type QuakeState = 'idle' | 'preparing' | 'shaken' | 'unavailable';

type Props = {
  night: boolean;
  onNightChange: (on: boolean) => void;
  // Hours after midnight of today; past 24 is tomorrow morning
  hour: number;
  onHourChange: (hour: number) => void;
  fog: boolean;
  onFogChange: (on: boolean) => void;
  bloom: boolean;
  onBloomChange: (on: boolean) => void;
  graphics: GraphicsSettings;
  onGraphicsChange: (change: Partial<GraphicsSettings>) => void;
  quake: QuakeState;
  onStartQuake: () => void;
  onResetQuake: () => void;
};

const formatHour = (hour: number) => {
  const minutes = Math.round(hour * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

/** The scene's "Efectos" button and the panel it opens (see src/effects/sceneEffects.ts) */
export default function SceneEffectsPanel(props: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-2 text-xs text-white transition-all hover:bg-black/80 sm:text-sm"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
        </svg>
        Efectos
      </button>

      {open && (
        <div className="absolute right-0 mt-2 max-h-[calc(100vh-6rem)] w-72 max-w-[calc(100vw-2rem)] space-y-1 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900/90 p-2 text-white shadow-lg backdrop-blur-sm">
          <PanelToggle
            label="Noche"
            description="Las estrellas y la Vía Láctea reales sobre este lugar, a la hora elegida."
            on={props.night}
            onChange={props.onNightChange}
          />
          {props.night && (
            <label className="flex items-center gap-2 px-2 pb-1 text-xs text-gray-300">
              Hora
              <input
                type="range"
                min={19}
                max={29}
                step={0.25}
                value={props.hour}
                onChange={(event) => props.onHourChange(Number(event.target.value))}
                className="flex-1 accent-orange-600"
              />
              <output className="w-10 text-right font-mono text-white">{formatHour(props.hour)}</output>
            </label>
          )}
          <PanelToggle
            label="Camanchaca"
            description="La niebla costera que entra desde el Pacífico."
            on={props.fog}
            onChange={props.onFogChange}
          />
          <PanelToggle
            label="Desierto florido"
            description="Pata de guanaco, añañuca y suspiro sobre el suelo descubierto."
            on={props.bloom}
            onChange={props.onBloomChange}
          />

          <div className="px-2 py-1.5">
            <span className="block text-sm font-medium">Sismo</span>
            <span className="block text-xs text-gray-400">
              Los muros capturados, cortados en piedras con física real. Es una demostración: las piedras escaneadas no
              tienen cara posterior.
            </span>
            <div className="mt-2 flex gap-2">
              {props.quake === 'unavailable' ? (
                <span className="text-xs text-gray-400">Esta escena no tiene muros que mover.</span>
              ) : (
                <button
                  onClick={props.onStartQuake}
                  disabled={props.quake === 'preparing'}
                  className="rounded-md bg-orange-600 px-3 py-1 text-xs font-medium transition-colors hover:bg-orange-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {props.quake === 'preparing' ? 'Preparando…' : props.quake === 'shaken' ? 'Otro sismo' : 'Iniciar sismo'}
                </button>
              )}
              {props.quake === 'shaken' && (
                <button
                  onClick={props.onResetQuake}
                  className="rounded-md border border-gray-600 px-3 py-1 text-xs transition-colors hover:border-orange-600"
                >
                  Restaurar
                </button>
              )}
            </div>
          </div>

          <div className="border-t border-gray-700 px-2 pt-2 text-xs font-medium uppercase tracking-wide text-gray-400">
            Gráficos
          </div>
          <PanelToggle
            label="Nubes"
            description="Nubes que pasan con el viento, su sombra sobre los cerros y su reflejo en el mar."
            on={props.graphics.clouds}
            onChange={(on) => props.onGraphicsChange({ clouds: on })}
          />
          <PanelToggle
            label="Luz atmosférica"
            description="El sol en el cielo y la bruma más clara y cálida hacia él."
            on={props.graphics.atmosphere}
            onChange={(on) => props.onGraphicsChange({ atmosphere: on })}
          />
          <PanelToggle
            label="Efecto cine"
            description="Brillos en el mar y la espuma, colores de cámara, bordes oscurecidos y grano fino."
            on={props.graphics.cinema}
            onChange={(on) => props.onGraphicsChange({ cinema: on })}
          />
        </div>
      )}
    </div>
  );
}
