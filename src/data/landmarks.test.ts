import { describe, expect, it } from 'vitest';
import landmarks from './landmarks.json';
import windTurbines from './windTurbines.json';
import type { MapLandmark, SceneTurbines } from '@/types/cesium';

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

  it.each(sites.map(site => [site.id, site] as const))('%s has its size, north and camera limits', (_, site) => {
    // The pipeline scales each site's main structure to 8 viewer units; pircas are a few metres to a few dozen across
    expect(site.metersPerUnit).toBeGreaterThan(0.2);
    expect(site.metersPerUnit).toBeLessThan(10);
    expect(Math.abs(site.heading)).toBeLessThanOrEqual(360);
    if (site.view?.maxDistance !== undefined) expect(site.view.maxDistance).toBeGreaterThan(1);
    if (site.view?.radius !== undefined) expect(site.view.radius).toBeGreaterThan(4);
  });

  it.each(sites.filter(site => site.environment).map(site => [site.id, site] as const))(
    '%s has its terrain and sky in the R2 bucket', (_, site) => {
      const environment = site.environment!;
      expect(isBucketPath(environment.terrainUrl), environment.terrainUrl).toBe(true);
      expect(environment.terrainUrl).toMatch(/\.glb$/);
      if (environment.skyUrl !== undefined) {
        expect(isBucketPath(environment.skyUrl), environment.skyUrl).toBe(true);
        expect(environment.skyUrl).toMatch(/\.(jpe?g|png|webp)$/i);
      }
      if (environment.background !== undefined) expect(environment.background).toMatch(/^#[0-9a-f]{6}$/i);
    });
});

describe('windTurbines.json', () => {
  const bySite = windTurbines as Record<string, SceneTurbines>;

  it('only names sites that exist', () => {
    const ids = new Set(sites.map(site => site.id));
    for (const id of Object.keys(bySite)) expect(ids.has(id), id).toBe(true);
  });

  it.each(Object.entries(bySite))('%s has turbines near the site, with sizes', (id, config) => {
    const site = sites.find(s => s.id === id)!;
    expect(config.turbines.length).toBeGreaterThan(0);
    for (const [lat, lng, hub, rotor] of config.turbines) {
      // Within about 30 km
      expect(Math.abs(lat - site.lat)).toBeLessThan(0.3);
      expect(Math.abs(lng - site.lng)).toBeLessThan(0.3);
      expect(hub).toBeGreaterThan(40);
      expect(rotor).toBeGreaterThan(40);
    }
  });
});
