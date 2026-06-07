"use client";
/**
 * Read-side aggregator for everything the Dashboard's live widgets
 * need but isn't its own single endpoint. Wraps several backend
 * routes; when a route is unavailable it returns null / empty arrays
 * so the UI can render a calm "no data" state rather than fake
 * numbers.
 *
 * Real backends used:
 *   - /api/v1/market/ltp?symbols=…              → live LTPs
 *   - /api/v1/eod/indices/{trade_date}          → prev_close / OHLC
 *   - /api/v1/eod/pcr/SPY/{trade_date}        → PCR
 *   - /api/v1/eod/breadth/{trade_date}          → advances / declines
 *   - /api/v1/institutional/cash-flow/summary   → FII / DII totals
 *   - /api/v1/eod/candles/VIXY?days=10 → VIX history
 *   - /api/v1/notifications                     → news ticker fallback
 *
 * For VIX live change% we approximate using `(LTP - prev_close)`. If
 * any endpoint is unavailable, we degrade gracefully with sensible
 * defaults rather than throwing.
 */
import { api } from "@/lib/api";
import type { MarketIndex, MarketSentiment, NewsAnnouncement } from "@/lib/marketTypes";

/**
 * Canonical index roster — US markets.
 *
 *  - `primary: true`  → shown in the dashboard's top index strip (5 cards).
 *  - `primary: false` → revealed when "View All" is toggled.
 *
 *  US cash indices (S&P 500, Dow, Nasdaq) aren't directly tradable, and the
 *  Alpaca/IBKR data feeds quote plain tickers, so each row uses a liquid ETF
 *  proxy as its `internal_symbol` (SPY for the S&P 500, QQQ for the Nasdaq
 *  100, the SPDR sector ETFs for sectors, etc.). When a true index feed is
 *  wired up later, swap the symbols here — nothing else depends on the proxy.
 *
 *  `sector_key` is the GICS sector name; it drives the heatmap drill-down
 *  once a constituent list is seeded. Rows without one leave it undefined and
 *  the StockHeatmap shows a calm "No constituent list seeded" message.
 *
 *  Order matters: array iteration drives card rendering order.
 */
export const US_INDEX_REGISTRY: Array<{
  id: string;
  name: string;
  short?: string;
  internal_symbol: string;
  primary: boolean;
  sector_key?: string;
}> = [
  // -------- Primary (top strip) --------
  { id: "sp500",    name: "S&P 500",        short: "SPX",     internal_symbol: "SPY",  primary: true,  sector_key: "S&P 500" },
  { id: "dow",      name: "DOW JONES",      short: "DJIA",    internal_symbol: "DIA",  primary: true,  sector_key: "Dow 30" },
  { id: "nasdaq",   name: "NASDAQ 100",     short: "NDX",     internal_symbol: "QQQ",  primary: true,  sector_key: "Nasdaq 100" },
  { id: "russell",  name: "RUSSELL 2000",   short: "RUT",     internal_symbol: "IWM",  primary: true },
  { id: "vix",      name: "VOLATILITY (VIX)", short: "VIX",   internal_symbol: "VIXY", primary: true },

  // -------- Sectoral (View All) — SPDR Select Sector ETFs --------
  { id: "tech",       name: "TECHNOLOGY",             short: "XLK",  internal_symbol: "XLK",  primary: false, sector_key: "Information Technology" },
  { id: "financials", name: "FINANCIALS",            short: "XLF",  internal_symbol: "XLF",  primary: false, sector_key: "Financials" },
  { id: "health",     name: "HEALTH CARE",           short: "XLV",  internal_symbol: "XLV",  primary: false, sector_key: "Health Care" },
  { id: "energy",     name: "ENERGY",                short: "XLE",  internal_symbol: "XLE",  primary: false, sector_key: "Energy" },
  { id: "discretion", name: "CONSUMER DISCRETIONARY", short: "XLY", internal_symbol: "XLY",  primary: false, sector_key: "Consumer Discretionary" },
  { id: "staples",    name: "CONSUMER STAPLES",      short: "XLP",  internal_symbol: "XLP",  primary: false, sector_key: "Consumer Staples" },
  { id: "industrials",name: "INDUSTRIALS",           short: "XLI",  internal_symbol: "XLI",  primary: false, sector_key: "Industrials" },
  { id: "materials",  name: "MATERIALS",             short: "XLB",  internal_symbol: "XLB",  primary: false, sector_key: "Materials" },
  { id: "utilities",  name: "UTILITIES",             short: "XLU",  internal_symbol: "XLU",  primary: false, sector_key: "Utilities" },
  { id: "realestate", name: "REAL ESTATE",           short: "XLRE", internal_symbol: "XLRE", primary: false, sector_key: "Real Estate" },
  { id: "comm",       name: "COMMUNICATION SVCS",    short: "XLC",  internal_symbol: "XLC",  primary: false, sector_key: "Communication Services" },

  // -------- Broad market --------
  { id: "total_market", name: "TOTAL MARKET",       short: "VTI",  internal_symbol: "VTI",  primary: false },
  { id: "midcap",       name: "S&P MIDCAP 400",     short: "MID",  internal_symbol: "MDY",  primary: false },
  { id: "smallcap",     name: "S&P SMALLCAP 600",   short: "SML",  internal_symbol: "IJR",  primary: false },
  { id: "nasdaq_comp",  name: "NASDAQ COMPOSITE",   short: "COMP", internal_symbol: "ONEQ", primary: false },
];

