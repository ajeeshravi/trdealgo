"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import marketDataService from "@/services/marketDataService";
import type { MarketIndex } from "@/lib/marketTypes";
import { useMarketOpen } from "@/lib/marketHours";

interface Options {
  /** Polling cadence in ms. Defaults to 2_500 (2.5 seconds). */
  refreshInterval?: number;
  /** When false, polling stops. */
  autoRefresh?: boolean;
}

/**
 * Dashboard's index strip + drill-down feed.
 *
 * Splits the registry into the five primary cards (always visible) and
 * the remaining "secondary" indices (toggled behind View All). Both
 * arrays are sorted to match the registry order so the dashboard
 * never re-orders mid-flight.
 *
 * Polling cadence is 1 second so the cards tick visibly in step with
 * the broker's WS feed. Each poll is a single `/market/snapshot` call
 * that reads the Redis `ltp:*` cache (sub-millisecond when the WS feed
 * is alive). The 2-tier cache (LTP 30s TTL + meta 8h TTL) means the
 * broker REST endpoint is hit at most once per 30s per symbol even at
 * this cadence — and effectively never while WS ticks are flowing.
 */
export function useLiveMarketIndices(opts: Options = {}) {
  // 2.5s strikes a balance: snapshot endpoint hits Redis sub-ms but each
  // poll still re-renders 30+ IndexCards. At 1s the dashboard burns ~30%
  // of one core just animating tick flashes — the visible "slow UI".
  //
  // Indices are NSE/BSE equity benchmarks — gate the poll to NSE/BSE
  // session hours (09:15–15:30 IST Mon-Fri). Outside that window LTP
  // can't change, so polling burns CPU and re-renders for nothing.
  const liveMs = opts.autoRefresh === false ? 0 : opts.refreshInterval ?? 2500;
  const marketOpen = useMarketOpen("EQ_FO");
  const refreshInterval = marketOpen ? liveMs : 0;
  const { data, error, isLoading } = useSWR<MarketIndex[]>(
    "live-market-indices",
    () => marketDataService.getMarketIndices(),
    {
      refreshInterval,
      dedupingInterval: Math.min(2000, Math.max(500, refreshInterval / 2)),
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    if (data) setLastUpdated(new Date());
  }, [data]);

  // Pre-index the registry once so the split below is O(n) instead of
  // O(n²) — at 30+ indices the .find inside .filter was running 900
  // string comparisons every poll.
  const primaryIds = useMemo(
    () => new Set(marketDataService.registry.filter((r) => r.primary).map((r) => r.id)),
    [],
  );

  const { primaryIndices, secondaryIndices } = useMemo(() => {
    const all = data ?? [];
    const primary: MarketIndex[] = [];
    const secondary: MarketIndex[] = [];
    for (const idx of all) {
      if (primaryIds.has(idx.id)) primary.push(idx);
      else secondary.push(idx);
    }
    return { primaryIndices: primary, secondaryIndices: secondary };
  }, [data, primaryIds]);

  return {
    indices: data ?? [],
    primaryIndices,
    secondaryIndices,
    loading: isLoading,
    error: error ? (error as Error).message : null,
    lastUpdated,
  };
}
