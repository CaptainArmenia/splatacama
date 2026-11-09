export interface MapLandmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  height: number;
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
  // Small image for the map pin; the pin falls back to previewUrl if it's missing or fails to load
  thumbnailUrl?: string;
  // Which way is north in the splat scene: the turn tools/ply_to_splat.py gave it (`heading` in the splat pipeline's
  // scenes.json), in degrees. North points along (sin h, 0, cos h) in the viewer's frame and east along
  // (cos h, 0, -sin h). The night sky, the camanchaca's wind and the wind turbines use it.
  heading: number;
  // Metres per splat viewer unit, the site's real size. The splat pipeline scales each site so its main structure is
  // 8 units across, so this is the structure's diameter / 8. VR shows the scene at real size with it, and the effects
  // (flowers, fog, earthquake) are built in metres.
  metersPerUnit: number;
  // How far the splat viewer's camera may go; unset fields use the viewer's defaults
  view?: SceneView;
  // Terrain and sky drawn around the splat, for a splat cropped to the site
  environment?: SceneEnvironment;
}

// Camera limits for one site, in viewer units (the site's main structure spans about 8). The camera may look from
// any angle, but not from too far away or from outside the part of the scene captured in detail.
export interface SceneView {
  // How far the camera may zoom out from the point it orbits
  maxDistance?: number;
  // How far from the site's centre the camera may go, measured on the ground: about where the splat starts to fade
  radius?: number;
}

// Surroundings for a site whose splat covers only the site itself (the photos saw the ground farther out only
// edge-on, so a splat of it is all needles and smears). Built by the splat pipeline's env_build.py, in viewer units.
export interface SceneEnvironment {
  // glTF terrain out to the horizon. Its "terrain_under" nodes lie under the splat: they are drawn without writing
  // depth, so the splat always covers them and they show only through holes. Its materials can carry a tiling detail
  // texture (extras.detail; see addTerrainDetail in sceneEnvironment.ts).
  terrainUrl: string;
  // Equirectangular sky for a sphere around the camera, drawn behind everything
  skyUrl?: string;
  // The haze colour the terrain fades to at the horizon, also drawn behind everything
  background?: string;
  // Camera far plane (viewer units), for terrain reaching the horizon; the default is 1000
  far?: number;
}

// Real wind turbines near a site, drawn by src/utils/windTurbines.ts as a backdrop: each at its true compass direction
// from `origin`, standing on the splat's horizon and scaled to look as big as the real one. src/data/windTurbines.json
// holds them by site id. Positions are from OpenStreetMap (generator:source=wind, fetched 2026-11-02): pirca0 shows
// the Cabo Leones II row in its photo. Pirca 1 and 2 have none within 25 km, and Pirca 3's, 9-25 km north, are hidden
// behind the ridge north of it.
export interface SceneTurbines {
  // [lat, lng] where the scene was captured: bearings and distances to the turbines are measured from here
  origin: number[];
  // Compass bearing the wind blows from; the rotors face it
  windFrom: number;
  // The splat's sky behind the turbines at 0, 4 and 8 degrees above the horizon (CSS colours, measured from renders):
  // blades thinner than a pixel are drawn a little wider and faded toward it
  sky: string[];
  // [lat, lng, hub height in metres, rotor diameter in metres, distance, base elevation] for each turbine. The sizes
  // are a generic 2-3 MW one. Distance (viewer units, from the site centre) and base elevation (degrees above level,
  // seen from the site centre at ground height) are where the splat's horizon is below that turbine, so the two stay
  // together as the camera moves. They're fitted to renders from many camera positions (README, "Wind turbines").
  turbines: number[][];
}

export interface CesiumMapProps {
  landmarks: MapLandmark[];
  selectedLandmark: MapLandmark | null;
  setSelectedLandmark: (landmark: MapLandmark | null) => void;
  setErrorState: (error: string | null) => void;
  showCameraPosition: boolean;
  preventPinOcclusion: boolean;
}

export interface CameraPosition {
  latitude: number;
  longitude: number;
  height: number;
  heading: number;
  pitch: number;
}

export interface PreviewUrlsState {
  urls: { [id: string]: string };     // preview images, for the info panels
  pinUrls: { [id: string]: string };  // thumbnails for pins, or the preview when there's no thumbnail
}