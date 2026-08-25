import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { EnergyAtmosphere } from "./components/EnergyAtmosphere";
import { WeatherThemeProvider } from "./components/WeatherTheme";
import { IngestionPinger } from "./components/IngestionPinger";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export function generateMetadata(): Metadata {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const origin = configuredOrigin && URL.canParse(configuredOrigin)
    ? new URL(configuredOrigin).origin
    : "http://localhost:3000";
  const title = "Gridline — Home energy intelligence";
  const description = "Live energy monitoring, history, devices, logs, and automation for your home.";
  return {
    metadataBase: new URL(origin), title, description,
    openGraph: { title, description, type: "website", url: origin, images: [{ url: `${origin}/og.png`, width: 1732, height: 908, alt: "Gridline home energy intelligence" }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}><WeatherThemeProvider><EnergyAtmosphere /><IngestionPinger />{children}</WeatherThemeProvider></body></html>;
}
