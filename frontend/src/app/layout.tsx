import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "P&ID Intelligence",
  description:
    "Ask engineering questions about a corpus of P&IDs, topology files and documents. " +
    "Answers cite the drawings they rest on.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom is not capped. Restricting it breaks the 200% text-zoom requirement and is a
  // direct accessibility failure on touch devices.
  maximumScale: 5,
  // Matches --bg-canvas. The browser paints chrome with this before any CSS loads, so it
  // is the one place a literal is unavoidable; keep it in step with the token.
  themeColor: "#151619",
};

/**
 * The root layout.
 *
 * Deliberately minimal: no font request, no analytics, no provider stack. The application
 * needs none of them, and each would be another thing that can fail between the user and
 * the answer.
 */
export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
