import landmarkData from './landmarks.json';
import type { MapLandmark } from '@/types/cesium';

// Leaves out the sites marked `localOnly` in landmarks.json when `hide` is set
export function visibleSites(all: MapLandmark[], hide: boolean): MapLandmark[] {
  return hide ? all.filter(site => !site.localOnly) : all;
}

// The sites the map and the scene pages show. The deployed site leaves out the `localOnly` ones, so they have no pin
// and their scene pages return a 404; a build on a developer's machine shows them all. next.config.js sets the flag
// on Vercel's builds.
export const sites: MapLandmark[] = visibleSites(landmarkData, process.env.NEXT_PUBLIC_HIDE_LOCAL_ONLY_SITES === '1');
