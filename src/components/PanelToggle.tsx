'use client';

/** A labelled on/off switch, for the scene's panels (effects, sound) */
export default function PanelToggle({ label, description, on, onChange }: {
  label: string;
  description: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-gray-400">{description}</span>
      </span>
      <span
        className={`mt-0.5 flex h-5 w-9 flex-shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-orange-600' : 'bg-gray-600'}`}
        aria-hidden="true"
      >
        <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  );
}
