"use client";
/**
 * Option Chain — live, no mock data.
 *
 * Data flow:
 *   - Underlying picker  → fixed list of index F&O underlyings (NIFTY,
 *                          BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX,
 *                          BANKEX). Equities are added later.
 *   - Expiries           → /api/v1/symbols/{u}/expiries?segment=OPT
 *   - Chain skeleton     → /api/v1/symbols/{u}/chain/{expiry}
 *   - OI snapshot        → /api/v1/eod/intraday-oi/{u}?expiry=...
 *                          (latest OI / ChgOI / Vol per leg; 30 s refresh)
 *   - LTP live ticks     → useLivePrices(visible CE+PE symbols)
 *   - Spot LTP           → useLivePrices([spot index symbol])
 *   - Greeks (IV/Delta/  → client-side Black-Scholes from market LTP +
 *     Theta/Gamma/Vega)    spot; renders "—" when LTP or spot unknown.
 *
 * Display rules:
 *   - Strike count picker: 5 / 10 / 15 / 20 / 30 strikes centered on ATM.
 *     Deep OTM / ITM are excluded — keeps the table readable and stops
 *     the FE from subscribing to ~150 illiquid legs that fail at the
 *     broker WS subscription cap.
 *   - Column toggle: pick which metric columns are visible. Calls
 *     columns render in REVERSE order so LTP sits closest to the strike.
 *   - OI bar: each OI cell carries a relative-width bar (max OI = 100%).
 *   - ATM / MaxPain rows are highlighted; CE side is ITM when strike <
 *     spot, PE when strike > spot.
 *   - Synchronised scrolling: Calls/Strike/Puts columns share vertical
 *     scroll; Calls + Puts share horizontal scroll (mirrored — Calls
 *     scroll right ↔ Puts scroll left so the LTP columns stay adjacent
 *     to the strike).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown, Loader2, Search, SlidersHorizontal } from "lucide-react";

import { api } from "@/lib/api";
import { useLivePrices } from "@/lib/useLivePrices";
import { calcGreeks, timeToExpiry } from "@/lib/blackScholes";
import { cn } from "@/lib/utils";
import { useMarketPollInterval } from "@/lib/marketHours";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ---------- types ----------------------------------------------------------

type ChainSymbol = {
  internal_symbol: string;
  trading_symbol: string;
  lot_size: number;
};
type ChainRow = {
  strike: number;
  ce: ChainSymbol | null;
  pe: ChainSymbol | null;
};
type ChainResponse = {
  underlying: string;
  expiry: string;
  rows: ChainRow[];
};

type OiSnapshotRow = {
  snapshot_ts: string;
  internal_symbol: string;
  strike: number;
  option_type: "CE" | "PE";
  expiry: string;
  ltp: number;
  open_interest: number;
  chg_in_oi: number | null;
  volume: number;
};

// ---------- config ---------------------------------------------------------

// Display labels for indices whose F&O underlying differs from the
// trader-facing name (NIFTYBANK appears in NSE as "BANKNIFTY" on every
// broker UI, NIFTY50 as "NIFTY"). Anything not in this map renders
// under its master ticker — stock options come through as RELIANCE,
// HDFCBANK, etc., which is exactly what users expect.
const LABEL_OVERRIDES: Record<string, string> = {
  NIFTY:      "NIFTY",
  NIFTYBANK:  "BANKNIFTY",
  FINNIFTY:   "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY",
  SENSEX:     "SENSEX",
  BANKEX:     "BANKEX",
  SENSEX50:   "SENSEX50",
};

type UnderlyingInfo = {
  underlying: string;
  exchange: "NFO" | "BFO";
  spot_internal: string | null;
  kind: "INDEX" | "STOCK";
};

const STRIKE_COUNT_OPTIONS = ["5", "10", "15", "20", "30"] as const;

const METRIC_COLUMNS = [
  { key: "buildup",  label: "Buildup" },
  { key: "oiChange", label: "OI Chg" },
  { key: "oi",       label: "OI" },
  { key: "volume",   label: "Volume" },
  { key: "change",   label: "Chg" },
  { key: "ltp",      label: "LTP" },
  { key: "iv",       label: "IV" },
  { key: "delta",    label: "Delta" },
  { key: "theta",    label: "Theta" },
  { key: "gamma",    label: "Gamma" },
  { key: "vega",     label: "Vega" },
] as const;
type MetricColumnKey = (typeof METRIC_COLUMNS)[number]["key"];

const DEFAULT_VISIBLE: MetricColumnKey[] = [
  "buildup", "oiChange", "oi", "volume", "change", "ltp", "iv", "delta",
];

// Standard Indian F&O buildup matrix (Δprice × Δoi). Driven by today's
// LTP vs prior-day settle and today's OI vs prior-day OI — same inputs
// as the EOD `/eod/oi-buildup` endpoint, just computed live.
type Buildup = "long_buildup" | "short_buildup" | "long_unwinding" | "short_covering" | "neutral";

function classifyBuildup(priceChange: number, oiChange: number): Buildup {
  if (priceChange > 0 && oiChange > 0) return "long_buildup";
  if (priceChange < 0 && oiChange > 0) return "short_buildup";
  if (priceChange < 0 && oiChange < 0) return "long_unwinding";
  if (priceChange > 0 && oiChange < 0) return "short_covering";
  return "neutral";
}

const BUILDUP_DISPLAY: Record<Buildup, { label: string; cls: string; title: string }> = {
  long_buildup:   { label: "LB", cls: "bg-profit/20 text-profit border-profit/40",
                    title: "Long Buildup (Δprice ↑, ΔOI ↑)" },
  short_buildup:  { label: "SB", cls: "bg-loss/20 text-loss border-loss/40",
                    title: "Short Buildup (Δprice ↓, ΔOI ↑)" },
  long_unwinding: { label: "LU", cls: "bg-warning/20 text-warning border-warning/40",
                    title: "Long Unwinding (Δprice ↓, ΔOI ↓)" },
  short_covering: { label: "SC", cls: "bg-primary/20 text-primary border-primary/40",
                    title: "Short Covering (Δprice ↑, ΔOI ↓)" },
  neutral:        { label: "—",  cls: "text-muted-foreground",
                    title: "No directional buildup" },
};

const SIDE_COLUMN_WIDTH = 110;
const STRIKE_COLUMN_WIDTH = 95;
const ROW_HEIGHT = 40;

// ATM detection tolerance — half a strike step. NIFTY strikes are 50pt,
// BANKNIFTY 100pt. We compute the actual step from the data.
const ATM_FALLBACK_TOLERANCE = 25;

const fetcher = (u: string) => api.get(u).then((r) => r.data);

const fmtExpiry = (iso: string): string => {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtK = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  if (abs >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return n.toFixed(0);
};

const fmtKSigned = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return "—";
  const s = fmtK(Math.abs(n));
  if (s === "—") return "—";
  return n >= 0 ? `+${s}` : `-${s}`;
};

const fmtPrice = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return "—";
  return n.toFixed(2);
};

const fmtPctSigned = (n: number): string => {
  if (!Number.isFinite(n) || n === 0) return "—";
  return n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
};

// ---------- component ------------------------------------------------------

export default function OptionChainPage() {
  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [expiry, setExpiry] = useState<string>("");
  const [strikeCount, setStrikeCount] = useState<string>("10");
  const [visibleColumns, setVisibleColumns] = useState<MetricColumnKey[]>(DEFAULT_VISIBLE);

  // Hard-reset on underlying switch: clear expiry so the chain / OI /
  // snapshot queries all gate on null until the new underlying's
  // nearest expiry resolves. Without this the page briefly fires
  // `/chain/<new-underlying>/<old-expiry>` (e.g. SENSEX with NIFTY's
  // weekly Tue date) and flashes "No strikes" before recovering. Also
  // resets the auto-center memo so the new chain gets centered on its
  // own ATM rather than inheriting the previous scroll position.
  const handleUnderlyingChange = useCallback((next: string) => {
    if (next === underlying) return;
    setUnderlying(next);
    setExpiry("");
    // Forget the auto-center key so the new chain re-centers on its
    // own ATM rather than holding the previous underlying's scroll.
    // The ref is mutated directly because we don't want the change
    // to trigger a re-render here — the auto-center effect picks it
    // up on the next render once rowMetrics is non-empty.
    lastAutoScrollKey.current = "";
  }, [underlying]);

  // Underlying picker (type-search popover) state.
  const [underlyingPickerOpen, setUnderlyingPickerOpen] = useState(false);
  const [underlyingQuery, setUnderlyingQuery] = useState("");
  const [underlyingActiveIdx, setUnderlyingActiveIdx] = useState(0);
  const underlyingPickerRef = useRef<HTMLDivElement>(null);
  const underlyingInputRef = useRef<HTMLInputElement>(null);
  const underlyingListRef = useRef<HTMLDivElement>(null);

  // Scroll-sync refs.
  const callsHeaderRef = useRef<HTMLDivElement>(null);
  const putsHeaderRef  = useRef<HTMLDivElement>(null);
  const callsBodyRef   = useRef<HTMLDivElement>(null);
  const putsBodyRef    = useRef<HTMLDivElement>(null);
  const strikeBodyRef  = useRef<HTMLDivElement>(null);
  const hSyncRef = useRef<"calls" | "puts" | null>(null);
  const vSyncRef = useRef<"calls" | "puts" | "strike" | null>(null);
  // Track whether we've auto-centered for the current (underlying, expiry).
  // Reset on switch; otherwise the user's scroll position would be reset on
  // every SWR re-render.
  const lastAutoScrollKey = useRef<string>("");

  // Underlyings — every OPT-enabled underlying in the master (indices
  // + stock options, NFO + BFO). Falls back to nothing on cold start;
  // the dropdown then just shows the default ("NIFTY"), which is the
  // sensible cold-start choice anyway.
  const { data: underlyingsList } = useSWR<UnderlyingInfo[]>(
    "/symbols/options-underlyings", fetcher,
  );

  // Expiries.
  const {
    data: expiries,
    error: expiriesError,
  } = useSWR<string[]>(`/symbols/${underlying}/expiries?segment=OPT`, fetcher);

  // Pick the nearest valid expiry as soon as the expiry list for the
  // current underlying is known. Handles three cases in one pass:
  //   1. First visit / underlying change with no cached list → set when
  //      SWR resolves.
  //   2. Underlying change with cached list → switch immediately so the
  //      chain query doesn't fire against the previous underlying's
  //      expiry (which would return empty for, say, NIFTY's weekly date
  //      under BANKNIFTY).
  //   3. Same underlying, expiry list shrinks (e.g. one rolled off) →
  //      drop to the new nearest instead of going blank.
  useEffect(() => {
    if (!expiries || expiries.length === 0) return;
    if (!expiry || !expiries.includes(expiry)) {
      setExpiry(expiries[0]);
    }
  }, [underlying, expiries, expiry]);

  // Chain skeleton.
  const chainKey = expiry ? `/symbols/${underlying}/chain/${expiry}` : null;
  const { data: chainRaw, isLoading: chainLoading } = useSWR<ChainResponse>(chainKey, fetcher);

  // Guard against SWR returning a stale-cached chain for the previous
  // underlying (or any window where the response in hand doesn't match
  // the currently-selected underlying/expiry). Treat such data as
  // "not yet loaded" so the table stays hidden behind the loading
  // screen until the response truly belongs to the picker state.
  const chain = (
    chainRaw &&
    chainRaw.underlying === underlying.toUpperCase() &&
    chainRaw.expiry === expiry
  ) ? chainRaw : undefined;

  // Prior-day settle + OI per leg — feeds the Buildup column. Mostly
  // static within a session, so fetch once and rely on SWR revalidation
  // on focus rather than a refresh timer. The endpoint walks 10 trading
  // days back to survive weekends.
  const prevDayKey = expiry ? `/eod/option-prev-day/${underlying}?expiry=${expiry}` : null;
  const { data: prevDay } = useSWR<Record<string, { prev_close: number; prev_oi: number; prev_date: string }>>(
    prevDayKey, fetcher, { shouldRetryOnError: false },
  );

  // Option-chain data only changes during the NSE/BSE F&O session.
  // Outside 09:15–15:30 IST Mon-Fri the snapshots and OI rows are
  // stable, so all the polls below collapse to 0.
  const optionChainPoll30s = useMarketPollInterval(30_000, "EQ_FO");
  const optionChainPoll15s = useMarketPollInterval(15_000, "EQ_FO");
  // Intraday OI snapshots — latest per leg.
  const oiKey = expiry ? `/eod/intraday-oi/${underlying}?expiry=${expiry}` : null;
  const { data: oiRows } = useSWR<OiSnapshotRow[]>(oiKey, fetcher, {
    refreshInterval: optionChainPoll30s,
    shouldRetryOnError: false,
  });
  const oiByInternal = useMemo(() => {
    const m = new Map<string, OiSnapshotRow>();
    if (!oiRows) return m;
    for (const r of oiRows) m.set(r.internal_symbol, r);
    return m;
  }, [oiRows]);

  // Spot LTP — live ticks preferred, snapshot endpoint as warm fallback.
  // The snapshot endpoint also fires a fire-and-forget broker subscribe
  // for the symbol, so the live tick path is primed even if the user
  // landed on this page without going through the dashboard first.
  const spotMeta = (underlyingsList ?? []).find((u) => u.underlying === underlying);
  const spotSymbol = spotMeta?.spot_internal ?? "";
  const spotSubs = useMemo(() => (spotSymbol ? [spotSymbol] : []), [spotSymbol]);
  const spotPrices = useLivePrices(spotSubs);
  const liveSpot = spotSymbol ? spotPrices[spotSymbol] : undefined;

  const { data: spotSnap } = useSWR<Record<string, { ltp: number | null; source?: string }>>(
    spotSymbol ? `/market/snapshot?symbols=${spotSymbol}` : null,
    fetcher,
    { refreshInterval: optionChainPoll15s, shouldRetryOnError: false },
  );
  const snapSpot = spotSymbol && spotSnap?.[spotSymbol]?.ltp != null
    ? Number(spotSnap[spotSymbol].ltp)
    : undefined;
  const spotSource = spotSymbol ? spotSnap?.[spotSymbol]?.source : undefined;

  const spot: number | undefined =
    typeof liveSpot === "number" && liveSpot > 0 ? liveSpot
    : typeof snapSpot === "number" && snapSpot > 0 ? snapSpot
    : undefined;

  // Strike step (derived from the chain — usually 50 for NIFTY, 100 for
  // BANKNIFTY, etc.). Used to set the ATM-match tolerance precisely.
  const strikeStep = useMemo(() => {
    if (!chain || chain.rows.length < 2) return ATM_FALLBACK_TOLERANCE * 2;
    const diffs: number[] = [];
    for (let i = 1; i < chain.rows.length; i++) {
      diffs.push(chain.rows[i].strike - chain.rows[i - 1].strike);
    }
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)] || ATM_FALLBACK_TOLERANCE * 2;
  }, [chain]);
  const atmTolerance = strikeStep / 2;

  // ATM index in the full chain.
  const atmIndex = useMemo(() => {
    if (!chain || chain.rows.length === 0 || typeof spot !== "number") return -1;
    let best = 0;
    let bestDiff = Math.abs(chain.rows[0].strike - spot);
    for (let i = 1; i < chain.rows.length; i++) {
      const d = Math.abs(chain.rows[i].strike - spot);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best;
  }, [chain, spot]);
  const atmStrike = atmIndex >= 0 && chain ? chain.rows[atmIndex].strike : null;

  // Window the chain to ATM ± half(strikeCount). Deep OTM/ITM excluded.
  const windowedRows = useMemo<ChainRow[]>(() => {
    if (!chain || chain.rows.length === 0) return [];
    const count = parseInt(strikeCount, 10);
    if (atmIndex < 0) return chain.rows.slice(0, count);
    const half = Math.floor(count / 2);
    const start = Math.max(0, atmIndex - half);
    const end = Math.min(chain.rows.length, start + count);
    // Re-align start if `end` got clipped (atmIndex near the end of the chain).
    const finalStart = Math.max(0, end - count);
    return chain.rows.slice(finalStart, end);
  }, [chain, atmIndex, strikeCount]);

  // Live-tick subscriptions: just the visible legs (max ~60 symbols even
  // at 30 strikes). The backend feed-router will pull these into the
  // broker WS automatically.
  const liveTickSymbols = useMemo(() => {
    const out: string[] = [];
    for (const r of windowedRows) {
      if (r.ce) out.push(r.ce.internal_symbol);
      if (r.pe) out.push(r.pe.internal_symbol);
    }
    return out.sort();
  }, [windowedRows]);
  const livePrices = useLivePrices(liveTickSymbols);

  // Snapshot LTP fallback for the visible legs. Off-hours (no live ticks)
  // and stale-expiry days (intraday-OI table only has the prior expiry)
  // are the two cases where `useLivePrices` returns nothing for these
  // symbols, leaving every cell as "—". `/market/snapshot` serves the
  // last Redis LTP if any tick arrived, otherwise the most recent 1d
  // candle close — either is a sensible read.
  const snapshotKey = liveTickSymbols.length
    ? `/market/snapshot?symbols=${liveTickSymbols.join(",")}`
    : null;
  const { data: snapshotPrices } = useSWR<
    Record<string, { ltp: number | null; source?: string }>
  >(snapshotKey, fetcher, { refreshInterval: optionChainPoll30s, shouldRetryOnError: false });

  // Detect whether the visible legs are being served from EOD data rather
  // than from a live broker feed. When the broker is logged out the LTP
  // cache empties (30s TTL) and `_resolve_snapshot` falls through to the
  // 1d candle / FoOiHistory settle — both flagged as `eod*` sources by
  // the backend. If a large majority of the visible legs land in that
  // bucket and live ticks are absent, we know the chain is showing
  // last-published prices rather than a live tape.
  const feedSource: "live" | "eod" | "unknown" = useMemo(() => {
    const liveCount = Object.values(livePrices).filter(
      (v) => typeof v === "number" && v > 0,
    ).length;
    if (liveCount > 0) return "live";
    if (!snapshotPrices || liveTickSymbols.length === 0) return "unknown";
    let eod = 0;
    let total = 0;
    for (const sym of liveTickSymbols) {
      const s = snapshotPrices[sym]?.source;
      if (s) total += 1;
      if (s === "eod" || s === "eod-settle") eod += 1;
    }
    return total > 0 && eod / total >= 0.5 ? "eod" : "unknown";
  }, [livePrices, snapshotPrices, liveTickSymbols]);

  // ---------- per-row computation -----------------------------------------

  // Greeks need T (in years) once per render.
  const T = useMemo(() => (expiry ? timeToExpiry(expiry) : 0), [expiry]);

  type RowMetrics = {
    strike: number;
    isATM: boolean;
    isITMCall: boolean;
    isITMPut: boolean;
    ce: SideMetrics;
    pe: SideMetrics;
  };
  type SideMetrics = {
    ltp: number;
    change: number;        // Day's price change %, vs prev settle. 0 when prev close unknown.
    oi: number;
    oiChange: number;      // Intraday delta vs prior snapshot.
    volume: number;
    iv: number;            // percent (display-ready)
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    buildup: Buildup;      // Long/Short buildup, unwinding, covering — vs prior day.
  };

  const rowMetrics: RowMetrics[] = useMemo(() => {
    return windowedRows.map((row) => {
      const ceLive = row.ce ? livePrices[row.ce.internal_symbol] : undefined;
      const peLive = row.pe ? livePrices[row.pe.internal_symbol] : undefined;
      const ceOi = row.ce ? oiByInternal.get(row.ce.internal_symbol) : undefined;
      const peOi = row.pe ? oiByInternal.get(row.pe.internal_symbol) : undefined;
      const ceSnap = row.ce ? snapshotPrices?.[row.ce.internal_symbol]?.ltp : undefined;
      const peSnap = row.pe ? snapshotPrices?.[row.pe.internal_symbol]?.ltp : undefined;

      // LTP preference: live tick > intraday-OI snapshot LTP > market/snapshot
      // (Redis LTP or EOD 1d candle close) > 0. The chain extends the
      // earlier intraday-OI fallback so off-hours and stale-expiry days
      // still render a price.
      const ceLtp = typeof ceLive === "number" && ceLive > 0 ? ceLive
        : (ceOi?.ltp && ceOi.ltp > 0) ? ceOi.ltp
        : (typeof ceSnap === "number" && ceSnap > 0) ? ceSnap
        : 0;
      const peLtp = typeof peLive === "number" && peLive > 0 ? peLive
        : (peOi?.ltp && peOi.ltp > 0) ? peOi.ltp
        : (typeof peSnap === "number" && peSnap > 0) ? peSnap
        : 0;

      const ceGreeks = (spot && ceLtp > 0)
        ? calcGreeks(ceLtp, spot, row.strike, T, "call")
        : { iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
      const peGreeks = (spot && peLtp > 0)
        ? calcGreeks(peLtp, spot, row.strike, T, "put")
        : { iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };

      const isATM = atmStrike != null && Math.abs(row.strike - atmStrike) < 1e-6;
      const isITMCall = typeof spot === "number" && row.strike < spot && !isATM;
      const isITMPut  = typeof spot === "number" && row.strike > spot && !isATM;

      // Day's deltas (vs prior trading day's settle/OI from FoOiHistory).
      // Drives both the Chg% column and the Buildup classification.
      const cePrev = row.ce ? prevDay?.[row.ce.internal_symbol] : undefined;
      const pePrev = row.pe ? prevDay?.[row.pe.internal_symbol] : undefined;
      const ceDayOi = ceOi?.open_interest ?? 0;
      const peDayOi = peOi?.open_interest ?? 0;
      const ceDayOiDelta = cePrev ? (ceDayOi - cePrev.prev_oi) : 0;
      const peDayOiDelta = pePrev ? (peDayOi - pePrev.prev_oi) : 0;
      const ceDayPriceDelta = (cePrev && ceLtp > 0) ? (ceLtp - cePrev.prev_close) : 0;
      const peDayPriceDelta = (pePrev && peLtp > 0) ? (peLtp - pePrev.prev_close) : 0;
      const ceChangePct = (cePrev && cePrev.prev_close > 0 && ceLtp > 0)
        ? ((ceLtp - cePrev.prev_close) / cePrev.prev_close) * 100 : 0;
      const peChangePct = (pePrev && pePrev.prev_close > 0 && peLtp > 0)
        ? ((peLtp - pePrev.prev_close) / pePrev.prev_close) * 100 : 0;
      const ceBuildup: Buildup = (cePrev && ceLtp > 0)
        ? classifyBuildup(ceDayPriceDelta, ceDayOiDelta) : "neutral";
      const peBuildup: Buildup = (pePrev && peLtp > 0)
        ? classifyBuildup(peDayPriceDelta, peDayOiDelta) : "neutral";

      return {
        strike: row.strike,
        isATM, isITMCall, isITMPut,
        ce: {
          ltp: ceLtp,
          change: ceChangePct,
          oi: ceDayOi,
          oiChange: ceOi?.chg_in_oi ?? 0,
          volume: ceOi?.volume ?? 0,
          iv: ceGreeks.iv * 100,
          delta: ceGreeks.delta,
          gamma: ceGreeks.gamma,
          theta: ceGreeks.theta,
          vega: ceGreeks.vega,
          buildup: ceBuildup,
        },
        pe: {
          ltp: peLtp,
          change: peChangePct,
          oi: peDayOi,
          oiChange: peOi?.chg_in_oi ?? 0,
          volume: peOi?.volume ?? 0,
          iv: peGreeks.iv * 100,
          delta: peGreeks.delta,
          gamma: peGreeks.gamma,
          theta: peGreeks.theta,
          vega: peGreeks.vega,
          buildup: peBuildup,
        },
      };
    });
  }, [windowedRows, livePrices, oiByInternal, snapshotPrices, spot, T, atmStrike, prevDay]);

  // PCR + MaxPain on the windowed set (matches what the trader actually sees).
  const totalCallOI = rowMetrics.reduce((s, r) => s + r.ce.oi, 0);
  const totalPutOI  = rowMetrics.reduce((s, r) => s + r.pe.oi, 0);
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : "—";
  const maxPainStrike = useMemo(() => {
    if (rowMetrics.length === 0) return null;
    let minPain = Infinity;
    let mpStrike = rowMetrics[0].strike;
    for (const row of rowMetrics) {
      let pain = 0;
      for (const r of rowMetrics) {
        if (r.strike < row.strike) pain += r.ce.oi * (row.strike - r.strike);
        if (r.strike > row.strike) pain += r.pe.oi * (r.strike - row.strike);
      }
      if (pain < minPain) { minPain = pain; mpStrike = row.strike; }
    }
    return mpStrike;
  }, [rowMetrics]);

  // Max OI in the windowed set for the bar scaling.
  const maxOI = useMemo(() => {
    let m = 1;
    for (const r of rowMetrics) {
      if (r.ce.oi > m) m = r.ce.oi;
      if (r.pe.oi > m) m = r.pe.oi;
    }
    return m;
  }, [rowMetrics]);

  // ---------- scroll sync --------------------------------------------------

  const getMaxScroll = (el: HTMLDivElement | null): number =>
    el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;

  const syncFromCalls = useCallback((callsLeft: number) => {
    const callsBody = callsBodyRef.current;
    const putsBody  = putsBodyRef.current;
    if (!callsBody || !putsBody) return;
    if (callsHeaderRef.current && Math.abs(callsHeaderRef.current.scrollLeft - callsLeft) > 1) {
      callsHeaderRef.current.scrollLeft = callsLeft;
    }
    const maxCalls = getMaxScroll(callsBody);
    const maxPuts  = getMaxScroll(putsBody);
    const ratio = maxCalls > 0 ? callsLeft / maxCalls : 0;
    // Mirror — when Calls scroll right (LTP at the right edge),
    // Puts scroll left so LTP stays adjacent to the strike column.
    const putsLeft = (1 - ratio) * maxPuts;
    if (Math.abs(putsBody.scrollLeft - putsLeft) > 1) putsBody.scrollLeft = putsLeft;
    if (putsHeaderRef.current && Math.abs(putsHeaderRef.current.scrollLeft - putsLeft) > 1) {
      putsHeaderRef.current.scrollLeft = putsLeft;
    }
  }, []);

  const syncFromPuts = useCallback((putsLeft: number) => {
    const callsBody = callsBodyRef.current;
    const putsBody  = putsBodyRef.current;
    if (!callsBody || !putsBody) return;
    if (putsHeaderRef.current && Math.abs(putsHeaderRef.current.scrollLeft - putsLeft) > 1) {
      putsHeaderRef.current.scrollLeft = putsLeft;
    }
    const maxCalls = getMaxScroll(callsBody);
    const maxPuts  = getMaxScroll(putsBody);
    const ratio = maxPuts > 0 ? putsLeft / maxPuts : 0;
    const callsLeft = (1 - ratio) * maxCalls;
    if (Math.abs(callsBody.scrollLeft - callsLeft) > 1) callsBody.scrollLeft = callsLeft;
    if (callsHeaderRef.current && Math.abs(callsHeaderRef.current.scrollLeft - callsLeft) > 1) {
      callsHeaderRef.current.scrollLeft = callsLeft;
    }
  }, []);

  const syncVertical = useCallback((source: "calls" | "puts" | "strike", top: number) => {
    if (source !== "calls" && callsBodyRef.current && Math.abs(callsBodyRef.current.scrollTop - top) > 1) {
      callsBodyRef.current.scrollTop = top;
    }
    if (source !== "puts" && putsBodyRef.current && Math.abs(putsBodyRef.current.scrollTop - top) > 1) {
      putsBodyRef.current.scrollTop = top;
    }
    if (source !== "strike" && strikeBodyRef.current && Math.abs(strikeBodyRef.current.scrollTop - top) > 1) {
      strikeBodyRef.current.scrollTop = top;
    }
  }, []);

  const onCallsBodyScroll = useCallback(() => {
    const el = callsBodyRef.current;
    if (!el) return;
    if (!hSyncRef.current || hSyncRef.current === "calls") {
      hSyncRef.current = "calls";
      syncFromCalls(el.scrollLeft);
      hSyncRef.current = null;
    }
    if (!vSyncRef.current || vSyncRef.current === "calls") {
      vSyncRef.current = "calls";
      syncVertical("calls", el.scrollTop);
      vSyncRef.current = null;
    }
  }, [syncFromCalls, syncVertical]);

  const onPutsBodyScroll = useCallback(() => {
    const el = putsBodyRef.current;
    if (!el) return;
    if (!hSyncRef.current || hSyncRef.current === "puts") {
      hSyncRef.current = "puts";
      syncFromPuts(el.scrollLeft);
      hSyncRef.current = null;
    }
    if (!vSyncRef.current || vSyncRef.current === "puts") {
      vSyncRef.current = "puts";
      syncVertical("puts", el.scrollTop);
      vSyncRef.current = null;
    }
  }, [syncFromPuts, syncVertical]);

  const onStrikeBodyScroll = useCallback(() => {
    const el = strikeBodyRef.current;
    if (!el) return;
    if (!vSyncRef.current || vSyncRef.current === "strike") {
      vSyncRef.current = "strike";
      syncVertical("strike", el.scrollTop);
      vSyncRef.current = null;
    }
  }, [syncVertical]);

  // Auto-center ATM on first render for each (underlying, expiry).
  useEffect(() => {
    const key = `${underlying}|${expiry}|${strikeCount}`;
    if (lastAutoScrollKey.current === key) return;
    if (rowMetrics.length === 0 || spot == null) return;
    const atmLocal = rowMetrics.findIndex((r) => r.isATM);
    if (atmLocal < 0) return;
    const body = strikeBodyRef.current;
    if (!body) return;
    const target = Math.max(0, atmLocal * ROW_HEIGHT - body.clientHeight / 2 + ROW_HEIGHT / 2);
    vSyncRef.current = "strike";
    body.scrollTop = target;
    if (callsBodyRef.current) callsBodyRef.current.scrollTop = target;
    if (putsBodyRef.current)  putsBodyRef.current.scrollTop = target;
    vSyncRef.current = null;
    lastAutoScrollKey.current = key;
  }, [underlying, expiry, strikeCount, rowMetrics, spot]);

  // ---------- helpers ------------------------------------------------------

  // Type-search filter for the underlying picker. Filters client-side
  // against the in-memory list (one /options-underlyings fetch covers
  // ~200 entries — substring matches feel instant). Matches against
  // both the canonical key (NIFTYBANK) and the display label (BANKNIFTY)
  // so users can type either.
  const filteredUnderlyings = useMemo(() => {
    const all = underlyingsList ?? [];
    const q = underlyingQuery.trim().toUpperCase();
    if (!q) return all;
    return all.filter((u) => {
      const label = LABEL_OVERRIDES[u.underlying] ?? u.underlying;
      return u.underlying.toUpperCase().includes(q) || label.toUpperCase().includes(q);
    });
  }, [underlyingsList, underlyingQuery]);

  // Reset highlight + scroll when the filter changes.
  useEffect(() => { setUnderlyingActiveIdx(0); }, [underlyingQuery]);

  // Outside-click close + autofocus the search input when opened.
  useEffect(() => {
    if (!underlyingPickerOpen) return;
    // Defer focus so the input is mounted before we grab it.
    const t = setTimeout(() => underlyingInputRef.current?.focus(), 0);
    function onDocClick(e: MouseEvent) {
      if (!underlyingPickerRef.current?.contains(e.target as Node)) {
        setUnderlyingPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [underlyingPickerOpen]);

  // Keep the highlighted row visible as Arrow keys move the cursor.
  useEffect(() => {
    if (!underlyingPickerOpen) return;
    const list = underlyingListRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(
      `[data-und-idx="${underlyingActiveIdx}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }, [underlyingActiveIdx, underlyingPickerOpen]);

  const pickUnderlying = useCallback((u: string) => {
    handleUnderlyingChange(u);
    setUnderlyingPickerOpen(false);
    setUnderlyingQuery("");
  }, [handleUnderlyingChange]);

  const onUnderlyingKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setUnderlyingActiveIdx((i) =>
        Math.min(i + 1, Math.max(filteredUnderlyings.length - 1, 0)),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setUnderlyingActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const target = filteredUnderlyings[underlyingActiveIdx];
      if (target) {
        e.preventDefault();
        pickUnderlying(target.underlying);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setUnderlyingPickerOpen(false);
    }
  }, [filteredUnderlyings, underlyingActiveIdx, pickUnderlying]);

  const activeColumns = useMemo(
    () => METRIC_COLUMNS.filter((c) => visibleColumns.includes(c.key)),
    [visibleColumns],
  );
  // Calls reversed so LTP is closest to strike.
  const callColumns = useMemo(() => [...activeColumns].reverse(), [activeColumns]);
  const putColumns = activeColumns;
  const sideTableMinWidth = activeColumns.length * SIDE_COLUMN_WIDTH;

  const toggleColumn = (column: MetricColumnKey) => {
    setVisibleColumns((prev) => {
      const exists = prev.includes(column);
      if (exists && prev.length === 1) return prev;     // never empty
      if (exists) return prev.filter((c) => c !== column);
      return [...prev, column];
    });
  };

  const renderCell = (
    side: "ce" | "pe",
    metrics: SideMetrics,
    key: MetricColumnKey,
    isITM: boolean,
    cellKey: string,
  ) => {
    const isOICol = key === "oi";
    const itmClass = side === "ce" ? "bg-profit/5" : "bg-loss/5";
    const baseClass = cn(
      "h-10 px-3 py-0 text-center align-middle whitespace-nowrap",
      isITM && !isOICol && itmClass,
    );
    const oiBar = isOICol ? (
      <div
        className="absolute top-1/2 left-[6px] h-[6px] -translate-y-1/2 rounded-sm"
        style={{
          width: `calc(${Math.round((metrics.oi / maxOI) * 100)}% - 12px)`,
          backgroundColor: side === "ce" ? "hsla(155, 100%, 40%, 0.45)" : "hsla(4, 85%, 50%, 0.45)",
        }}
      />
    ) : null;

    let content: React.ReactNode;
    switch (key) {
      case "buildup": {
        const b = BUILDUP_DISPLAY[metrics.buildup];
        content = metrics.buildup === "neutral"
          ? <span className={b.cls} title={b.title}>—</span>
          : (
            <span
              className={cn("inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-bold font-mono", b.cls)}
              title={b.title}
            >
              {b.label}
            </span>
          );
        break;
      }
      case "oiChange":
        content = <span className={metrics.oiChange >= 0 ? "text-profit" : "text-loss"}>{fmtKSigned(metrics.oiChange)}</span>;
        break;
      case "oi":
        content = <span className="font-medium">{fmtK(metrics.oi)}</span>;
        break;
      case "volume":
        content = <span className="text-muted-foreground">{fmtK(metrics.volume)}</span>;
        break;
      case "change":
        content = <span className={metrics.change >= 0 ? "text-profit" : "text-loss"}>{metrics.change === 0 ? "—" : fmtPctSigned(metrics.change)}</span>;
        break;
      case "ltp":
        content = <span className="font-semibold">{fmtPrice(metrics.ltp)}</span>;
        break;
      case "iv":
        content = <span className="text-muted-foreground">{metrics.iv > 0 ? `${metrics.iv.toFixed(1)}%` : "—"}</span>;
        break;
      case "delta":
        content = <span>{metrics.ltp > 0 ? metrics.delta.toFixed(3) : "—"}</span>;
        break;
      case "theta":
        content = <span className="text-loss">{metrics.ltp > 0 ? metrics.theta.toFixed(2) : "—"}</span>;
        break;
      case "gamma":
        content = <span>{metrics.ltp > 0 ? metrics.gamma.toFixed(5) : "—"}</span>;
        break;
      case "vega":
        content = <span>{metrics.ltp > 0 ? metrics.vega.toFixed(2) : "—"}</span>;
        break;
    }
    return (
      <td key={cellKey} className={cn(baseClass, isOICol && "relative")} style={{ minWidth: SIDE_COLUMN_WIDTH }}>
        {oiBar}
        <span className="relative z-[1]">{content}</span>
      </td>
    );
  };

  // ---------- render -------------------------------------------------------

  return (
    <div className="flex flex-col overflow-hidden h-[calc(100vh-7.5rem)]">
      {/* Title + filter row */}
      <div className="flex items-center justify-between gap-3 flex-wrap flex-shrink-0 mb-3">
        <div>
          <h2 className="text-xl font-bold">Option Chain</h2>
          <p className="text-sm text-muted-foreground">Live options data for Indian indices &amp; stocks</p>
        </div>
        <div className="flex items-center gap-2 flex-nowrap">
          {/* Underlying typeahead picker: full list when empty input,
              substring filter as you type, ↑/↓ to navigate, Enter to pick. */}
          <div ref={underlyingPickerRef} className="relative">
            <button
              type="button"
              onClick={() => setUnderlyingPickerOpen((o) => !o)}
              className={cn(
                "flex h-7 w-[140px] items-center justify-between gap-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs",
                "hover:bg-muted/40 focus:outline-none focus:ring-1 focus:ring-ring",
              )}
            >
              <span className="truncate">
                {LABEL_OVERRIDES[underlying] ?? underlying}
              </span>
              <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
            </button>
            {underlyingPickerOpen && (
              <div className="absolute z-30 mt-1 w-[220px] rounded-md border border-border bg-popover shadow-lg">
                <div className="relative border-b border-border/40 p-2">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={underlyingInputRef}
                    value={underlyingQuery}
                    onChange={(e) => setUnderlyingQuery(e.target.value)}
                    onKeyDown={onUnderlyingKeyDown}
                    placeholder="Search NIFTY, RELIANCE, SENSEX…"
                    className="w-full rounded border border-input bg-background pl-7 pr-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-ring"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div ref={underlyingListRef} className="max-h-72 overflow-y-auto py-1">
                  {filteredUnderlyings.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {underlyingsList ? "No matches" : "Loading…"}
                    </div>
                  ) : (
                    filteredUnderlyings.map((u, i) => {
                      const label = LABEL_OVERRIDES[u.underlying] ?? u.underlying;
                      const selected = u.underlying === underlying;
                      const active = i === underlyingActiveIdx;
                      return (
                        <button
                          key={u.underlying}
                          type="button"
                          data-und-idx={i}
                          onMouseEnter={() => setUnderlyingActiveIdx(i)}
                          onMouseDown={(e) => { e.preventDefault(); pickUnderlying(u.underlying); }}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs font-mono",
                            active && "bg-muted/60",
                            selected && "text-primary font-semibold",
                          )}
                        >
                          <span className="truncate">{label}</span>
                          <span className="text-[9px] uppercase text-muted-foreground shrink-0">
                            {u.kind === "INDEX" ? "idx" : "stock"}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger className="font-mono text-xs h-7 w-[150px]">
              <SelectValue placeholder="Expiry" />
            </SelectTrigger>
            <SelectContent>
              {(expiries ?? []).map((exp) => (
                <SelectItem key={exp} value={exp}>
                  {fmtExpiry(exp)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={strikeCount} onValueChange={setStrikeCount}>
            <SelectTrigger className="font-mono text-xs h-7 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRIKE_COUNT_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c} Strikes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 font-mono text-xs">
                <SlidersHorizontal className="h-3 w-3" />
                Columns ({activeColumns.length})
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-3">
              <div className="space-y-2">
                <p className="text-xs font-semibold">Show Columns</p>
                {METRIC_COLUMNS.map((column) => (
                  <label key={column.key} className="flex cursor-pointer items-center gap-2 text-xs">
                    <Checkbox
                      checked={visibleColumns.includes(column.key)}
                      onCheckedChange={() => toggleColumn(column.key)}
                    />
                    <span>{column.label}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Errors / loading / stat strip */}
      {expiriesError && (
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-4 text-sm text-loss mb-3">
          Failed to load expiries for {underlying}. Check that the symbol-master has been synced.
        </div>
      )}

      {feedSource === "eod" && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning mb-2 flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-warning" />
          Broker feed offline — showing last EOD prices
          {spotSource === "eod" && " (incl. spot)"}.
          Live ticks will resume once a broker is logged in.
        </div>
      )}

      {!expiriesError && chain && (
        <div className="flex items-center gap-4 mb-2 text-xs font-mono text-muted-foreground">
          <span>Spot <span className={cn("font-bold", spot != null ? "text-foreground" : "text-muted-foreground")}>
            {spot != null ? spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
          </span></span>
          <span>PCR <span className="font-bold text-foreground">{pcr}</span></span>
          <span>MaxPain <span className="font-bold text-foreground">
            {maxPainStrike != null ? maxPainStrike.toLocaleString("en-IN") : "—"}
          </span></span>
          <span className="ml-auto text-muted-foreground">
            {windowedRows.length} of {chain.rows.length} strikes
          </span>
        </div>
      )}

      {!chain && !expiriesError && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4 rounded-xl border border-border/40 bg-muted/20 px-10 py-8 shadow-sm">
            <Loader2 className="h-9 w-9 animate-spin text-primary" />
            <div className="flex flex-col items-center gap-1">
              <p className="text-sm font-semibold">
                Loading {LABEL_OVERRIDES[underlying] ?? underlying} option chain
              </p>
              <p className="text-xs text-muted-foreground">
                {!expiries
                  ? "Resolving expiries…"
                  : !expiry
                    ? "Picking nearest expiry…"
                    : chainLoading
                      ? `Fetching strikes for ${fmtExpiry(expiry)}…`
                      : "Preparing chain…"}
              </p>
            </div>
          </div>
        </div>
      )}

      {chain && chain.rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/40 py-10 text-center text-sm text-muted-foreground">
          No strikes for {underlying} {fmtExpiry(expiry)} in the symbol master yet.
        </div>
      )}

      {chain && rowMetrics.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/50 flex-1 flex flex-col">
          {/* Headers */}
          <div
            className="grid w-full"
            style={{ gridTemplateColumns: `minmax(0,1fr) ${STRIKE_COLUMN_WIDTH}px minmax(0,1fr)` }}
          >
            {/* Calls header */}
            <div className="min-w-0 border-r border-border/40">
              <div className="flex h-9 items-center justify-center border-b border-border/40 bg-profit/10 text-[11px] font-semibold uppercase tracking-wider text-profit">
                Calls
              </div>
              <div ref={callsHeaderRef} className="overflow-x-auto overflow-y-hidden scrollbar-hide">
                <table className="w-full text-[10px] font-mono uppercase tracking-wider" style={{ minWidth: sideTableMinWidth }}>
                  <thead>
                    <tr className="border-b border-border/40 bg-background text-muted-foreground">
                      {callColumns.map((c) => (
                        <th key={`ch-${c.key}`} className="h-9 px-3 py-0 text-center font-medium" style={{ minWidth: SIDE_COLUMN_WIDTH }}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                </table>
              </div>
            </div>

            {/* Strike header */}
            <div className="border-r border-border/40 bg-muted/60">
              <div className="flex h-9 items-center justify-center border-b border-border/40 text-[11px] font-semibold uppercase tracking-wider">
                Strike
              </div>
              <div className="flex h-9 items-center justify-center border-b border-border/40 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Strike
              </div>
            </div>

            {/* Puts header */}
            <div className="min-w-0">
              <div className="flex h-9 items-center justify-center border-b border-border/40 bg-loss/10 text-[11px] font-semibold uppercase tracking-wider text-loss">
                Puts
              </div>
              <div ref={putsHeaderRef} className="overflow-x-auto overflow-y-hidden scrollbar-hide">
                <table className="w-full text-[10px] font-mono uppercase tracking-wider" style={{ minWidth: sideTableMinWidth }}>
                  <thead>
                    <tr className="border-b border-border/40 bg-background text-muted-foreground">
                      {putColumns.map((c) => (
                        <th key={`ph-${c.key}`} className="h-9 px-3 py-0 text-center font-medium" style={{ minWidth: SIDE_COLUMN_WIDTH }}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                </table>
              </div>
            </div>
          </div>

          {/* Bodies */}
          <div
            className="grid w-full flex-1 overflow-hidden"
            style={{ gridTemplateColumns: `minmax(0,1fr) ${STRIKE_COLUMN_WIDTH}px minmax(0,1fr)` }}
          >
            {/* Calls body */}
            <div
              ref={callsBodyRef}
              onScroll={onCallsBodyScroll}
              className="min-w-0 overflow-x-auto overflow-y-auto scrollbar-hide border-r border-border/40 h-full"
            >
              <table className="w-full text-xs font-mono" style={{ minWidth: sideTableMinWidth }}>
                <tbody>
                  {rowMetrics.map((row) => {
                    const isMaxPain = maxPainStrike != null && row.strike === maxPainStrike;
                    return (
                      <tr key={`c-${row.strike}`} className={cn(
                        "border-b border-border/20 transition-colors hover:bg-muted/30",
                        row.isATM && "bg-primary/10",
                        isMaxPain && !row.isATM && "bg-warning/5",
                      )}>
                        {callColumns.map((c) => renderCell("ce", row.ce, c.key, row.isITMCall, `c-${row.strike}-${c.key}`))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Strike body */}
            <div
              ref={strikeBodyRef}
              onScroll={onStrikeBodyScroll}
              className="overflow-x-hidden overflow-y-auto scrollbar-hide border-r border-border/40 h-full"
            >
              <table className="w-full text-xs font-mono">
                <tbody>
                  {rowMetrics.map((row) => {
                    const isMaxPain = maxPainStrike != null && row.strike === maxPainStrike;
                    return (
                      <tr key={`s-${row.strike}`} className={cn(
                        "border-b border-border/20 transition-colors hover:bg-muted/30",
                        row.isATM && "bg-primary/10",
                        isMaxPain && !row.isATM && "bg-warning/5",
                      )}>
                        <td className={cn(
                          "h-10 px-2 py-0 text-center align-middle font-bold bg-muted/40 whitespace-nowrap",
                          row.isATM && "text-primary",
                          isMaxPain && "underline decoration-warning",
                        )} style={{ width: STRIKE_COLUMN_WIDTH }}>
                          {row.strike.toLocaleString("en-IN")}
                          {row.isATM && <span className="ml-1 text-[8px] text-primary">ATM</span>}
                          {isMaxPain && !row.isATM && <span className="ml-1 text-[8px] text-warning">MP</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Puts body */}
            <div
              ref={putsBodyRef}
              onScroll={onPutsBodyScroll}
              className="min-w-0 overflow-x-auto overflow-y-auto scrollbar-hide h-full"
            >
              <table className="w-full text-xs font-mono" style={{ minWidth: sideTableMinWidth }}>
                <tbody>
                  {rowMetrics.map((row) => {
                    const isMaxPain = maxPainStrike != null && row.strike === maxPainStrike;
                    return (
                      <tr key={`p-${row.strike}`} className={cn(
                        "border-b border-border/20 transition-colors hover:bg-muted/30",
                        row.isATM && "bg-primary/10",
                        isMaxPain && !row.isATM && "bg-warning/5",
                      )}>
                        {putColumns.map((c) => renderCell("pe", row.pe, c.key, row.isITMPut, `p-${row.strike}-${c.key}`))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
