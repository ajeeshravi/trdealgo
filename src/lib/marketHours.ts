"use client";
/**
 * Market-hours gating for client-side polling.
 *
 * Most pages in the app poll the backend with SWR's `refreshInterval`.
 * Outside trading hours the data can't change, so the polls just burn
 * CPU + battery + backend cycles for nothing. These helpers return a
 * "live" interval during market hours and 0 (= no polling) outside.
 *
 * US sessions in America/New_York (Mon–Fri only — exchange holidays are
 * not modelled here since they vary per year; that's a separate concern
 * handled by the backend's holiday calendar). DST is handled correctly
 * because the wall-clock is read via `Intl` for the New York zone:
 *   - EQ_FO  (regular equities / options session)             09:30 – 16:00
 *   - MCX    (extended: pre-market open → regular close)      04:00 – 16:00
 *   - CDS    (regular + after-hours)                          09:30 – 20:00
 *   - ANY    (union — pre-market through after-hours)         04:00 – 20:00
 *
 * The group keys are kept from the original (India) implementation so
 * existing call sites don't change; only the underlying hours moved to
 * US markets. Use `ANY` for endpoints that mix data (positions, orders,
 * strategies, dashboard tiles); use `EQ_FO` for the regular cash session.
 *
 * Open-transition handling: a singleton watcher inside this module
 * detects the closed→open transition and fires a global SWR `mutate()`
 * so every cached key revalidates *immediately* — without it, polls
 * that flipped from `refreshInterval=0` to e.g. `15000` would still
 * wait the full 15 s before refetching, leaving the UI showing stale
 * pre-open data well past 09:15.
 */
import { useEffect, useState } from "react";
import { mutate as globalSWRMutate } from "swr";

export type ExchangeGroup = "EQ_FO" | "MCX" | "CDS" | "ANY";

interface Session {
  /** Start of the trading session, ET minutes since midnight. */
  startMin: number;
  /** End of the trading session, ET minutes since midnight. */
  endMin: number;
}

const SESSIONS: Record<ExchangeGroup, Session> = {
  EQ_FO: { startMin: 9 * 60 + 30, endMin: 16 * 60 },
  MCX: { startMin: 4 * 60, endMin: 16 * 60 },
  CDS: { startMin: 9 * 60 + 30, endMin: 20 * 60 },
  ANY: { startMin: 4 * 60, endMin: 20 * 60 },
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Returns the current US/Eastern wall-clock as `{ weekday, minutesOfDay }`.
 *  Weekday: 0 = Sun … 6 = Sat. Uses `Intl` so DST (EST/EDT) is correct. */
function etNow(at?: Date): { weekday: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at ?? new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some engines emit "24" at midnight
  const minute = parseInt(get("minute"), 10);
  return {
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minutesOfDay: hour * 60 + minute,
  };
}

/** True when the given exchange-group session is open *right now* (ET). */
export function isMarketOpen(group: ExchangeGroup = "EQ_FO", at?: Date): boolean {
  const { weekday, minutesOfDay } = etNow(at);
  if (weekday === 0 || weekday === 6) return false; // Sun / Sat
  const s = SESSIONS[group];
  return minutesOfDay >= s.startMin && minutesOfDay <= s.endMin;
}

// ---- Open-transition watcher (singleton) ---------------------------------
// One window-wide interval tracks the open/closed state of every group
// we care about. When any group transitions closed→open we fire a
// global SWR `mutate()` so polls don't have to wait their full
// `refreshInterval` after market open before showing fresh prices.
//
// The 5 s tick keeps the worst-case post-open latency to ~5 s instead
// of the previous 30 s. Cost is negligible — a single setInterval that
// does four cheap arithmetic comparisons.
const TRACKED_GROUPS: ExchangeGroup[] = ["EQ_FO", "MCX", "CDS", "ANY"];
const watcherSubscribers = new Set<() => void>();
let watcherStarted = false;
const watcherLastOpen: Partial<Record<ExchangeGroup, boolean>> = {};

function ensureWatcher() {
  if (watcherStarted || typeof window === "undefined") return;
  watcherStarted = true;
  for (const g of TRACKED_GROUPS) watcherLastOpen[g] = isMarketOpen(g);
  window.setInterval(() => {
    let anyOpened = false;
    for (const g of TRACKED_GROUPS) {
      const cur = isMarketOpen(g);
      if (cur && !watcherLastOpen[g]) anyOpened = true;
      watcherLastOpen[g] = cur;
    }
    // Notify every subscribed `useMarketOpen` so their local state
    // reflects the new session status.
    watcherSubscribers.forEach((cb) => cb());
    // Force-refresh every SWR cache entry so the first post-open poll
    // happens *now*, not after refreshInterval ms.
    if (anyOpened) {
      globalSWRMutate(() => true, undefined, { revalidate: true });
    }
  }, 5_000);
}

/**
 * React hook: returns `true` when the market is open. State flips
 * automatically within ~5 s of a session boundary; closed→open
 * transitions also trigger a global SWR revalidation so polls show
 * fresh data immediately, not after their refresh interval elapses.
 */
export function useMarketOpen(group: ExchangeGroup = "EQ_FO"): boolean {
  const [open, setOpen] = useState<boolean>(() => isMarketOpen(group));
  useEffect(() => {
    ensureWatcher();
    const sync = () => setOpen((prev) => {
      const next = isMarketOpen(group);
      return next === prev ? prev : next;
    });
    sync();
    watcherSubscribers.add(sync);
    return () => {
      watcherSubscribers.delete(sync);
    };
  }, [group]);
  return open;
}

/**
 * SWR-friendly polling interval that collapses to 0 outside market
 * hours. Drop-in replacement for a numeric `refreshInterval` literal.
 *
 *   const ms = useMarketPollInterval(15_000);             // EQ_FO
 *   const ms = useMarketPollInterval(10_000, "ANY");      // 09:00–23:30
 *   const ms = useMarketPollInterval(10_000, "ANY", 300_000);
 *     // poll every 5 min after hours instead of stopping outright
 */
export function useMarketPollInterval(
  liveMs: number,
  group: ExchangeGroup = "EQ_FO",
  closedMs: number = 0,
): number {
  const open = useMarketOpen(group);
  return open ? liveMs : closedMs;
}
