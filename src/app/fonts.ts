import localFont from "next/font/local";

/**
 * The three families are self-hosted rather than pulled from Google Fonts.
 * A hackathon demo runs on venue wifi: nothing the room sees should depend on
 * a third-party request succeeding, at build time or at first paint.
 * All three are the latin subsets shipped with the original design bundle.
 */

/** Body text. Variable weight, so one file covers 400 through 800. */
export const nunito = localFont({
  src: "./fonts/nunito.woff2",
  variable: "--font-nunito",
  weight: "400 1000",
  display: "swap",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

/** The `.disp` face: ALL CAPS micro-labels and buttons, 7-12px only. */
export const pressStart = localFont({
  src: "./fonts/press-start-2p.woff2",
  variable: "--font-press-start",
  weight: "400",
  display: "swap",
  fallback: ["monospace"],
});

/** The `.head` face: names, headings and the big numbers. */
export const pixelify = localFont({
  src: "./fonts/pixelify-sans.woff2",
  variable: "--font-pixelify",
  weight: "400 700",
  display: "swap",
  fallback: ["sans-serif"],
});
