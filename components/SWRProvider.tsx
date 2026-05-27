"use client";
import { SWRConfig } from "swr";
import { api } from "@/lib/api";

const defaultFetcher = (url: string) => api.get(url).then((r) => r.data);

/**
 * Single SWR config for the whole app. Keeps per-hook call sites short
 * and, more importantly, applies dedupe + focus-revalidation defaults so
 * mounting the dashboard doesn't fire 8 simultaneous duplicate requests
 * for the same endpoint when several widgets happen to share a key.
 */
export function SWRProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher: defaultFetcher,
        // Two widgets asking for the same key within 2s share one request.
        dedupingInterval: 2000,
        // Don't slam the backend the moment the user alt-tabs back.
        revalidateOnFocus: false,
        // Keep last-known data on screen while the next page loads so the
        // UI doesn't flash skeletons every refresh.
        keepPreviousData: true,
        // One retry is plenty; the SWR default of 5 with exponential
        // backoff piles up requests on a flaky backend.
        errorRetryCount: 1,
        errorRetryInterval: 4000,
      }}
    >
      {children}
    </SWRConfig>
  );
}
