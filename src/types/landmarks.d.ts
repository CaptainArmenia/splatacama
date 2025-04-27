declare module '@/data/landmarks.json' {
  interface Landmark {
    id: string;
    name: string;
    description: string;
    lat: number;
    lon: number;
    gsplatUrl: string;
    previewUrl?: string;
  }

  const landmarks: Landmark[];
  export default landmarks;
}
