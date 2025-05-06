// Enhanced Cesium loader with better type handling

// We're defining a global namespace for Cesium modules
declare global {
  interface Window {
    Cesium: any;
  }
}

let Cesium: any = null;

/**
 * Load Cesium dynamically and make it available globally
 */
export async function loadCesium() {
  // Skip on server-side
  if (typeof window === 'undefined') {
    return null;
  }
  
  // Return cached instance if available
  if (window.Cesium || Cesium) {
    return window.Cesium || Cesium;
  }
  
  try {
    // Dynamically import Cesium
    const cesiumModule = await import('cesium');
    
    // Set default token
    cesiumModule.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN || 'REMOVED_OLD_CESIUM_TOKEN';
    
    // Save to both module and window scopes
    Cesium = cesiumModule;
    window.Cesium = cesiumModule;
    
    // Import CSS (handled by webpack)
    try {
      // Use require for CSS to handle any bundler quirks
      require('cesium/Build/Cesium/Widgets/widgets.css');
    } catch (cssError) {
      console.warn('Could not load Cesium CSS:', cssError);
    }
    
    return cesiumModule;
  } catch (error) {
    console.error('Failed to load Cesium:', error);
    throw new Error(`Cesium loading failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Checks if Cesium is already loaded
 */
export function isCesiumLoaded(): boolean {
  return typeof window !== 'undefined' && (!!window.Cesium || !!Cesium);
}

/**
 * Get the loaded Cesium module without triggering a load
 */
export function getCesium(): any {
  return typeof window !== 'undefined' ? (window.Cesium || Cesium) : null;
}

export default loadCesium;
