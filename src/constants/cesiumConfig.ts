// Default camera configuration - consolidated settings for initial view and reset
export const DEFAULT_CAMERA_CONFIG = {
  position: {
    height: 10800, // Height in meters
  },
  orientation: {
    heading: 34,    // North (in degrees, will be converted to radians)
    pitch: -30,    // 10-degree inclination (in degrees, will be converted to radians)
    roll: 0
  },
  animation: {
    duration: 2   // Animation duration in seconds (for reset only)
  }
};

// Marker configuration
export const MARKER_CONFIG = {
  defaultSize: 50,  // Increased from 40 to maintain quality at 3X scale
  selectedScale: 1.2,
  hoveredScale: 1.2,  // Increased from 1.1 to 3.0 for dramatic hover effect
  defaultScale: 1.0
};

// Cesium viewer configuration
export const VIEWER_CONFIG = {
  timeline: false,
  animation: false,
  sceneModePicker: false,
  baseLayerPicker: true,
  navigationHelpButton: false,
  homeButton: false,
  geocoder: false,
  fullscreenButton: false,
  vrButton: false,
  navigationInstructionsInitiallyVisible: false,
  selectionIndicator: true,
  infoBox: false
};

// Globe and scene settings
export const SCENE_CONFIG = {
  enableLighting: false,
  terrainExaggeration: 1.5,
  enableCollisionDetection: true,
  minimumZoomDistance: 500,
  maximumZoomDistance: 50000000
};