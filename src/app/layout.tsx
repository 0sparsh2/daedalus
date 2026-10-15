import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const ui = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-ui", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono", display: "swap" });
const display = Fraunces({ subsets: ["latin"], weight: ["500"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Daedalus — build apps by describing them",
  description: "Describe an app in plain words. Daedalus plans it, builds it in a live sandbox, checks its own work, and ships it.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
