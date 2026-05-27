"use client";
import { COMMON_TIMEZONES, usePrefs } from "@/store/prefs";

/**
 * Compact dropdown that switches the global display timezone for live ticks
 * and any other timestamp routed through `fmtTs(ts, tz)`. The choice is
 * persisted in localStorage via the prefs store, so users only pick once.
 */
export function TimezoneSelector({ className }: { className?: string }) {
  const timezone = usePrefs((s) => s.timezone);
  const setTimezone = usePrefs((s) => s.setTimezone);
  // If the user previously picked something exotic, surface it as the first
  // option so it stays selectable even though it's not in COMMON_TIMEZONES.
  const known = COMMON_TIMEZONES.some((t) => t.id === timezone);
  return (
    <select
      className={className ?? "input text-xs py-1 w-auto"}
      value={timezone}
      onChange={(e) => setTimezone(e.target.value)}
      title="Display timezone for tick timestamps"
    >
      {!known && <option value={timezone}>{timezone}</option>}
      {COMMON_TIMEZONES.map((tz) => (
        <option key={tz.id} value={tz.id}>
          {tz.label}
        </option>
      ))}
    </select>
  );
}
