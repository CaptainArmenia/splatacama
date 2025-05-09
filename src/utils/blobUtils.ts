import { list } from '@vercel/blob';
import path from 'path';

const blobUrlCache: Record<string, string> = {};

export async function getBlobUrl(blobPath: string): Promise<string> {
  try {
    // If it's not a blob path, return as is
    if (!blobPath.includes('atacama-blobs') && !blobPath.includes('blob')) {
      return blobPath;
    }
    
    // Check cache first
    if (blobUrlCache[blobPath]) {
      return blobUrlCache[blobPath];
    }
    
    // Call our server API to get the signed URL
    const response = await fetch(`/api/blob?path=${encodeURIComponent(blobPath)}`);
    
    if (!response.ok) {
      console.warn(`Failed to get signed blob URL: ${response.status}`);
      return blobPath; // Fallback to original path
    }
    
    const data = await response.json();
    
    if (data.url) {
      // Cache the URL to avoid repeated API calls
      blobUrlCache[blobPath] = data.url;
      return data.url;
    } else {
      console.warn(`No URL in API response for ${blobPath}`);
      return blobPath;
    }
  } catch (error) {
    console.error('Error fetching blob URL:', error);
    return blobPath;
  }
}