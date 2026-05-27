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
 *   - /api/v1/eod/pcr/NIFTY/{trade_date}        → PCR
 *   - /api/v1/eod/breadth/{trade_date}          → advances / declines
 *   - /api/v1/institutional/cash-flow/summary   → FII / DII totals
 *   - /api/v1/eod/candles/NSE_INDIAVIX_IDX?days=10 → VIX history
 *   - /api/v1/notifications                     → news ticker fallback
 *
 * For VIX live change% we approximate using `(LTP - prev_close)`. If
 * any endpoint is unavailable, we degrade gracefully with sensible
 * defaults rather than throwing.
 */
import { api } from "@/lib/api";
import type { MarketIndex, MarketSentiment, NewsAnnouncement } from "@/lib/marketTypes";

/**
 * Canonical index roster — Indian markets.
 *
 *  - `primary: true`  → shown in the dashboard's top index strip (5 cards).
 *  - `primary: false` → revealed when "View All" is toggled (~23 sectors).
 *
 *  `sector_key` matches the corresponding entry in
 *  `backend/seed_data/sector_stock_mapping.json` and drives the heatmap
 *  drill-down. Indices without a seeded constituent list (yet) leave it
 *  null — the StockHeatmap shows a clear "No constituent list seeded"
 *  message until the weekly Celery refresh fills the JSON in.
 *
 *  `internal_symbol` follows the project's `<EXCH>_<TICKER>_IDX`
 *  convention (see `app.services.symbols.aliases.INDEX_ALIASES`). When a
 *  ticker isn't in the alias table, NSE's published code is used
 *  (`NIFTYIT`, `NIFTYAUTO`, …); if the broker feed publishes a different
 *  spelling we extend the alias table rather than this list.
 *
 *  Order matters: array iteration drives card rendering order.
 */
