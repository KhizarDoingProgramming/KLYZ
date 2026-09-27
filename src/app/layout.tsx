import type { Metadata, Viewport } from "next";
import "@fontsource-variable/archivo/standard";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "KLYZ — Automate what happens next",
    template: "%s · KLYZ",
  },
  description:
    "KLYZ is a visual automation platform. Connect events, data, logic, APIs and AI into workflows you can watch, inspect and control.",
  applicationName: "KLYZ",
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a09" },
    { media: "(prefers-color-scheme: light)", color: "#eae7df" },
  ],
  width: "device-width",
  initialScale: 1,
};

/**
 * Applies the stored theme before first paint so there is no flash.
 * KLYZ ships dark-first; light is a first-class, separately designed theme.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("klyz.theme");if(t!=="light"&&t!=="dark"){t="dark";}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
