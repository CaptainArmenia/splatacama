/** The map's orange spinner with a message under it, e.g. "Cargando mapa 3D..." */
export function LoadingMessage({ message }: { message: string }) {
  return (
    <div className="text-center" role="status">
      <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-orange-500 border-r-transparent align-[-0.125em]" />
      <p className="mt-2">{message}</p>
    </div>
  );
}