const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

async function safeGet<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await api.get(url);
    return r.data as T;
  } catch {
    return fallback;
  }
}

/**
 * Latest trade dates the backend has actually ingested. Used to back
 * off from "today" (which may not be available until evening) to the
 * most recent date that DOES have data. Cached for the lifetime of the
 * tab — the dashboard refetches when the user reloads.
 */
interface LatestTradeDates {
  candles_1d: string | null;
  fo_oi: string | null;
  institutional: string | null;
}
let _latestDatesCache: Promise<LatestTradeDates> | null = null;
function getLatestTradeDates(): Promise<LatestTradeDates> {
  if (!_latestDatesCache) {
    _latestDatesCache = safeGet<LatestTradeDates>(
      "/eod/latest-trade-date",
      { candles_1d: null, fo_oi: null, institutional: null },
    );
  }
  return _latestDatesCache;
}

/**
 * Build the full MarketIndex[] by composing /market/ltp (live) with
 * /eod/indices (prev close). An index with neither a live LTP nor a
 * 1d candle returns null fields — the IndexCard renders "—" for those
 * instead of fabricating a value.
 */
/** Single-row payload from `/market/snapshot`. */
interface SnapshotRow {
  ltp: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  source: "live" | "rest" | "eod" | "none";
}

async function fetchMarketIndices(): Promise<MarketIndex[]> {
  const symbols = US_INDEX_REGISTRY.map((r) => r.internal_symbol);
  // /market/snapshot is the dashboard's one-call endpoint: it tries
  // Redis (live tick) → broker REST quotes → most recent 1d candle.
  // Each row tells us its `source` so the UI can render a tiny
  // live/rest/eod badge later if we want.
  const snap = await safeGet<Record<string, SnapshotRow>>(
    `/market/snapshot?symbols=${encodeURIComponent(symbols.join(","))}`,
    {},
  );

  return US_INDEX_REGISTRY.map((r): MarketIndex => {
    const row = snap[r.internal_symbol];
    const live = row?.ltp ?? null;
    const prev = row?.prev_close ?? null;
    const change = live != null && prev != null ? live - prev : null;
    const change_pct = change != null && prev ? (change / prev) * 100 : null;
    return {
      id: r.id,
      name: r.name,
      short: r.short,
      internal_symbol: r.internal_symbol,
      sector_key: r.sector_key,
      value: live,
      change,
      change_pct,
      open: row?.open ?? undefined,
      high: row?.high ?? undefined,
      low: row?.low ?? undefined,
      prev_close: prev ?? undefined,
      isUp: change != null ? change >= 0 : undefined,
    };
  });
}

/**
 * Compose the Sentiment Widget payload — PCR + FII/DII + breadth + VIX.
 * Each block is independently nulled out when its backend endpoint
 * returns nothing; nothing is fabricated.
 */
