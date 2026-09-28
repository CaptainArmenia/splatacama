# CLAUDE.md

Splatacama is a Next.js 15 app (App Router, React 19, Tailwind 4) that shows archaeological sites in the Atacama Desert on a CesiumJS 3D globe. Each site opens a Gaussian splat viewer (`@mkkellogg/gaussian-splats-3d` on three.js). See [README.md](README.md) for setup, environment variables, and the file layout.

## Commands

- `pnpm dev`, `pnpm build`, `pnpm start`. Use pnpm; the lockfile is pnpm v9 format.
- `pnpm build` is the only automated check. It type-checks, but `tsconfig.json` has `strict: false`.
- `pnpm lint` fails because ESLint was removed from the dependencies (commit 7201b1c). There are no tests.
- Runtime needs `NEXT_PUBLIC_CESIUM_TOKEN` and `NEXT_PUBLIC_R2_PUBLIC_DOMAIN` in `.env.local`. Without the Cesium token the map shows an error instead of loading.

## Architecture in brief

- **Data:** [src/data/landmarks.json](src/data/landmarks.json) is the only site list. The map page loads it with a client-side dynamic import; the scene page imports it on the server and finds the entry by `id`.
- **Assets:** `.splat` files and preview JPEGs live in Cloudflare R2. `getBlobUrl()` in [src/utils/blobUtils.ts](src/utils/blobUtils.ts) turns a bucket path into `/api/image-proxy?url=https://<R2 domain>/<path>`. Despite its name, [src/app/api/image-proxy/route.ts](src/app/api/image-proxy/route.ts) serves the splat files as well as the images, and it loads each file fully into memory before responding.
- **Map:** `MapWithPins` loads `CesiumMapComponent` with `ssr: false`. `useCesiumViewer` builds the viewer: world terrain, Cesium ion imagery asset 3954, then switches the base layer picker to ArcGIS World Imagery after a timeout. It also adds one billboard entity per landmark and sets up click and hover picking. Pin images are drawn on a canvas (a round crop of the preview, or an orange fallback circle) and cached under keys like `${id}_img` or `${id}_fallback`.
- **Map to scene:** the "Ver Escena 3D" button does a full page load (`window.location.href`), not client-side routing.
- **Splat viewer:** [src/components/GSplatViewer.tsx](src/components/GSplatViewer.tsx) creates the viewer in a container that React doesn't manage and tears it down by hand on unmount. The scene is y-down (`cameraUp: [0, -1, 0]`) and scaled 10×. WebXR is off, and GPU sorting and shared-memory workers are disabled.

## Gotchas

- **Keep webpack, not Turbopack.** [next.config.js](next.config.js) aliases `cesium` to its package path (a pnpm workaround), defines `CESIUM_BASE_URL=/cesium`, and copies Cesium's Workers, ThirdParty, Assets, and Widgets folders into `public/cesium/` (gitignored). `next dev --turbopack` would skip all of that and break Cesium.
- **`next.config.ts` does nothing.** Next.js loads `next.config.js` first. Edit the `.js` file.
- **Cesium runs in the browser only.** Anything that touches `cesium` or `window` must stay behind the `ssr: false` dynamic import or inside `useEffect`.
- **Cross-origin headers are fragile.** `next.config.js` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on every route, plus open CORS headers. Pin canvases load images with `crossOrigin = 'anonymous'` so the WebGL canvas isn't blocked for cross-origin content. Many recent commits are cross-origin fixes, so check both `/` and `/scene/<id>` in a browser after changing headers, the proxy, or asset URLs.
- **The proxy allowlist is a substring match.** `route.ts:13` accepts any URL containing `r2.dev` or `cloudflare`, and `blobUtils.ts:11` uses the same test to decide whether to proxy. Change both together.
- **Duplicated values.** The splat camera start position `[7, -2.5, 5]` appears both in the viewer options and in `resetCamera()` in `GSplatViewer.tsx`. `Landmark` ([src/types/landmarkTypes.ts](src/types/landmarkTypes.ts)) and `MapLandmark` ([src/types/cesium.ts](src/types/cesium.ts)) are identical types; update both.
- **Overlapping pins.** `pirca11` and `pirca12` are 30 m apart, so their pins stack at almost every zoom level. The click handler uses `scene.drillPick` to get every pin under the cursor. When there's more than one, `OverlappingLandmarksPanel` lists them. Keep that path working if you change picking.
- **Default view.** The start camera (centered on `humboldtCenter`, looking northeast) doesn't show `pirca11` and `pirca12`, which are about 16 km southeast.

## Known issues

[AUDIT.md](AUDIT.md) lists the open bugs, security issues, and inefficiencies found on 2026-09-27, numbered and ranked by severity. Check it before changing the image proxy, the Cesium viewer setup, or the splat viewer, and tick items off as they're fixed.

## Dead code (don't build on it)

- [src/utils/cesiumLoader.ts](src/utils/cesiumLoader.ts) isn't imported anywhere. It also hardcodes a fallback Cesium ion token.
- `scripts/copyAssets.js` isn't wired to any script; webpack already copies the Cesium assets.
- Unused dependencies: `@aws-sdk/*`, `@deck.gl/*`, `mapbox-gl`, `@react-google-maps/api`, `@tanstack/react-query`, `@vercel/blob`, `underscore`, `use-debounce`, `zstddec`, `vercel`. `images.domains` in `next.config.js` still lists Vercel Blob hosts from before the move to R2, and nothing uses `next/image`.
- Leftover files: the empty root files `next` and `splatacama@0.1.0` (from a mistyped shell command), `public/map*.png`, and the default create-next-app SVGs in `public/`.

## Conventions

- Text users see is in Spanish (for example "Volver al mapa", "Cargando terreno 3D..."). Code, comments, and identifiers are in English.
- Styling is Tailwind utility classes inline. UI panels use dark gray with orange accents (`bg-gray-900 bg-opacity-90`, `orange-600`).
- Import from `src/` with the `@/` alias.
- Cesium and viewer objects are typed `any` throughout. Match that instead of adding partial typings.
