# Splatacama

An interactive 3D map of archaeological sites on the coast of the Atacama Desert, Chile. Visitors fly over real terrain around the Humboldt Archipelago, click a site's pin, and open a Gaussian splat reconstruction of it (a photorealistic 3D capture) right in the browser.

The current sites are *pircas*: circular dry-stone structures from before the Spanish conquest. The interface is in Spanish.

## How it works

| Route | What it shows |
| --- | --- |
| `/` | CesiumJS globe with world terrain and satellite imagery. Each site is a round pin made from its preview photo. Clicking a pin opens an info panel with a **Ver Escena 3D** ("view 3D scene") button. |
| `/scene/[id]` | Full-screen Gaussian splat viewer (three.js with [Spark](https://sparkjs.dev/)) for that site, with a back-to-map button, a toggleable info panel, a wind sound, and an **Efectos** panel: the real night sky over the site, the camanchaca (coastal fog), the desierto florido (flowering desert) and an earthquake. Pirca 1–3 are drawn with the terrain around them out to the horizon. On a VR headset it adds a **Ver en VR** button for walking through the site at real size. |

Site data lives in [src/data/landmarks.json](src/data/landmarks.json). Large assets (the `.splat` files, terrain, skies and preview JPEGs) live in a Cloudflare R2 bucket, not in this repo. The app builds each asset URL from `NEXT_PUBLIC_R2_PUBLIC_DOMAIN` and the file name in the JSON, and the browser downloads them straight from the bucket. Every page is static; there's no server code.

## Tech stack

- Next.js 15 (App Router) with React 19 and TypeScript (strict)
- Tailwind CSS 4
- CesiumJS 1.145 with a Cesium ion account for terrain and imagery
- Spark (`@sparkjsdev/spark`) 2.4 on three.js 0.186, with WebXR for VR headsets
- Rapier (`@dimforge/rapier3d-compat`) for the earthquake's physics, downloaded only when a visitor starts one
- Cloudflare R2 for asset storage
- pnpm for packages; the project is set up to deploy on Vercel

## Getting started

Prerequisites: Node.js 20 or newer and pnpm 9 or newer. The lockfile is pnpm format v9; the build was last checked with Node 26 and pnpm 10.

```bash
pnpm install
```

Create `.env.local` in the repo root:

```bash
# Required. Cesium ion access token (https://ion.cesium.com/tokens).
# Without it the map shows an error instead of loading.
NEXT_PUBLIC_CESIUM_TOKEN=your-cesium-ion-token

# Required for assets. Public host name of the R2 bucket, without https://
# Example: pub-xxxxxxxxxxxxxxxx.r2.dev
NEXT_PUBLIC_R2_PUBLIC_DOMAIN=your-bucket-public-domain
```

Both variables start with `NEXT_PUBLIC_`, so their values are bundled into the client JavaScript. Don't put anything secret in them.

Then:

```bash
pnpm dev      # dev server at http://localhost:3000
pnpm build    # production build (also type-checks and lints)
pnpm start    # serve the production build
pnpm lint     # ESLint
pnpm test     # unit tests (Vitest)
pnpm typecheck
```

The first `dev` or `build` copies Cesium's static assets (web workers, widgets, imagery) from `node_modules/cesium` into `public/cesium/`. That folder is gitignored and gets rebuilt automatically.

The unit tests cover asset URLs, pin clustering, and the site data (`landmarks.json`, `windTurbines.json`): unique ids, coordinates in Chile, sizes and camera limits, and asset paths inside the bucket. They don't drive the map or the splat viewer. Before deploying a change that touches the map, check it with `pnpm build && pnpm start`: the dev server doesn't minify, and minifier problems only show up in production builds.

## Adding or editing a site

The `.splat` files, terrain and skies come from the splat pipeline, which lives outside this repo (`~/datasets/pircas-work` on the machine that built the scenes; its README covers every step). For a drone capture it writes three files per site: `<id>_center.splat` (the splat, cropped to the site), `<id>_terrain.glb` and `<id>_sky.jpg`, and prints the values for `landmarks.json`.

1. Upload the scene files, a preview JPEG and a small square thumbnail (about 160 px) to the root of the R2 bucket.
2. Add an entry to [src/data/landmarks.json](src/data/landmarks.json):

   ```json
   {
     "id": "pirca14",
     "name": "Pirca",
     "lat": -29.0,
     "lng": -71.5,
     "height": 30,
     "heading": 54.5,
     "metersPerUnit": 1.625,
     "description": "Descripción en español…",
     "gsplatUrl": "pirca14_center.splat",
     "previewUrl": "pirca14_preview.jpg",
     "thumbnailUrl": "pirca14_thumb.jpg",
     "view": { "maxDistance": 11, "radius": 14.8 },
     "environment": {
       "terrainUrl": "pirca14_terrain.glb",
       "skyUrl": "pirca14_sky.jpg",
       "background": "#b4c5d2",
       "far": 20000
     }
   }
   ```

   - `id` becomes the URL: `/scene/pirca14`.
   - `height` is how far above the ground the pin floats, in meters (30 works well).
   - `heading` says which way is north in the scene: it's the turn the pipeline gave the scene (`heading` in its `scenes.json`). The night sky, the camanchaca's wind and the wind turbines need it.
   - `metersPerUnit` is the site's real size: meters per splat viewer unit. The pipeline scales each site so its main structure is 8 units across, so this is the structure's diameter in meters divided by 8. VR and the effects need it.
   - `view` limits the camera, in viewer units: `maxDistance` is how far it may zoom out, and `radius` how far from the site's centre it may go (the pipeline prints it: where the cropped splat starts to fade). Without it the viewer uses 14 and 14.
   - `environment` is the terrain and sky around a cropped splat; `background` is the haze colour the pipeline prints. Leave it out for a splat that isn't cropped.
   - `gsplatUrl`, `previewUrl`, `thumbnailUrl` and the environment's URLs are paths inside the bucket. The app also accepts a full URL, which is handy for testing a local file, but `pnpm test` rejects one in a committed site.
   - `previewUrl` is shown in the info panels. `thumbnailUrl` is drawn on the map pin; if it's missing or fails to load, the pin uses the preview.

Sites close enough that their pins overlap are fine. Overlapping pins merge into one marker showing how many sites are there. Clicking it fans the pins out around the location, and clicking empty map folds them back.

The map currently has four sites, each a splat cropped to the site with terrain out to 25 km. `pirca0` is the original capture, a phone capture of which only the trained splat and one photo are left; its terrain was made from the splat and the elevation data alone (the pipeline's `splat_ground_cache.py`), and real wind turbines (Cabo Leones II) stand on it ([src/data/windTurbines.json](src/data/windTurbines.json)). `pirca11`–`pirca13` are the three drone captures added in September 2026.

To try scene files before uploading them, put them in `public/local-splats/` (gitignored) and point a site's URLs at `http://localhost:<port>/local-splats/<file>` without committing that. Files in the bucket only load on `http://localhost:3000` (see the CORS note below).

### People

A site can have people walking it: `npcs` in its `landmarks.json` entry, each with a `name`, a `model` (a `.glb` in the bucket) and the `walkSpeed` of the model's walk animation (metres a second at its own speed). [src/effects/npc.ts](src/effects/npc.ts) finds the ground she can walk (open, gently sloping, clear of the walls and bushes the site analysis found, on the splat's own ground) and has her wander it: to a spot, often by the walls, at her own unhurried pace, then standing a while to look around, mostly at the site or the visitor. The walk's playback follows her speed, so her feet don't slide.

The characters are inspired by members of the Chango families of these sites, with their OK; pirca0 has Doña Estermila Álvarez Hidalgo, the families' matriarch, close to 90. They're built outside the repo, in `~/datasets/pircas-work/npc/` (its README): a MakeHuman body and clothes in Blender, and CMU motion capture moved onto it.

### Wind turbines

[src/data/windTurbines.json](src/data/windTurbines.json) lists the real turbines around a site, and [src/utils/windTurbines.ts](src/utils/windTurbines.ts) draws them with turning rotors, each at its true compass bearing and scaled to look as big as the real one. pirca0 has all 295 within 20 km, in seven farms. The pipeline's `tools/turbines/osm_turbines.py` writes them from OpenStreetMap, with each farm's hub height and rotor diameter, which OpenStreetMap rarely has (the script lists them and their sources; one group of 24 near the site matches no farm found, and is drawn as the area's most common model). Each entry ends with a distance and a base elevation, which place it:

- **On a site with terrain** (pirca0), the turbines stand on the terrain at their real distances, and its hills hide their bases as the real ridge does in pirca0's photo. The pipeline writes the two numbers from the same terrain: `env_build.py <id> <out> --turbines <this repo>/src/data/windTurbines.json`. Re-run it whenever the terrain is rebuilt.
- **On a full splat without terrain**, they're a backdrop drawn much nearer than they are, standing where the splat's ground meets the sky below each of them; anywhere else they'd float above the horizon when the camera rises. A splat's far ground is a soft smear, so those numbers are fitted to renders from about 30 camera positions, with the scripts in `~/datasets/pircas-work/tools/turbines/`.

`sky` holds the sky colours behind the turbines, measured from renders; blades thinner than a pixel are faded toward them.

`windFrom` sets which way the rotors face. For pirca0 it's 200°, which shows the rotors almost side-on from the site, as in its photo.

## Project layout

```
src/
  app/
    page.tsx                  map page
    scene/[id]/page.tsx       splat viewer page (looks up the id in landmarks.json)
    layout.tsx                root layout; loads Cesium's CSS
    not-found.tsx             404 page
  components/
    MapWithPins.tsx           loads the map on the client only
    CesiumMapComponent.tsx    map UI: pins, hover and selection, panels, controls
    GSplatViewer.tsx          splat viewer (Spark): loading, terrain, camera limits, effects panel, sound, VR button
    SceneEffectsPanel.tsx     the "Efectos" panel: night, camanchaca, desierto florido, earthquake
    SceneSound.tsx            the sound button and its panel: wind and turbines, each on or off
    PanelToggle.tsx           the on/off switch both panels use
    LandmarkInfoPanel.tsx     info panel on the map
    ToggleableInfoPanel.tsx   info panel on the scene page
    LandmarkDetails.tsx       what both info panels show: photo, name, description
    CesiumCompass.tsx, MapControls.tsx, CameraPositionPanel.tsx
  effects/                    the scene effects, built from the splat when a scene loads
    siteAnalysis.ts           reads ground, walls and bushes off the splats
    sceneEffects.ts           turns effects on and off across the splat, terrain, sky and turbines
    nightSky.ts, camanchaca.ts, desertBloom.ts, earthquake.ts
    npc.ts                    people who walk a site: finds the walkable ground, wanders, walks and idles
  hooks/
    useCesiumViewer.ts        creates and destroys the Cesium viewer: imagery, terrain, pins, click/hover handlers
    useCesiumState.ts         preview URLs, camera position readout
  utils/
    assetUrl.ts               assetUrl(): bucket paths to R2 URLs
    cesiumMarkers.ts          draws round pin images on a canvas
    cesiumMarkerManager.ts    updates pin image and scale; resets the camera
    cesiumPinClusters.ts      merges overlapping pins into clusters and fans them out on click
    sceneEnvironment.ts       terrain and sky around a cropped splat, with the terrain's detail texture
    meshAntialias.ts          smooths the meshes' edges (FXAA) without touching the splats
    windTurbines.ts           real wind turbines on a scene's terrain or backdrop, with turning rotors
    sceneSound.ts             the scene's sound (Web Audio): each sound on or off, start on the first click, listener follows the camera
    windAmbience.ts           wind made from noise, in gusts (no recording)
    turbineSound.ts           the nearest wind turbines' whine and blade swish, each from where it stands
    walkArea.ts               where a visitor can walk in VR: ground height, walls and bushes, edge of the detailed area
    vrWalk.ts                 the VR session: walking and turning with the controllers, kept inside the walk area
  constants/cesiumConfig.ts   camera, pin, viewer and scene settings
  data/landmarks.json         site list
  data/windTurbines.json      wind turbines near the sites, by site id
public/data/stars.json        the star catalogue for the night sky
next.config.js                webpack setup for Cesium
```

## Configuration notes

- **Map view.** The starting point, camera height, heading and pitch, terrain exaggeration, zoom limits, and pin and cluster sizes are all in [src/constants/cesiumConfig.ts](src/constants/cesiumConfig.ts).
- **Splat viewer.** Camera start position, up vector, scene scale and the default camera limits are set in [src/components/GSplatViewer.tsx](src/components/GSplatViewer.tsx). The camera can look from any angle, but it can't zoom out past the site's `maxDistance`, leave the circle of its `radius`, or go below a standing visitor's eye height.
- **Effects.** Colours, fog distances, the flowers' opening time and the earthquake's strength are at the top of [src/effects/sceneEffects.ts](src/effects/sceneEffects.ts). The night sky uses today's date at the chosen hour, in Chile's summer time (UTC-3).
- **VR.** Headsets (and computers with one attached) get a **Ver en VR** button. The left stick walks where you look, the right stick turns in 30° steps, and walking around the room works too. Visitors stay on the ground and can't walk through walls or bushes or past the well-captured part of the scene; all of that is read off the splats when the scene loads ([src/utils/walkArea.ts](src/utils/walkArea.ts), tuned in `WALK_CONFIG`). Speed, turning and headset rendering settings are in `VR_CONFIG` in [src/utils/vrWalk.ts](src/utils/vrWalk.ts). Phones don't get VR.
- **Credits.** Scenes show credits their data's licences ask for: OpenStreetMap for the wind turbines, Copernicus (elevation data and Sentinel-2 imagery) for the terrain, and the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, created with funding from NSF EIA-0196217) for the people's movement. The people's bodies and clothes are MakeHuman's, public domain (CC0). The sound is made in the browser, with no recordings; the star catalogue is d3-celestial's `stars.6.json`.
- **Rendering.** The map only redraws when something changes, to save battery. Code that changes pins or other map entities must call `viewer.scene.requestRender()`.
- **R2 bucket.** The browser loads assets straight from the bucket, so its CORS rule must allow `GET` from every origin the site runs on. It lists `https://splatacama.vercel.app` and `http://localhost:3000`. Vercel preview deployments and other local ports aren't on the list, so their pin photos fall back to orange markers and scenes fail to load until they're added.
