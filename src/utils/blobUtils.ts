import path from 'path';

// Simple cache for blob URLs to avoid redundant requests
const blobUrlCache: {[key: string]: string} = {};

export async function getBlobUrl(blobPath: string): Promise<string> {
  try {
    // If it's already a full URL, check if it's an R2 URL that needs proxying
    if (blobPath.startsWith('http://') || blobPath.startsWith('https://')) {
      // For R2 images, use the API proxy to avoid CORS issues
      if (blobPath.includes('r2.dev') || blobPath.includes('cloudflare')) {
        return `/api/image-proxy?url=${encodeURIComponent(blobPath)}`;
      }
      return blobPath;
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