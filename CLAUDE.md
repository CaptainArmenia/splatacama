# CLAUDE.md

Splatacama is a Next.js 15 app (App Router, React 19, Tailwind 4) that shows archaeological sites in the Atacama Desert on a CesiumJS 3D globe. Each site opens a Gaussian splat viewer (`@mkkellogg/gaussian-splats-3d` on three.js). See [README.md](README.md) for setup, environment variables, and the file layout.

## Commands

- `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm lint`. Use pnpm; the lockfile is pnpm v9 format.
- `pnpm lint` runs ESLint and should report 0 problems. `pnpm build` type-checks and lints too, so a lint error fails the Vercel deploy. `tsconfig.json` still has `strict: false`, and there are no tests.
- After changing anything the map loads, test a **production** build (`pnpm build && pnpm start`), not only `pnpm dev`: the dev server doesn't minify, and one minifier bug has already broken production only (see the SPZ gotcha below).
- Runtime needs `NEXT_PUBLIC_CESIUM_TOKEN` and `NEXT_PUBLIC_R2_PUBLIC_DOMAIN` in `.env.local`. Without the Cesium token the map shows an error instead of loading.
- Vercel refuses to deploy Next.js versions with known critical advisories. Keep Next.js patched.

## Architecture in brief

- **Data:** [src/data/landmarks.json](src/data/landmarks.json) is the only site list, imported statically by the map and by the scene page. The scene pages are prebuilt with `generateStaticParams`; unknown ids return a 404.
- **Assets:** `.splat` files, preview JPEGs and pin thumbnails live in Cloudflare R2. `getBlobUrl()` in [src/utils/blobUtils.ts](src/utils/blobUtils.ts) turns a bucket path into `/api/image-proxy?url=https://<R2 domain>/<path>`. The proxy ([route.ts](src/app/api/image-proxy/route.ts)) streams the file and only accepts URLs that pass `isR2AssetUrl()`: https, with an exact host match. Both sides use that one function.
- **Map:** `MapWithPins` loads `CesiumMapComponent` with `ssr: false`. `useCesiumViewer` builds the viewer with ArcGIS World Imagery and Cesium World Terrain selected in the constructor, one billboard entity per landmark, pin clustering, and click and hover handlers. The effect returns a teardown that destroys all of it. Pin images are canvases (a round crop of `thumbnailUrl`, falling back to `previewUrl`, then an orange circle) cached under `${id}_img` or `${id}_fallback`.
- **Map to scene:** the "Ver Escena 3D" button does a full page load (`window.location.href`), not client-side routing.
- **Splat viewer:** [src/components/GSplatViewer.tsx](src/components/GSplatViewer.tsx) creates the viewer in a container React doesn't manage, and disposes it with the library's `dispose()`. The scene is y-down (`cameraUp: [0, -1, 0]`), scaled 10×, and loaded with an explicit `format: SceneFormat.Splat`. WebXR is off, and GPU sorting and shared-memory workers are disabled. The library's own loading box is turned off (`addSplatScenes(scenes, false, onProgress)`); the component draws its own Spanish progress panel from `onProgress`. Camera limits keep visitors where the scene looks right: zoom range, height range and a small pan area, per site from the optional `view` field in `landmarks.json` (type `ViewLimits`), falling back to `DEFAULT_VIEW_LIMITS`. A site whose ground-level photos cover only part of the orbit can set `lowViewArc`: outside it the camera is drawn raised, and it comes back down when it orbits back. The limits were picked from renders at the extremes; re-check them when a site's `.splat` is replaced. The library's click-to-recentre and debug keys are turned off.

## Gotchas

- **Keep webpack, not Turbopack.** [next.config.js](next.config.js) aliases `cesium` to its package path (a pnpm workaround), defines `CESIUM_BASE_URL=/cesium` (the only place it's set), and copies Cesium's Workers, ThirdParty, Assets and Widgets folders into `public/cesium/` (gitignored). `next dev --turbopack` would skip all of that and break Cesium.
- **SPZ loader alias.** Cesium 1.145 depends on `@spz-loader/core`, whose embedded WebAssembly is turned into invalid JavaScript by the production minifier, so Cesium fails to load. `next.config.js` aliases it to `false`. Keep that alias unless a later Cesium or Next.js fixes it; check with a production build.
- **The map only redraws on request.** `VIEWER_CONFIG.requestRenderMode` is on. Camera moves and tile loads trigger redraws automatically, but entity changes don't. Any code that changes pins, clusters or other entities must call `viewer.scene.requestRender()`, or the change won't show until the camera moves.
- **Cesium runs in the browser only.** Anything that touches `cesium` or `window` must stay behind the `ssr: false` dynamic import or inside `useEffect`.
- **Pin heights are relative to the ground.** Pins, cluster markers and the explode dot use `HeightReference.RELATIVE_TO_GROUND`, and `height` in `landmarks.json` is meters above the ground. Terrain is exaggerated 1.5× (`SCENE_CONFIG.verticalExaggeration`); absolute heights put pins underground.
- **Overlapping pins.** `pirca11` and `pirca12` are 30 m apart, so their pins stack at almost every zoom level. [src/utils/cesiumPinClusters.ts](src/utils/cesiumPinClusters.ts) groups pins closer than `MARKER_CONFIG.clusterDistance` on screen, every frame. Each group gets a cluster entity with id `cluster:<ids>`, drawn as a stack of its pins' images plus a count badge (`createClusterMarker`). Clicking one fans its pins out with `billboard.pixelOffset`. Use `pinClusters.getClusterMembers(entity)` to recognize a picked cluster.
- **Don't switch back to Cesium's `EntityCluster`.** It deletes and recreates cluster markers on every camera change, and their images reload asynchronously, so clusters blinked out while zooming. For the same reason, pins under a cluster are shrunk to width 0 instead of `show = false`, and a dissolving cluster's marker is removed one frame after its pins reappear. A probe that zooms the map and counts frames where a site isn't drawn lives outside the repo, at `~/datasets/pircas-work/viewer-test/zoom_probe.py` on the machine that built the splats. It should report 0.
- **Render resolution.** `setupViewerSettings` turns off `useBrowserRecommendedResolution` and caps rendering at 2× device pixels. Marker canvases are drawn at `MARKER_CONFIG.textureScale` so they match. Together these fix blurry, jagged pins on high-density screens, at some GPU cost.
- **Default view.** The start camera (`DEFAULT_CAMERA_CONFIG.center`, looking northeast) doesn't show `pirca11` and `pirca12`, which are about 16 km southeast.

## Known issues

[AUDIT.md](AUDIT.md) tracks the audit from 2026-09-27. Most items are fixed. The ones still open need something outside the code: a CORS rule on the R2 bucket so the proxy can go (#3), uploading the pin thumbnails (#11), revoking an old Cesium ion token (#17), and tests plus strict TypeScript (#20).

## Conventions

- Text users see is in Spanish (for example "Volver al mapa", "Cargando mapa 3D..."). Code, comments, and identifiers are in English.
- Styling is Tailwind 4 utility classes inline. Use the slash syntax for opacity (`bg-gray-900/90`); the Tailwind 3 `bg-opacity-*` utilities don't exist here. UI panels use dark gray with orange accents (`bg-gray-900/90`, `orange-600`).
- Import from `src/` with the `@/` alias.
- Cesium and viewer objects are typed `any` throughout, and ESLint's `no-explicit-any` is off for that reason. Match that instead of adding partial typings.
