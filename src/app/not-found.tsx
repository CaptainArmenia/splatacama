import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-screen w-screen items-center justify-center flex-col">
      <h1 className="text-2xl font-bold mb-4">Sitio no encontrado</h1>
      <Link href="/" className="text-blue-500 hover:underline">
        Volver al mapa
      </Link>
    </div>
  );
}
