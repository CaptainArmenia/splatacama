// Configure Cesium to use assets from the public folder
import { Ion } from 'cesium';

// Configure Cesium to load assets from our public directory
window.CESIUM_BASE_URL = '/cesium';

// If you have a Cesium ion access token, you can set it here
// Ion.defaultAccessToken = 'your-token-here';

export const initCesium = () => {
  // Any additional Cesium configuration can go here
  console.log('Cesium configured with base URL:', window.CESIUM_BASE_URL);
};
