// Simple cache for blob URLs to avoid redundant requests
const blobUrlCache: {[key: string]: string} = {};

/**
 * True when `url` is an https URL on this site's R2 bucket (NEXT_PUBLIC_R2_PUBLIC_DOMAIN). These are the only
 * URLs that get proxied, and the only ones the proxy route (src/app/api/image-proxy/route.ts) will fetch.
 */
export function isR2AssetUrl(url: string): boolean {
  const r2PublicDomain = process.env.NEXT_PUBLIC_R2_PUBLIC_DOMAIN;
  if (!r2PublicDomain) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === r2PublicDomain && parsed.port === ''
      && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export async function getBlobUrl(blobPath: string): Promise<string> {
  try {
    // Full URLs: R2 ones go through the API proxy to avoid CORS issues, anything else is used as is
    if (blobPath.startsWith('http://') || blobPath.startsWith('https://')) {
      return isR2AssetUrl(blobPath) ? `/api/image-proxy?url=${encodeURIComponent(blobPath)}` : blobPath;
    }

    // Check cache first
    if (blobUrlCache[blobPath]) {
      return blobUrlCache[blobPath];
    }

    // Validate R2_PUBLIC_DOMAIN environment variable (client-side accessible)
    const r2PublicDomain = process.env.NEXT_PUBLIC_R2_PUBLIC_DOMAIN;
    if (!r2PublicDomain) {
      console.warn('NEXT_PUBLIC_R2_PUBLIC_DOMAIN environment variable is not defined, falling back to original path');
      return blobPath;
    }

    // Construct direct R2 public URL
    const normalizedPath = blobPath.startsWith('/') ? blobPath.slice(1) : blobPath;
    const r2Url = `https://${r2PublicDomain}/${normalizedPath}`;

    // Use the API proxy for R2 URLs to avoid CORS issues
    const proxiedUrl = `/api/image-proxy?url=${encodeURIComponent(r2Url)}`;

    // Cache the proxied URL
    blobUrlCache[blobPath] = proxiedUrl;
    return proxiedUrl;

  } catch (error) {
    console.error('Error constructing R2 blob URL:', error);
    return blobPath;
  }
}