export const INDIAN_INDEX_REGISTRY: Array<{
  id: string;
  name: string;
  short?: string;
  internal_symbol: string;
  primary: boolean;
  sector_key?: string;
}> = [
  // -------- Primary (top strip) --------
  { id: "nifty50",   name: "NIFTY 50",        short: "NIFTY",        internal_symbol: "NSE_NIFTY50_IDX",    primary: true, sector_key: "Nifty 50" },
  { id: "banknifty", name: "BANK NIFTY",      short: "BANKNIFTY",    internal_symbol: "NSE_NIFTYBANK_IDX",  primary: true, sector_key: "Nifty Bank" },
  { id: "sensex",    name: "SENSEX",          short: "SENSEX",       internal_symbol: "BSE_SENSEX_IDX",     primary: true, sector_key: "SENSEX" },
  { id: "finnifty",  name: "FIN NIFTY",       short: "FINNIFTY",     internal_symbol: "NSE_FINNIFTY_IDX",   primary: true, sector_key: "NIFTY FIN SERVICE" },
  { id: "midselect", name: "MID CAP SELECT",  short: "MIDSELECT",    internal_symbol: "NSE_MIDCPNIFTY_IDX", primary: true, sector_key: "Nifty Mid Select" },

  // -------- Sectoral (View All) --------
  { id: "nifty_it",        name: "NIFTY IT",                short: "IT",           internal_symbol: "NSE_NIFTYIT_IDX",                primary: false, sector_key: "Nifty IT" },
  { id: "nifty_auto",      name: "NIFTY AUTO",              short: "AUTO",         internal_symbol: "NSE_NIFTYAUTO_IDX",              primary: false, sector_key: "Nifty Auto" },
  { id: "nifty_pharma",    name: "NIFTY PHARMA",            short: "PHARMA",       internal_symbol: "NSE_NIFTYPHARMA_IDX",            primary: false, sector_key: "Nifty Pharma" },
  { id: "nifty_fmcg",      name: "NIFTY FMCG",              short: "FMCG",         internal_symbol: "NSE_NIFTYFMCG_IDX",              primary: false, sector_key: "Nifty FMCG" },
  { id: "nifty_metal",     name: "NIFTY METAL",             short: "METAL",        internal_symbol: "NSE_NIFTYMETAL_IDX",             primary: false, sector_key: "Nifty Metal" },
  { id: "nifty_realty",    name: "NIFTY REALTY",            short: "REALTY",       internal_symbol: "NSE_NIFTYREALTY_IDX",            primary: false, sector_key: "Nifty Realty" },
  { id: "nifty_media",     name: "NIFTY MEDIA",             short: "MEDIA",        internal_symbol: "NSE_NIFTYMEDIA_IDX",             primary: false, sector_key: "Nifty Media" },
  { id: "nifty_psubank",   name: "NIFTY PSU BANK",          short: "PSUBANK",      internal_symbol: "NSE_NIFTYPSUBANK_IDX",           primary: false, sector_key: "Nifty PSU Bank" },
  { id: "nifty_pvtbank",   name: "NIFTY PVT BANK",          short: "PVTBANK",      internal_symbol: "NSE_NIFTYPVTBANK_IDX",           primary: false, sector_key: "Nifty Private Bank" },
  { id: "nifty_healthcare",name: "NIFTY HEALTHCARE",        short: "HEALTH",       internal_symbol: "NSE_NIFTYHEALTHCARE_IDX",        primary: false, sector_key: "Nifty Healthcare" },
  { id: "nifty_consumer",  name: "NIFTY CONS. DURABLES",    short: "CONSDUR",      internal_symbol: "NSE_NIFTYCONSRDURBL_IDX",        primary: false, sector_key: "Nifty Consumer Durables" },
  { id: "nifty_oilgas",    name: "NIFTY OIL & GAS",         short: "OIL&GAS",      internal_symbol: "NSE_NIFTYOILANDGAS_IDX",         primary: false, sector_key: "Nifty Oil AND Gas" },

  // -------- Thematic --------
  { id: "nifty_commodities", name: "NIFTY COMMODITIES",     short: "COMM",         internal_symbol: "NSE_NIFTYCOMMODITIES_IDX",       primary: false, sector_key: "Nifty Commodities" },
  { id: "nifty_energy",      name: "NIFTY ENERGY",          short: "ENERGY",       internal_symbol: "NSE_NIFTYENERGY_IDX",            primary: false, sector_key: "Nifty Energy" },
  { id: "nifty_infra",       name: "NIFTY INFRA",           short: "INFRA",        internal_symbol: "NSE_NIFTYINFRA_IDX",             primary: false, sector_key: "Nifty Infra" },
  { id: "nifty_mnc",         name: "NIFTY MNC",             short: "MNC",          internal_symbol: "NSE_NIFTYMNC_IDX",               primary: false, sector_key: "Nifty MNC" },
  { id: "nifty_pse",         name: "NIFTY PSE",             short: "PSE",          internal_symbol: "NSE_NIFTYPSE_IDX",               primary: false, sector_key: "Nifty PSE" },
  { id: "nifty_cpse",        name: "NIFTY CPSE",            short: "CPSE",         internal_symbol: "NSE_NIFTYCPSE_IDX",              primary: false, sector_key: "Nifty CPSE" },
  { id: "nifty_services",    name: "NIFTY SERVICES",        short: "SERV",         internal_symbol: "NSE_NIFTYSERVSECTOR_IDX",        primary: false, sector_key: "Nifty Services Sector" },
  { id: "nifty_consumption", name: "NIFTY CONSUMPTION",     short: "CONSMPT",      internal_symbol: "NSE_NIFTYCONSUMPTION_IDX",       primary: false, sector_key: "Nifty Consumption" },

  // -------- Broad market --------
  { id: "nifty100",        name: "NIFTY 100",               short: "NIFTY100",     internal_symbol: "NSE_NIFTY100_IDX",               primary: false, sector_key: "Nifty 100" },
  { id: "nifty200",        name: "NIFTY 200",               short: "NIFTY200",     internal_symbol: "NSE_NIFTY200_IDX",               primary: false, sector_key: "Nifty 200" },
  { id: "nifty500",        name: "NIFTY 500",               short: "NIFTY500",     internal_symbol: "NSE_NIFTY500_IDX",               primary: false, sector_key: "Nifty 500" },
  { id: "next50",          name: "NIFTY NEXT 50",           short: "NEXT50",       internal_symbol: "NSE_NIFTYNXT50_IDX",             primary: false, sector_key: "Nifty Next 50" },
  { id: "midcap50",        name: "NIFTY MIDCAP 50",         short: "MIDCAP50",     internal_symbol: "NSE_NIFTYMIDCAP50_IDX",          primary: false, sector_key: "Nifty Midcap 50" },
  { id: "midcap100",       name: "NIFTY MIDCAP 100",        short: "MIDCAP100",    internal_symbol: "NSE_NIFTYMIDCAP100_IDX",         primary: false, sector_key: "Nifty Midcap 100" },
  { id: "smallcap50",      name: "NIFTY SMALLCAP 50",       short: "SMCAP50",      internal_symbol: "NSE_NIFTYSMLCAP50_IDX",          primary: false, sector_key: "Nifty Smallcap 50" },
  { id: "smallcap100",     name: "NIFTY SMALLCAP 100",      short: "SMCAP100",     internal_symbol: "NSE_NIFTYSMLCAP100_IDX",         primary: false, sector_key: "Nifty Smallcap 100" },

  // -------- Volatility / others --------
  { id: "vix",       name: "INDIA VIX",     short: "VIX",       internal_symbol: "NSE_INDIAVIX_IDX",   primary: false },
  { id: "bankex",    name: "BSE BANKEX",    short: "BANKEX",    internal_symbol: "BSE_BANKEX_IDX",     primary: false },
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
  const symbols = INDIAN_INDEX_REGISTRY.map((r) => r.internal_symbol);
  // /market/snapshot is the dashboard's one-call endpoint: it tries
  // Redis (live tick) → broker REST quotes → most recent 1d candle.
  // Each row tells us its `source` so the UI can render a tiny
  // live/rest/eod badge later if we want.
  const snap = await safeGet<Record<string, SnapshotRow>>(
    `/market/snapshot?symbols=${encodeURIComponent(symbols.join(","))}`,
    {},
  );

  return INDIAN_INDEX_REGISTRY.map((r): MarketIndex => {
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
    safeGet<{ pcr_oi: number | null } | null>(`/eod/pcr/NIFTY/${pcrDate}`, null),
    safeGet<{ advances: number; declines: number; unchanged: number } | null>(
      `/eod/breadth/${breadthDate}`,
      null,
    ),
    safeGet<{ daily: Array<{ category: string; net_value: number }> } | null>(
      `/institutional/cash-flow/summary`,
      null,
    ),
    safeGet<Array<{ ts: string; open: number; high: number; low: number; close: number }>>(
      `/eod/candles/NSE_INDIAVIX_IDX?days=30`,
      [],
    ),
    // `/market/snapshot` does the full LTP → 1d → 1m fallback server-side,
    // so VIX renders even when NSE didn't ship it in today's ind_close_all
    // and only a brief intraday WS connection left 1m bars behind.
    safeGet<Record<string, { ltp: number | null; prev_close: number | null }>>(
      `/market/snapshot?symbols=NSE_INDIAVIX_IDX`,
      {},
    ),
  ]);

  // VIX — pull the latest price from snapshot (with full fallback chain),
  // and the prior close from EOD candles when available. If both are
  // missing the block is null and the widget shows "—".
  const vixRow = vixSnap["NSE_INDIAVIX_IDX"];
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

/** Latest intraday PCR snapshot for `underlying` (default NIFTY).
 *
 *  Backed by /eod/intraday-oi-aggregate which materialises one row per
 *  IntradayOiSnapshot timestamp. The endpoint returns the day's series,
 *  so we just take the last entry — `pcr_oi` updates every time the
 *  intraday OI scraper writes a fresh snapshot (roughly once a minute
 *  during market hours). NSE doesn't publish "live PCR" as a tick, so
 *  this poll-the-latest-snapshot path is the freshest source available
 *  without a custom matching engine. */
async function fetchPcrLive(underlying: string = "NIFTY"): Promise<number | null> {
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
  registry: INDIAN_INDEX_REGISTRY,
};

export default marketDataService;
