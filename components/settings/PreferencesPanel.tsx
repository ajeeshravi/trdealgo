"use client";
import { useEffect, useState } from "react";
import { TimezoneSelector } from "@/components/TimezoneSelector";
import { fmtTs } from "@/lib/fmt";
import { usePrefs } from "@/store/prefs";

/**
 * "Preferences" tab inside Settings. Currently exposes the display timezone
 * used by all tick timestamps + a live preview that updates as the user picks
 * a zone. Add new global prefs (theme, number format, default broker, …) here
 * — one card per topic, so the page stays scannable.
 *
 * The clock preview is mounted client-side only (`now` starts as `null` and
 * fills in via `useEffect`). Rendering `new Date()` directly on the server
 * produced a different string than the client immediately produced on hydration
 * — a textbook React hydration mismatch.
 */
export function PreferencesPanel() {
  const timezone = usePrefs((s) => s.timezone);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-base font-semibold mb-1">Display timezone</h2>
        <p className="text-xs text-muted-foreground mb-3">
          All tick timestamps, order timestamps, and live feed entries are shown in
          this timezone. Internally the platform always stores UTC — only the display
          changes. Pick whichever market you trade.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <TimezoneSelector className="input text-sm py-1.5 w-64" />
          <span className="text-xs text-muted-foreground" suppressHydrationWarning>
            Now in <span className="font-mono text-gray-200">{timezone}</span>:
            <span className="ml-2 font-mono text-primary">
              {now ? fmtTs(now, timezone) : "—"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
