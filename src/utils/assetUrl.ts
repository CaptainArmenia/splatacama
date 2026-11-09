/**
 * The URL a landmark asset (a .splat scene, preview photo or pin thumbnail) is loaded from.
 *
 * Bucket paths ("pirca13.splat") become URLs on the site's R2 bucket (NEXT_PUBLIC_R2_PUBLIC_DOMAIN), which the
 * browser fetches directly. That needs the bucket's CORS rule to allow the page's origin; it lists production
 * and http://localhost:3000. Full URLs are used as they are.
 */
export function assetUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;

  const normalizedPath = path.replace(/^\/+/, '');
  const r2PublicDomain = process.env.NEXT_PUBLIC_R2_PUBLIC_DOMAIN;
  if (!r2PublicDomain) {
    console.warn('NEXT_PUBLIC_R2_PUBLIC_DOMAIN is not set; loading assets from this site instead of R2');
    return `/${normalizedPath}`;
  }
  return `https://${r2PublicDomain}/${normalizedPath}`;
}
