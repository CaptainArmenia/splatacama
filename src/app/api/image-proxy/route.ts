import { NextRequest, NextResponse } from 'next/server';
import { isR2AssetUrl } from '@/utils/blobUtils';

// Image types passed through as is. SVG is left out on purpose: it can carry scripts.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/**
 * Proxies files from this site's R2 bucket (preview images and .splat scenes) to avoid CORS issues.
 */
export async function GET(request: NextRequest) {
  try {
    const assetUrl = request.nextUrl.searchParams.get('url');

    if (!assetUrl) {
      return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    // Only fetch from this site's R2 bucket, so the route can't be used to fetch or serve anything else
    if (!isR2AssetUrl(assetUrl)) {
      return NextResponse.json({ error: 'Invalid image source' }, { status: 400 });
    }

    const response = await fetch(assetUrl, {
      headers: {
        'User-Agent': 'Splatacama/1.0',
      },
    });

    if (!response.ok || !response.body) {
      return NextResponse.json({ error: 'Failed to fetch image' }, { status: response.ok ? 502 : response.status });
    }

    // Anything that isn't a known image type (such as a .splat file) is sent as opaque binary
    const upstreamType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': IMAGE_TYPES.includes(upstreamType) ? upstreamType : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // s-maxage lets the CDN cache the response as well as the browser (24 hours)
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    };

    // Pass the length through so the splat viewer can show download progress. fetch() decompresses
    // encoded responses, so the upstream length only matches the body when there was no encoding.
    const contentLength = response.headers.get('content-length');
    if (contentLength && !response.headers.get('content-encoding')) {
      headers['Content-Length'] = contentLength;
    }

    // Stream the body through instead of holding the whole file in memory (splats are about 30 MB)
    return new NextResponse(response.body, { status: 200, headers });

  } catch (error) {
    console.error('Image proxy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
