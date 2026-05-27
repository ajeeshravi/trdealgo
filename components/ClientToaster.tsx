"use client";
import { useEffect, useState } from "react";
import { Toaster } from "react-hot-toast";

/**
 * Client-only wrapper around react-hot-toast's `<Toaster>`.
 *
 * Avoids the "Extra attributes from the server: bis_skin_checked" (and the
 * Grammarly / LastPass / ColorZilla variants) hydration warnings. Those
 * extensions scan the DOM between the server-side HTML landing and React
 * hydrating, stamping attributes onto every `<div>` they pass through —
 * including the one react-hot-toast renders. By withholding the Toaster
 * subtree from the SSR pass and mounting it after `useEffect` runs, there
 * is no server-rendered HTML for the extension-mutated client DOM to
 * disagree with, so React never compares them.
 *
 * Toasts only fire in response to user interaction, so they have no SEO
 * or first-paint value — losing the SSR pass for this one subtree is free.
 */
export function ClientToaster() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        style: {
          background: "hsl(var(--card))",
          color: "hsl(var(--card-foreground))",
          border: "1px solid hsl(var(--border))",
        },
      }}
    />
  );
}
