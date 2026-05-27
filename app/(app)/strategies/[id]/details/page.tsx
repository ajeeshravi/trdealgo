"use client";
/**
 * Strategy details — read-only overview + unified log feed.
 *
 * Pulls signals, orders, and run-lifecycle events into one timeline via
 * `GET /strategies/{id}/logs`. Filter chips toggle kinds; "by run" chips
 * narrow the feed to a single StrategyRun. Auto-refreshes every 10s while
 * the page is open so live strategies show fresh activity.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import toast from "react-hot-toast";
import clsx from "clsx";
import { api } from "@/lib/api";
import { fmtINR, fmtTs, prettySymbol } from "@/lib/fmt";
import { useLivePrices } from "@/lib/useLivePrices";
import { useMarketPollInterval } from "@/lib/marketHours";

interface StrategyDetail {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  symbols: string[];
  timeframe_min: number | null;
  capital: number;
  instrument_class?: "EQUITY" | "FUTURES" | "OPTIONS";
}

interface StrategyRun {
  id: string;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  is_paper: boolean;
  pnl: number;
  realized_pnl: number;
}

interface LogEntry {
  ts: string;
  kind: "run" | "signal" | "order";
  level: "info" | "warn" | "error";
  message: string;
  run_id: string | null;
  signal_id: string | null;
  order_id: string | null;
  internal_symbol: string | null;
  meta: Record<string, unknown>;
}

interface IndicatorValue {
  indicator: string;
  label: string;
  params: Record<string, number>;
  source: string;
  value: number | null;
}

interface IndicatorSnapshot {
  internal_symbol: string;
  last_candle_ts: string | null;
  last_close: number | null;
  indicators: IndicatorValue[];
  error: string | null;
}

interface SymbolInfo {
  display_symbol: string;
  internal_symbol: string | null;
  logical: boolean;
  alias: string | null;
  expiry: string | null;
  days_to_expiry: number | null;
  lot_size: number | null;
  segment: string | null;
  error: string | null;
}

const fetcher = (u: string) => api.get(u).then((r) => r.data);

const KIND_STYLES: Record<LogEntry["kind"], string> = {
  run:    "bg-panel2 text-gray-300",
  signal: "bg-primary/15 text-primary",
  order:  "bg-yellow-500/15 text-yellow-300",
};

const LEVEL_STYLES: Record<LogEntry["level"], string> = {
  info:  "",
  warn:  "text-orange-300",
  error: "text-danger",
};

const RUN_STATUS_STYLES: Record<string, string> = {
  LIVE:    "bg-primary/20 text-primary",
  PAPER:   "bg-yellow-500/20 text-yellow-300",
  PAUSED:  "bg-orange-500/20 text-orange-300",
  STOPPED: "bg-panel2 text-muted-foreground",
};

const STATUS_STYLES: Record<string, string> = {
  DRAFT:   "bg-panel2 text-muted-foreground",
  LIVE:    "bg-primary/20 text-primary",
  PAPER:   "bg-yellow-500/20 text-yellow-300",
  PAUSED:  "bg-orange-500/20 text-orange-300",
  STOPPED: "bg-panel2 text-muted-foreground",
};

export default function StrategyDetailsPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [kindFilter, setKindFilter] = useState<Set<LogEntry["kind"]>>(
    new Set(["run", "signal", "order"]),
  );
  const [runFilter, setRunFilter] = useState<string>("");   // "" = all runs
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // All per-strategy polls gate to "any market open" so MCX/CDS
  // strategies keep ticking after the equity close at 15:30.
  const runsPoll = useMarketPollInterval(15000, "ANY");
  const logsPoll = useMarketPollInterval(10000, "ANY");
  const indicatorsPoll = useMarketPollInterval(15000, "ANY");
  const resolvedPoll = useMarketPollInterval(60000, "ANY");

  const { data: detail } = useSWR<StrategyDetail>(`/strategies/${id}`, fetcher);
  const { data: runs } = useSWR<StrategyRun[]>(`/strategies/${id}/runs`, fetcher, {
    refreshInterval: runsPoll,
  });
  const { data: logs, mutate: mutateLogs, isLoading: logsLoading } = useSWR<LogEntry[]>(
    `/strategies/${id}/logs?limit=300`,
    fetcher,
    { refreshInterval: logsPoll },
  );
  const {
    data: indicators,
    mutate: mutateIndicators,
    isLoading: indicatorsLoading,
  } = useSWR<IndicatorSnapshot[]>(
    `/strategies/${id}/indicators`,
    fetcher,
    { refreshInterval: indicatorsPoll },
  );
  const { data: resolvedSymbols } = useSWR<SymbolInfo[]>(
    `/strategies/${id}/symbols-resolved`,
    fetcher,
    { refreshInterval: resolvedPoll },
  );

  // Build the logical-symbol → concrete-contract map so we can subscribe
  // ticks on the actual symbol the feed publishes (`@CURRENT_FUT` won't
  // ever appear on the ticks channel — only `NFO_NIFTY_290526_FUT` will).
  const concreteFor = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const sym of detail?.symbols ?? []) map[sym] = sym;
    for (const r of resolvedSymbols ?? []) {
      if (r.internal_symbol) map[r.display_symbol] = r.internal_symbol;
    }
    return map;
  }, [detail?.symbols, resolvedSymbols]);

  // Unique concrete symbols to feed to the tick stream. Sorted+joined as
  // an effect dep so we don't churn the subscription on identical renders.
  //
  // We add THREE sources to the set:
  //  1. `concreteFor` — the strategy's stored symbols (logical aliases
  //     map to themselves; non-options aliases map to the resolved future).
  //  2. `resolvedSymbols[*].internal_symbol` — concrete OPTIONS legs
  //     (CE/PE contracts) so their LTP populates the Symbols table.
  //  3. `indicators[*].internal_symbol` — the indicator-feed contract
  //     used by the runner (front-month FUT for OPTIONS strategies in
  //     FUTURES mode). Without this, the Indicator values table can
  //     never resolve LTP for that row — `symbols-resolved` returns the
  //     option contract, not the FUT, so the FUT would otherwise be
  //     unsubscribed.
  const subscribeSymbols = useMemo(
    () => {
      const set = new Set<string>(
        Object.values(concreteFor).filter(Boolean) as string[],
      );
      for (const snap of indicators ?? []) {
        if (snap.internal_symbol) set.add(snap.internal_symbol);
      }
      return Array.from(set).sort();
    },
    [concreteFor, indicators],
  );

  // Latest LTP per concrete symbol. Refreshes tick-by-tick via the
  // multiplexed `/ws/stream` connection. The hook throttles state flushes
  // to ~300ms so the indicators + symbols tables don't re-render on every
  // raw tick (broker rate ~10Hz × N symbols).
  const livePricesRaw = useLivePrices(subscribeSymbols);
  const livePrices = useMemo<Record<string, { ltp: number; ts: number }>>(() => {
    const now = Date.now();
    const out: Record<string, { ltp: number; ts: number }> = {};
    for (const [s, ltp] of Object.entries(livePricesRaw)) {
      out[s] = { ltp, ts: now };
    }
    return out;
  }, [livePricesRaw]);

  const filtered = useMemo(() => {
    return (logs || []).filter((l) => {
      if (!kindFilter.has(l.kind)) return false;
      if (runFilter && l.run_id !== runFilter) return false;
      return true;
    });
  }, [logs, kindFilter, runFilter]);

  function toggleKind(k: LogEntry["kind"]) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Don't allow zero filters — re-enable the just-toggled one.
      if (next.size === 0) next.add(k);
      return next;
    });
  }

  function toggleRow(rowKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }

  function copyJson(entry: LogEntry) {
    navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).then(
      () => toast.success("copied"),
      () => toast.error("copy failed"),
    );
  }

  if (!detail) return <div className="card">Loading…</div>;

  const totalPnl = (runs || []).reduce((s, r) => s + Number(r.pnl || 0), 0);
  const activeRuns = (runs || []).filter((r) => r.status === "LIVE" || r.status === "PAPER");

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link href="/strategies" className="hover:underline">← Strategies</Link>
          </div>
          <h1 className="text-2xl font-semibold mt-1">{detail.name}</h1>
          <p className="text-sm text-muted-foreground">
            {detail.kind} · {detail.timeframe_min ? `${detail.timeframe_min}m` : "tick"} · capital {fmtINR(detail.capital)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              "pill text-[10px] uppercase tracking-wide",
              detail.instrument_class === "FUTURES"
                ? "bg-blue-500/20 text-blue-300"
                : detail.instrument_class === "OPTIONS"
                  ? "bg-purple-500/20 text-purple-300"
                  : "bg-panel2 text-gray-300",
            )}
            title={
              detail.instrument_class === "FUTURES"
                ? "Futures strategy"
                : detail.instrument_class === "OPTIONS"
                  ? "Options strategy"
                  : "Equity strategy"
            }
          >
            {detail.instrument_class === "FUTURES"
              ? "FUTURES"
              : detail.instrument_class === "OPTIONS"
                ? "OPTIONS"
                : "EQUITY"}
          </span>
          <span
            className={clsx(
              "pill text-[10px] uppercase tracking-wide",
              STATUS_STYLES[detail.status] ?? "bg-panel2 text-muted-foreground",
            )}
          >
            {detail.status}
          </span>
          <Link href={`/strategies/${id}`} className="btn-outline text-sm">Edit</Link>
        </div>
      </header>

      {/* ---------------------- Summary cards ---------------------- */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Total runs"       value={(runs || []).length.toString()} />
        <SummaryCard label="Active runs"      value={activeRuns.length.toString()} accent={activeRuns.length > 0 ? "primary" : undefined} />
        {detail.kind === "PLAN_BASED" ? (
          <SummaryCard label="Mode" value="Daily @ 09:15" />
        ) : (
          <SummaryCard label="Symbols" value={(detail.symbols || []).length.toString()} />
        )}
        <SummaryCard
          label="Cumulative P&L"
          value={`₹ ${fmtINR(totalPnl)}`}
          accent={totalPnl >= 0 ? "primary" : "danger"}
        />
      </section>

      {/* ---------------------- Pending triggers ------------------------
          Inline view of client-side ManagedTriggers belonging to any of
          this strategy's runs. Visible regardless of strategy kind —
          plan-based fills this section with its top-N picks the moment
          the dispatcher runs, and candle-driven strategies fill it
          whenever a manual or automated entry arms an SL/SL-M. */}
      <PendingTriggersSection
        runIds={(runs ?? []).map((r) => r.id)}
      />

      {/* ---------------------- Plan picks (PLAN_BASED only) ----------
          Replaces the Symbols + Indicators sections for plan auto-traders:
          there's no static symbol universe and no candle-based indicators,
          so the most useful read-out is what the dispatcher would place. */}
      {detail.kind === "PLAN_BASED" ? (
        <PlanPicksSection strategyId={id} />
      ) : (
        <>
          {/* ---------------------- Symbols + expiry ---------------------- */}
          <SymbolsSection
            rows={resolvedSymbols}
            instrumentClass={detail.instrument_class}
            livePrices={livePrices}
          />

          {/* ---------------------- Indicators ---------------------- */}
          <IndicatorsSection
            snapshots={indicators}
            loading={indicatorsLoading}
            onRefresh={() => mutateIndicators()}
            timeframeMin={detail.timeframe_min}
            livePrices={livePrices}
          />
        </>
      )}

      {/* ---------------------- Filters ---------------------- */}
      <section className="card flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="label">Show:</span>
          {(["run", "signal", "order"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={clsx(
                "pill text-[10px] uppercase tracking-wide cursor-pointer",
                kindFilter.has(k) ? KIND_STYLES[k] : "bg-panel2 text-muted-foreground opacity-60",
              )}
            >
              {k === "run" ? "Run lifecycle" : k}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="label">Run:</span>
          <select
            className="input py-1 text-xs w-56"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
          >
            <option value="">All runs</option>
            {(runs || []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.is_paper ? "Paper" : "Live"} · {r.started_at ? fmtTs(r.started_at) : r.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-outline text-xs"
            onClick={() => mutateLogs()}
            title="Refresh now"
          >
            ↻
          </button>
        </div>
      </section>

      {/* ---------------------- Feed ---------------------- */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Activity log</h2>
          <span className="text-xs text-muted-foreground">
            {logsLoading ? "loading…" : `${filtered.length} of ${(logs || []).length} entries`}
          </span>
        </div>
        {filtered.length === 0 ? (
          <div className="text-center text-muted-foreground py-6 text-sm">
            {(logs || []).length === 0
              ? "No activity yet — start a run to see logs here."
              : "No entries match the current filters."}
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((l, idx) => {
              const rowKey = `${l.kind}-${l.signal_id || l.order_id || l.run_id || idx}-${l.ts}`;
              const open = expanded.has(rowKey);
              return (
                <li key={rowKey} className="py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleRow(rowKey)}
                    className="w-full text-left flex items-start gap-3"
                  >
                    <span className="text-[11px] text-muted-foreground font-mono whitespace-nowrap pt-0.5">
                      {fmtTs(l.ts)}
                    </span>
                    <span
                      className={clsx(
                        "pill text-[10px] uppercase tracking-wide whitespace-nowrap",
                        KIND_STYLES[l.kind],
                      )}
                    >
                      {l.kind}
                    </span>
                    {l.internal_symbol && (
                      <span
                        className="pill text-[10px] bg-panel2 text-gray-300 font-mono whitespace-nowrap"
                        title={l.internal_symbol}
                      >
                        {prettySymbol(l.internal_symbol)}
                      </span>
                    )}
                    <span className={clsx("text-sm flex-1", LEVEL_STYLES[l.level])}>
                      {l.message}
                    </span>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap pt-0.5">
                      {open ? "▾" : "▸"}
                    </span>
                  </button>
                  {open && (
                    <div className="mt-2 ml-[8.25rem] rounded bg-panel2/60 p-2 text-xs space-y-1">
                      <Meta label="Run"    value={l.run_id} />
                      <Meta label="Signal" value={l.signal_id} />
                      <Meta label="Order"  value={l.order_id} />
                      <Meta
                        label="Symbol"
                        value={l.internal_symbol ? prettySymbol(l.internal_symbol) : null}
                      />
                      {Object.keys(l.meta || {}).length > 0 && (
                        <details className="pt-1">
                          <summary className="cursor-pointer text-muted-foreground">meta</summary>
                          <pre className="text-[11px] mt-1 whitespace-pre-wrap break-words">
{JSON.stringify(l.meta, null, 2)}
                          </pre>
                        </details>
                      )}
                      <div className="pt-1">
                        <button
                          type="button"
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => copyJson(l)}
                        >
                          Copy entry as JSON
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "primary" | "danger";
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div
        className={clsx(
          "text-xl font-semibold mt-1",
          accent === "primary" ? "text-primary" : accent === "danger" ? "text-danger" : "",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** Single-cell live-LTP renderer used by both the Contracts and the
 *  Indicator Values tables. Pulses briefly when the price changes so the
 *  user can see at a glance that ticks are still arriving. */
function LivePriceCell({
  symbol,
  live,
}: {
  symbol: string;
  live: Record<string, { ltp: number; ts: number }>;
}) {
  const cur = live[symbol];
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [prevLtp, setPrevLtp] = useState<number | null>(null);
  useEffect(() => {
    if (!cur) return;
    if (prevLtp !== null && cur.ltp !== prevLtp) {
      setFlash(cur.ltp > prevLtp ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 600);
      setPrevLtp(cur.ltp);
      return () => clearTimeout(t);
    }
    if (prevLtp === null) setPrevLtp(cur.ltp);
  }, [cur?.ltp, prevLtp]);
  if (!cur) return <span className="text-muted-foreground">…</span>;
  return (
    <span
      className={clsx(
        "transition-colors px-1 rounded",
        flash === "up" && "bg-primary/30 text-primary",
        flash === "down" && "bg-danger/30 text-danger",
        !flash && "text-gray-100",
      )}
      title={`tick received ${Math.max(0, Math.floor((Date.now() - cur.ts) / 1000))}s ago`}
    >
      ₹{cur.ltp.toFixed(2)}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 font-mono">
      <span className="text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

/** Format an indicator value: 2dp for normal scalars, integer for round
 *  numbers, em-dash for null/NaN (insufficient candle history etc.). */
function fmtIndicator(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  if (abs >= 1)    return v.toFixed(2);
  return v.toFixed(4);
}

function SymbolsSection({
  rows,
  instrumentClass,
  livePrices,
}: {
  rows: SymbolInfo[] | undefined;
  instrumentClass: "EQUITY" | "FUTURES" | "OPTIONS" | undefined;
  livePrices: Record<string, { ltp: number; ts: number }>;
}) {
  // The expiry-table section is meaningful only for futures (concrete-
  // contract symbols). Options strategies store the underlying, not the
  // option contract, so the resolved-symbols section here doesn't apply
  // to OPTIONS either — Phase 2 may add a "current option leg" panel.
  if (instrumentClass !== "FUTURES") return null;
  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">Contracts</h2>
          <p className="text-xs text-muted-foreground">
            Logical aliases (e.g. <span className="font-mono">@CURRENT</span>) auto-roll
            to the next contract on expiry. The LTP column updates tick-by-tick.
          </p>
        </div>
      </div>
      {!rows ? (
        <div className="text-center text-muted-foreground py-4 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-muted-foreground py-4 text-sm">No symbols in this strategy.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="whitespace-nowrap">Contract</th>
                <th className="text-right whitespace-nowrap">LTP</th>
                <th className="whitespace-nowrap">Expiry</th>
                <th className="text-right whitespace-nowrap">Days left</th>
                <th className="text-right whitespace-nowrap">Lot size</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.display_symbol}>
                  <td className="font-mono">
                    {/* Show the concrete contract the strategy is trading
                        today. The user's original logical alias (if any)
                        is surfaced as a pill so they remember the rule
                        that picked this contract, without needing a
                        separate "Resolves to" column. */}
                    {r.error ? (
                      <span className="text-danger">
                        {prettySymbol(r.display_symbol)} — {r.error}
                      </span>
                    ) : (
                      <>
                        <span title={r.internal_symbol || r.display_symbol}>
                          {prettySymbol(r.internal_symbol || r.display_symbol)}
                        </span>
                        {r.logical && r.alias && (
                          <span
                            className="ml-2 pill text-[10px] bg-blue-500/15 text-blue-300 uppercase"
                            title={`auto-rolling alias: ${r.display_symbol}`}
                          >
                            {r.alias}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="text-right font-mono">
                    <LivePriceCell
                      symbol={r.internal_symbol || r.display_symbol}
                      live={livePrices}
                    />
                  </td>
                  <td className="font-mono">
                    {r.expiry ? (
                      <span
                        className={clsx(
                          r.days_to_expiry !== null && r.days_to_expiry <= 3
                            ? "text-orange-300"
                            : "",
                        )}
                      >
                        {r.expiry}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-right font-mono">
                    {r.days_to_expiry !== null && r.days_to_expiry !== undefined ? (
                      <span
                        className={clsx(
                          r.days_to_expiry <= 0
                            ? "text-danger"
                            : r.days_to_expiry <= 3
                            ? "text-orange-300"
                            : "",
                        )}
                      >
                        {r.days_to_expiry}d
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-right font-mono">{r.lot_size ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function IndicatorsSection({
  snapshots,
  loading,
  onRefresh,
  timeframeMin,
  livePrices,
}: {
  snapshots: IndicatorSnapshot[] | undefined;
  loading: boolean;
  onRefresh: () => void;
  timeframeMin: number | null;
  livePrices: Record<string, { ltp: number; ts: number }>;
}) {
  // The first snapshot dictates the column order; in practice every
  // snapshot's spec list is identical because the indicators are
  // strategy-wide.
  const cols = snapshots?.[0]?.indicators ?? [];
  const tf = timeframeMin ? `${timeframeMin}m` : "tick";

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Indicator values</h2>
          <p className="text-xs text-muted-foreground">
            Latest reading per symbol on the strategy's timeframe ({tf}). Indicators
            refresh every 15s; the LTP column updates tick-by-tick over the live feed.
          </p>
        </div>
        <button type="button" className="btn-outline text-xs" onClick={onRefresh} title="Recompute now">
          ↻
        </button>
      </div>

      {loading && !snapshots ? (
        <div className="text-center text-muted-foreground py-6 text-sm">Computing indicators…</div>
      ) : !snapshots || snapshots.length === 0 ? (
        <div className="text-center text-muted-foreground py-6 text-sm">
          No symbols in this strategy — add some on the Edit page.
        </div>
      ) : cols.length === 0 ? (
        <div className="text-center text-muted-foreground py-6 text-sm">
          This strategy's rules don't reference any indicators (e.g. only candle patterns
          or volume spikes).
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="whitespace-nowrap">Symbol</th>
                <th
                  className="text-right whitespace-nowrap"
                  title="Live LTP — last tick received via the broker WS"
                >
                  LTP
                </th>
                <th
                  className="text-right whitespace-nowrap"
                  title="Close of the most recent completed candle on the strategy's timeframe"
                >
                  Close
                </th>
                {cols.map((c, i) => (
                  <th key={i} className="text-right whitespace-nowrap" title={`source: ${c.source}`}>
                    {c.label}
                  </th>
                ))}
                <th className="whitespace-nowrap">As of</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap) => (
                <tr key={snap.internal_symbol}>
                  <td className="font-mono" title={snap.internal_symbol}>
                    {prettySymbol(snap.internal_symbol)}
                  </td>
                  <td className="text-right font-mono">
                    <LivePriceCell symbol={snap.internal_symbol} live={livePrices} />
                  </td>
                  <td className="text-right font-mono">{fmtIndicator(snap.last_close)}</td>
                  {cols.map((col, i) => {
                    const cell = snap.indicators.find(
                      (x) => x.indicator === col.indicator && x.label === col.label,
                    );
                    return (
                      <td key={i} className="text-right font-mono">
                        {fmtIndicator(cell?.value ?? null)}
                      </td>
                    );
                  })}
                  <td className="text-xs text-muted-foreground">
                    {snap.error
                      ? <span className="text-danger">{snap.error}</span>
                      : snap.last_candle_ts
                      ? fmtTs(snap.last_candle_ts)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Plan picks — only rendered for PLAN_BASED strategies. Shows what the
// dispatcher WOULD place at 09:15 IST today, given the current plan +
// strategy filters. Read-only, no side effects.
// ---------------------------------------------------------------------------

interface PlanPickIdea {
  underlying: string | null;
  internal_symbol: string | null;
  direction: string | null;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  r_to_r: number | null;
  confidence: number | null;
  conviction_score: number | null;
  why: string | null;
  setup_type: string | null;
}

interface PlanPickRow {
  internal_symbol: string;
  side: "BUY" | "SELL" | null;
  qty: number;
  trigger_price: number | null;
  limit_price: number | null;
  stop_loss: number | null;
  target: number | null;
  skip_reason: string | null;
  idea: PlanPickIdea;
}

interface PlanPreviewResp {
  trade_date: string | null;
  section: string;
  top_n: number;
  min_confidence: number;
  min_rr: number;
  risk_pct_per_trade: number;
  capital: number;
  orders: PlanPickRow[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Pending triggers — inline view of ManagedTriggers tied to this
// strategy's runs (any role: ENTRY / SL / TARGET).
// ---------------------------------------------------------------------------

interface InlineTrigger {
  id: string;
  strategy_run_id: string | null;
  role: "ENTRY" | "SL" | "TARGET";
  internal_symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  direction: "UP" | "DOWN";
  trigger_price: number;
  limit_price: number | null;
  state: "PENDING" | "ARMED" | "TRIGGERED" | "FILLED" | "CANCELLED" | "FAILED";
  created_at: string;
}

const INLINE_STATE_STYLES: Record<InlineTrigger["state"], string> = {
  PENDING: "bg-secondary text-muted-foreground",
  ARMED: "bg-primary/20 text-primary",
  TRIGGERED: "bg-warning/20 text-warning",
  FILLED: "bg-profit/20 text-profit",
  CANCELLED: "bg-secondary text-muted-foreground",
  FAILED: "bg-loss/20 text-loss",
};

function PendingTriggersSection({ runIds }: { runIds: string[] }) {
  // We don't have a `/triggers?strategy_id=…` filter in the API yet,
  // so do a global "live triggers" fetch and filter client-side to
  // the runs that belong to this strategy. The set is small (a few
  // dozen at most), so this is cheap. Adding a strategy_id filter
  // server-side is a future API tweak.
  const poll = useMarketPollInterval(10_000, "ANY");
  const { data, mutate } = useSWR<InlineTrigger[]>(
    "/triggers?limit=300",
    fetcher,
    { refreshInterval: poll, keepPreviousData: true },
  );
  const runIdSet = useMemo(() => new Set(runIds), [runIds]);
  const triggers = useMemo(
    () =>
      (data ?? []).filter(
        (t) => t.strategy_run_id && runIdSet.has(t.strategy_run_id),
      ),
    [data, runIdSet],
  );

  async function cancelOne(t: InlineTrigger) {
    try {
      await api.delete(`/triggers/${t.id}`);
      toast.success(`${t.role} trigger cancelled`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "cancel failed");
    }
  }

  if (!triggers.length) {
    // Don't take up vertical space when there's nothing to show. The
    // PlanPicksSection below covers the empty-state messaging for
    // plan-based strategies, and candle-driven strategies don't expect
    // anything here until an SL/SL-M is armed.
    return null;
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Pending triggers · {triggers.length}
        </h2>
        <Link href="/triggers" className="text-[11px] text-primary hover:underline">
          Open Triggers page →
        </Link>
      </div>
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground uppercase text-[10px] tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">State</th>
                <th className="px-3 py-2 text-left">Role</th>
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-left">Side · Qty</th>
                <th className="px-3 py-2 text-right">Trigger</th>
                <th className="px-3 py-2 text-right">Limit</th>
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t) => (
                <tr key={t.id} className="border-t border-border/40">
                  <td className="px-3 py-2">
                    <span className={clsx("pill font-mono", INLINE_STATE_STYLES[t.state])}>
                      {t.state}
                    </span>
                  </td>
                  <td className="px-3 py-2">{t.role}</td>
                  <td
                    className="px-3 py-2 font-mono truncate max-w-[260px]"
                    title={t.internal_symbol}
                  >
                    {prettySymbol(t.internal_symbol)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <span className={t.side === "BUY" ? "text-profit" : "text-loss"}>
                      {t.side}
                    </span>{" "}
                    <span className="text-muted-foreground">·</span> {t.qty}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    ₹{Number(t.trigger_price).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.limit_price != null
                      ? `₹${Number(t.limit_price).toFixed(2)}`
                      : "MKT"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {t.state === "ARMED" || t.state === "PENDING" ? (
                      <button
                        type="button"
                        onClick={() => cancelOne(t)}
                        className="text-[11px] text-loss hover:underline"
                      >
                        Cancel
                      </button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}


function PlanPicksSection({ strategyId }: { strategyId: string }) {
  // PLAN_BASED dispatcher fires at 09:15 IST — the picks for "today"
  // settle by 09:16 and don't change again, so a 60s poll during the
  // equity session is plenty and silent outside it.
  const planPicksPoll = useMarketPollInterval(60_000, "EQ_FO");
  const { data, isLoading, error, mutate, isValidating } = useSWR<PlanPreviewResp>(
    `/strategies/${strategyId}/plan-preview`,
    fetcher,
    {
      refreshInterval: planPicksPoll,
      revalidateOnFocus: false,
    },
  );

  const placed = useMemo(
    () => (data?.orders ?? []).filter((o) => !o.skip_reason),
    [data?.orders],
  );
  const skipped = useMemo(
    () => (data?.orders ?? []).filter((o) => o.skip_reason),
    [data?.orders],
  );

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">Today's picks (preview)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What the dispatcher would place at 09:15 IST (market open).
            {data?.trade_date && (
              <span className="ml-1 font-mono">as of {data.trade_date}</span>
            )}
            {data && (
              <span className="ml-2">
                · top {data.top_n} · min conf {data.min_confidence} · min R:R {data.min_rr}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={() => mutate()}
          disabled={isValidating}
          title="Refresh preview"
        >
          {isValidating ? "…" : "↻"}
        </button>
      </div>

      {isLoading && !data ? (
        <div className="text-xs text-muted-foreground">loading preview…</div>
      ) : error ? (
        <div className="text-xs text-loss">
          couldn't load preview: {String((error as any)?.message ?? error)}
        </div>
      ) : !data || data.orders.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          {data?.note
            ? data.note
            : "no qualifying ideas right now — either today's plan is empty or no idea passes your filters."}
        </div>
      ) : (
        <>
          {placed.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3">Symbol</th>
                    <th className="py-2 pr-3">Side</th>
                    <th className="py-2 pr-3 text-right">Qty</th>
                    <th className="py-2 pr-3 text-right">Trigger</th>
                    <th className="py-2 pr-3 text-right">Limit</th>
                    <th className="py-2 pr-3 text-right">Stop</th>
                    <th className="py-2 pr-3 text-right">Target</th>
                    <th className="py-2 pr-3 text-right">R:R</th>
                    <th className="py-2 pr-3 text-right">Conf</th>
                    <th className="py-2">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {placed.map((row, idx) => (
                    <tr
                      key={`${row.internal_symbol}-${idx}`}
                      className="border-b border-border/40 hover:bg-panel2/50"
                    >
                      <td className="py-2 pr-3 font-mono">
                        {prettySymbol(row.internal_symbol)}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={clsx(
                            "pill text-[10px] uppercase",
                            row.side === "BUY"
                              ? "bg-primary/20 text-primary"
                              : "bg-loss/20 text-loss",
                          )}
                        >
                          {row.side}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">{row.qty}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {row.trigger_price?.toFixed(2) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {row.limit_price?.toFixed(2) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-loss">
                        {row.stop_loss?.toFixed(2) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-primary">
                        {row.target?.toFixed(2) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {row.idea.r_to_r?.toFixed(2) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {row.idea.confidence ?? "—"}
                        {row.idea.confidence != null && "/4"}
                      </td>
                      <td className="py-2 text-muted-foreground max-w-[280px] truncate" title={row.idea.why ?? ""}>
                        {row.idea.why ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {skipped.length > 0 && (
            <details className="mt-3" open={placed.length === 0}>
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                {skipped.length} skipped (click to expand)
              </summary>
              <div className="mt-2 space-y-1">
                {skipped.map((row, idx) => (
                  <div key={`skip-${idx}`} className="text-xs">
                    <span className="font-mono text-muted-foreground">
                      {prettySymbol(row.internal_symbol)}
                    </span>
                    <span className="text-loss ml-2">— {row.skip_reason}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
