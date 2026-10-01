import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voz Clara — Estudio de pronunciación",
  description:
    "Práctica guiada de mantras e idiomas con voz en tiempo real.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0a08",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
