"use client";
/**
 * Tomorrow's Plan — actionable EOD-derived trade ideas.
 *
 * Section A (this page): Index Options Plan for NIFTY · BANKNIFTY ·
 * SENSEX. One card per index showing bias, strategy, key levels,
 * expected next-session range, and the bullish/bearish signals that
 * drove the verdict.
 *
 * Backend: GET /api/v1/eod/tomorrow-plan/options
 *
 * Sections B (Intraday Stocks) and C (F&O R:R Scanner) will land on the
 * same page below this block.
 */
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  Goal,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  Layers,
  Lightbulb,
  Target,
  Gauge,
  RefreshCw,
  Crosshair,
} from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Types — mirror backend `tomorrow_plan.py` response shape.
// ---------------------------------------------------------------------------

type Bias =
  | "STRONG_BULL" | "MILD_BULL" | "NEUTRAL" | "MILD_BEAR" | "STRONG_BEAR";

interface Signal {
  name: string;
  score: number;
  weight: number;
  tag: string;
}

interface Verdict {
  bias: Bias;
  composite: number;
  bullish: Signal[];
  bearish: Signal[];
  neutral: Signal[];
}

interface EmaStack {
  score: number;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  above: string[];
  computed: string[];
  tag: string;
}

interface Pivots {
  pp: number; r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number;
}

interface ExpectedRange {
  lower: number;
  upper: number;
  lower_2x: number;
  upper_2x: number;
  atr: number;
}

interface OiWalls {
  highest_call_oi_strike: number | null;
  highest_put_oi_strike: number | null;
  call_oi_total: number;
  put_oi_total: number;
}

interface MaxPain {
  underlying: string;
  trade_date: string;
  expiry: string | null;
  max_pain_strike: number;
  min_pain_value: number;
}

interface IvRegime {
  value: number | null;
  percentile: number | null;
  regime: "LOW" | "MID" | "HIGH" | null;
}

interface FiiDii {
  trade_date: string | null;
  fii_net: number | null;
  dii_net: number | null;
}

interface Strategy {
  strategy: string;
  stance: "BUY_PREMIUM" | "SELL_PREMIUM";
  rationale: string;
}

interface StrikeMap {
  resistance?: number;
  support?: number;
  max_pain?: number;
  atm?: number;
}

interface PriceActionLevel {
  level: number;
  touches: number;
  last_tested_bars_ago: number;
  strength: number;
}

interface PriceActionLevels {
  resistance: PriceActionLevel[];
  support: PriceActionLevel[];
}

interface IndexPlan {
  index: string;
  spot_symbol: string;
  lot_size?: number;
  as_of: string | null;
  close?: number;
  change_pct?: number;
  atr_14?: number | null;
  expected_range_next_session?: ExpectedRange | null;
  ema_stack?: EmaStack | null;
  pivots?: Pivots;
  price_action_levels?: PriceActionLevels;
  expiry?: string | null;
  pcr_oi?: number | null;
  oi_walls?: OiWalls;
  max_pain?: MaxPain | null;
  iv_regime?: IvRegime;
  fii_dii?: FiiDii;
  verdict?: Verdict;
  strategy?: Strategy;
  strike_suggestions?: StrikeMap;
  bias?: null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Style maps
// ---------------------------------------------------------------------------

const BIAS_STYLE: Record<Bias, { label: string; tone: string; icon: React.ReactNode }> = {
  STRONG_BULL: { label: "Strong Bullish", tone: "bg-profit/20 text-profit border-profit/40", icon: <TrendingUp className="w-4 h-4" /> },
  MILD_BULL:   { label: "Mild Bullish",   tone: "bg-profit/10 text-profit border-profit/30", icon: <ArrowUpRight className="w-4 h-4" /> },
  NEUTRAL:     { label: "Neutral",        tone: "bg-warning/10 text-warning border-warning/30", icon: <Minus className="w-4 h-4" /> },
  MILD_BEAR:   { label: "Mild Bearish",   tone: "bg-loss/10 text-loss border-loss/30", icon: <ArrowDownRight className="w-4 h-4" /> },
  STRONG_BEAR: { label: "Strong Bearish", tone: "bg-loss/20 text-loss border-loss/40", icon: <TrendingDown className="w-4 h-4" /> },
};

const IV_TONE: Record<"LOW" | "MID" | "HIGH", string> = {
  LOW:  "bg-profit/10 text-profit border-profit/30",
  MID:  "bg-warning/10 text-warning border-warning/30",
  HIGH: "bg-loss/10 text-loss border-loss/30",
};

const STANCE_TONE: Record<"BUY_PREMIUM" | "SELL_PREMIUM", string> = {
  BUY_PREMIUM:  "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  SELL_PREMIUM: "bg-purple-500/10 text-purple-300 border-purple-500/30",
};

const fmtNum = (n: number | null | undefined, frac = 2) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });

