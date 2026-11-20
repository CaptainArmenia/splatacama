export interface MapLandmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  height: number;
  description: string;
  gsplatUrl: string;
  // A lighter version of the scene (fewer splats, a smaller file) that phones, tablets and headsets load instead:
  // their GPUs and connections can't take the full one
  gsplatLightUrl?: string;
  previewUrl?: string;
  // Small image for the map pin; the pin falls back to previewUrl if it's missing or fails to load
  thumbnailUrl?: string;
  // Which way is north in the splat scene: the turn tools/ply_to_splat.py gave it (`heading` in the splat pipeline's
  // scenes.json), in degrees. North points along (sin h, 0, cos h) in the viewer's frame and east along
  // (cos h, 0, -sin h). The night sky, the camanchaca's wind and the wind turbines use it.
  heading: number;
  // Metres per splat viewer unit, the site's real size. The splat pipeline scales each site so its main structure is
  // 8 units across, so this is the structure's diameter / 8. VR shows the scene at real size with it, and the effects
  // (fog, night sky, people) are built in metres.
  metersPerUnit: number;
  // The sun of the site's photos, for the shadows of its people and of the plants around it
  sun?: SiteSun;
  // How far the splat viewer's camera may go; unset fields use the viewer's defaults
  view?: SceneView;
  // Terrain and sky drawn around the splat, for a splat cropped to the site
  environment?: SceneEnvironment;
  // People who walk the site (src/effects/npc.ts)
  npcs?: SceneNpc[];
  // The drone's 360 degree photo of the site, to compare with the reconstruction (src/utils/panoView.ts)
  pano?: ScenePano;
  // Where every photo the site was reconstructed from was taken: a JSON file in the R2 bucket, written by the
  // pipeline's site_cameras.py in the viewer's frame (see src/utils/photoPoses.ts for its layout)
  photoPosesUrl?: string;
  // Other versions of the scene to compare with it in the viewer (a switch appears when there are any)
  variants?: SceneVariant[];
  // Draw the splat with the trainer's blur instead of the renderer's anti-aliased one (see GSplatViewer.tsx): for
  // models that come out washed otherwise. Check a site in the app both ways (?blur=plain, ?blur=aa) before setting it.
  plainBlur?: boolean;
  // The same for the gsplatLightUrl scene, when it is an older model that needs the other blur. Defaults to plainBlur.
  lightPlainBlur?: boolean;
}

// Another version of a site's scene: a splat that carries its own surroundings, shown without the terrain mesh, the
// sky and the plants. In the same frame and scale as the site's own splat.
export interface SceneVariant {
  // Used in the code only; "site" is taken by the scene itself
  id: string;
  // What its button says, and a line explaining it
  label: string;
  description?: string;
  // The splat, in the R2 bucket
  splatUrl: string;
}

// A 360 degree photo taken at a site and registered in its reconstruction by the splat pipeline (pano_register.py
// finds where it was taken and how it is turned; pano_site.py writes this entry).
export interface ScenePano {
  // Equirectangular image in the R2 bucket, 8192 pixels wide
  url: string;
  // The same at 4096 pixels, for phones
  smallUrl?: string;
  // Where it was taken, in the viewer's frame and units
  position: number[];
  // The turn (x, y, z, w) from the photo's frame to the viewer's. The photo's frame is a camera's looking at the
  // image centre: x right, y up, z back.
  quaternion: number[];
  // How far each pixel of the photo is, for showing it with depth ("Foto 3D")
  depth?: PanoDepth;
}

// A 360 photo's depth map: estimated from the photo alone by a depth model (Depth Any Panoramas) and scaled to the
// site's reconstruction by the pipeline's pano_depth_fit.py.
export interface PanoDepth {
  // PNG in the R2 bucket, equirectangular like the photo. Each pixel holds 16 bits in its red (high) and green (low)
  // bytes: the distance is near * (far / near) ^ (value / 65535) metres, and 65535 is the sky.
  url: string;
  near: number;
  far: number;
  // How far the camera may move from the photo's viewpoint, in metres: about half the distance to the nearest thing
  // in the photo. Farther, the gaps behind things (which one photo can't fill) open too wide.
  reach: number;
}

