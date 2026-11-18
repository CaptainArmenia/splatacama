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

  it.each(sites.filter(site => site.sun).map(site => [site.id, site] as const))(
    '%s has its sun in the sky', (_, site) => {
      const sun = site.sun!;
      expect(sun.bearing).toBeGreaterThanOrEqual(0);
      expect(sun.bearing).toBeLessThan(360);
      expect(sun.elevation).toBeGreaterThan(0);
      expect(sun.elevation).toBeLessThanOrEqual(90);
      if (sun.shadows !== undefined) {
        expect(sun.shadows).toBeGreaterThanOrEqual(0);
        expect(sun.shadows).toBeLessThanOrEqual(1);
      }
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
      if (environment.scrubUrl !== undefined) {
        expect(isBucketPath(environment.scrubUrl), environment.scrubUrl).toBe(true);
        expect(environment.scrubUrl).toMatch(/\.json$/);
      }
      if (environment.background !== undefined) expect(environment.background).toMatch(/^#[0-9a-f]{6}$/i);
    });

  it.each(sites.filter(site => site.pano).map(site => [site.id, site] as const))(
    '%s has its 360 photo in the R2 bucket, taken at the site', (_, site) => {
      const pano = site.pano!;
      for (const image of [pano.url, pano.smallUrl]) {
        if (image === undefined) continue;
        expect(isBucketPath(image), image).toBe(true);
        expect(image).toMatch(/\.(jpe?g|webp)$/i);
      }
      // Within reach of the site (viewer units; the structure spans about 8) and above the ground (y points down)
      expect(pano.position).toHaveLength(3);
      expect(Math.hypot(pano.position[0], pano.position[2])).toBeLessThan(40);
      expect(pano.position[1]).toBeLessThan(0);
      // A rotation: a unit quaternion
      expect(pano.quaternion).toHaveLength(4);
      expect(Math.hypot(...pano.quaternion)).toBeCloseTo(1, 4);
      if (pano.depth) {
        expect(isBucketPath(pano.depth.url), pano.depth.url).toBe(true);
        expect(pano.depth.url).toMatch(/\.png$/i);
        expect(pano.depth.near).toBeGreaterThan(0);
        expect(pano.depth.far).toBeGreaterThan(pano.depth.near);
        // Metres the camera may move: less than the viewpoint's height above the ground
        expect(pano.depth.reach).toBeGreaterThan(0.2);
        expect(pano.depth.reach).toBeLessThanOrEqual(4);
        expect(pano.depth.reach).toBeLessThan(-pano.position[1] * site.metersPerUnit);
      }
    });

  it.each(sites.filter(site => site.npcs).map(site => [site.id, site] as const))(
    '%s has its people in the R2 bucket', (_, site) => {
      for (const npc of site.npcs!) {
        expect(isBucketPath(npc.model), npc.model).toBe(true);
        expect(npc.model).toMatch(/\.glb$/);
        expect(npc.walkSpeed).toBeGreaterThan(0.1);
        expect(npc.walkSpeed).toBeLessThan(2);
      }
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
    expect(config.sky).toHaveLength(3);
    for (const color of config.sky) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(config.turbines.length).toBeGreaterThan(0);
    for (const turbine of config.turbines) {
      const [lat, lng, hub, rotor, distance, baseElevation] = turbine;
      expect(turbine).toHaveLength(6);
      // Within about 30 km
      expect(Math.abs(lat - site.lat)).toBeLessThan(0.3);
      expect(Math.abs(lng - site.lng)).toBeLessThan(0.3);
      expect(hub).toBeGreaterThan(40);
      expect(rotor).toBeGreaterThan(40);
      // Past the site and inside the camera's far plane (1000 units without terrain), a few degrees from level at most
      expect(distance).toBeGreaterThan(20);
      expect(distance).toBeLessThan(site.environment?.far ?? 1000);
      expect(Math.abs(baseElevation)).toBeLessThan(10);
    }
  });
});
