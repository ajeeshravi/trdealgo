"use client";
/**
 * EOD Analysis — surfaces every NSE end-of-day signal the platform ingests.
 *
 * Five panels, each backed by one backend endpoint:
 *   • Indices hero                 GET /eod/indices/{date}
 *   • Top delivery % screener      GET /eod/delivery/top/{date}
 *   • F&O OI buildup               GET /eod/oi-buildup/{underlying}/{date}
 *   • Put-Call Ratio               GET /eod/pcr/{underlying}/{date}
 *   • Per-symbol history           GET /eod/delivery/{symbol}  or
 *                                  GET /eod/oi-history/{symbol}
 *
 * Date defaults to the most recent weekday so a cold-load shows real data
 * outside trading hours. Every panel falls back to a calm empty state if
 * the ingest for `date` hasn't run yet — operators can trigger it from
 * Admin → NSE EOD ingest → "Download now".
 */
import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Crosshair,
  Flame,
  Layers,
  PieChart as PieIcon,
  ScanLine,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MetricCard } from "@/components/MetricCard";
import { SymbolPicker } from "@/components/SymbolPicker";
import { api } from "@/lib/api";
import { prettySymbol } from "@/lib/fmt";
import { useMarketPollInterval } from "@/lib/marketHours";
import {
  isNonTradingDay,
  maxAvailableEodDateISO,
} from "@/lib/eodSchedule";
import { cn } from "@/lib/utils";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

// ---------------------------------------------------------------------------
// Types (mirror the backend response shapes)
// ---------------------------------------------------------------------------

type IndexRow = {
  internal_symbol: string;
  open: number; high: number; low: number; close: number;
  prev_close: number | null;
  change_pct: number | null;
};

type DeliveryTopRow = {
  internal_symbol: string;
  deliv_qty: number;
  deliv_pct: number;
};

type DeliveryHistRow = {
  trade_date: string;
  deliv_qty: number;
  deliv_pct: number;
  total_trades: number;
};

type BuildupTag =
  | "long_buildup" | "short_buildup"
  | "long_unwinding" | "short_covering"
  | "neutral";

type OiBuildupRow = {
  internal_symbol: string;
  expiry: string;
  settle_price: number;
  prev_settle: number;
  price_change: number;
  open_interest: number;
  chg_in_oi: number;
  buildup: BuildupTag;
};

type PcrPayload = {
  underlying: string;
  trade_date: string;
  expiry: string | null;
  call_oi: number;
  put_oi: number;
  pcr_oi: number | null;
  call_volume: number;
  put_volume: number;
  pcr_volume: number | null;
};

type OiHistRow = {
  trade_date: string;
  settle_price: number;
  open_interest: number;
  chg_in_oi: number;
  contracts: number;
  turnover: number;
};

type BreadthPayload = {
  trade_date: string;
  total_symbols: number;
  advances: number;
  declines: number;
  unchanged: number;
  adv_dec_ratio: number | null;
  total_turnover: number;
};

type MoverRow = {
  internal_symbol: string;
  close: number;
  prev_close: number;
  high: number;
  low: number;
  volume: number;
  change_pct: number;
};

type ActiveRow = {
  internal_symbol: string;
  close: number;
  volume: number;
  turnover: number;
};

type ExtremeRow = {
  internal_symbol: string;
  close: number;
  prior_high?: number;
  prior_low?: number;
  delta_pct: number;
};

type OiLeaderRow = {
  internal_symbol: string;
  underlying: string;
  expiry: string;
  settle_price: number;
  open_interest: number;
  chg_in_oi: number;
  contracts: number;
  turnover: number;
};

type OiByStrikeRow = {
  strike: number;
  call_oi: number;
  put_oi: number;
  call_chg: number;
  put_chg: number;
  call_settle: number | null;
  put_settle: number | null;
};

type MaxPainPayload = {
  underlying: string;
  trade_date: string;
  expiry: string | null;
  max_pain_strike: number;
  min_pain_value: number;
  pain_curve: { strike: number; pain: number }[];
};

type DailyCandle = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const COMMON_UNDERLYINGS = [
  "NIFTY", "NIFTYBANK", "FINNIFTY", "MIDCPNIFTY",
  "RELIANCE", "HDFCBANK", "TCS", "INFY", "TATAMOTORS", "SBIN",
];

// Indices we surface in the hero row. The backend returns ALL indices for
// the date; we filter client-side so this list is the only place to
// change the highlighted set.
const HERO_INDICES = new Set([
  "NSE_NIFTY50_IDX",
  "NSE_NIFTYBANK_IDX",
  "NSE_FINNIFTY_IDX",
  "NSE_INDIAVIX_IDX",
]);

