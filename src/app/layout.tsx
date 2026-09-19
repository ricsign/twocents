import type { Metadata, Viewport } from "next";
import { nunito, pressStart, pixelify } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "twocents.ai",
  description:
    "Every friend gets an AI agent. The agents negotiate the trip. One plan nobody loses on.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2b1e14",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${nunito.variable} ${pressStart.variable} ${pixelify.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
