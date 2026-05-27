import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "@/styles/globals.css";

import { ClientToaster } from "@/components/ClientToaster";

// `adjustFontFallback` is the important one when next/font can't reach Google
// Fonts (corporate cert chain, offline build, etc.) — Next emits a size-adjusted
// @font-face for the fallback so the system font ends up with Inter's metrics.
// Without it the rendered text gets noticeably taller/wider and breaks every
// component sized around Inter (cards, sidebar, headers).
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: true,
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  adjustFontFallback: true,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
});

export const metadata: Metadata = {
  title: "AlgoTrade",
  description: "Multi-broker algo trading for Indian markets",
};

// Inline pre-hydration script — synchronously applies the stored theme to <html>
// before React mounts, avoiding the dark→light flash for light-mode users.
// One line, no leading/trailing newlines: the SSR/client serialization of a
// multi-line `dangerouslySetInnerHTML` payload diverges under Next's dev
// HMR (server emits `""`, client re-emits the trimmed string), which is
// what triggers the "Prop `dangerouslySetInnerHTML` did not match" warning.
// Collapsing to a single line and adding `suppressHydrationWarning` on the
// script element itself is the standard Next.js fix for this pattern.
const themeInitScript = `(function(){try{var t=localStorage.getItem('app-theme');if(t==='light'){document.documentElement.classList.add('light');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body
        suppressHydrationWarning
        className="min-h-screen bg-background text-foreground font-sans antialiased"
      >
        <ClientToaster />
        {children}
      </body>
    </html>
  );
}
