/**
 * The scene's graphics settings (the "Gráficos" part of the Efectos panel), remembered in this browser. Storage can be
 * missing or refuse (private windows, blocked site data): the defaults then apply.
 */
export type GraphicsSettings = {
  // Clouds in the sky, their shadows over the land and their reflection in the sea
  clouds: boolean;
  // The sun's disc, and the haze brighter and warmer toward it
  atmosphere: boolean;
  // Gulls and pelicans flying round the site (src/effects/seabirds.ts)
  birds: boolean;
  // A light camanchaca, always about (src/effects/camanchaca.ts FOG_WISPS, and mist banks on the terrain)
  mist: boolean;
  // For computers: clouds with depth, lit by the sun, and their shadows crossing the site (sceneEnvironment.ts
  // SKY_VOLUME_GLSL). Costs several times the sky's usual work, so it is off unless asked for, and never on in VR.
  quality: boolean;
};

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  clouds: true, atmosphere: true, birds: true, mist: true, quality: false,
};

const KEY = 'splatacama.graphics';

export function loadGraphics(): GraphicsSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    const settings = { ...DEFAULT_GRAPHICS };
    for (const name of Object.keys(DEFAULT_GRAPHICS) as (keyof GraphicsSettings)[]) {
      if (typeof stored?.[name] === 'boolean') settings[name] = stored[name];
    }
    return settings;
  } catch {
    return { ...DEFAULT_GRAPHICS };
  }
}

export function saveGraphics(settings: GraphicsSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered; the setting still applies now
  }
}
