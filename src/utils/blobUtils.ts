import path from 'path';

const blobUrlCache: Record<string, string> = {};

export async function getBlobUrl(blobPath: string): Promise<string> {
  try {
    // If it's already a full URL, return as is
    if (blobPath.startsWith('http://') || blobPath.startsWith('https://')) {
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
    const publicUrl = `https://${r2PublicDomain}/${normalizedPath}`;
    
    // Cache the URL
    blobUrlCache[blobPath] = publicUrl;
    return publicUrl;
  } catch (error) {
    console.error('Error constructing R2 blob URL:', error);
    return blobPath;
  }
}