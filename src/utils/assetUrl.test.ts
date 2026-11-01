import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetUrl } from './assetUrl';

describe('assetUrl', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_R2_PUBLIC_DOMAIN', 'pub-example.r2.dev');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('turns a bucket path into a URL on the R2 bucket', () => {
    expect(assetUrl('pirca13.splat')).toBe('https://pub-example.r2.dev/pirca13.splat');
  });

  it('drops leading slashes from the path', () => {
    expect(assetUrl('/pirca13_preview.jpg')).toBe('https://pub-example.r2.dev/pirca13_preview.jpg');
    expect(assetUrl('//nested/file.jpg')).toBe('https://pub-example.r2.dev/nested/file.jpg');
  });

  it('keeps folders in the path', () => {
    expect(assetUrl('scenes/pirca13.splat')).toBe('https://pub-example.r2.dev/scenes/pirca13.splat');
  });

  it('uses full URLs as they are', () => {
    expect(assetUrl('https://elsewhere.example/a.splat')).toBe('https://elsewhere.example/a.splat');
    expect(assetUrl('http://localhost:3000/local-splats/a.splat')).toBe('http://localhost:3000/local-splats/a.splat');
  });

  it('falls back to this site, with a warning, when the bucket domain is not set', () => {
    vi.stubEnv('NEXT_PUBLIC_R2_PUBLIC_DOMAIN', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(assetUrl('pirca13.splat')).toBe('/pirca13.splat');
    expect(warn).toHaveBeenCalledOnce();
  });
});
