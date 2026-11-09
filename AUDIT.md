# Code audit

Audited on 2026-09-27 at commit `1d6a321`. Covers everything in `src/`, the config files, and the dependencies.

**How findings were checked.** Every source file was read. Claims about library behavior were checked against the installed packages (Next.js 15.3.1, Cesium 1.128, `@mkkellogg/gaussian-splats-3d` 0.4.7, Tailwind 4) and against a local `pnpm build`. Vulnerability counts come from `pnpm audit --prod` on the same date. Production was only checked where noted; items that depend on it are otherwise marked **unverified**.

Items are numbered so they can be referenced in commits ("fixes audit #5"). Check an item off when it's done.

**Status on 2026-10-31:** 21 of 23 items are done, and everything in the code is fixed. Two items still need someone with the accounts: #11 (upload the pin thumbnails to R2) and #17 (revoke the old Cesium token). Problems found since the audit are listed [at the end](#found-after-the-audit).

## Summary

| # | Severity | Area | Finding |
| --- | --- | --- | --- |
| 1 | ~~Critical~~ Done | Security | Next.js 15.3.1 has a remote code execution vulnerability |
| 2 | ~~High~~ Done | Security | Image proxy fetches and serves any URL containing "cloudflare" |
| 3 | ~~High~~ Done | Performance | Every `.splat` file is downloaded in full by a server function before it reaches the browser |
| 4 | ~~High~~ Done | Security | 152 dependency advisories, most from packages the code never uses |
| 5 | ~~Medium~~ Done | Bug | Cesium viewer is never destroyed, and a second one can be created on top of the first |
| 6 | ~~Medium~~ Done | Bug | Splat viewer can load twice and restart after it was torn down |
| 7 | ~~Medium~~ Done | Bug | Terrain exaggeration setting is ignored |
| 8 | ~~Medium~~ Done | Bug | Semi-transparent panels render solid; compass letters are nearly invisible |
| 9 | ~~Medium~~ Done | Performance | Map imagery and terrain are loaded, thrown away, and loaded again at startup |
| 10 | ~~Medium~~ Done | Performance | The map redraws continuously and runs a pick on every mouse move |
| 11 | Medium (partly done) | Performance | Pins and panels use full-size photos (unverified for the live files) |
| 12 | ~~Medium~~ Done | Maintenance | Cross-origin isolation headers are set, but the feature they enable is turned off |
| 13 | ~~Medium~~ Done | Content | All 11 map pins are placeholders for the same scene |
| 14 | ~~Low~~ Done | Bug | Unknown scene id returns a 200 page instead of a 404 |
| 15 | ~~Low~~ Done | Accessibility | Page language is `en` but the interface is Spanish; some visible strings are English |
| 16 | ~~Low~~ Done | Maintenance | Unused and misplaced dependencies |
| 17 | Low (partly done) | Maintenance | Dead code and leftover files, including a hardcoded Cesium ion token |
| 18 | ~~Low~~ Done | Maintenance | Values and types defined twice |
| 19 | ~~Low~~ Done | Build | Build copies Cesium assets on every compilation and transpiles all of Cesium |
| 20 | ~~Low~~ Done | Tooling | No lint, no tests, loose TypeScript, and hand-written types that override React's |
| 21 | ~~Low~~ Done | Bug | Splat format detection depends on the URL happening to end in `.splat` |
| 22 | ~~Low~~ Done | Performance | Every hover and selection re-applies all pin images |
| 23 | ~~Low~~ Done | UI | Small layout and code issues |

---

## Critical

### 1. Next.js 15.3.1 has a remote code execution vulnerability
- [x] Done (2026-09-28): upgraded to 15.5.26 in `ba743fc`. `pnpm audit --prod` now reports no Next.js advisories. Vercel had started refusing to deploy 15.3.1 ("Vulnerable version of Next.js detected").

**Where:** `package.json:24`

`pnpm audit` reports three critical Next.js advisories for this version. One affects this app directly: "RCE in React flight protocol", a flaw in how App Router apps handle React Server Components requests. It is fixed in 15.3.6. The other two are fixed in 15.5.24: one affects only Windows-hosted servers, and the other is in the image optimization endpoint. There are also 12 high and 15 moderate Next.js advisories.

**Fix:** upgrade to the latest 15.5.x release (at least 15.5.24), rebuild, and re-run `pnpm audit --prod`. React may need a matching bump.

