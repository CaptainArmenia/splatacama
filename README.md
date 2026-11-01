# Splatacama

An interactive 3D map of archaeological sites on the coast of the Atacama Desert, Chile. Visitors fly over real terrain around the Humboldt Archipelago, click a site's pin, and open a Gaussian splat reconstruction of it (a photorealistic 3D capture) right in the browser.

The current sites are *pircas*: circular dry-stone structures from before the Spanish conquest. The interface is in Spanish.

## How it works

| Route | What it shows |
| --- | --- |
| `/` | CesiumJS globe with world terrain and satellite imagery. Each site is a round pin made from its preview photo. Clicking a pin opens an info panel with a **Ver Escena 3D** ("view 3D scene") button. |
| `/scene/[id]` | Full-screen Gaussian splat viewer (three.js with `@mkkellogg/gaussian-splats-3d`) for that site, plus a back-to-map button and a toggleable info panel. |

Site data lives in [src/data/landmarks.json](src/data/landmarks.json). Large assets (the `.splat` files and preview JPEGs) live in a Cloudflare R2 bucket, not in this repo. The app builds each asset URL from `NEXT_PUBLIC_R2_PUBLIC_DOMAIN` and the file name in the JSON, and the browser downloads them straight from the bucket. Every page is static; there's no server code.

## Tech stack

- Next.js 15 (App Router) with React 19 and TypeScript (strict)
- Tailwind CSS 4
- CesiumJS 1.145 with a Cesium ion account for terrain and imagery
- `@mkkellogg/gaussian-splats-3d` 0.4 on three.js 0.176
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

The unit tests cover asset URLs, pin clustering, and the site list (`landmarks.json`): unique ids, coordinates in Chile, and asset paths inside the bucket. They don't drive the map or the splat viewer. Before deploying a change that touches the map, check it with `pnpm build && pnpm start`: the dev server doesn't minify, and minifier problems only show up in production builds.

## Adding or editing a site

1. Upload the `.splat` file, a preview JPEG and a small square thumbnail (about 160 px) to the root of the R2 bucket.
2. Add an entry to [src/data/landmarks.json](src/data/landmarks.json):

   ```json
   {
     "id": "pirca14",
     "name": "Pirca",
     "lat": -29.0,
     "lng": -71.5,
     "height": 30,
     "description": "Descripción en español…",
     "gsplatUrl": "pirca14.splat",
     "previewUrl": "pirca14_preview.jpg",
     "thumbnailUrl": "pirca14_thumb.jpg"
   }
   ```

   - `id` becomes the URL: `/scene/pirca14`.
   - `height` is how far above the ground the pin floats, in meters (30 works well).
   - `gsplatUrl`, `previewUrl` and `thumbnailUrl` are paths inside the bucket. The app also accepts a full URL, which is handy for testing a local file, but `pnpm test` rejects one in a committed site.
   - `previewUrl` is shown in the info panels. `thumbnailUrl` is drawn on the map pin; if it's missing or fails to load, the pin uses the preview.

Sites close enough that their pins overlap are fine. Overlapping pins merge into one marker showing how many sites are there. Clicking it fans the pins out around the location, and clicking empty map folds them back.

The map currently has four sites. `pirca0` is the original capture, at its original coordinates. `pirca11`–`pirca13` are the three drone captures added in September 2026.

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
    GSplatViewer.tsx          Gaussian splat viewer wrapper
    LandmarkInfoPanel.tsx     info panel on the map
    ToggleableInfoPanel.tsx   info panel on the scene page
    LandmarkDetails.tsx       what both info panels show: photo, name, description
    CesiumCompass.tsx, MapControls.tsx, CameraPositionPanel.tsx
  hooks/
    useCesiumViewer.ts        creates and destroys the Cesium viewer: imagery, terrain, pins, click/hover handlers
    useCesiumState.ts         preview URLs, camera position readout
  utils/
    assetUrl.ts               assetUrl(): bucket paths to R2 URLs
    cesiumMarkers.ts          draws round pin images on a canvas
    cesiumMarkerManager.ts    updates pin image and scale; resets the camera
    cesiumPinClusters.ts      merges overlapping pins into clusters and fans them out on click
  constants/cesiumConfig.ts   camera, pin, viewer and scene settings
  data/landmarks.json         site list
next.config.js                webpack setup for Cesium
```

## Configuration notes

- **Map view.** The starting point, camera height, heading and pitch, terrain exaggeration, zoom limits, and pin and cluster sizes are all in [src/constants/cesiumConfig.ts](src/constants/cesiumConfig.ts).
- **Splat viewer.** Camera start position, up vector, and scene scale are set in [src/components/GSplatViewer.tsx](src/components/GSplatViewer.tsx). WebXR (headset VR) is turned off.
- **Rendering.** The map only redraws when something changes, to save battery. Code that changes pins or other map entities must call `viewer.scene.requestRender()`.
- **R2 bucket.** The browser loads assets straight from the bucket, so its CORS rule must allow `GET` from every origin the site runs on. It lists `https://splatacama.vercel.app` and `http://localhost:3000`. Vercel preview deployments and other local ports aren't on the list, so their pin photos fall back to orange markers and scenes fail to load until they're added.
