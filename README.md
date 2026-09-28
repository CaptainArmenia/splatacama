# Splatacama

An interactive 3D map of archaeological sites on the coast of the Atacama Desert, Chile. Visitors fly over real terrain around the Humboldt Archipelago, click a site's pin, and open a Gaussian splat reconstruction of it (a photorealistic 3D capture) right in the browser.

The current sites are *pircas*: circular dry-stone structures from before the Spanish conquest. The interface is in Spanish.

## How it works

| Route | What it shows |
| --- | --- |
| `/` | CesiumJS globe with world terrain and satellite imagery. Each site is a round pin made from its preview photo. Clicking a pin opens an info panel with a **Ver Escena 3D** ("view 3D scene") button. |
| `/scene/[id]` | Full-screen Gaussian splat viewer (three.js with `@mkkellogg/gaussian-splats-3d`) for that site, plus a back-to-map button and a toggleable info panel. |
| `/api/image-proxy?url=…` | Server route that fetches files from Cloudflare R2 and sends them back with permissive cross-origin headers. Preview images **and** `.splat` files both go through it. |

Site data lives in [src/data/landmarks.json](src/data/landmarks.json). Large assets (the `.splat` files and preview JPEGs) live in a Cloudflare R2 bucket, not in this repo. The app builds each asset URL from `NEXT_PUBLIC_R2_PUBLIC_DOMAIN` and the file name in the JSON.

## Tech stack

- Next.js 15 (App Router) with React 19 and TypeScript (non-strict)
- Tailwind CSS 4
- CesiumJS 1.128 with a Cesium ion account for terrain and imagery
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
pnpm build    # production build
pnpm start    # serve the production build
```

The first `dev` or `build` copies Cesium's static assets (web workers, widgets, imagery) from `node_modules/cesium` into `public/cesium/`. That folder is gitignored and gets rebuilt automatically.

`pnpm lint` does not work at the moment: ESLint isn't installed (it was removed on purpose), so `next build` skips linting too. The project has no test suite.

## Adding or editing a site

1. Upload the `.splat` file and a preview JPEG to the root of the R2 bucket.
2. Add an entry to [src/data/landmarks.json](src/data/landmarks.json):

   ```json
   {
     "id": "pirca14",
     "name": "Pirca",
     "lat": -29.0,
     "lng": -71.5,
     "height": 100,
     "description": "Descripción en español…",
     "gsplatUrl": "pirca14.splat",
     "previewUrl": "pirca14_preview.jpg"
   }
   ```

   - `id` becomes the URL: `/scene/pirca14`.
   - `height` is the pin's altitude in meters.
   - `gsplatUrl` and `previewUrl` are paths inside the bucket. A full `https://` URL also works; R2 URLs still go through the proxy.

Sites close enough that their pins overlap are fine. Clicking a stack of pins opens a list of the sites underneath so you can pick one.

The map currently has four sites. `pirca0` is the original capture, at its original coordinates. `pirca11`–`pirca13` are the three drone captures added in September 2026.

## Project layout

```
src/
  app/
    page.tsx                  map page
    scene/[id]/page.tsx       splat viewer page (looks up the id in landmarks.json)
    api/image-proxy/route.ts  proxy for R2 assets
    layout.tsx                root layout; loads Cesium CSS and base-URL setup
  components/
    MapWithPins.tsx           loads landmarks, sets map center, loads the map on the client only
    CesiumMapComponent.tsx    map UI: pins, hover and selection, panels, controls
    GSplatViewer.tsx          Gaussian splat viewer wrapper
    LandmarkInfoPanel.tsx     info panel on the map
    ToggleableInfoPanel.tsx   info panel on the scene page
    CesiumCompass.tsx, MapControls.tsx, CameraPositionPanel.tsx
  hooks/
    useCesiumViewer.ts        creates the Cesium viewer, terrain, imagery, pins, click/hover handlers
    useCesiumState.ts         preview URLs, camera position readout, pin image cache
  utils/
    blobUtils.ts              getBlobUrl(): turns an asset path into a proxied R2 URL
    cesiumMarkers.ts          draws round pin images on a canvas
    cesiumMarkerManager.ts    updates pin image and scale; resets the camera
    cesiumConfig.js           sets CESIUM_BASE_URL on window
  constants/cesiumConfig.ts   camera, pin, viewer and scene settings
  data/landmarks.json         site list
next.config.js                webpack setup for Cesium, response headers
```

## Configuration notes

- **Map view.** The starting center is `humboldtCenter` in [src/components/MapWithPins.tsx](src/components/MapWithPins.tsx). Camera height, heading, and pitch, plus terrain exaggeration and zoom limits, are in [src/constants/cesiumConfig.ts](src/constants/cesiumConfig.ts).
- **Splat viewer.** Camera start position, up vector, and scene scale are set in [src/components/GSplatViewer.tsx](src/components/GSplatViewer.tsx). WebXR (headset VR) is turned off.
- **Headers.** [next.config.js](next.config.js) sends cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`) and open CORS headers on every route. Several recent commits fixed cross-origin loading problems, so test both pages after changing these.
- **Two Next.js config files.** Next.js reads `next.config.js` first, so the empty `next.config.ts` is ignored.