## High

### 2. Image proxy fetches and serves any URL containing "cloudflare"
- [x] Done (2026-09-28)

**Resolved:** Both the client and the route now use `isR2AssetUrl()` (`src/utils/blobUtils.ts`): https only, with an exact host match against the R2 domain. Only JPEG, PNG, WebP, GIF and AVIF keep their type; everything else is sent as `application/octet-stream`, with `nosniff`. The site-wide CORS headers are gone. Tested: the audit's example URL, plain http, userinfo tricks, the domain in a query string and an internal address all return 400.

**Where:** `src/app/api/image-proxy/route.ts:13`, `:30`; `next.config.js:78`

The allowlist check is a substring test: `imageUrl.includes('r2.dev') || imageUrl.includes('cloudflare')`. Any URL passes if that text appears anywhere, even in a query string. The route then fetches the URL on the server and returns the body with the upstream `Content-Type`.

For example, `/api/image-proxy?url=https://attacker.example/page.html?cloudflare` would make the server fetch the attacker's page and serve it as HTML from this site's own origin, so its scripts run as this site. The server can also be pointed at arbitrary hosts, and with the site-wide `Access-Control-Allow-Origin: *` any other website can read the responses.

**Fix:** parse the URL with `new URL()`, require `https:` and an exact hostname match against the R2 domain (read from a server-side environment variable), and only pass through `image/*` and `application/octet-stream`. Add `X-Content-Type-Options: nosniff`. Better still, remove the proxy (see #3). This was confirmed by reading the code; it was not tried against production.

### 3. Every `.splat` file is downloaded in full by a server function before it reaches the browser
- [x] Done (2026-10-31)

**Resolved:** The R2 bucket now has a CORS rule allowing `GET` from `https://splatacama.vercel.app` and `http://localhost:3000`. The browser loads splats and images straight from the bucket, and the proxy route is deleted, so the site has no server code left and every page is static. `assetUrl()` (`src/utils/assetUrl.ts`) builds the URLs; it's synchronous, so the preview URL state and loading spinners that waited on the old async helper are gone. Checked in a production build served as `localhost:3000`: the splat, previews and pin photos all load from R2, with no requests to the old route. Two things to know: Vercel preview deployments and other local ports aren't in the CORS rule, so assets don't load there until their origin is added; and Cloudflare rate-limits `r2.dev` addresses and recommends a custom domain for production traffic. The proxy had been shielding the bucket behind Vercel's CDN cache.

(2026-09-28, before the CORS rule existed: the proxy was changed to stream the body, pass `Content-Length` through and set `s-maxage`.)

**Where:** `src/utils/blobUtils.ts:12`, `:34`; `src/app/api/image-proxy/route.ts:29`

`getBlobUrl()` sends every R2 asset through `/api/image-proxy`, including the splat files, not just images. The route calls `response.arrayBuffer()`: it waits for the whole file, holds it in memory, then sends it. The splat that was in git history was 28 MB. The costs:
- users see nothing load until the server has the whole file
- the viewer's progress bar can't move during that time
- the function pays for the memory and bandwidth on every visit

**Checked 2026-09-28:** production (`splatacama.vercel.app`) serves the 28 MB `pirca.splat` through the proxy correctly: HTTP 200, all 28,275,296 bytes, in 6.7 s. So the file size doesn't break loading. The costs above still apply.

The response also sets `Cache-Control: public, max-age=86400` without `s-maxage`, so a CDN may not cache it and every visitor may go through the function.

**Fix:** set a CORS policy on the R2 bucket that allows `GET` from the site's origin, then load R2 URLs directly and delete the proxy. If the proxy has to stay, stream `response.body` instead of buffering it.

### 4. 152 dependency advisories, most from packages the code never uses
- [x] Done (2026-09-28)

**Resolved:** Unused packages removed and Cesium upgraded to 1.145. `pnpm audit --prod` went from 152 advisories (7 critical) to 7 (0 critical). The 7 left are in the copy of `postcss` and `nanoid` that Next.js bundles for its build step; they go away when Next.js updates them. Cesium 1.145 brings in an SPZ loader whose embedded WebAssembly breaks the production minifier, so `next.config.js` aliases it to an empty module.

**Where:** `package.json`

`pnpm audit --prod` finds 7 critical, 57 high, 71 moderate, and 17 low advisories. Outside Next.js (#1), most come through dependencies nothing imports:
- `vercel` (the command-line tool) brings `tar` (1 critical), `minimatch`, `picomatch`, `brace-expansion` and `undici`
- `@aws-sdk/client-s3` brings `fast-xml-parser` (1 critical)
- `@vercel/blob` brings `undici`
- `underscore` has 1 high
- `mapbox-gl` brings `protocol-buffers-schema`

Cesium 1.128 brings `protobufjs` (1 critical, arbitrary code execution) and `dompurify` (19 moderate or low).

**Fix:** remove the unused packages (#16), upgrade Cesium, and re-run `pnpm audit --prod`.

## Medium

### 5. Cesium viewer is never destroyed, and a second one can be created on top of the first
- [x] Done (2026-09-28)

**Resolved:** The viewer is now created synchronously and the effect returns its teardown: input handlers destroyed, cluster updates stopped, `viewer.destroy()`. `MapWithPins` imports `landmarks.json` statically, so the list never changes after the first render.

**Where:** `src/hooks/useCesiumViewer.ts:45`–`106`; `src/components/MapWithPins.tsx:37`; `src/components/CesiumMapComponent.tsx:143`

`createViewer()` is an `async` function that returns a cleanup function (line 90). The effect calls it (line 105) but never returns that cleanup, so React gets nothing. As a result:
- `viewer.destroy()` and `resizeObserver.disconnect()` never run
- the two `ScreenSpaceEventHandler`s are never destroyed at all

The effect depends on `landmarks`, which `MapWithPins` loads asynchronously. If the landmark list arrives after the viewer is built, the effect runs again and builds a second full Cesium viewer (a second WebGL context, terrain, and imagery) in the same container, without removing the first. Whether that happens depends on which download finishes first.

For now, the full-page navigation to scenes (`window.location.href`, `CesiumMapComponent.tsx:143`) hides the leak. Switching to client-side navigation would leak a viewer on every visit to the map.

**Fix:** keep a `cancelled` flag in the effect, destroy the viewer and handlers in the effect's cleanup, and import `landmarks.json` statically so the list never changes after mount.

### 6. Splat viewer can load twice and restart after it was torn down
- [x] Done (2026-09-28)

**Resolved:** The effect depends only on `url` and `backgroundColor`, `start()` is skipped after unmount, and teardown uses the library's `dispose()`. The unused WebXR check is gone.

**Where:** `src/components/GSplatViewer.tsx:227`, `:146`, `:160`–`215`

The setup effect depends on `isXRCompatible`, which changes from `false` to `true` asynchronously on browsers that report WebXR VR support (for example Meta Quest). The value is no longer used, since WebXR mode is off and the related rotation and scale code is commented out. On those browsers the viewer is torn down mid-download and built again, so the splat file downloads twice.

After a teardown, `viewer.start()` (line 146) still runs, because only `setLoading` is guarded by `isMounted`, and it restarts a viewer whose renderer was set to `null`. In development, React Strict Mode (on by default for the App Router) mounts effects twice, which triggers the same path: the first viewer is built in a detached container and keeps running.

The hand-written teardown also never stops the library's sorting web worker. The library's own `viewer.dispose()` does.

**Fix:** remove `isXRCompatible` (and `onError`) from the effect's dependencies, guard `viewer.start()` with `isMounted`, and replace the manual teardown with `await viewer.dispose()`.

### 7. Terrain exaggeration setting is ignored
- [x] Done (2026-09-28)

**Resolved:** Now uses `scene.verticalExaggeration` (1.5). Checking pins against the ground showed they were 18–84 m underground, so pins, cluster markers and the explode dot now use `HeightReference.RELATIVE_TO_GROUND`. `height` in `landmarks.json` now means meters above the ground (30).

**Where:** `src/hooks/useCesiumViewer.ts:123`; `src/constants/cesiumConfig.ts:43`

The code sets `viewer.scene.globe.terrainExaggeration = 1.5`. Cesium 1.128's `Globe` no longer defines that property, so the assignment just creates an unused field and the terrain is drawn at true scale. The current API is `viewer.scene.verticalExaggeration`.

Pins are placed at absolute heights (`landmark.height`, 100 m, `useCesiumViewer.ts:227`), so enabling exaggeration will change how pins line up with the ground. Check both together.

### 8. Semi-transparent panels render solid; compass letters are nearly invisible
- [x] Done (2026-09-28)

**Resolved:** Every `bg-opacity-*` now uses the slash syntax (`bg-black/70`), `text-white-500` is `text-white`, `pb-safe` is `pb-[env(safe-area-inset-bottom)]`, and `tailwind.config.js` is deleted.

**Where:** many components; `src/components/CesiumCompass.tsx:90`–`92`; `src/app/scene/[id]/page.tsx:45`; `tailwind.config.js`

Tailwind 4 removed the `bg-opacity-*` utilities. None of them appear in the built CSS. Every `bg-black bg-opacity-70`, `bg-gray-900 bg-opacity-90`, and so on renders fully opaque. That includes the map's loading overlay (`bg-white bg-opacity-70`), which covers the map in solid white instead of fading it. A few other classes also do nothing:
- `text-white-500` doesn't exist (white has no shades), so the compass's S, E and O inherit the page text color: #171717 in light mode, on a dark gray face
- `pb-safe` comes from a plugin that isn't installed, so the scene page gets no padding above the iPhone home indicator
- `tailwind.config.js` is never loaded, because Tailwind 4 needs an `@config` line in the CSS; its `fadeIn` animation isn't used anyway

**Fix:** use the slash syntax (`bg-black/70`, `bg-gray-900/90`), `text-white`, and `pb-[env(safe-area-inset-bottom)]`. Delete `tailwind.config.js`.

### 9. Map imagery and terrain are loaded, thrown away, and loaded again at startup
- [x] Done (2026-09-28)

**Resolved:** ArcGIS World Imagery and Cesium World Terrain are selected in the `Viewer` constructor. Verified: one imagery layer and no requests for the Sentinel-2 asset.

**Where:** `src/hooks/useCesiumViewer.ts:57`, `:63`, `:155`

The viewer is created with a terrain provider (`createWorldTerrainAsync`) and Cesium ion imagery asset 3954 (Sentinel-2) as `baseLayer`. Cesium's documentation says `baseLayer` is only valid when the base layer picker is off, and here it's on. 300 ms later, a `setTimeout` makes the picker select "Cesium World Terrain", which builds a new terrain provider, and "ArcGIS World Imagery", which replaces Sentinel-2. The first round of tile requests is wasted, uses Cesium ion quota, and makes the imagery visibly swap.

**Fix:** pass `selectedImageryProviderViewModel` and `selectedTerrainProviderViewModel` to the `Viewer` constructor, taken from the default view-model lists, and drop `baseLayer`, `terrainProvider`, and the `setTimeout`.

### 10. The map redraws continuously and runs a pick on every mouse move
- [x] Done (2026-09-28)

**Resolved:** `requestRenderMode` is on (0 frames drawn in 3 idle seconds, down from about 180). Everything that changes pins or clusters calls `scene.requestRender()`, and hover picking runs at most once per animation frame.

**Where:** `src/constants/cesiumConfig.ts` (`VIEWER_CONFIG`); `src/hooks/useCesiumViewer.ts:274`–`291`

Without `requestRenderMode: true`, Cesium redraws the globe every frame even when nothing moves, which drains battery on phones and laptops. The code already calls `scene.requestRender()` in its resize handler, as if that mode were on. The hover handler also calls `scene.pick()`, an extra render pass, on every `MOUSE_MOVE` event.

**Fix:** enable `requestRenderMode` and call `requestRender()` after pin changes. Throttle hover picking, for example once per animation frame.

### 11. Pins and panels use full-size photos (unverified for the live files)
- [ ] Partly done (2026-09-28)

**Progress:** Landmarks can have a `thumbnailUrl` for the pin, falling back to `previewUrl` if it's missing or fails to load. 160 px thumbnails (about 10 KB each) and a 1024 px `pirca0_preview.jpg` (426 KB, replacing the 2.3 MB original) are in `~/datasets/pircas-work/output/`. **Still to do:** upload `pirca*_thumb.jpg` to R2 and replace `pirca0_preview.jpg` there. Until then pins keep using the previews.

**Where:** `src/utils/cesiumMarkers.ts`; `src/components/LandmarkInfoPanel.tsx`

Each pin is drawn by loading the landmark's `previewUrl` into a new `Image` and scaling it down to a 50 px circle. The copy of `pirca0_preview.jpg` that was in git history is 3024×3024 and 2.1 MB, and all 11 landmarks use it. If the R2 copy is the same, every visitor downloads and decodes a 9-megapixel image to draw 50 px pins, and again for the 208 px panel.

**Fix:** store small thumbnails for pins (about 128 px) and medium previews for panels (about 800 px), and add fields for them in `landmarks.json`.

### 12. Cross-origin isolation headers are set, but the feature they enable is turned off
- [x] Done (2026-09-28)

**Resolved:** Removed the cross-origin isolation headers and the site-wide CORS headers. Only `Cache-Control` on `/cesium/*` is left.

**Where:** `next.config.js:78`–`170`; `src/components/GSplatViewer.tsx:117`

`next.config.js` sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` on every route, "to support SharedArrayBuffer". But the splat viewer runs with `sharedMemoryForWorkers: false` (and `gpuAcceleratedSort: false`), so nothing uses it. These headers are behind most of the cross-origin fixes in recent history.

The same config also sends `Access-Control-Allow-Origin: *` and write methods (`PATCH`, `DELETE`) on every page and route. Nothing needs that.

**Fix:** decide either way. Turn shared memory on (it makes splat sorting faster, and the headers stay), or remove the isolation headers. Limit CORS headers to routes that need them.

### 13. All 11 map pins are placeholders for the same scene
- [x] Done (2026-09-28)

**Where:** `src/data/landmarks.json`

Every entry uses the same `pirca.splat`, the same preview, and the same description. So each pin opens the same 3D scene, while the map suggests 11 different sites. `pirca5` and `pirca10` also have identical coordinates, so their pins are stacked.

**Fix:** mark placeholders or hide them until each has its own capture. Remove the duplicate.

**Resolved:** the placeholders `pirca1`–`pirca10` were removed. `pirca0` is back at its original coordinates (−28.955, −71.476), next to the three new drone captures `pirca11`–`pirca13`. Pins that overlap now merge into a numbered cluster that fans out when clicked, instead of hiding one site.

## Low

### 14. Unknown scene id returns a 200 page instead of a 404
- [x] Done (2026-09-28)

**Resolved:** Unknown ids call `notFound()`, which returns a real 404 with a Spanish page (`src/app/not-found.tsx`). `generateStaticParams()` prebuilds the scene pages.

**Where:** `src/app/scene/[id]/page.tsx:18`

The "Landmark not found" branch returns a normal page, so search engines and link checkers see a success. Call `notFound()` instead. Since the landmark list is static, `generateStaticParams()` would also let the scene pages be built ahead of time instead of rendered on every request (the build currently lists `/scene/[id]` as dynamic).

### 15. Page language is `en` but the interface is Spanish; some visible strings are English
- [x] Done (2026-09-28)

**Resolved:** `<html lang="es">`, Spanish title and description, and the English strings translated.

**Where:** `src/app/layout.tsx:18`, `:28`; `src/components/CesiumMapComponent.tsx:148`; `src/components/GSplatViewer.tsx:270`; `src/hooks/useCesiumViewer.ts` (error messages)

`<html lang="en">` makes screen readers use English pronunciation for Spanish text, and it misleads search engines. The page title and description are in English. The user can also see these English strings:
- "Loading Cesium..."
- the reset button's "Reset camera position" tooltip
- the error messages "Cesium Ion Token is missing…", "Failed to initialize 3D map viewer", and "Error loading 3D map components"

### 16. Unused and misplaced dependencies
- [x] Done (2026-09-28)

**Resolved:** Removed the twelve unused packages, `vercel`, and `fs-extra` (only the deleted copy script used it). `@types/three` moved to `devDependencies`. The app now has 6 runtime dependencies.

**Where:** `package.json`

Never imported: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox`, `mapbox-gl`, `@react-google-maps/api`, `@tanstack/react-query`, `@vercel/blob`, `underscore`, `use-debounce`, `zstddec`.

`vercel` is the command-line tool and shouldn't be a runtime dependency. `@types/three` belongs in `devDependencies`. Removing these speeds up installs and clears most of #4.

### 17. Dead code and leftover files, including a hardcoded Cesium ion token
- [ ] Partly done (2026-09-28)

**Progress:** Deleted: `cesiumLoader.ts`, `cesiumConfig.js`, the `CesiumConfig` component, `copyAssets.js`, `next.config.ts`, the empty root files, the unused images and SVGs, and `tailwind.config.js`. Removed the unused state, props, imports and config, and the never-reachable loading and error states. **Still to do (in Cesium ion):** revoke the token that was hardcoded in `cesiumLoader.ts` (it's in git history), and restrict `NEXT_PUBLIC_CESIUM_TOKEN` to the site's domains.

- `src/utils/cesiumLoader.ts` is never imported. Line 35 hardcodes a fallback Cesium ion token, which is also in git history. If it's your token, revoke it in Cesium ion.
- `src/utils/cesiumConfig.js:17`–`33` does nothing. It reads `window.Cesium`, which nothing sets. It also sends `Cross-Origin-Resource-Policy` as a request header, but that's a response header, so sending it has no effect.
- `scripts/copyAssets.js` isn't wired to any script; webpack already copies the Cesium assets.
- `next.config.ts` is empty and ignored, because `next.config.js` wins.
- The empty root files `next` and `splatacama@0.1.0`, from a mistyped shell command.
- `public/map.png`, `public/map_.png` and `public/map-background.png` (6 MB together) and the create-next-app SVGs are unused.
- Unused state and props:
  - `MapWithPins.tsx:33`, `:45`: `setPreventPinOcclusion` and `toggleCameraPosition`
  - `GSplatViewer.tsx:17`, `:22`: `showLoadingPercentage` and `loading`
- In `useCesiumState.ts`, the preview `loading` and `errors` maps can never be seen as true. The hook publishes state once, at the end (line 43), and `getBlobUrl()` never throws.
- `useCanvasCache`'s reset effect repeats what `useRef({})` already does.
- `src/utils/blobUtils.ts:1` imports `path` and never uses it.
- `next.config.js:8`: `images.domains` lists Vercel Blob hosts from before the move to R2, and nothing uses `next/image`.
- `next.config.js:24`: the fallback path requires `glob`, which isn't installed.
- The `NEXT_PUBLIC_CESIUM_TOKEN` value ships to every browser by design. Restrict it to the site's domains in Cesium ion's token settings.

### 18. Values and types defined twice
- [x] Done (2026-09-28)

**Resolved:** `landmarkTypes.ts` is gone and everything uses `MapLandmark`. The splat camera start is a shared constant. `CESIUM_BASE_URL` comes only from `DefinePlugin`. The map center lives in `DEFAULT_CAMERA_CONFIG.center`. The resize observer is removed, since Cesium resizes itself.

- `Landmark` (`src/types/landmarkTypes.ts`) and `MapLandmark` (`src/types/cesium.ts`) are identical.
- The splat camera start `[7, -2.5, 5]` appears both in the viewer options and in `resetCamera()` in `GSplatViewer.tsx`.
- `CESIUM_BASE_URL` is set twice: by webpack's `DefinePlugin` and in `src/utils/cesiumConfig.js`.
- The map center (`humboldtCenter`) is hardcoded in `MapWithPins.tsx` rather than kept with the other camera settings in `src/constants/cesiumConfig.ts`.
- The resize observer in `useCesiumViewer.ts` repeats what Cesium already does each frame.

### 19. Build copies Cesium assets on every compilation and transpiles all of Cesium
- [x] Done (2026-09-28)

**Resolved:** The Cesium asset copy runs only in the client compilation. `transpilePackages` and `externalDir` are removed. A local production build takes about 15 s.

**Where:** `next.config.js:56`, `:178`

`CopyWebpackPlugin` is added to every webpack compilation (client and server, and on every dev rebuild), so Cesium's asset folders are copied into `public/cesium/` repeatedly. `transpilePackages: ['cesium']` makes webpack run all of Cesium through the compiler, which Cesium's ES module build likely doesn't need. The effect on build time wasn't measured. `experimental.externalDir` isn't needed either.

### 20. No lint, no tests, loose TypeScript, and hand-written types that override React's
- [x] Done (2026-10-31)

**Resolved:** `tsconfig.json` has `strict: true`. It surfaced two errors: a ref type that didn't allow `null`, and the splat library's missing type declarations (now declared as `any` in `src/types/gaussian-splats-3d.d.ts`, matching how Cesium is typed). `pnpm test` runs Vitest: 23 tests covering `assetUrl()`, the pin grouping and fan-out math (moved out of the Cesium code into pure functions for this), and the site list. The site-list test rejects a site whose assets point outside the bucket, which catches a local test entry left in `landmarks.json`. Vercel doesn't run the tests; there's no CI.

(2026-09-28: ESLint restored with 0 problems, `src/env.d.ts` deleted, `moduleResolution: "bundler"`.)

- `pnpm lint` (`package.json:9`) fails because ESLint was removed. `next build` skips linting too.
- There are no tests.
- `tsconfig.json` has `strict: false` and `moduleResolution: "node"` (Next.js recommends `"bundler"`).
- `src/env.d.ts:13`–`30` redeclares parts of React's own types (`ReactNode`, `ReactElement`, with `ReactPortal = any`), and `:47` redeclares `next/font/google`. Looser hand-written types replace the real ones, which hides type errors.

### 21. Splat format detection depends on the URL happening to end in `.splat`
- [x] Done (2026-09-28)

**Resolved:** The scene definition passes `format: SceneFormat.Splat`.

**Where:** `src/components/GSplatViewer.tsx` (scene definition)

The splat library picks the file format from the URL's ending (`sceneFormatFromPath`). The proxied URL (`/api/image-proxy?url=…%2Fpirca.splat`) happens to end in `.splat`, so it works. Adding any query parameter, such as a cache-buster, would break loading. Pass `format: GaussianSplats3D.SceneFormat.Splat` explicitly.

### 22. Every hover and selection re-applies all pin images
- [x] Done (2026-09-28)

**Resolved:** Replaced by one effect that applies pin photos when the map is ready and when a pin image URL changes. It doesn't depend on hover or selection.

**Where:** `src/components/CesiumMapComponent.tsx:116`

The "load initial markers" effect depends on `selectedLandmark` and `hoveredLandmark`, so every hover change loops over all landmarks and sets each pin's image and scale again. When preview URLs change, this effect and the one above it can both build the same pin canvas at the same time. Run the initial marker load only once, when the map loads and preview URLs are ready.

### 23. Small layout and code issues
- [x] Done (2026-09-28)

**Resolved:** The camera readout sits bottom-left on every screen size. The info toggle has a single background per state. `new ImageryLayer.fromProviderAsync` is gone, since #9 removed it. The interim loading state uses the same Spanish spinner.

- On phones, the camera position panel (`CameraPositionPanel.tsx:16`, `fixed top-4 right-4`, `z-50`) covers the compass (`CesiumCompass.tsx:72`, also top-right).
- The open info toggle in `ToggleableInfoPanel.tsx` has both `bg-black` and `bg-orange-600`. Which color shows depends on CSS order, not on intent.
- `new cesium.ImageryLayer.fromProviderAsync(...)` (`useCesiumViewer.ts:63`) calls a factory function with `new`. It only works because the factory returns an object.
- The map briefly shows an unstyled "Loading Cesium..." line (`CesiumMapComponent.tsx:148`) between two styled spinners.

## Found after the audit

Reviewed on 2026-10-31, at the code as of `cd27859`, which includes the pin clustering, marker drawing and splat loading panel written after the audit. All fixed on 2026-10-31.

- **Pin image loader could fetch the fallback twice.** When a pin photo timed out, the loader cleared the image's source, which also fired its error handler; both paths started loading the fallback image. The loader is rewritten around a promise that settles once (`src/utils/cesiumMarkers.ts`).
- **The viewer was handed out by reading a ref during render.** `useCesiumViewer` returned `viewerRef.current` from render, which only worked because a separate state change happened to re-render afterwards. The viewer is now state, and `mapLoaded` is derived from it.
- **The layer picker restyling searched the whole page.** It now looks only inside its own map container.
- **The compass had 40 lines of shortest-path rotation tracking.** That only matters with a CSS transition, and the transition is off, so it now sets the rotation from the camera heading directly.
- **The two info panels duplicated their preview block, close button and description.** Both now use `LandmarkDetails` (`src/components/LandmarkDetails.tsx`). The three copies of the loading spinner are one `LoadingMessage`.
- **Dead branches and stale comments.** Server-rendering checks in a component that only renders in the browser; a hook that only wrapped `useRef`; comments in `cesiumConfig.ts` that described old values ("hover 3.0" next to 1.2, "10-degree inclination" next to -30).
