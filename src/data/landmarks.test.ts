import { describe, expect, it } from 'vitest';
import landmarks from './landmarks.json';
import type { MapLandmark } from '@/types/cesium';

// Checks the site list, the one data file the map and the scene pages are built from
const sites: MapLandmark[] = landmarks;

// A path inside the R2 bucket, e.g. "pirca13.splat". Full URLs work in the app (see assetUrl), but committed
// sites must point at the bucket; a localhost or other URL here is a local test entry that slipped in.
const isBucketPath = (path: string) => !/^[a-z]+:\/\//i.test(path) && !path.startsWith('/');

describe('landmarks.json', () => {
  it('has sites', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it('has unique ids that are safe in a URL', () => {
    const ids = sites.map(site => site.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]+$/);
  });

  it.each(sites.map(site => [site.id, site] as const))('%s has a name, a description and a place in Chile', (_, site) => {
    expect(site.name.trim()).not.toBe('');
    expect(site.description.trim()).not.toBe('');
    // Chile's mainland bounds, roughly
    expect(site.lat).toBeGreaterThan(-56);
    expect(site.lat).toBeLessThan(-17);
    expect(site.lng).toBeGreaterThan(-76);
    expect(site.lng).toBeLessThan(-66);
    // Meters above the ground (pins use RELATIVE_TO_GROUND)
    expect(site.height).toBeGreaterThan(0);
    expect(site.height).toBeLessThan(1000);
  });

  it.each(sites.map(site => [site.id, site] as const))('%s points at files in the R2 bucket', (_, site) => {
    expect(isBucketPath(site.gsplatUrl), site.gsplatUrl).toBe(true);
    expect(site.gsplatUrl).toMatch(/\.splat$/);
    for (const image of [site.previewUrl, site.thumbnailUrl]) {
      if (image === undefined) continue;
      expect(isBucketPath(image), image).toBe(true);
      expect(image).toMatch(/\.(jpe?g|png|webp)$/i);
    }
  });
});
