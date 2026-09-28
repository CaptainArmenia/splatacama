import { MARKER_CONFIG } from '@/constants/cesiumConfig';

const PIN_RING_COLOR = '#FFFFFF';
const PIN_FALLBACK_COLOR = '#dd6b20';
const BADGE_COLOR = '#ea580c'; // Tailwind orange-600, the accent used in the panels

/**
 * Creates a canvas for a marker `size` pixels across on screen. Its backing store is MARKER_CONFIG.textureScale
 * times larger and the context is pre-scaled, so drawing code works in on-screen pixels while the texture stays
 * sharp on high-density screens.
 */
const createMarkerCanvas = (size: number) => {
  const scale = MARKER_CONFIG.textureScale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * scale);
  canvas.height = Math.round(size * scale);
  const ctx = canvas.getContext('2d');
  ctx?.scale(scale, scale);
  return { canvas, ctx };
};

/**
 * Draws the white disc every pin sits on, with a soft shadow so pins stand out on bright imagery.
 * Returns the radius left inside the white ring.
 */
const drawPinBase = (ctx: CanvasRenderingContext2D, size: number): number => {
  const radius = size / 2 - 3; // leave room for the shadow
  ctx.save();
  // Shadow settings ignore the context's scale, so they're given in backing-store pixels
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 4 * MARKER_CONFIG.textureScale;
  ctx.shadowOffsetY = 1 * MARKER_CONFIG.textureScale;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
  ctx.fillStyle = PIN_RING_COLOR;
  ctx.fill();
  ctx.restore();
  return radius - 3; // 3 px white ring
};

/**
 * Draws the center square of an image as a circle. The circle is cut with a composited mask on a scratch
 * canvas, which gives antialiased edges; clip() can leave them jagged.
 */
const drawImageInCircle = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  radius: number
) => {
  const diameter = Math.round(2 * radius * MARKER_CONFIG.textureScale);
  const scratch = document.createElement('canvas');
  scratch.width = diameter;
  scratch.height = diameter;
  const s = scratch.getContext('2d');
  if (!s) return;

  const side = Math.min(img.naturalWidth, img.naturalHeight);
  s.imageSmoothingQuality = 'high';
  s.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, diameter, diameter);
  s.globalCompositeOperation = 'destination-in';
  s.beginPath();
  s.arc(diameter / 2, diameter / 2, diameter / 2, 0, Math.PI * 2);
  s.fill();

  ctx.drawImage(scratch, cx - radius, cy - radius, 2 * radius, 2 * radius);
};

/**
 * Creates a circular image canvas from an image URL with robust CORS handling. If the image can't be loaded,
 * tries `fallbackUrl` (e.g. the full preview when a thumbnail is missing), then the plain orange marker.
 */
export const createCircularImageCanvas = (
  imageUrl: string,
  size: number = MARKER_CONFIG.defaultSize,
  fallbackUrl?: string
): Promise<HTMLCanvasElement> => {
  const loadFallback = (): Promise<HTMLCanvasElement> | HTMLCanvasElement =>
    fallbackUrl && fallbackUrl !== imageUrl ? createCircularImageCanvas(fallbackUrl, size) : createFallbackMarker(size);

  return new Promise((resolve) => {
    const { canvas, ctx } = createMarkerCanvas(size);

    if (!ctx) {
      console.warn('Could not get canvas context, using fallback');
      resolve(createFallbackMarker(size));
      return;
    }

    const img = new Image();

    const drawImageToCanvas = () => {
      try {
        const innerRadius = drawPinBase(ctx, size);
        drawImageInCircle(ctx, img, size / 2, size / 2, innerRadius);
        resolve(canvas);
      } catch (error) {
        console.warn('Canvas drawing error, using fallback:', error);
        resolve(createFallbackMarker(size));
      }
    };

    // Set up error handler - use fallback on any error
    img.onerror = () => {
      console.warn('Image load failed, using fallback for:', imageUrl);
      resolve(loadFallback());
    };

    // Set up success handler
    img.onload = drawImageToCanvas;

    // Add timeout
    const timeout = setTimeout(() => {
      if (!img.complete) {
        img.src = ''; // Cancel request
        console.warn('Image load timed out, using fallback for:', imageUrl);
        resolve(loadFallback());
      }
    }, 5000); // 5 second timeout

    // Clear timeout on completion
    const originalOnload = img.onload;
    const originalOnerror = img.onerror;

    img.onload = (ev: Event) => {
      clearTimeout(timeout);
      if (originalOnload) originalOnload.call(img, ev);
    };

    img.onerror = (ev: Event | string) => {
      clearTimeout(timeout);
      if (originalOnerror) originalOnerror.call(img, ev);
    };

    // Always use CORS to prevent canvas tainting for WebGL
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;
  });
};

