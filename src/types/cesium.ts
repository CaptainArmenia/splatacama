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