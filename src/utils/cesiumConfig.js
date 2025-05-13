// Configure Cesium to use assets from the public folder
import { Ion } from 'cesium';

// Configure Cesium to load assets from our public directory
// Only set this if it's not already set to avoid conflicts
if (typeof window !== 'undefined' && !window.CESIUM_BASE_URL) {
  window.CESIUM_BASE_URL = '/cesium';
}

// If you have a Cesium ion access token, you can set it here
// Ion.defaultAccessToken = 'your-token-here';

export const initCesium = () => {
  // Any additional Cesium configuration can go here
  console.log('Cesium configured with base URL:', window.CESIUM_BASE_URL);
  
  // Set additional Cesium options for better compatibility with COEP policies
  try {
    const Cesium = window.Cesium;
    if (Cesium && Cesium.RequestScheduler) {
      // Configure request headers for cross-origin requests
      Cesium.RequestScheduler.requestsByServer = {};
      
      // Configure default request headers
      if (Cesium.Resource) {
        Cesium.Resource.defaultHeaders = {
          ...Cesium.Resource.defaultHeaders,
          'Cross-Origin-Resource-Policy': 'cross-origin',
        };
      }
    }
  } catch (e) {
    console.warn('Could not set Cesium cross-origin configurations:', e);
  }
};
