export interface MapLandmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  height: number;
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
}

export interface CesiumMapProps {
  landmarks: MapLandmark[];
  humboldtCenter: { lat: number; lng: number };
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
  urls: { [id: string]: string };
  loading: { [id: string]: boolean };
  errors: { [id: string]: boolean };
}