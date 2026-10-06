import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Oswald } from "next/font/google";

import "./globals.css";

// The same three faces the original tracker loaded, self-hosted by next/font so there
// is no render-blocking request to Google and no layout shift.
const oswald = Oswald({
  variable: "--font-oswald",
  weight: ["500", "600"],
  subsets: ["latin"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "600"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Saturday Fitness",
  description: "Weekly training plans that actually progress.",
};

export const viewport: Viewport = {
  // Used one-handed at a squat rack, so the layout is phone-first.
  width: "device-width",
  initialScale: 1,
  // Follows whichever theme the phone is in, matching the original tracker.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f2ed" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1013" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${oswald.variable} ${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
