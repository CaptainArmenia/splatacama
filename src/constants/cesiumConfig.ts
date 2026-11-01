// Default camera configuration - consolidated settings for initial view and reset
export const DEFAULT_CAMERA_CONFIG = {
  // Humboldt Archipelago (approximate center); the camera starts above this point and resets to it
  center: { lat: -29.168210, lng: -71.599582 },
  position: {
    height: 10800, // Height in meters
  },
  orientation: {
    heading: 34,   // Degrees clockwise from north: looking northeast
    pitch: -30,    // Degrees below the horizon
    roll: 0
  },
  animation: {
    duration: 2   // Animation duration in seconds (for reset only)
  }
};

// Marker configuration
export const MARKER_CONFIG = {
  defaultSize: 50,  // Pin diameter on screen, in pixels
  selectedScale: 1.2,   // Pins grow 20% when selected or hovered
  hoveredScale: 1.2,
  defaultScale: 1.0,
  clusterDistance: 44,   // Pins whose centers are closer than this (in pixels, about one pin width) merge into a cluster
  explodeRadius: 45,     // How far (in pixels) a clicked cluster fans its pins out from their shared location
  clusterSize: 60,       // On-screen size of a cluster marker (a stack of its pins plus a count badge)
  textureScale: 2        // Marker images are drawn at this multiple of their on-screen size so they stay sharp
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
  infoBox: false,
  // Only redraw when something changes, instead of 60 times a second while idle. Code that changes pins
  // or clusters must call scene.requestRender() (camera moves and tile loads request one automatically).
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity
};

// Globe and scene settings
export const SCENE_CONFIG = {
  enableLighting: false,
  verticalExaggeration: 1.5, // Terrain drawn 1.5x taller than it is
  enableCollisionDetection: true,
  minimumZoomDistance: 500,
  maximumZoomDistance: 50000000
};