async function fetchMarketSentiment(): Promise<MarketSentiment> {
  const today = TODAY_ISO();
  const latest = await getLatestTradeDates();
  // PCR comes from F&O OI history (FoOiHistory table). NSE publishes
  // the FO bhavcopy ~18:45 IST, well after equity bhavcopy. During
  // market hours / before that time we use the most recent FO date
  // available; otherwise PCR endpoint 422s with "no option data".
  const pcrDate = latest.fo_oi ?? today;
  const breadthDate = latest.candles_1d ?? today;

  const [pcr, breadth, instSummary, vixCandles, vixSnap] = await Promise.all([
    safeGet<{ pcr_oi: number | null } | null>(`/eod/pcr/SPY/${pcrDate}`, null),
    safeGet<{ advances: number; declines: number; unchanged: number } | null>(
      `/eod/breadth/${breadthDate}`,
      null,
    ),
    safeGet<{ daily: Array<{ category: string; net_value: number }> } | null>(
      `/institutional/cash-flow/summary`,
      null,
    ),
    safeGet<Array<{ ts: string; open: number; high: number; low: number; close: number }>>(
      `/eod/candles/VIXY?days=30`,
      [],
    ),
    // `/market/snapshot` does the full LTP → 1d → 1m fallback server-side,
    // so VIX renders even when NSE didn't ship it in today's ind_close_all
    // and only a brief intraday WS connection left 1m bars behind.
    safeGet<Record<string, { ltp: number | null; prev_close: number | null }>>(
      `/market/snapshot?symbols=VIXY`,
      {},
    ),
  ]);

  // VIX — pull the latest price from snapshot (with full fallback chain),
  // and the prior close from EOD candles when available. If both are
  // missing the block is null and the widget shows "—".
  const vixRow = vixSnap["VIXY"];
  const liveVix = vixRow?.ltp ?? null;
  const snapPrevClose = vixRow?.prev_close ?? null;
  // Prefer snapshot's prev_close (set when an EOD row was used); fall back
  // to the second-most-recent close in the 30-day candle history so the
  // change calc still works on the live-LTP path.
  const prevVix: number | undefined =
    typeof snapPrevClose === "number"
      ? snapPrevClose
      : vixCandles.length >= 2
      ? vixCandles[vixCandles.length - 2]?.close
      : undefined;
  const vixCurrent: number | null = liveVix;
  const indiaVix =
    vixCurrent != null && typeof prevVix === "number" && prevVix !== 0
      ? {
          value: vixCurrent,
          change: vixCurrent - prevVix,
          changePercent: ((vixCurrent - prevVix) / prevVix) * 100,
        }
      : vixCurrent != null
      ? { value: vixCurrent, change: 0, changePercent: 0 }
      : null;

  // PCR — null when the endpoint returned no data or pcr_oi is missing.
  const pcrValueRaw = pcr?.pcr_oi;
  const pcrBlock =
    typeof pcrValueRaw === "number"
      ? {
          value: pcrValueRaw,
          trend: (pcrValueRaw > 1 ? "Bullish" : pcrValueRaw < 0.8 ? "Bearish" : "Neutral") as
            | "Bullish"
            | "Bearish"
            | "Neutral",
        }
      : null;

  // FII / DII — null when no daily rows came back at all.
  const dailyRows = instSummary?.daily ?? [];
  const fii = dailyRows.find((d) => d.category === "FII")?.net_value;
  const dii = dailyRows.find((d) => d.category === "DII")?.net_value;
  const fiiDii =
    typeof fii === "number" || typeof dii === "number"
      ? { fii: typeof fii === "number" ? Math.round(fii) : 0, dii: typeof dii === "number" ? Math.round(dii) : 0 }
      : null;

  const advDecline = breadth ?? null;

  const vixHistory = vixCandles.map((c, i) => ({
    // `ts` is an ISO datetime (1d candles set ts to 09:15 IST). Strip
    // to YYYY-MM-DD for the date axis label — the chart only needs the
    // day, not the time.
    d: typeof c.ts === "string" ? c.ts.slice(0, 10) : "",
    o: c.open,
    h: c.high,
    l: c.low,
    v: c.close,
    change:
      i > 0 && vixCandles[i - 1].close
        ? ((c.close - vixCandles[i - 1].close) / vixCandles[i - 1].close) * 100
        : 0,
  }));

  return {
    indiaVix,
    pcr: pcrBlock,
    fiiDii,
    advDecline,
    vixHistory,
  };
}