/**
 * Creates a fallback marker canvas: the same white-ringed pin, filled orange instead of a photo
 */
export const createFallbackMarker = (size: number = MARKER_CONFIG.defaultSize): HTMLCanvasElement => {
  const { canvas, ctx } = createMarkerCanvas(size);

  if (ctx) {
    const innerRadius = drawPinBase(ctx, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = PIN_FALLBACK_COLOR;
    ctx.fill();
  }

  return canvas;
};

const markerImageIds = new WeakMap<object, number>();
let nextMarkerImageId = 1;

/**
 * Stable id for a pin image object, so cluster markers can be cached by the pin images they show.
 */
export const getMarkerImageId = (image: object): number => {
  if (!markerImageIds.has(image)) {
    markerImageIds.set(image, nextMarkerImageId++);
  }
  return markerImageIds.get(image) as number;
};

const clusterMarkerCache: { [key: string]: string } = {};

/**
 * Creates the marker for a cluster of overlapping pins: two of its pins stacked, with an orange badge
 * showing how many sites are there.
 * Returned as a data URL because Cesium keys billboard textures by URL; a canvas would get a new texture on
 * every recluster. `cacheKey` must change whenever `pinImages` do.
 */
export const createClusterMarker = (
  count: number,
  pinImages: CanvasImageSource[],
  cacheKey: string,
  size: number = MARKER_CONFIG.clusterSize
): string => {
  if (clusterMarkerCache[cacheKey]) {
    return clusterMarkerCache[cacheKey];
  }

  const { canvas, ctx } = createMarkerCanvas(size);

  if (ctx) {
    const pinSize = MARKER_CONFIG.defaultSize * 0.9;
    const back = pinImages[1] ?? createFallbackMarker();
    const front = pinImages[0] ?? createFallbackMarker();

    // Back pin up and to the right, front pin down and to the left
    ctx.drawImage(back, size - pinSize - 1, 1, pinSize, pinSize);
    ctx.drawImage(front, 1, size - pinSize - 1, pinSize, pinSize);

    // Count badge in the top-right corner
    const badgeRadius = 10;
    const bx = size - badgeRadius - 2;
    const by = badgeRadius + 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3 * MARKER_CONFIG.textureScale;
    ctx.shadowOffsetY = 1 * MARKER_CONFIG.textureScale;
    ctx.beginPath();
    ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
    ctx.fillStyle = PIN_RING_COLOR;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(bx, by, badgeRadius - 2, 0, Math.PI * 2);
    ctx.fillStyle = BADGE_COLOR;
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${count > 9 ? 10 : 12}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), bx, by + 0.5);
  }

  clusterMarkerCache[cacheKey] = canvas.toDataURL();
  return clusterMarkerCache[cacheKey];
};

/**
 * Generates cache key for marker canvases
 */
export const getCacheKey = (landmarkId: string, hasPreviewImage: boolean): string => {
  return `${landmarkId}_${hasPreviewImage ? 'img' : 'fallback'}`;
};