// Where the sun stood when a site was photographed: its compass bearing and its elevation, in degrees (the splat
// pipeline's sun_position.py works them out from the photos' time and place), and how hard its shadows were: 1 under
// a clear sky (the default), toward 0 under cloud.
export interface SiteSun {
  bearing: number;
  elevation: number;
  shadows?: number;
}

// A person who walks a site: a rigged glTF character with "walk" and "idle" animations, made by the pipeline's npc
// tools (outside the repo). Inspired by real people of the Chango families of these sites, with their OK.
export interface SceneNpc {
  name: string;
  // Path in the R2 bucket
  model: string;
  // How fast the walk animation moves at its own speed (metres a second): the app plays it faster or slower to keep
  // her feet in step with how fast she goes
  walkSpeed: number;
  // How fast she walks (metres a second; npc.ts has a default)
  pace?: number;
}

// Camera limits for one site, in viewer units (the site's main structure spans about 8). The camera may look from
// any angle, but not from too far away or from outside the part of the scene captured in detail.
export interface SceneView {
  // How far the camera may zoom out from the point it orbits
  maxDistance?: number;
  // How far from the site's centre the camera may go, measured on the ground: about where the splat starts to fade
  radius?: number;
  // Where the start camera (and the reset button's) looks down from, in degrees above the horizon, for a site
  // photographed only from high up: it opens on the view that holds up best. Only a starting view: the camera is
  // never limited in angle, only in distance and to staying above the ground (the user's rule).
  startElevation?: number;
  // false: no VR button. For sites photographed from high up or from one side only, where walking at eye level
  // would go through blur and needles.
  vr?: boolean;
  // How close the camera may zoom in to the point it orbits (the default is 1)
  minDistance?: number;
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
  // The site's plants for the land around it: a JSON file naming their atlas image, which lies next to it, and each
  // kind's size (see src/effects/scrub.ts; the pipeline's scrub_atlas.py cuts them out of the site's photos)
  scrubUrl?: string;
  // How far the plants stand as cut-out cards: metres per metre of a plant's size (the default is 130: a 1.3 m shrub
  // to about 110 m). Lower for an atlas cut from the drone's oblique shots (the second batch's), whose plants are
  // flat ovals that read as stickers on the slopes.
  scrubReach?: number;
  // How much the terrain's brightest sand is tinted a warm sand colour, 0 to 1 (the default is 0.15). High where far
  // dunes came out a bluish white that read as snow (the second batch); low where the site's own sand is as pale
  // and the land must meet the splat's.
  paleSand?: number;
  // The haze colour the terrain fades to at the horizon, also drawn behind everything
  background?: string;
  // Camera far plane (viewer units), for terrain reaching the horizon; the default is 1000
  far?: number;
}

// Real wind turbines near a site, drawn by src/utils/windTurbines.ts: each at its true compass direction from `origin`,
// scaled to look as big as the real one. On a site with terrain they stand on it at their real distances; without,
// they're a backdrop on the splat's horizon. src/data/windTurbines.json holds them by site id. pirca0 has every turbine
// within 20 km in OpenStreetMap (fetched 2026-11-09; the pipeline's tools/turbines/osm_turbines.py writes them): seven
// farms, the nearest 530 m away, and Cabo Leones II's row in its photo. Pirca 1 and 2 have none within 25 km, and
// Pirca 3's, 9-25 km north, are hidden behind the ridge north of it.
export interface SceneTurbines {
  // [lat, lng] where the scene was captured: bearings and distances to the turbines are measured from here
  origin: number[];
  // Compass bearing the wind blows from; the rotors face it
  windFrom: number;
  // The sky behind the turbines at 0, 4 and 8 degrees above the horizon (CSS colours, measured from renders): blades
  // thinner than a pixel are drawn a little wider and faded toward it
  sky: string[];
  // [lat, lng, hub height in metres, rotor diameter in metres, distance, base elevation] for each turbine. The sizes
  // are its wind farm's model (osm_turbines.py lists them and their sources). Distance (viewer units, from the site centre) and base elevation (degrees above level,
  // seen from the site centre at ground height) place its base: on a site with terrain, where the terrain is under the
  // turbine (the pipeline's env_build.py --turbines writes them); without, where the splat's horizon is below it, so
  // the two stay together as the camera moves, fitted to renders from many camera positions (README, "Wind turbines").
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