/**
 * Pull the latest NSE corporate announcements for the dashboard ticker.
 *
 * Source: `/market/announcements`, backed by NSE's public
 * corporate-filings feed with a 5-minute Redis cache. Each row carries
 * a `detail_url` so the ticker click can open the announcement on
 * NSE's own site (we don't proxy attachments).
 *
 * Falls back to user notifications if the announcements endpoint is
 * empty — keeps the ticker non-empty in dev / first-run when NSE's
 * bot-mitigation cookie dance has yet to succeed.
 */
async function fetchNewsAnnouncements(limit = 20): Promise<NewsAnnouncement[]> {
  const items = await safeGet<
    Array<{
      symbol: string;
      subject: string;
      description?: string;
      timestamp?: string;
      file_url?: string | null;
      detail_url?: string;
    }>
  >(`/market/announcements?limit=${limit}`, []);

  if (items.length > 0) {
    return items.map((a) => ({
      symbol: a.symbol,
      subject: a.subject,
      description: a.subject || a.description,
      impact: "neutral",
      timestamp: a.timestamp,
      file_url: a.file_url ?? undefined,
      detail_url: a.detail_url,
    }));
  }

  // Fallback to user notifications so the ticker isn't blank when the
  // upstream NSE feed hasn't returned yet.
  const notifs = await safeGet<Array<{ created_at: string; type: string; title: string; message: string }>>(
    `/notifications?limit=${limit}`,
    [],
  );
  return notifs.map((n) => ({
    description: `${n.title}: ${n.message}`,
    type: n.type,
    impact: n.type === "loss" ? "bearish" : n.type === "info" ? "neutral" : "bullish",
    timestamp: n.created_at,
  }));
}

/** Live market breadth — Redis LTPs vs latest 1d close across the
 *  broad-market universe (Nifty 500 ... falls back to Nifty 50). */
async function fetchBreadthLive(): Promise<{
  advances: number; declines: number; unchanged: number;
  missing: number; live_count: number; eod_count: number;
} | null> {
  return await safeGet(`/eod/breadth/live`, null as any);
}

/** Per-sector live breadth — one row per sector with adv/dec/unchanged. */
async function fetchBreadthBySector(): Promise<Array<{
  sector: string; stock_count: number;
  advances: number; declines: number; unchanged: number;
  missing: number; live_count: number; eod_count: number;
}>> {
  return await safeGet(`/eod/breadth/by-sector`, [] as any);
}

/** Latest intraday PCR snapshot for `underlying` (default SPY).
 *
 *  Backed by /eod/intraday-oi-aggregate which materialises one row per
 *  IntradayOiSnapshot timestamp. The endpoint returns the day's series,
 *  so we just take the last entry — `pcr_oi` updates every time the
 *  intraday OI scraper writes a fresh snapshot (roughly once a minute
 *  during market hours). NSE doesn't publish "live PCR" as a tick, so
 *  this poll-the-latest-snapshot path is the freshest source available
 *  without a custom matching engine. */
async function fetchPcrLive(underlying: string = "SPY"): Promise<number | null> {
  const series = await safeGet<Array<{ ts: string; pcr_oi: number | null }>>(
    `/eod/intraday-oi-aggregate/${underlying}`,
    [],
  );
  if (!Array.isArray(series) || series.length === 0) return null;
  const last = series[series.length - 1];
  return typeof last?.pcr_oi === "number" ? last.pcr_oi : null;
}

const marketDataService = {
  getMarketIndices: fetchMarketIndices,
  getMarketSentiment: fetchMarketSentiment,
  getNewsAnnouncements: fetchNewsAnnouncements,
  getBreadthLive: fetchBreadthLive,
  getBreadthBySector: fetchBreadthBySector,
  getPcrLive: fetchPcrLive,
  registry: US_INDEX_REGISTRY,
};

export default marketDataService;