export default function EODAnalysisPage() {
  // Fetches the admin-tuned ingest time so the cutoff in the date picker
  // tracks whatever's configured. Falls back to 19:30 IST while loading.
  const { data: schedule } = useSWR<{ eod_ingest_time: string; eod_ingest_enabled: boolean }>(
    "/eod/schedule", fetcher,
  );
  // Pull NSE holidays for the surrounding year so the date picker can
  // step back over them. One year is plenty — the picker only walks
  // back a handful of days at most.
  const today = new Date();
  const yearStart = `${today.getFullYear()}-01-01`;
  const yearEnd = `${today.getFullYear() + 1}-01-01`;
  const { data: holidayList } = useSWR<string[]>(
    `/eod/holidays?from=${yearStart}&to=${yearEnd}`, fetcher,
  );
  const holidaySet = useMemo(
    () => new Set<string>(holidayList || []),
    [holidayList],
  );

  const maxDate = maxAvailableEodDateISO(schedule?.eod_ingest_time, holidaySet);

  const [date, setDate] = useState<string>(maxDate);
  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [drillSymbol, setDrillSymbol] = useState<string>("");

  // Once the schedule fetch resolves, snap the picker forward to "today"
  // if the cutoff has just passed. Don't fight the user if they've
  // already moved the picker manually to a past date.
  useEffect(() => {
    setDate((cur) => (cur < maxDate ? cur : maxDate));
    // We only want to snap when the *maxDate* moves (i.e., schedule
    // resolves or the cutoff is crossed), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxDate]);

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            EOD Analysis
          </h1>
          <p className="text-sm text-muted-foreground">
            End-of-day market breakdown from NSE bhavcopies — delivery %,
            F&amp;O open interest, PCR, and per-symbol history.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <input
            className="input max-w-[200px]"
            type="date"
            value={date}
            max={maxDate}
            onChange={(e) => {
              const v = e.target.value;
              // `<input type=date>` can't disable specific dates, so we
              // bounce holidays back to the previous valid pick rather
              // than letting an empty panel-set confuse the user.
              if (v && isNonTradingDay(v, holidaySet)) return;
              setDate(v);
            }}
          />
          <span className="text-[10px] text-muted-foreground">
            Latest: {maxDate}
            {schedule?.eod_ingest_time && (
              <> · today opens after {schedule.eod_ingest_time} IST</>
            )}
            {holidaySet.size > 0 && (
              <> · {holidaySet.size} NSE holiday{holidaySet.size === 1 ? "" : "s"} skipped</>
            )}
          </span>
        </div>
      </header>

      <IndicesHero date={date} />

      <BreadthCard date={date} />

      <MoversCard date={date} onPickSymbol={setDrillSymbol} />

      <MostActiveCard date={date} onPickSymbol={setDrillSymbol} />

      <FiftyTwoWeekCard date={date} onPickSymbol={setDrillSymbol} />

      <TopDeliveryCard date={date} onPickSymbol={setDrillSymbol} />

      <OiLeadersCard date={date} onPickContract={setDrillSymbol} />

      <OiBuildupCard
        date={date}
        underlying={underlying}
        onChangeUnderlying={setUnderlying}
        onPickContract={setDrillSymbol}
      />

      <PcrCard date={date} underlying={underlying} />

      <MaxPainCard date={date} underlying={underlying} />

      <OiChangeByStrikeCard date={date} underlying={underlying} />

      <IntradayOiCard underlying={underlying} />

      <DrillDownCard
        symbol={drillSymbol}
        onChangeSymbol={setDrillSymbol}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Indices hero
// ---------------------------------------------------------------------------

function IndicesHero({ date }: { date: string }) {
  const { data, isLoading } = useSWR<IndexRow[]>(
    `/eod/indices/${date}`, fetcher,
  );
  const indices = useMemo(
    () => (data || []).filter((r) => HERO_INDICES.has(r.internal_symbol)),
    [data],
  );

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">Loading indices…</div>;
  }

  if (indices.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 className="w-4 h-4" />}
        title="No index data for this date"
        hint="The EOD ingest may not have run yet — try Admin → NSE EOD ingest → Download now."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {indices.map((r) => {
        const trend = (r.change_pct ?? 0) >= 0 ? "up" : "down";
        return (
          <MetricCard
            key={r.internal_symbol}
            label={prettySymbol(r.internal_symbol)}
            value={r.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            subValue={
              r.change_pct === null
                ? "no prior close"
                : `${r.change_pct >= 0 ? "+" : ""}${r.change_pct.toFixed(2)}%`
            }
            trend={trend}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top delivery % screener
// ---------------------------------------------------------------------------

function TopDeliveryCard({
  date,
  onPickSymbol,
}: {
  date: string;
  onPickSymbol: (sym: string) => void;
}) {
  const [minPct, setMinPct] = useState<number>(70);
  const [limit, setLimit] = useState<number>(50);

  const { data, isLoading } = useSWR<DeliveryTopRow[]>(
    `/eod/delivery/top/${date}?min_pct=${minPct}&limit=${limit}`,
    fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ScanLine className="w-4 h-4 text-primary" />
            Top delivery %
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            High delivery % = lower intraday flip; institutional accumulation
            often leaves a footprint here.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">Min %</label>
          <input
            type="number" min={0} max={100} step={5}
            className="input w-20"
            value={minPct}
            onChange={(e) => setMinPct(Number(e.target.value) || 0)}
          />
          <label className="text-muted-foreground">Limit</label>
          <input
            type="number" min={10} max={500} step={10}
            className="input w-20"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 50)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<ScanLine className="w-4 h-4" />}
          title="No matches"
          hint={`No equities crossed ${minPct}% delivery on ${date}.`}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="text-right">Delivery qty</th>
                <th className="text-right">Delivery %</th>
                <th className="text-right" />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr
                  key={r.internal_symbol}
                  className="hover:bg-accent/30 transition-colors cursor-pointer"
                  onClick={() => onPickSymbol(r.internal_symbol)}
                  title={r.internal_symbol}
                >
                  <td className="font-mono">{prettySymbol(r.internal_symbol)}</td>
                  <td className="font-mono text-right">
                    {r.deliv_qty.toLocaleString("en-IN")}
                  </td>
                  <td className="font-mono text-right text-profit">
                    {r.deliv_pct.toFixed(2)}%
                  </td>
                  <td className="text-right">
                    <span className="text-xs text-muted-foreground">drill ↓</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// F&O OI buildup
// ---------------------------------------------------------------------------

const BUILDUP_STYLE: Record<BuildupTag, { label: string; cls: string }> = {
  long_buildup:   { label: "Long buildup",   cls: "bg-profit/15 text-profit border-profit/40" },
  short_buildup:  { label: "Short buildup",  cls: "bg-loss/15 text-loss border-loss/40" },
  short_covering: { label: "Short covering", cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40" },
  long_unwinding: { label: "Long unwinding", cls: "bg-yellow-500/15 text-yellow-300 border-yellow-500/40" },
  neutral:        { label: "Neutral",        cls: "bg-white/5 text-muted-foreground border-white/10" },
};

function OiBuildupCard({
  date,
  underlying,
  onChangeUnderlying,
  onPickContract,
}: {
  date: string;
  underlying: string;
  onChangeUnderlying: (u: string) => void;
  onPickContract: (sym: string) => void;
}) {
  const { data, isLoading } = useSWR<OiBuildupRow[]>(
    underlying ? `/eod/oi-buildup/${underlying}/${date}` : null,
    fetcher,
  );

  // Counts per category, for the header strip.
  const counts = useMemo(() => {
    const c: Record<BuildupTag, number> = {
      long_buildup: 0, short_buildup: 0, long_unwinding: 0, short_covering: 0, neutral: 0,
    };
    (data || []).forEach((r) => { c[r.buildup] = (c[r.buildup] || 0) + 1; });
    return c;
  }, [data]);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            F&amp;O OI buildup
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Classified by (ΔSettlePrice, ΔOI). Sorted by abs(ΔOI) — biggest
            money moves on top.
          </p>
        </div>
        <UnderlyingInput value={underlying} onChange={onChangeUnderlying} />
      </div>

      {/* Counts strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-xs">
        {(["long_buildup", "short_buildup", "short_covering", "long_unwinding"] as BuildupTag[])
          .map((tag) => (
            <div
              key={tag}
              className={cn("rounded border px-2 py-1.5", BUILDUP_STYLE[tag].cls)}
            >
              <div className="uppercase tracking-wide text-[10px] opacity-80">
                {BUILDUP_STYLE[tag].label}
              </div>
              <div className="font-mono text-lg">{counts[tag]}</div>
            </div>
          ))}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<Layers className="w-4 h-4" />}
          title={`No FO data for ${underlying} on ${date}`}
          hint="Try a different underlying or date, or run the EOD ingest from Admin."
        />
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="table">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th>Contract</th>
                <th className="text-right">Settle</th>
                <th className="text-right">Δ Settle</th>
                <th className="text-right">OI</th>
                <th className="text-right">Δ OI</th>
                <th>Buildup</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                const style = BUILDUP_STYLE[r.buildup];
                return (
                  <tr
                    key={r.internal_symbol}
                    className="hover:bg-accent/30 transition-colors cursor-pointer"
                    onClick={() => onPickContract(r.internal_symbol)}
                    title={r.internal_symbol}
                  >
                    <td className="font-mono text-xs">{prettySymbol(r.internal_symbol)}</td>
                    <td className="font-mono text-right">{r.settle_price.toFixed(2)}</td>
                    <td className={cn(
                      "font-mono text-right",
                      r.price_change >= 0 ? "text-profit" : "text-loss",
                    )}>
                      {r.price_change >= 0 ? "+" : ""}{r.price_change.toFixed(2)}
                    </td>
                    <td className="font-mono text-right">
                      {r.open_interest.toLocaleString("en-IN")}
                    </td>
                    <td className={cn(
                      "font-mono text-right",
                      r.chg_in_oi >= 0 ? "text-profit" : "text-loss",
                    )}>
                      {r.chg_in_oi >= 0 ? "+" : ""}{r.chg_in_oi.toLocaleString("en-IN")}
                    </td>
                    <td>
                      <span className={cn(
                        "pill border text-[10px]",
                        style.cls,
                      )}>
                        {style.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PCR card
// ---------------------------------------------------------------------------

function PcrCard({ date, underlying }: { date: string; underlying: string }) {
  const { data, error, isLoading } = useSWR<PcrPayload>(
    underlying ? `/eod/pcr/${underlying}/${date}` : null,
    fetcher,
    { shouldRetryOnError: false },
  );

  const bias =
    data?.pcr_oi == null
      ? null
      : data.pcr_oi > 1.3
        ? { label: "Bullish (heavy put writing)", cls: "text-profit" }
        : data.pcr_oi < 0.7
          ? { label: "Bearish (heavy call writing)", cls: "text-loss" }
          : { label: "Neutral", cls: "text-muted-foreground" };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <PieIcon className="w-4 h-4 text-primary" />
            Put-Call Ratio · {underlying}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            PCR(OI) {">"}1.3 typically bullish, {"<"}0.7 bearish. Volume-based
            PCR adds a flow lens on top of positioning.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : error || !data ? (
        <EmptyState
          icon={<PieIcon className="w-4 h-4" />}
          title="No PCR available"
          hint={`No option data for ${underlying} on ${date}.`}
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <BigStat
            label="PCR (OI)"
            value={data.pcr_oi == null ? "—" : data.pcr_oi.toFixed(2)}
            sub={bias?.label ?? ""}
            subCls={bias?.cls ?? ""}
          />
          <BigStat
            label="PCR (Volume)"
            value={data.pcr_volume == null ? "—" : data.pcr_volume.toFixed(2)}
          />
          <div className="rounded border border-white/10 bg-white/5 p-3 text-xs space-y-1">
            <div className="uppercase tracking-wide text-[10px] text-muted-foreground">
              Open interest
            </div>
            <div className="flex justify-between">
              <span className="text-profit">Calls</span>
              <span className="font-mono">{data.call_oi.toLocaleString("en-IN")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-loss">Puts</span>
              <span className="font-mono">{data.put_oi.toLocaleString("en-IN")}</span>
            </div>
          </div>
          <div className="rounded border border-white/10 bg-white/5 p-3 text-xs space-y-1">
            <div className="uppercase tracking-wide text-[10px] text-muted-foreground">
              Volume (contracts)
            </div>
            <div className="flex justify-between">
              <span className="text-profit">Calls</span>
              <span className="font-mono">{data.call_volume.toLocaleString("en-IN")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-loss">Puts</span>
              <span className="font-mono">{data.put_volume.toLocaleString("en-IN")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-symbol drilldown
// ---------------------------------------------------------------------------

function DrillDownCard({
  symbol,
  onChangeSymbol,
}: {
  symbol: string;
  onChangeSymbol: (s: string) => void;
}) {
  const isOption = /_CE$|_PE$/.test(symbol);
  const isFuture = /_FUT$/.test(symbol);
  const isFno = isOption || isFuture;
  // Equity grammar: NSE_X-SERIES, BSE_X-SERIES. Detect by hyphen segment
  // before the end. (Index symbols end with `_IDX` — no delivery/OI for those.)
  const isEquity = /^(?:NSE|BSE)_[A-Z0-9&]+(?:-[A-Z0-9]+)+$/.test(symbol);
  const isIndex  = /_IDX$/.test(symbol);

  const { data: deliv } = useSWR<DeliveryHistRow[]>(
    symbol && isEquity ? `/eod/delivery/${symbol}?days=60` : null,
    fetcher,
  );
  const { data: oi } = useSWR<OiHistRow[]>(
    symbol && isFno ? `/eod/oi-history/${symbol}?days=60` : null,
    fetcher,
  );
  // Daily candles are available for every symbol type the EOD writer
  // produces — equities, FO contracts, AND indices. We show them on
  // every drill-down so the chart is always anchored to actual price.
  const { data: candles } = useSWR<DailyCandle[]>(
    symbol ? `/eod/candles/${symbol}?days=90` : null,
    fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Symbol drill-down
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Daily price chart for any symbol plus delivery % (equities)
            or OI history (F&amp;O). Tables above are clickable.
          </p>
        </div>
        <div className="w-full md:w-80">
          <SymbolPicker
            value={symbol}
            onChange={onChangeSymbol}
            placeholder="RELIANCE-EQ, NIFTY 24500 CE, …"
          />
        </div>
      </div>

      {!symbol ? (
        <EmptyState
          icon={<Activity className="w-4 h-4" />}
          title="Nothing selected"
          hint="Pick a symbol above, or click a row in the panels above."
        />
      ) : (
        <div className="space-y-4">
          {/* Daily price — every symbol type */}
          <DailyPriceChart rows={candles || []} symbol={symbol} />

          {/* Then the symbol-class-specific overlay */}
          {isEquity && <DeliveryChart rows={deliv || []} symbol={symbol} />}
          {isFno    && <OiHistoryChart rows={oi || []} symbol={symbol} />}
          {isIndex  && (
            <div className="text-xs text-muted-foreground">
              Indices don&apos;t have delivery or OI history — only daily OHLC above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function DailyPriceChart({ rows, symbol }: { rows: DailyCandle[]; symbol: string }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="w-4 h-4" />}
        title="No daily candles"
        hint={`No 1d data ingested yet for ${symbol}. Run a backfill from Admin.`}
      />
    );
  }
  const series = rows.map((r) => ({
    date: r.ts.slice(0, 10),
    close: r.close,
    high:  r.high,
    low:   r.low,
    volume: r.volume,
  }));
  const first = series[0].close;
  const last  = series[series.length - 1].close;
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-2">
        <span className="font-mono" title={symbol}>{prettySymbol(symbol)}</span> · {series.length} days ·
        last close <span className="font-mono">{last.toFixed(2)}</span>{" "}
        (<span className={changePct >= 0 ? "text-profit" : "text-loss"}>
          {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
        </span> over window)
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="price" stroke="#6b7280" tick={{ fontSize: 10 }}
                   domain={["auto", "auto"]} />
            <YAxis yAxisId="vol" orientation="right" stroke="#6b7280"
                   tick={{ fontSize: 10 }}
                   tickFormatter={(v) => fmtCount_short(v)} />
            <Tooltip
              contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
              formatter={(v: number, name: string) =>
                name === "volume"
                  ? [fmtCount_short(v), "Volume"]
                  : [v.toFixed(2), name === "close" ? "Close" : name]}
            />
            <Bar yAxisId="vol" dataKey="volume" fill="#374151" opacity={0.6} />
            <Line yAxisId="price" type="monotone" dataKey="close"
                  stroke="#60a5fa" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DeliveryChart({ rows, symbol }: { rows: DeliveryHistRow[]; symbol: string }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<TrendingUp className="w-4 h-4" />}
        title="No delivery history"
        hint={`Backfill EOD data to see delivery % over time for ${symbol}.`}
      />
    );
  }
  // Backend returns desc; reverse for a left-to-right chart timeline.
  const series = [...rows].reverse().map((r) => ({
    date: r.trade_date,
    deliv_pct: r.deliv_pct,
  }));
  const avg = series.reduce((a, b) => a + b.deliv_pct, 0) / series.length;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-2">
        <span className="font-mono" title={symbol}>{prettySymbol(symbol)}</span> · last {series.length} days ·{" "}
        average delivery <span className="font-mono">{avg.toFixed(2)}%</span>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} />
            <YAxis stroke="#6b7280" tick={{ fontSize: 11 }}
                   domain={[0, 100]} unit="%" />
            <Tooltip
              contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Delivery"]}
            />
            <Line type="monotone" dataKey="deliv_pct" stroke="#22c55e" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function OiHistoryChart({ rows, symbol }: { rows: OiHistRow[]; symbol: string }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<TrendingUp className="w-4 h-4" />}
        title="No OI history"
        hint={`Backfill EOD data to see OI evolution for ${symbol}.`}
      />
    );
  }
  const series = [...rows].reverse().map((r) => ({
    date: r.trade_date,
    open_interest: r.open_interest,
    settle: r.settle_price,
  }));

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        <span className="font-mono" title={symbol}>{prettySymbol(symbol)}</span> · last {series.length} days ·{" "}
        latest OI{" "}
        <span className="font-mono">
          {series[series.length - 1].open_interest.toLocaleString("en-IN")}
        </span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} />
            <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
              formatter={(v: number, name: string) =>
                name === "OI"
                  ? [v.toLocaleString("en-IN"), "OI"]
                  : [v.toFixed(2), "Settle"]
              }
            />
            <Line type="monotone" dataKey="open_interest" name="OI"
                  stroke="#60a5fa" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} />
            <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
              formatter={(v: number) => [v.toFixed(2), "Settle"]}
            />
            <Line type="monotone" dataKey="settle" name="Settle"
                  stroke="#f59e0b" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

function UnderlyingInput({
  value, onChange,
}: { value: string; onChange: (u: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        className="input text-xs w-40 font-mono"
        list="eod-common-underlyings"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="NIFTY, RELIANCE…"
      />
      <datalist id="eod-common-underlyings">
        {COMMON_UNDERLYINGS.map((u) => <option key={u} value={u} />)}
      </datalist>
    </div>
  );
}

function BigStat({
  label, value, sub, subCls,
}: { label: string; value: string; sub?: string; subCls?: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-3">
      <div className="uppercase tracking-wide text-[10px] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-2xl font-bold mt-1">{value}</div>
      {sub && <div className={cn("text-xs mt-1", subCls)}>{sub}</div>}
    </div>
  );
}

function EmptyState({
  icon, title, hint,
}: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-6 text-center">
      <div className="mx-auto w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div className="mt-2 text-sm">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



function fmtINR_short(n: number): string {
  // 12,345,678 → "₹1.23 Cr"; 8,500,000 → "₹85.0 L"; smaller → "₹85,000"
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}


function fmtCount_short(n: number): string {
  // 1,234,567 → "1.23M"; 8,500 → "8.5K"
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-IN");
}


// ---------------------------------------------------------------------------
// Market breadth
// ---------------------------------------------------------------------------

function BreadthCard({ date }: { date: string }) {
  const { data, isLoading } = useSWR<BreadthPayload>(
    `/eod/breadth/${date}`, fetcher,
  );

  if (isLoading) return null;
  if (!data || data.total_symbols === 0) return null;

  const advPct = data.total_symbols > 0 ? (data.advances / data.total_symbols) * 100 : 0;
  const decPct = data.total_symbols > 0 ? (data.declines / data.total_symbols) * 100 : 0;

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Flame className="w-4 h-4 text-primary" />
          Market breadth
        </h2>
        <span className="text-xs text-muted-foreground">
          {data.total_symbols.toLocaleString("en-IN")} NSE equities
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <BigStat
          label="Advances"
          value={data.advances.toLocaleString("en-IN")}
          sub={`${advPct.toFixed(1)}%`}
          subCls="text-profit"
        />
        <BigStat
          label="Declines"
          value={data.declines.toLocaleString("en-IN")}
          sub={`${decPct.toFixed(1)}%`}
          subCls="text-loss"
        />
        <BigStat
          label="Unchanged"
          value={data.unchanged.toLocaleString("en-IN")}
        />
        <BigStat
          label="A/D ratio"
          value={data.adv_dec_ratio == null ? "—" : data.adv_dec_ratio.toFixed(2)}
          sub={data.adv_dec_ratio == null ? "" :
               data.adv_dec_ratio > 1.5 ? "Strongly bullish" :
               data.adv_dec_ratio > 1   ? "Bullish" :
               data.adv_dec_ratio > 0.67 ? "Mixed" : "Bearish"}
          subCls={data.adv_dec_ratio == null ? "" :
                  data.adv_dec_ratio > 1 ? "text-profit" : "text-loss"}
        />
        <BigStat
          label="Total turnover"
          value={fmtINR_short(data.total_turnover)}
        />
      </div>

      {/* Visual breadth bar */}
      <div className="mt-3 h-2 rounded overflow-hidden flex border border-white/10">
        <div className="bg-profit" style={{ width: `${advPct}%` }} title={`${data.advances} advances`} />
        <div className="bg-white/10" style={{ width: `${(100 - advPct - decPct)}%` }} title={`${data.unchanged} unchanged`} />
        <div className="bg-loss" style={{ width: `${decPct}%` }} title={`${data.declines} declines`} />
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Top gainers / losers
// ---------------------------------------------------------------------------

function MoversCard({
  date, onPickSymbol,
}: { date: string; onPickSymbol: (s: string) => void }) {
  const [tab, setTab] = useState<"gainers" | "losers">("gainers");
  const { data, isLoading } = useSWR<MoverRow[]>(
    `/eod/movers/${date}?kind=${tab}&limit=25`, fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            {tab === "gainers"
              ? <TrendingUp className="w-4 h-4 text-profit" />
              : <TrendingDown className="w-4 h-4 text-loss" />}
            Top {tab}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            By % change. Symbols with prev_close &lt; ₹5 filtered out.
          </p>
        </div>
        <div className="flex gap-1">
          <TabPill active={tab === "gainers"} onClick={() => setTab("gainers")} cls="text-profit">
            Gainers
          </TabPill>
          <TabPill active={tab === "losers"} onClick={() => setTab("losers")} cls="text-loss">
            Losers
          </TabPill>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<TrendingUp className="w-4 h-4" />}
                    title="No movers for this date"
                    hint="Bhavcopy may not be ingested yet." />
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="table">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th>Symbol</th>
                <th className="text-right">Close</th>
                <th className="text-right">Prev</th>
                <th className="text-right">Change %</th>
                <th className="text-right">Volume</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.internal_symbol}
                    className="hover:bg-accent/30 cursor-pointer"
                    onClick={() => onPickSymbol(r.internal_symbol)}
                    title={r.internal_symbol}>
                  <td className="font-mono">{prettySymbol(r.internal_symbol)}</td>
                  <td className="font-mono text-right">{r.close.toFixed(2)}</td>
                  <td className="font-mono text-right text-muted-foreground">
                    {r.prev_close.toFixed(2)}
                  </td>
                  <td className={cn(
                    "font-mono text-right",
                    r.change_pct >= 0 ? "text-profit" : "text-loss",
                  )}>
                    {r.change_pct >= 0 ? "+" : ""}{r.change_pct.toFixed(2)}%
                  </td>
                  <td className="font-mono text-right text-xs">
                    {fmtCount_short(r.volume)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Most active (by turnover or volume)
// ---------------------------------------------------------------------------

function MostActiveCard({
  date, onPickSymbol,
}: { date: string; onPickSymbol: (s: string) => void }) {
  const [tab, setTab] = useState<"turnover" | "volume">("turnover");
  const { data, isLoading } = useSWR<ActiveRow[]>(
    `/eod/most-active/${date}?by=${tab}&limit=25`, fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Most active
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Largest equity flows of the day — institutional footprint.
          </p>
        </div>
        <div className="flex gap-1">
          <TabPill active={tab === "turnover"} onClick={() => setTab("turnover")}>
            By turnover
          </TabPill>
          <TabPill active={tab === "volume"} onClick={() => setTab("volume")}>
            By volume
          </TabPill>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<Zap className="w-4 h-4" />}
                    title="No data"
                    hint="Ingest may not be complete." />
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="table">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th>Symbol</th>
                <th className="text-right">Close</th>
                <th className="text-right">Volume</th>
                <th className="text-right">Turnover</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.internal_symbol}
                    className="hover:bg-accent/30 cursor-pointer"
                    onClick={() => onPickSymbol(r.internal_symbol)}
                    title={r.internal_symbol}>
                  <td className="font-mono">{prettySymbol(r.internal_symbol)}</td>
                  <td className="font-mono text-right">{r.close.toFixed(2)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.volume)}</td>
                  <td className="font-mono text-right">{fmtINR_short(r.turnover)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// 52-week highs / lows
// ---------------------------------------------------------------------------

function FiftyTwoWeekCard({
  date, onPickSymbol,
}: { date: string; onPickSymbol: (s: string) => void }) {
  const [tab, setTab] = useState<"highs" | "lows">("highs");
  const { data, isLoading } = useSWR<ExtremeRow[]>(
    `/eod/52w-extremes/${date}?kind=${tab}&limit=50`, fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            52-week {tab}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Equities at or near their 365-day extreme (within 0.5% tolerance).
          </p>
        </div>
        <div className="flex gap-1">
          <TabPill active={tab === "highs"} onClick={() => setTab("highs")} cls="text-profit">
            New highs
          </TabPill>
          <TabPill active={tab === "lows"} onClick={() => setTab("lows")} cls="text-loss">
            New lows
          </TabPill>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<Target className="w-4 h-4" />}
                    title={`No 52-week ${tab}`}
                    hint="Either no stocks crossed the boundary, or insufficient history." />
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="table">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th>Symbol</th>
                <th className="text-right">Close</th>
                <th className="text-right">Prior {tab === "highs" ? "high" : "low"}</th>
                <th className="text-right">Δ%</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.internal_symbol}
                    className="hover:bg-accent/30 cursor-pointer"
                    onClick={() => onPickSymbol(r.internal_symbol)}
                    title={r.internal_symbol}>
                  <td className="font-mono">{prettySymbol(r.internal_symbol)}</td>
                  <td className="font-mono text-right">{r.close.toFixed(2)}</td>
                  <td className="font-mono text-right text-muted-foreground">
                    {(r.prior_high ?? r.prior_low ?? 0).toFixed(2)}
                  </td>
                  <td className={cn(
                    "font-mono text-right",
                    tab === "highs" ? "text-profit" : "text-loss",
                  )}>
                    {r.delta_pct >= 0 ? "+" : ""}{r.delta_pct.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// OI leaders
// ---------------------------------------------------------------------------

function OiLeadersCard({
  date, onPickContract,
}: { date: string; onPickContract: (s: string) => void }) {
  const [tab, setTab] = useState<"open_interest" | "abs_chg_in_oi">("open_interest");
  const { data, isLoading } = useSWR<OiLeaderRow[]>(
    `/eod/oi-leaders/${date}?metric=${tab}&limit=25`, fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-primary" />
            F&amp;O OI leaders
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Biggest open-interest concentrations and biggest single-day OI moves.
          </p>
        </div>
        <div className="flex gap-1">
          <TabPill active={tab === "open_interest"} onClick={() => setTab("open_interest")}>
            Total OI
          </TabPill>
          <TabPill active={tab === "abs_chg_in_oi"} onClick={() => setTab("abs_chg_in_oi")}>
            |Δ OI|
          </TabPill>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<Crosshair className="w-4 h-4" />}
                    title="No F&O data"
                    hint="FO bhavcopy may not be ingested yet." />
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="table">
            <thead className="sticky top-0 bg-card z-10">
              <tr>
                <th>Contract</th>
                <th>Expiry</th>
                <th className="text-right">Settle</th>
                <th className="text-right">OI</th>
                <th className="text-right">Δ OI</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.internal_symbol}
                    className="hover:bg-accent/30 cursor-pointer"
                    onClick={() => onPickContract(r.internal_symbol)}
                    title={r.internal_symbol}>
                  <td className="font-mono text-xs">{prettySymbol(r.internal_symbol)}</td>
                  <td className="text-xs text-muted-foreground">{r.expiry}</td>
                  <td className="font-mono text-right">{r.settle_price.toFixed(2)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.open_interest)}</td>
                  <td className={cn(
                    "font-mono text-right",
                    r.chg_in_oi >= 0 ? "text-profit" : "text-loss",
                  )}>
                    {r.chg_in_oi >= 0 ? "+" : ""}{fmtCount_short(r.chg_in_oi)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Max Pain + OI distribution
// ---------------------------------------------------------------------------

function MaxPainCard({ date, underlying }: { date: string; underlying: string }) {
  const { data: chain, isLoading: chainLoading } = useSWR<OiByStrikeRow[]>(
    underlying ? `/eod/oi-by-strike/${underlying}/${date}` : null,
    fetcher,
  );
  const { data: mp, error: mpErr } = useSWR<MaxPainPayload>(
    underlying ? `/eod/max-pain/${underlying}/${date}` : null,
    fetcher,
    { shouldRetryOnError: false },
  );

  // Build the chart data: each row is one strike with calls (positive)
  // and puts (negative) on opposite sides — gives the classic "option
  // skyscraper" look. Putting calls below the axis visually reads the
  // wrong way for traders used to NSE's tool; we keep calls positive,
  // puts as a separate green-vs-red colored bar.
  const chartData = useMemo(
    () => (chain || []).map((r) => ({
      strike: r.strike,
      "Call OI": r.call_oi,
      "Put OI":  r.put_oi,
    })),
    [chain],
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Max Pain &amp; OI distribution · {underlying}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Where option writers benefit most if spot pins at expiry.
            Strikes with highest combined OI act as gravity for the spot.
          </p>
        </div>
        {mp && (
          <div className="rounded border border-primary/40 bg-primary/10 px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-primary">
              Max pain strike
            </div>
            <div className="font-mono text-xl font-bold text-primary">
              {mp.max_pain_strike.toLocaleString("en-IN")}
            </div>
          </div>
        )}
      </div>

      {chainLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !chain || chain.length === 0 ? (
        <EmptyState icon={<Target className="w-4 h-4" />}
                    title={`No option data for ${underlying} on ${date}`}
                    hint="Try a different underlying, or ingest the FO bhavcopy." />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="strike" stroke="#6b7280" tick={{ fontSize: 10 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }}
                     tickFormatter={(v) => fmtCount_short(v)} />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number) => fmtCount_short(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {mp && (
                <ReferenceLine
                  x={mp.max_pain_strike}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: "Max Pain", position: "top", fontSize: 10, fill: "#f59e0b" }}
                />
              )}
              <Bar dataKey="Call OI" fill="#22c55e" />
              <Bar dataKey="Put OI"  fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// OI Change vs Strike — Sensibull-style buildup/unwind chart
//
// Same data source as MaxPainCard; SWR dedupes the request so we don't
// double-fetch. The chart contrasts positive vs negative ΔOI per strike:
//   * Calls (green): positive = fresh writing (short build → resistance);
//                    negative = covering (bullish exit).
//   * Puts  (red):   positive = fresh writing (short build → support);
//                    negative = covering (bearish exit).
// The "max |ΔOI|" badge surfaces where the biggest positional move
// happened that day — usually more actionable than the absolute OI peak.
// ---------------------------------------------------------------------------

function OiChangeByStrikeCard({ date, underlying }: { date: string; underlying: string }) {
  const { data: chain, isLoading } = useSWR<OiByStrikeRow[]>(
    underlying ? `/eod/oi-by-strike/${underlying}/${date}` : null,
    fetcher,
  );

  const chartData = useMemo(
    () => (chain || []).map((r) => ({
      strike: r.strike,
      "Call ΔOI": r.call_chg,
      "Put ΔOI":  r.put_chg,
    })),
    [chain],
  );

  // Strike with the largest absolute ΔOI move — either side. Surfaced as
  // a badge so the operator can spot it without scanning every bar.
  const peak = useMemo(() => {
    if (!chain || chain.length === 0) return null;
    let best = chain[0];
    let bestAbs = Math.abs(best.call_chg) + Math.abs(best.put_chg);
    for (const r of chain) {
      const a = Math.abs(r.call_chg) + Math.abs(r.put_chg);
      if (a > bestAbs) { best = r; bestAbs = a; }
    }
    return best;
  }, [chain]);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            OI Change vs Strike · {underlying}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            ΔOI per strike vs the prior session. Positive = fresh writes,
            negative = covering. Calls bar green, puts red.
          </p>
        </div>
        {peak && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-warning">
              Biggest move
            </div>
            <div className="font-mono text-xl font-bold text-warning">
              {peak.strike.toLocaleString("en-IN")}
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !chain || chain.length === 0 ? (
        <EmptyState icon={<Target className="w-4 h-4" />}
                    title={`No option data for ${underlying} on ${date}`}
                    hint="Try a different underlying, or ingest the FO bhavcopy." />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="strike" stroke="#6b7280" tick={{ fontSize: 10 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }}
                     tickFormatter={(v) => fmtCount_short(v)} />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number) => fmtCount_short(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Bar dataKey="Call ΔOI" fill="#22c55e" />
              <Bar dataKey="Put ΔOI"  fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Intraday OI evolution — line chart of Call/Put total OI through the day
//
// Fed by /eod/intraday-oi-aggregate/{underlying}, which sums OI per
// snapshot timestamp and computes PCR. The Celery beat task
// `intraday_oi.snapshot` writes one snapshot every 5 min between
// 09:15-15:30 IST; empty state covers fresh installs / off-hours where
// no rows exist yet.
// ---------------------------------------------------------------------------

type IntradayOiPoint = {
  ts: string;
  call_oi_total: number;
  put_oi_total: number;
  pcr_oi: number | null;
};

function IntradayOiCard({ underlying }: { underlying: string }) {
  // Auto-refresh every 60s during NSE/BSE F&O hours (09:15–15:30 IST
  // Mon-Fri). Celery only writes intraday OI snapshots in that window,
  // so polling outside it returns the same payload — gate it off.
  const intradayOiPoll = useMarketPollInterval(60_000, "EQ_FO");
  const { data, isLoading } = useSWR<IntradayOiPoint[]>(
    underlying ? `/eod/intraday-oi-aggregate/${underlying}` : null,
    fetcher,
    { refreshInterval: intradayOiPoll },
  );

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.map((p) => ({
      // Render HH:MM in IST for the x-axis tick. Backend ships ISO
      // with timezone offset; trust the browser to format locally.
      time: new Date(p.ts).toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: false,
      }),
      "Call OI": p.call_oi_total,
      "Put OI":  p.put_oi_total,
      PCR: p.pcr_oi,
    }));
  }, [data]);

  const latest = data && data.length > 0 ? data[data.length - 1] : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Intraday OI · {underlying}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Total Call vs Put OI through the session (5-min snapshots).
            Watch for crossovers — a rising Put OI relative to Call OI
            often precedes intraday support.
          </p>
        </div>
        {latest && (
          <div className="flex items-center gap-2">
            <div className="rounded border border-primary/40 bg-primary/10 px-3 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-primary">
                Latest PCR(OI)
              </div>
              <div className="font-mono text-xl font-bold text-primary">
                {latest.pcr_oi != null ? latest.pcr_oi.toFixed(2) : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<Activity className="w-4 h-4" />}
          title={`No intraday OI for ${underlying} today`}
          hint="Snapshots run every 5 min from 09:15-15:30 IST. Outside market hours this is expected."
        />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="time" stroke="#6b7280" tick={{ fontSize: 10 }} />
              <YAxis
                yAxisId="oi"
                stroke="#6b7280" tick={{ fontSize: 10 }}
                tickFormatter={(v) => fmtCount_short(v)}
              />
              <YAxis
                yAxisId="pcr"
                orientation="right"
                stroke="#f59e0b"
                tick={{ fontSize: 10 }}
                domain={[0, "auto"]}
              />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number, name: string) =>
                  name === "PCR"
                    ? [v != null ? v.toFixed(2) : "—", name]
                    : [fmtCount_short(v), name]
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="oi" type="monotone" dataKey="Call OI"
                    stroke="#22c55e" strokeWidth={2} dot={false} />
              <Line yAxisId="oi" type="monotone" dataKey="Put OI"
                    stroke="#ef4444" strokeWidth={2} dot={false} />
              <Line yAxisId="pcr" type="monotone" dataKey="PCR"
                    stroke="#f59e0b" strokeWidth={1.5}
                    strokeDasharray="4 2" dot={false} />
              <ReferenceLine yAxisId="pcr" y={1} stroke="#f59e0b"
                             strokeDasharray="2 2" opacity={0.4} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Reusable: tab pill
// ---------------------------------------------------------------------------

function TabPill({
  active, onClick, children, cls,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  cls?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1 rounded text-xs font-medium border transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-white/10 text-muted-foreground hover:border-white/20",
        cls,
      )}
    >
      {children}
    </button>
  );
}

