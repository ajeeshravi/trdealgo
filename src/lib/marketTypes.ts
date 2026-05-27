/**
 * Shared types for the Dashboard's live market widgets.
 *
 * MarketIndex is the canonical row consumed by IndexCard and the
 * useLiveMarketIndices hook. It is produced by mapping each known
 * Indian index symbol (NSE_NIFTY50_IDX, etc.) over backend feeds:
 *
 *   - LTP   ← /api/v1/market/ltp?symbols=…
 *   - OHLC  ← /api/v1/eod/indices/{trade_date}   (for prev_close / day high / low)
 *
 * `change_pct` is computed front-end as `((value - prev_close) / prev_close) * 100`
 * so we don't need a separate live endpoint for it. When prev_close is
 * unknown (pre-market open, weekend, first run before EOD ingest), the
 * card shows `—` instead of `0.00%`.
 */

export interface MarketIndex {
  /** Canonical id used for routing — uses the lowercased ticker (e.g. `"nifty50"`). */
  id: string;
  /** Display label e.g. "NIFTY 50". */
  name: string;
  /** Short label e.g. "NIFTY". Optional. */
  short?: string;
  /** Backend internal_symbol — e.g. "NSE_NIFTY50_IDX". */
  internal_symbol: string;
  /** Latest price. `null` means neither a live LTP nor a 1d candle is
   * available yet — render as "—" rather than synthesising a value. */
  value: number | null;
  /** Absolute change vs prev_close. `null` when value is null. */
  change: number | null;
  /** Percent change vs prev_close. `null` when value is null. */
  change_pct: number | null;
  /** Day open. */
  open?: number;
  /** Day high. */
  high?: number;
  /** Day low. */
  low?: number;
  /** Prior trading day close — sourced from /eod/indices/{date}. */
  prev_close?: number;
  /** True while value > prev_close. */
  isUp?: boolean;
  /** Matches the JSON key in backend/seed_data/sector_stock_mapping.json
   * (e.g. "Nifty 50", "Nifty Bank", "SENSEX"). When set, the StockHeatmap
   * drill-down can fetch /eod/sector-constituents/{sector_key}. Indices
   * without a constituent list (e.g. INDIA VIX) leave this undefined and
   * the heatmap shows a "not seeded" message. */
  sector_key?: string;
}

/** Row returned by /api/v1/eod/sector-constituents/{key} — used by the StockHeatmap drill-down. */
export interface SectorStockRow {
  symbol: string;
  internal_symbol: string;
  ltp: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change_pct: number | null;
  market_cap: number | null;
  /** Where the LTP / change came from:
   * - "live": tick from broker WS (Redis cache hit) — reference is the latest daily close.
   * - "eod":  fallback to latest daily close — reference is the prior trading day's close.
   * - "none": no LTP and no EOD candle (e.g. newly-listed stock, no ingest yet).
   */
  data_source: "live" | "eod" | "none";
}

/** Output of marketDataService.getMarketSentiment() — see service file for source mapping.
 * Every block is independent; if its underlying endpoint returns no data
 * the whole block is `null` so the widget can render an empty state.
 */
export interface MarketSentiment {
  indiaVix: { value: number; change: number; changePercent: number } | null;
  pcr: { value: number; trend: "Bullish" | "Bearish" | "Neutral" } | null;
  fiiDii: { fii: number; dii: number } | null;
  advDecline: { advances: number; declines: number; unchanged: number } | null;
  /** Optional historical VIX OHLC rows, latest first. */
  vixHistory?: Array<{ d: string; o?: number; h?: number; l?: number; v?: number; change?: number }>;
}

/** Per-row shape for the rolling Announcements ticker. */
export interface NewsAnnouncement {
  symbol?: string;
  /** Back-compat single-blob field — prefer the structured ones below. */
  description?: string;
  type?: string;
  impact?: "bullish" | "bearish" | "neutral";
  timestamp?: string;
  /** Subject / headline of the announcement (NSE corp filings only). */
  subject?: string;
  /** Longer body the filer submitted alongside the PDF — typically 1-3
   *  sentences describing what the announcement is about. Distinct from
   *  `subject` (short headline). */
  attachment_text?: string;
  /** Full company name from the NSE master (e.g. "Reliance Industries
   *  Limited") — useful when `symbol` is opaque. */
  company_name?: string;
  /** GICS-style industry classification (e.g. "Banking", "IT Services"). */
  industry?: string;
  /** Broadcast / exchange disseminated time as an ISO string, if NSE
   *  provided one different from `timestamp`. */
  broadcast_time?: string;
  /** Time NSE actually disseminated the filing to the market — usually
   *  a few seconds after `broadcast_time`. */
  dissem_time?: string;
  /** NSE's sequence id for this filing — used to build a per-filing
   *  detail URL when present. */
  seq_id?: string;
  /** Click-through URL — opens the NSE-hosted detail page in a new tab. */
  detail_url?: string;
  /** Direct attachment URL (PDF) when NSE supplies one. */
  file_url?: string;
  /** File size hint NSE sometimes returns alongside the attachment. */
  file_size?: string;
  /** Full announcement text parsed from the linked XBRL XML, when
   *  available. This is the rich "Details" you see on NSE's website
   *  (e.g. "Company X has informed the Exchange about change in
   *  Management"). Preferred over `attachment_text` for the card body. */
  description_full?: string;
  /** Any NSE row fields we didn't map onto named output above —
   *  preserved for forward-compat / debugging. UI can iterate and
   *  render as a small "more details" section. */
  extra?: Record<string, string | number | boolean>;
}
