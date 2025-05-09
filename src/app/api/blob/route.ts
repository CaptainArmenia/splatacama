import { NextRequest, NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json({ error: 'Path parameter is required' }, { status: 400 });
    }

    // Normalize the path (remove leading slash if present)
    const normalizedPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
    
    console.log(`[Blob API] Looking for blob: ${normalizedPath}`);
    
    // IMPORTANT: Running server-side where we have access to the BLOB_READ_WRITE_TOKEN
    const { blobs } = await list();
    
    console.log(`[Blob API] Found ${blobs.length} blobs in storage`);
    
    // Try different path variations to find the blob
    let blob = blobs.find(b => b.pathname === normalizedPath);
    
    // Try with just the filename if not found with full path
    if (!blob) {
      const filename = path.basename(normalizedPath);
      blob = blobs.find(b => b.pathname.endsWith(filename));
      console.log(`[Blob API] Trying with basename: ${filename}`);
    }
    
    // Try with atacama-blobs prefix
    if (!blob) {
      const prefixedPath = `atacama-blobs/${path.basename(normalizedPath)}`;
      blob = blobs.find(b => b.pathname === prefixedPath);
      console.log(`[Blob API] Trying with prefix: ${prefixedPath}`);
    }
    
    if (blob) {
      console.log(`[Blob API] Found blob: ${blob.pathname} with URL: ${blob.url}`);
      return NextResponse.json({ url: blob.url });
    }
    
    // If blob not found, return an appropriate error
    console.warn(`[Blob API] No blob found for path: ${normalizedPath}`);
    return NextResponse.json({ 
      error: 'Blob not found',
      requestedPath: normalizedPath
    }, { status: 404 });
  } catch (error) {
    console.error('Error in blob API:', error);
    return NextResponse.json({ 
      error: 'Failed to process request',
      message: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}