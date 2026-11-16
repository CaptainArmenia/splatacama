/**
 * The scene's graphics settings (the "Gráficos" part of the Efectos panel), remembered in this browser. Storage can be
 * missing or refuse (private windows, blocked site data): the defaults then apply.
 */
export type GraphicsSettings = {
  // Clouds in the sky, their shadows over the land and their reflection in the sea
  clouds: boolean;
  // The sun's disc, and the haze brighter and warmer toward it
  atmosphere: boolean;
  // A camera's last touch over the whole frame (src/utils/cinemaEffect.ts)
  cinema: boolean;
  // Gulls and pelicans flying round the site (src/effects/seabirds.ts)
  birds: boolean;
};

export const DEFAULT_GRAPHICS: GraphicsSettings = { clouds: true, atmosphere: true, cinema: false, birds: true };

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
