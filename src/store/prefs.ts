"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TimezoneId = string;

export const COMMON_TIMEZONES: { id: TimezoneId; label: string }[] = [
  { id: "America/New_York", label: "ET · New York" },
  { id: "America/Chicago",  label: "CT · Chicago" },
  { id: "America/Denver",   label: "MT · Denver" },
  { id: "America/Los_Angeles", label: "PT · Los Angeles" },
  { id: "UTC",              label: "UTC" },
  { id: "Europe/London",    label: "London" },
  { id: "Europe/Frankfurt", label: "Frankfurt" },
  { id: "Asia/Tokyo",       label: "Tokyo" },
  { id: "Australia/Sydney", label: "Sydney" },
];

interface PrefsState {
  timezone: TimezoneId;
  setTimezone: (tz: TimezoneId) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      timezone: "America/New_York",
      setTimezone: (tz) => set({ timezone: tz }),
    }),
    { name: "prefs" },
  ),
);
