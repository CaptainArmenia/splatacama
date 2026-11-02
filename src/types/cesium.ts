export interface MapLandmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  height: number;
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
  // Small image for the map pin; the pin falls back to previewUrl if it's missing or fails to load
  thumbnailUrl?: string;
  // Where the splat viewer's camera may go; unset fields use the viewer's defaults
  view?: ViewLimits;
}

// Camera limits for one site, chosen from renders so the views stay where the photos make the scene look right.
// Distances are in viewer units: the site's main structure spans about 8 units. Angles are in degrees from straight
// overhead (90 = level with the site's ground).
export interface ViewLimits {
  minDistance?: number;
  maxDistance?: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  // [from, to]: the directions the camera may go low from (maxPolarAngle), in degrees around the site from the start
  // camera's side, clockwise seen from above. Elsewhere it stays at maxPolarAngleOutsideArc or higher.
  lowViewArc?: number[];
  maxPolarAngleOutsideArc?: number;
}

export interface CesiumMapProps {
  landmarks: MapLandmark[];
  selectedLandmark: MapLandmark | null;
  setSelectedLandmark: (landmark: MapLandmark | null) => void;
  setErrorState: (error: string | null) => void;
  showCameraPosition: boolean;
  preventPinOcclusion: boolean;
}

export interface CameraPosition {
  latitude: number;
  longitude: number;
  height: number;
  heading: number;
  pitch: number;
}

export interface PreviewUrlsState {
  urls: { [id: string]: string };     // preview images, for the info panels
  pinUrls: { [id: string]: string };  // thumbnails for pins, or the preview when there's no thumbnail
}