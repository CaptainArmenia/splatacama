import { MARKER_CONFIG } from '@/constants/cesiumConfig';

/**
 * Creates a circular image canvas from a preview URL with robust CORS handling
 */
export const createCircularImageCanvas = (
  imageUrl: string, 
  size: number = MARKER_CONFIG.defaultSize
): Promise<HTMLCanvasElement> => {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      console.warn('Could not get canvas context, using fallback');
      resolve(createFallbackMarker(size));
      return;
    }
    
    const img = new Image();
    
    const drawImageToCanvas = () => {
      try {
        // Create circular clipping path
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        
        // Draw image
        ctx.drawImage(img, 0, 0, size, size);
        
        // Add simple white border
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
        
        resolve(canvas);
      } catch (error) {
        console.warn('Canvas drawing error, using fallback:', error);
        resolve(createFallbackMarker(size));
      }
    };
    
    // Set up error handler - use fallback on any error
    img.onerror = () => {
      console.warn('Image load failed, using fallback for:', imageUrl);
      resolve(createFallbackMarker(size));
    };
    
    // Set up success handler
    img.onload = drawImageToCanvas;
    
    // Add timeout
    const timeout = setTimeout(() => {
      if (!img.complete) {
        img.src = ''; // Cancel request
        console.warn('Image load timed out, using fallback for:', imageUrl);
        resolve(createFallbackMarker(size));
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
 * Creates a fallback marker canvas
 */
export const createFallbackMarker = (size: number = MARKER_CONFIG.defaultSize): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  if (ctx) {
    // Fill circle with orange color
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = '#dd6b20';
    ctx.fill();
    
    // Add white border
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
  }
  
  return canvas;
};

/**
 * Generates cache key for marker canvases
 */
export const getCacheKey = (landmarkId: string, hasPreviewImage: boolean): string => {
  return `${landmarkId}_${hasPreviewImage ? 'img' : 'fallback'}`;
};