const fmtUSD_Cr = (n: number | null | undefined) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}$${Math.round(n).toLocaleString("en-US")} Cr`;

const fetcher = (u: string) => api.get(u).then((r) => r.data);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TomorrowPlanPage() {
  const { data, isLoading, error, mutate, isValidating } = useSWR<IndexPlan[]>(
    "/eod/tomorrow-plan/options",
    fetcher,
    {
      // EOD data only refreshes once per day after the bhavcopy is
      // ingested — no point polling more than once per page open.
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
    },
  );

  const asOf = useMemo(
    () => data?.find((p) => p.as_of)?.as_of ?? null,
    [data],
  );

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Goal className="w-5 h-5 text-primary" />
            Tomorrow&apos;s Plan
          </h1>
          {/* <p className="text-sm text-muted-foreground">
            EOD-derived index options bias + strategy for the next session.
            Built on Redis-cached signals; refreshes after the daily NSE ingest.
          </p> */}
        </div>
        <div className="flex items-center gap-3">
          {asOf && (
            <span className="text-xs font-mono text-muted-foreground">
              as of {asOf.slice(0, 10)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isValidating}
            onClick={() => mutate()}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isValidating && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      {/* Page-level banner — only shown when the whole fetch fails. */}
      {error && (
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-loss mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-loss font-medium">Couldn&apos;t load the plan.</p>
            <p className="text-xs text-muted-foreground mt-1">
              {String((error as any)?.message ?? error)}
            </p>
          </div>
        </div>
      )}

      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Layers className="w-4 h-4 text-primary" />
        Index Options Plan
      </h2>

      {isLoading && !data ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card animate-pulse h-[420px]" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {data.map((plan) => (
            <IndexPlanCard key={plan.index} plan={plan} />
          ))}
        </div>
      )}

      {/* Section B — intraday cash-equity plan (longs / shorts / breakout watch). */}
      <IntradayStocksSection />

      {/* Section C — single-stock F&O R:R scanner. */}
      <FnoOpportunitiesSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section B — Intraday Stocks Plan
// ---------------------------------------------------------------------------

interface OptionLeg {
  instrument: string;       // e.g. "Buy 1130 CE"
  stance: "BUY_PREMIUM" | "SELL_PREMIUM";
  option_type: "CE" | "PE";
  strike: number;
  premium: number;
  max_risk: number;
  expected_payout_at_t1: number;
  r_to_r: number;
  rationale: string;
}

interface IntradayOptionsPick {
  expiry: string;
  iv_regime: "LOW" | "MID" | "HIGH" | null;
  buy: OptionLeg | null;
  sell: OptionLeg | null;
  recommended: "buy" | "sell";
  note?: string;
}

interface IntradayRow {
  underlying: string;
  internal_symbol: string;
  close: number;
  prev_close: number;
  today_change_pct: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  r_to_r: number;
  confidence: number;
  confidence_max: number;
  setup_type: "LONG" | "SHORT" | "BREAKOUT";
  why: string;
  extras: {
    delivery_pct: number | null;
    volume: number;
    volume_vs_20d_avg: number | null;
    atr: number;
    atr_period: number;
    today_high: number;
    today_low: number;
    today_open: number;
    near_52w_high: boolean;
    near_52w_low: boolean;
    direction: "LONG" | "SHORT";
    iv_regime: "LOW" | "MID" | "HIGH" | null;
  };
  /** Suggested options leg — null when the stock has no F&O contract. */
  options: IntradayOptionsPick | null;
}

interface IntradayPlan {
  as_of: string;
  universe_size: number;
  long_setups: IntradayRow[];
  short_setups: IntradayRow[];
  breakout_watch: IntradayRow[];
}

function IntradayStocksSection() {
  const [limit, setLimit] = useState(10);
  const [selected, setSelected] = useState<IntradayRow | null>(null);
  const { data, error, isLoading, mutate, isValidating } = useSWR<IntradayPlan>(
    `/eod/tomorrow-plan/intraday?limit_per_bucket=${limit}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Intraday Stocks Plan
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cash-equity setups for next session. Stop = 0.75 × ATR; T1 = 1.25–2 × ATR by confidence.
            {data?.universe_size != null && ` · scanned ${data.universe_size} stocks`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">Per bucket</label>
          <input
            type="number" min={3} max={50} step={1}
            className="input w-20"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 10)}
          />
          <Button
            variant="outline" size="sm" className="gap-1.5"
            disabled={isValidating}
            onClick={() => mutate()}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isValidating && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-3 text-xs text-loss">
          Couldn&apos;t load intraday plan: {String((error as any)?.message ?? error)}
        </div>
      ) : isLoading && !data ? (
        <div className="rounded-lg border border-border/40 p-10 text-center text-xs text-muted-foreground">
          Scanning cash-equity universe…
        </div>
      ) : !data ? null : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <IntradayBucket
            title="Long Setups"
            tone="profit"
            icon={<TrendingUp className="w-4 h-4 text-profit" />}
            rows={data.long_setups}
            emptyHint="No bullish setups passing 2/4 signal threshold."
            onSelect={setSelected}
          />
          <IntradayBucket
            title="Short Setups"
            tone="loss"
            icon={<TrendingDown className="w-4 h-4 text-loss" />}
            rows={data.short_setups}
            emptyHint="No bearish setups passing 2/4 signal threshold."
            onSelect={setSelected}
          />
          <IntradayBucket
            title="Breakout Watch"
            tone="primary"
            icon={<Crosshair className="w-4 h-4 text-primary" />}
            rows={data.breakout_watch}
            emptyHint="No coiling/tight-range candidates today."
            onSelect={setSelected}
          />
        </div>
      )}

      <IntradayDetailDialog row={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function IntradayBucket({
  title, tone, icon, rows, emptyHint, onSelect,
}: {
  title: string;
  tone: "profit" | "loss" | "primary";
  icon: React.ReactNode;
  rows: IntradayRow[];
  emptyHint: string;
  onSelect: (row: IntradayRow) => void;
}) {
  const headerTone =
    tone === "profit" ? "text-profit"
  : tone === "loss"   ? "text-loss"
  :                     "text-primary";
  return (
    <div className="card flex flex-col gap-2 p-3">
      <h3 className={cn("text-sm font-semibold flex items-center gap-1.5", headerTone)}>
        {icon} {title}
        <span className="text-muted-foreground font-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-6 text-center">{emptyHint}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <IntradayCompactRow key={r.underlying} row={r} onOpen={() => onSelect(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Single-line row — symbol · entry · R:R · confidence dots.
 *  Options pick (if F&O exists) shows as a small badge below the row. */
function IntradayCompactRow({ row, onOpen }: { row: IntradayRow; onOpen: () => void }) {
  const isLong = row.extras.direction === "LONG";
  const dirTone = isLong
    ? "bg-profit/15 text-profit border-profit/30"
    : "bg-loss/15 text-loss border-loss/30";
  const opt = row.options;
  // Pick the recommended leg for the compact row badge; if missing
  // fall back to whichever side exists.
  const recLeg: OptionLeg | null = !opt
    ? null
    : opt.recommended === "sell"
      ? (opt.sell ?? opt.buy)
      : (opt.buy ?? opt.sell);
  const optTone =
    recLeg?.stance === "SELL_PREMIUM" ? "text-purple-300"
  : recLeg?.option_type === "CE"      ? "text-profit"
  : recLeg?.option_type === "PE"      ? "text-loss"
  :                                     "text-muted-foreground";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "w-full text-left rounded border px-2 py-1.5 hover:shadow-sm transition-all flex flex-col gap-0.5",
        row.setup_type === "LONG"     && "border-profit/15 hover:border-profit/40",
        row.setup_type === "SHORT"    && "border-loss/15 hover:border-loss/40",
        row.setup_type === "BREAKOUT" && "border-primary/15 hover:border-primary/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("pill border text-[9px] font-bold shrink-0 px-1 py-0", dirTone)}>
          {row.extras.direction}
        </span>
        <span className="font-semibold text-xs truncate min-w-0" title={row.underlying}>
          {row.underlying}
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="font-mono text-xs font-bold text-primary tabular-nums">
            {fmtNum(row.entry)}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
            R:R {row.r_to_r.toFixed(2)}
          </span>
          <ConfidenceBar n={row.confidence} max={row.confidence_max} />
        </div>
      </div>
      {recLeg && opt ? (
        <div
          className={cn("text-[10px] font-mono pl-5 truncate flex items-center gap-1", optTone)}
          title={`${recLeg.instrument} · R:R ${recLeg.r_to_r}`}
        >
          <span>◇ {recLeg.instrument}</span>
          <span className="opacity-60">·</span>
          <span>R:R {recLeg.r_to_r.toFixed(1)}</span>
          <span className="opacity-60">·</span>
          <span>{opt.expiry.slice(5)}</span>
        </div>
      ) : (
        <div className="text-[10px] font-mono pl-5 text-muted-foreground/60">
          ◇ equity only
        </div>
      )}
    </button>
  );
}

/**
 * Modal showing the full intraday-setup plan for one row. Same layout
 * conventions as `FnoDetailDialog` so the page feels unified.
 */
function IntradayDetailDialog({ row, onClose }: { row: IntradayRow | null; onClose: () => void }) {
  if (!row) return null;
  const isLong = row.extras.direction === "LONG";
  const dirTone = isLong
    ? "bg-profit/15 text-profit border-profit/30"
    : "bg-loss/15 text-loss border-loss/30";
  const low  = Math.min(row.stop, row.target1);
  const high = Math.max(row.stop, row.target1);
  const entryPos = Math.max(0, Math.min(1, (row.entry - low) / Math.max(1e-9, high - low)));
  const bucketLabel =
    row.setup_type === "LONG"     ? "Long setup" :
    row.setup_type === "SHORT"    ? "Short setup" :
                                    "Breakout watch";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[92vw] max-w-5xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-lg flex items-center gap-2">
            <span className={cn("pill border text-[11px] font-bold", dirTone)}>{row.extras.direction}</span>
            <span>{row.underlying}</span>
            <span className="ml-auto text-xs text-muted-foreground font-normal">{bucketLabel}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Trade plan grid */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Trade plan</div>
            <div className="grid grid-cols-4 gap-3 text-center">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-primary font-semibold">Entry</div>
                <div className="font-mono text-base font-bold text-primary tabular-nums">{fmtNum(row.entry)}</div>
                <div className={cn(
                  "text-[9px] font-mono tabular-nums",
                  row.today_change_pct >= 0 ? "text-profit" : "text-loss",
                )}>
                  cls {fmtNum(row.close, 1)} ({row.today_change_pct >= 0 ? "+" : ""}{row.today_change_pct.toFixed(2)}%)
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</div>
                <div className="font-mono text-base font-bold text-loss tabular-nums">{fmtNum(row.stop)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">T1</div>
                <div className="font-mono text-base font-bold text-profit tabular-nums">{fmtNum(row.target1)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">T2</div>
                <div className="font-mono text-base font-bold text-profit/70 tabular-nums">{fmtNum(row.target2)}</div>
              </div>
            </div>
          </div>

          {/* Risk envelope */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Risk envelope · R:R {row.r_to_r.toFixed(2)}
            </div>
            <div className="relative h-2 rounded-full bg-muted/30 overflow-hidden">
              <div
                className={cn(
                  "absolute top-0 h-full",
                  isLong ? "bg-loss/40 left-0" : "bg-profit/40 right-0",
                )}
                style={{ width: `${entryPos * 100}%` }}
              />
              <div
                className="absolute top-0 w-0.5 h-full bg-primary"
                style={{ left: `${entryPos * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-muted-foreground mt-1">
              <span className={cn(isLong ? "text-loss" : "text-profit")}>
                {isLong ? "Stop" : "T1"} {fmtNum(low, 1)}
              </span>
              <span className="text-primary">Entry {fmtNum(row.entry, 1)}</span>
              <span className={cn(!isLong ? "text-loss" : "text-profit")}>
                {isLong ? "T1" : "Stop"} {fmtNum(high, 1)}
              </span>
            </div>
          </div>

          {/* Why */}
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Why</div>
              <ConfidenceBar n={row.confidence} max={row.confidence_max} />
            </div>
            <p className="text-xs leading-relaxed">{row.why}</p>
          </div>

          {/* Options strategy — both legs side-by-side with R:R, the
              ★ marks whichever leg the backend's R:R math preferred. */}
          {row.options ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Options strategy · expiry {row.options.expiry}
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">
                  IV regime: {row.options.iv_regime ?? "—"}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <OptionLegCard leg={row.options.buy} recommended={row.options.recommended === "buy"} />
                <OptionLegCard leg={row.options.sell} recommended={row.options.recommended === "sell"} />
              </div>
              {row.options.note && (
                <p className="text-[10px] text-muted-foreground italic mt-2">{row.options.note}</p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-[10px] text-muted-foreground italic">
              Equity only — this underlying has no F&amp;O contracts. Trade the cash leg directly.
            </div>
          )}

          {/* Detail metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0">
            <DetailLine
              label="Volume"
              value={
                row.extras.volume_vs_20d_avg != null
                  ? `${row.extras.volume_vs_20d_avg.toFixed(2)}× avg`
                  : row.extras.volume.toLocaleString("en-US")
              }
            />
            <DetailLine
              label="Delivery %"
              value={row.extras.delivery_pct == null ? "—" : `${row.extras.delivery_pct.toFixed(1)}%`}
            />
            <DetailLine label={`ATR(${row.extras.atr_period})`} value={fmtNum(row.extras.atr, 2)} />
            <DetailLine
              label="Today range"
              value={`${fmtNum(row.extras.today_low, 1)} – ${fmtNum(row.extras.today_high, 1)}`}
            />
            <DetailLine label="IV regime" value={row.extras.iv_regime ?? "—"} />
            {row.extras.near_52w_high && (
              <DetailLine label="52w high" value="near" tone="text-profit" />
            )}
            {row.extras.near_52w_low && (
              <DetailLine label="52w low" value="near" tone="text-loss" />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Section C — F&O Opportunity Scanner
// ---------------------------------------------------------------------------

interface FnoOpportunity {
  underlying: string;
  direction: "LONG" | "SHORT";
  close: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  r_to_r: number;
  confidence: number;
  confidence_max: number;
  instrument: string;
  why: string;
  extras: {
    buildup: string;
    price_change_pct: number;
    chg_in_oi_total: number;
    weighted_settle_change: number;
    atr: number;
    atr_period: number;
    ema_score: number | null;
    ema_tag: string | null;
    delivery_pct: number | null;
    iv_regime: "LOW" | "MID" | "HIGH" | null;
  };
}

function FnoOpportunitiesSection() {
  const [minRr, setMinRr] = useState(2.5);
  const [limit, setLimit] = useState(15);
  const [dirFilter, setDirFilter] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [selected, setSelected] = useState<FnoOpportunity | null>(null);

  const { data, error, isLoading, mutate, isValidating } = useSWR<FnoOpportunity[]>(
    `/eod/tomorrow-plan/fno-opportunities?min_rr=${minRr}&limit=${limit}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const rows = useMemo(
    () => (data ?? []).filter((r) => dirFilter === "ALL" || r.direction === dirFilter),
    [data, dirFilter],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-primary" />
            F&amp;O Opportunity Scanner
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Single-stock setups with R:R ≥ {minRr.toFixed(1)}, ranked by R:R × confidence.
            Stop = 1 ATR; T1 scales 3–4.5 × ATR with signal strength.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {(["ALL", "LONG", "SHORT"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDirFilter(d)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium border transition-colors",
                dirFilter === d
                  ? d === "LONG"  ? "border-profit/60 bg-profit/15 text-profit"
                  : d === "SHORT" ? "border-loss/60 bg-loss/15 text-loss"
                  : "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/40 text-muted-foreground hover:border-border",
              )}
            >
              {d}
            </button>
          ))}
          <label className="text-muted-foreground ml-2">Min R:R</label>
          <input
            type="number" min={1} max={10} step={0.5}
            className="input w-20"
            value={minRr}
            onChange={(e) => setMinRr(Number(e.target.value) || 2.5)}
          />
          <label className="text-muted-foreground">Top</label>
          <input
            type="number" min={5} max={100} step={5}
            className="input w-20"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 15)}
          />
          <Button
            variant="outline" size="sm" className="gap-1.5"
            disabled={isValidating}
            onClick={() => mutate()}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isValidating && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-3 text-xs text-loss">
          Couldn&apos;t load opportunities: {String((error as any)?.message ?? error)}
        </div>
      ) : isLoading && !data ? (
        <div className="rounded-lg border border-border/40 p-10 text-center text-xs text-muted-foreground">
          Scanning F&amp;O universe…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 p-10 text-center">
          <Crosshair className="w-7 h-7 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm font-medium">No opportunities at this threshold</p>
          <p className="text-xs text-muted-foreground mt-1">
            Try lowering Min R:R, or wait for more EOD history (ATR + EMA need 20+ days for the full signal set).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {rows.map((r) => (
            <FnoCompactRow key={r.underlying} row={r} onOpen={() => setSelected(r)} />
          ))}
        </div>
      )}

      <FnoDetailDialog row={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

/**
 * Single-line compact card for the F&O scanner grid. 3-up on xl,
 * 2-up on md, 1-up on mobile. Shows just the essentials — direction
 * chip, symbol, entry trigger, R:R, confidence dots. Tap to open the
 * full breakdown in a modal.
 */
function FnoCompactRow({ row, onOpen }: { row: FnoOpportunity; onOpen: () => void }) {
  const isLong = row.direction === "LONG";
  const dirTone = isLong
    ? "bg-profit/15 text-profit border-profit/30"
    : "bg-loss/15 text-loss border-loss/30";
  const deltaPct = row.close > 0 ? ((row.entry - row.close) / row.close) * 100 : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "rounded border bg-card px-3 py-2 text-left hover:shadow-md transition-all",
        isLong ? "border-profit/20 hover:border-profit/50" : "border-loss/20 hover:border-loss/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn("pill border text-[9px] font-bold shrink-0 px-1.5 py-0", dirTone)}>
            {row.direction}
          </span>
          <span className="font-semibold text-sm truncate" title={row.underlying}>{row.underlying}</span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
          R:R {row.r_to_r.toFixed(2)}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1">
          <span className="text-[9px] uppercase tracking-wider text-primary font-semibold">Entry</span>
          <span className="font-mono text-sm font-bold text-primary tabular-nums">{fmtNum(row.entry)}</span>
          <span className="font-mono text-[9px] text-muted-foreground tabular-nums">
            ({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
          </span>
        </div>
        <ConfidenceBar n={row.confidence} max={row.confidence_max} />
      </div>
    </button>
  );
}

/**
 * Modal showing the full plan for one F&O setup. Vertically organized
 * for readability — header → level grid → risk-envelope bar → why →
 * detail metrics.
 */
function FnoDetailDialog({ row, onClose }: { row: FnoOpportunity | null; onClose: () => void }) {
  if (!row) return null;
  const isLong = row.direction === "LONG";
  const dirTone = isLong
    ? "bg-profit/15 text-profit border-profit/30"
    : "bg-loss/15 text-loss border-loss/30";
  const low  = Math.min(row.stop, row.target1);
  const high = Math.max(row.stop, row.target1);
  const entryPos = Math.max(0, Math.min(1, (row.entry - low) / Math.max(1e-9, high - low)));
  const deltaPct = row.close > 0 ? ((row.entry - row.close) / row.close) * 100 : 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[92vw] max-w-5xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-lg flex items-center gap-2">
            <span className={cn("pill border text-[11px] font-bold", dirTone)}>{row.direction}</span>
            <span>{row.underlying}</span>
            <span className="ml-auto text-xs text-muted-foreground font-normal">
              {row.instrument}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Trade plan — Entry, Stop, T1, T2 as a 4-cell strip */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Trade plan</div>
            <div className="grid grid-cols-4 gap-3 text-center">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-primary font-semibold">Entry</div>
                <div className="font-mono text-base font-bold text-primary tabular-nums">{fmtNum(row.entry)}</div>
                <div className="text-[9px] font-mono text-muted-foreground tabular-nums">
                  cls {fmtNum(row.close, 1)} ({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%)
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop</div>
                <div className="font-mono text-base font-bold text-loss tabular-nums">{fmtNum(row.stop)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">T1</div>
                <div className="font-mono text-base font-bold text-profit tabular-nums">{fmtNum(row.target1)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">T2</div>
                <div className="font-mono text-base font-bold text-profit/70 tabular-nums">{fmtNum(row.target2)}</div>
              </div>
            </div>
          </div>

          {/* Risk envelope visualisation */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Risk envelope · R:R {row.r_to_r.toFixed(2)}
            </div>
            <div className="relative h-2 rounded-full bg-muted/30 overflow-hidden">
              <div
                className={cn(
                  "absolute top-0 h-full",
                  isLong ? "bg-loss/40 left-0" : "bg-profit/40 right-0",
                )}
                style={{ width: `${entryPos * 100}%` }}
              />
              <div
                className="absolute top-0 w-0.5 h-full bg-primary"
                style={{ left: `${entryPos * 100}%` }}
                title="Entry"
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-muted-foreground mt-1">
              <span className={cn(isLong ? "text-loss" : "text-profit")}>
                {isLong ? "Stop" : "T1"} {fmtNum(low, 1)}
              </span>
              <span className="text-primary">Entry {fmtNum(row.entry, 1)}</span>
              <span className={cn(!isLong ? "text-loss" : "text-profit")}>
                {isLong ? "T1" : "Stop"} {fmtNum(high, 1)}
              </span>
            </div>
          </div>

          {/* Why */}
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Why</div>
              <ConfidenceBar n={row.confidence} max={row.confidence_max} />
            </div>
            <p className="text-xs leading-relaxed">{row.why}</p>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0">
            <DetailLine label="Buildup"          value={row.extras.buildup.replace("_", " ")} />
            <DetailLine
              label="Today change"
              value={`${row.extras.price_change_pct >= 0 ? "+" : ""}${row.extras.price_change_pct.toFixed(2)}%`}
              tone={row.extras.price_change_pct >= 0 ? "text-profit" : "text-loss"}
            />
            <DetailLine label="ΣΔOI (futures)"   value={row.extras.chg_in_oi_total.toLocaleString("en-US")} />
            <DetailLine label={`ATR(${row.extras.atr_period})`} value={fmtNum(row.extras.atr, 2)} />
            <DetailLine label="Delivery %"       value={row.extras.delivery_pct == null ? "—" : `${row.extras.delivery_pct.toFixed(1)}%`} />
            <DetailLine label="IV regime"        value={row.extras.iv_regime ?? "—"} />
            <DetailLine label="EMA stack"        value={row.extras.ema_tag ?? "—"} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Cell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-sm font-semibold tabular-nums", tone)}>{fmtNum(value)}</div>
    </div>
  );
}

/**
 * Single option-leg card — used twice per row (BUY + SELL) in the
 * intraday detail modal. Premium / max-risk / payout / R:R laid out
 * top-to-bottom so the eye can scan multiple cards quickly. A ★ badge
 * marks the backend's preferred leg (higher R:R).
 */
function OptionLegCard({ leg, recommended }: { leg: OptionLeg | null; recommended: boolean }) {
  if (!leg) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 p-3 text-[10px] text-muted-foreground italic flex items-center justify-center min-h-[120px]">
        No liquid contract available
      </div>
    );
  }
  const isBuy = leg.stance === "BUY_PREMIUM";
  return (
    <div
      className={cn(
        "rounded-lg border p-3 relative",
        isBuy
          ? "border-cyan-500/30 bg-cyan-500/5"
          : "border-purple-500/30 bg-purple-500/5",
        recommended && "ring-2 ring-warning/50",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={cn(
          "pill border text-[9px] font-bold",
          isBuy
            ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
            : "bg-purple-500/15 text-purple-300 border-purple-500/40",
        )}>
          {isBuy ? "BUY" : "SELL"}
        </span>
        {recommended && (
          <span className="pill border bg-warning/15 text-warning border-warning/40 text-[9px] font-bold">
            ★ BEST R:R
          </span>
        )}
      </div>
      <p className="font-mono text-sm font-bold mb-2">{leg.instrument}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono mb-2">
        <span className="text-muted-foreground">Premium</span>
        <span className="text-right tabular-nums">${leg.premium.toFixed(2)}</span>
        <span className="text-muted-foreground">Max risk</span>
        <span className="text-right tabular-nums text-loss">${leg.max_risk.toFixed(2)}</span>
        <span className="text-muted-foreground">Payout @ T1</span>
        <span className="text-right tabular-nums text-profit">${leg.expected_payout_at_t1.toFixed(2)}</span>
        <span className="text-muted-foreground">R:R</span>
        <span className="text-right tabular-nums font-bold">{leg.r_to_r.toFixed(2)}</span>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{leg.rationale}</p>
    </div>
  );
}

/** Single label : value line used inside the detail modals. */
function DetailLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/20 py-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs text-right", tone)}>{value}</span>
    </div>
  );
}

function ConfidenceBar({ n, max }: { n: number; max: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`Confidence ${n}/${max}`}>
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "w-1.5 h-3 rounded-sm",
            i < n ? "bg-primary" : "bg-muted/30",
          )}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-index card
// ---------------------------------------------------------------------------

function IndexPlanCard({ plan }: { plan: IndexPlan }) {
  // Cold-stub case: backend returned `{index, bias: null, reason: "..."}`.
  if (!plan.verdict || plan.close == null) {
    return (
      <div className="card flex flex-col">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-lg font-semibold">{plan.index}</h3>
          <span className="text-xs text-muted-foreground font-mono">{plan.spot_symbol}</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground text-center px-2">
          <div>
            <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-warning" />
            <p>{plan.reason ?? "No data yet."}</p>
            <p className="mt-1 text-[10px]">Run the EOD ingest from Admin once spot data is available.</p>
          </div>
        </div>
      </div>
    );
  }

  const biasStyle = BIAS_STYLE[plan.verdict.bias];
  const changePct = plan.change_pct ?? 0;
  const stanceTone = plan.strategy ? STANCE_TONE[plan.strategy.stance] : null;

  return (
    <div className="card flex flex-col gap-4 hover:border-primary/40 transition-colors">
      {/* Header — index + spot + bias chip */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">{plan.index}</h3>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="font-mono text-2xl font-bold tabular-nums">
              {fmtNum(plan.close)}
            </span>
            <span
              className={cn(
                "font-mono text-sm tabular-nums",
                changePct >= 0 ? "text-profit" : "text-loss",
              )}
            >
              {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 pill border text-xs font-medium",
            biasStyle.tone,
          )}
        >
          {biasStyle.icon}
          {biasStyle.label}
        </span>
      </div>

      {/* Strategy panel — the actionable bit */}
      {plan.strategy && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider">
              <Lightbulb className="w-3.5 h-3.5" /> Strategy
            </div>
            {stanceTone && (
              <span className={cn("pill border text-[10px]", stanceTone)}>
                {plan.strategy.stance.replace("_", " ")}
              </span>
            )}
          </div>
          <p className="text-sm font-semibold leading-snug">{plan.strategy.strategy}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {plan.strategy.rationale}
          </p>
        </div>
      )}

      {/* Key level map */}
      {plan.strike_suggestions && (
        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider mb-2">
            <Target className="w-3.5 h-3.5" /> Key Levels
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <LevelCell
              label="Resistance"
              value={plan.strike_suggestions.resistance}
              tone="text-loss"
              tooltip="Highest call OI — where writers defend a ceiling."
            />
            <LevelCell
              label="Support"
              value={plan.strike_suggestions.support}
              tone="text-profit"
              tooltip="Highest put OI — where writers defend a floor."
            />
            <LevelCell
              label="Max pain"
              value={plan.strike_suggestions.max_pain}
              tone="text-warning"
              tooltip="Pin price where option writers benefit most at expiry."
            />
            <LevelCell
              label="ATM"
              value={plan.strike_suggestions.atm}
              tone="text-primary"
              tooltip={`Nearest strike (interval ${plan.index === "NIFTY" ? "50" : "100"}).`}
            />
          </div>

          {/* Price-action S/R — only the strong levels (≥2 touches). Each
              chip shows the level + a "Nx" touch count badge. When empty
              (fresh install, not enough history) the section auto-hides. */}
          {plan.price_action_levels &&
            ((plan.price_action_levels.resistance?.length ?? 0) > 0 ||
              (plan.price_action_levels.support?.length ?? 0) > 0) && (
              <div className="mt-3 pt-3 border-t border-border/30">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Price Action S/R · last 90d swings
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-loss font-medium">Resistance</div>
                    {plan.price_action_levels.resistance.length === 0 && (
                      <div className="text-[11px] text-muted-foreground italic">—</div>
                    )}
                    {plan.price_action_levels.resistance.map((r) => (
                      <PriceActionLevelChip key={`r-${r.level}`} level={r} tone="loss" />
                    ))}
                  </div>
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase text-profit font-medium">Support</div>
                    {plan.price_action_levels.support.length === 0 && (
                      <div className="text-[11px] text-muted-foreground italic">—</div>
                    )}
                    {plan.price_action_levels.support.map((s) => (
                      <PriceActionLevelChip key={`s-${s.level}`} level={s} tone="profit" />
                    ))}
                  </div>
                </div>
              </div>
            )}
        </div>
      )}

      {/* Expected next-session range */}
      {plan.expected_range_next_session && (
        <div className="rounded-lg border border-border/40 bg-muted/30 p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" /> Expected Range (1σ)
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              ATR(14): {fmtNum(plan.expected_range_next_session.atr, 1)}
            </span>
          </div>
          <p className="font-mono text-sm tabular-nums">
            {fmtNum(plan.expected_range_next_session.lower)} – {fmtNum(plan.expected_range_next_session.upper)}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground tabular-nums mt-0.5">
            2σ outer band {fmtNum(plan.expected_range_next_session.lower_2x)} – {fmtNum(plan.expected_range_next_session.upper_2x)}
          </p>
        </div>
      )}

      {/* PCR + IV regime + FII row */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <ContextChip label="PCR(OI)" value={plan.pcr_oi != null ? plan.pcr_oi.toFixed(2) : "—"} />
        <ContextChip
          label="IV regime"
          value={plan.iv_regime?.regime ?? "—"}
          tone={plan.iv_regime?.regime ? IV_TONE[plan.iv_regime.regime] : undefined}
        />
        <ContextChip
          label="FII"
          value={plan.fii_dii?.fii_net != null ? fmtUSD_Cr(plan.fii_dii.fii_net) : "—"}
          tone={
            plan.fii_dii?.fii_net != null && plan.fii_dii.fii_net >= 0
              ? "bg-profit/10 text-profit border-profit/30"
              : plan.fii_dii?.fii_net != null
              ? "bg-loss/10 text-loss border-loss/30"
              : undefined
          }
        />
      </div>

      {/* EMA stack — short tag only, full block in the why list below */}
      {plan.ema_stack && (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5" />
          <span>{plan.ema_stack.tag}</span>
        </div>
      )}

      {/* "Why" — bullish + bearish signal breakdown */}
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Why</div>
        <div className="space-y-1.5">
          {plan.verdict.bullish.length === 0 && plan.verdict.bearish.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No directional signals fired yet.</p>
          )}
          {plan.verdict.bullish.map((s) => (
            <SignalRow key={`b-${s.name}`} signal={s} tone="profit" />
          ))}
          {plan.verdict.bearish.map((s) => (
            <SignalRow key={`r-${s.name}`} signal={s} tone="loss" />
          ))}
        </div>
      </div>

      {/* Footer — expiry + lot size + composite */}
      <div className="mt-auto pt-2 border-t border-border/30 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>
          {plan.expiry ? `Expiry ${plan.expiry}` : "No F&O expiry"}
          {plan.lot_size ? ` · Lot ${plan.lot_size}` : ""}
        </span>
        <span>composite {plan.verdict.composite.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function SignalRow({
  signal,
  tone,
}: {
  signal: Signal;
  tone: "profit" | "loss";
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "shrink-0 w-1 h-4 rounded-full",
            tone === "profit" ? "bg-profit" : "bg-loss",
          )}
        />
        <span className="truncate">{signal.tag}</span>
      </div>
      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
        score {signal.score >= 0 ? "+" : ""}{signal.score.toFixed(2)} × w{signal.weight}
      </span>
    </div>
  );
}

function PriceActionLevelChip({
  level,
  tone,
}: {
  level: PriceActionLevel;
  tone: "loss" | "profit";
}) {
  const toneCls =
    tone === "loss"
      ? "border-loss/30 bg-loss/5 text-loss"
      : "border-profit/30 bg-profit/5 text-profit";
  // "Tested today" reads cleaner than "0 bars ago".
  const ago =
    level.last_tested_bars_ago === 0
      ? "today"
      : `${level.last_tested_bars_ago}d ago`;
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded border px-2 py-1 text-xs font-mono tabular-nums",
        toneCls,
      )}
      title={`${level.touches} touches over the last 90 trading days · last tested ${ago} · strength ${level.strength}`}
    >
      <span className="font-semibold">{fmtNum(level.level, 0)}</span>
      <span className="text-[10px] opacity-80">
        {level.touches}× · {ago}
      </span>
    </div>
  );
}

function LevelCell({
  label,
  value,
  tone,
  tooltip,
}: {
  label: string;
  value: number | null | undefined;
  tone: string;
  tooltip: string;
}) {
  return (
    <div
      className="rounded border border-border/40 bg-muted/20 px-2 py-1.5"
      title={tooltip}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("font-mono text-sm font-semibold tabular-nums", tone)}>
        {value == null ? "—" : fmtNum(value, 0)}
      </div>
    </div>
  );
}

function ContextChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div
      className={cn(
        "rounded border px-2 py-1.5",
        tone ?? "border-border/40 bg-muted/20",
      )}
    >
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border/50 p-10 text-center">
      <Goal className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
      <p className="text-sm font-medium">No plan available yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        The EOD ingest hasn&apos;t produced index-spot 1d candles yet.
        Run it from Admin → NSE EOD ingest, then come back.
      </p>
    </div>
  );
}
