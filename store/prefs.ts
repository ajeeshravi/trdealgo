"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TimezoneId = string;

export const COMMON_TIMEZONES: { id: TimezoneId; label: string }[] = [
  { id: "Asia/Kolkata",     label: "IST · Mumbai" },
  { id: "UTC",              label: "UTC" },
  { id: "America/New_York", label: "New York" },
  { id: "America/Chicago",  label: "Chicago" },
  { id: "Europe/London",    label: "London" },
  { id: "Europe/Frankfurt", label: "Frankfurt" },
  { id: "Asia/Dubai",       label: "Dubai" },
  { id: "Asia/Singapore",   label: "Singapore" },
  { id: "Asia/Hong_Kong",   label: "Hong Kong" },
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
      timezone: "Asia/Kolkata",
      setTimezone: (tz) => set({ timezone: tz }),
    }),
    { name: "prefs" },
  ),
);
