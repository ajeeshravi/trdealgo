"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import { XCircle, Plug } from "lucide-react";
import { api } from "@/lib/api";
import { fmtExpiry, fmtUSD } from "@/lib/fmt";
import { useLivePrices } from "@/lib/useLivePrices";
import { cn } from "@/lib/utils";
import { useMarketPollInterval } from "@/lib/marketHours";
import { useConfirm } from "@/components/ConfirmDialog";
import { Pagination, usePagination } from "@/components/Pagination";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { SymbolColumnsRow } from "@/components/SymbolColumns";

type Position = SymbolColumnsRow & {
  id: string;
  broker_account_id: string | null;
  // Strategy run that opened this row. Critical on close: a paper run on a
  // LIVE broker account stores the live broker_account_id; without this, the
  // backend can't tell the position was paper and routes the exit to the
  // real broker.
  strategy_run_id?: string | null;
  // Strategy that owns the run above. Backend joins these in; both stay null
  // for manual trades. Used by the "Strategy" column so the user can tell
  // which strategy placed each position.
  strategy_id?: string | null;
  strategy_name?: string | null;
  internal_symbol: string;
  product: string;
  qty: number;
  avg_price: number;
  realized_pnl: number;
  unrealized_pnl: number;
  last_price?: number | null;
};

type BrokerAccount = {
  id: string;
  broker: string;
  client_id: string;
  label?: string | null;
  is_paper: boolean;
};

const fetcher = (u: string) => api.get(u).then((r) => r.data);

/** What we show to the user for a position. Never the internal_symbol — only
 *  the broker-tradeable form, with the underlying as a fallback for cash rows
 *  whose backend `trading_symbol` may be empty until the symbol-master cache
 *  has warmed. */
function displayName(p: { trading_symbol?: string; underlying?: string | null }): string {
  return p.trading_symbol || p.underlying || "—";
}

/** Collapse rows that share the same broker + symbol + strategy_run.
 *
 *  Aggregation rules:
 *    - Different products (MIS + CNC on the same account, same run) fold
 *      into one row — same trader, same intent.
 *    - Different strategy_runs DO NOT merge, even on the same broker +
 *      symbol. Each run owns its own realised PnL on the backend
 *      (Position is keyed by `(user, broker, symbol, product, run_id)`),
 *      and merging them would double-attribute closed runs' realised
 *      onto the latest open run — e.g. 4 closed `dfghj` runs each with
 *      18K realised would appear as a single 1-share row with 72K
 *      realised, which both reads as a bug and fools RMS reading the
 *      `realized_pnl` field.
 *    - Rows in DIFFERENT brokers stay separate so each row's Close
 *      routes to its own broker account.
 *    - Manual trades (no strategy_run_id) all share `run_id = NULL` on
 *      the backend, so they collapse onto a single row per broker +
 *      symbol + product — matches the Position table's unique key.
 */
function aggregateByBrokerSymbol(rows: Position[]): Position[] {
  const groups = new Map<string, Position[]>();
  for (const r of rows) {
    const runKey = r.strategy_run_id || "__manual__";
    const key = `${r.broker_account_id || "__none__"}::${r.internal_symbol}::${runKey}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  return Array.from(groups.values()).map((grp) => {
    if (grp.length === 1) return grp[0];
    const first = grp[0];
    let totalQty = 0;
    let weightedAvgNum = 0;
    let weightedAvgDen = 0;
    let realized = 0;
    let lastPrice: number | null | undefined = undefined;
    const products = new Set<string>();
    const strategyNames = new Set<string>();
    for (const r of grp) {
      totalQty += r.qty;
      const w = Math.abs(r.qty);
      weightedAvgNum += w * r.avg_price;
      weightedAvgDen += w;
      realized += r.realized_pnl;
      if (lastPrice == null && r.last_price != null) lastPrice = r.last_price;
      products.add(r.product);
      if (r.strategy_name) strategyNames.add(r.strategy_name);
    }
    const avg = weightedAvgDen > 0 ? weightedAvgNum / weightedAvgDen : first.avg_price;
    const unreal = lastPrice != null ? (lastPrice - avg) * totalQty : 0;
    // Strategy attribution after aggregation: within one strategy_run
    // there can only ever be one strategy, so `strategyNames` is either
    // empty (manual) or a single entry. The earlier MULTI branch was
    // only reachable when we used to merge across runs; keep the guard
    // defensively in case the backend ever emits a stray.
    const stratName =
      strategyNames.size === 0
        ? null
        : strategyNames.size === 1
          ? Array.from(strategyNames)[0]
          : "MULTI";
    const stratId = strategyNames.size === 1 ? first.strategy_id ?? null : null;
    return {
      ...first,
      id: `agg:${first.broker_account_id || "_"}:${first.internal_symbol}:${first.strategy_run_id || "_"}`,
      qty: totalQty,
      avg_price: avg,
      unrealized_pnl: unreal,
      realized_pnl: realized,
      last_price: lastPrice,
      product: products.size === 1 ? first.product : "MULTI",
      strategy_name: stratName,
      strategy_id: stratId,
    } as Position;
  });
}

type PositionsView = "open" | "closed" | "all";

export default function PositionsPage() {
  // Default to "all" so users land on a screen that shows both their open
  // and closed trades. The Open/Closed pills are a filter for users who want
  // to narrow the view, not a discovery step required to find closed rows.
  const [view, setView] = useState<PositionsView>("all");
  // Fetch closed too whenever we need them, so flipping the tab is instant.
  // The Open tab still filters client-side from the same payload.
  const includeClosed = view !== "open";
  // Positions can change on any exchange (NSE/BSE/F&O/MCX/CDS) so use
  // the union session — outside 09:00–23:30 IST Mon-Fri the poll stops.
  const positionsPoll = useMarketPollInterval(10000, "ANY");
  const { data, mutate } = useSWR<Position[]>(
    `/positions${includeClosed ? "?include_closed=true" : ""}`,
    fetcher,
    { refreshInterval: positionsPoll },
  );
  const { data: brokers } = useSWR<BrokerAccount[]>("/brokers", fetcher);
  const [closing, setClosing] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const confirm = useConfirm();

  const apiRows: Position[] = data || [];
  // Apply the view filter on the raw rows before aggregation.
  const viewRows: Position[] = useMemo(() => {
    if (view === "open") return apiRows.filter((p) => p.qty !== 0);
    if (view === "closed") return apiRows.filter((p) => p.qty === 0);
    return apiRows;
  }, [apiRows, view]);
  // Raw rows kept for the Close handlers (need every distinct row so we can
  // send one closing order per (broker, symbol, product) — products differ in
  // the OMS even within a single broker/symbol).
  const rawRows = viewRows;
  // Display rows: collapsed where same broker holds same symbol.
  const displayRows: Position[] = useMemo(() => aggregateByBrokerSymbol(viewRows), [viewRows]);

  // broker_account_id -> account info, for the Broker column + close-routing safety
  const brokerById = useMemo(() => {
    const m = new Map<string, BrokerAccount>();
    (brokers || []).forEach((b) => m.set(b.id, b));
    return m;
  }, [brokers]);

  // WebSocket tick subscription so the LTP + unrealised P&L update live.
  // Only subscribe to OPEN symbols — closed positions have qty=0 and LTP
  // updates would do nothing useful. Saves bandwidth + WS load.
  // The hook throttles tick → setState to one flush per ~300ms so the table
  // doesn't re-render at the broker's raw tick rate.
  const subSymbols = useMemo(
    () =>
      Array.from(new Set(rawRows.filter((r) => r.qty !== 0).map((r) => r.internal_symbol))).sort(),
    [rawRows],
  );
  const livePrices = useLivePrices(subSymbols);

  // Snapshot fallback for LTP. Live ticks are the fast path — but they
  // require the broker WS to actually be streaming the symbol, and that
  // doesn't always happen immediately (broker not logged in yet, feed
  // router still claiming the symbol, etc.). Without an LTP, unrealised
  // P&L stays 0 and RMS rules that fire on PnL won't trigger. The
  // /market/snapshot endpoint reads Redis LTP cache first and falls back
  // to the latest EOD candle close, so it always returns *something* we
  // can compute against.
  //
  // Polled every 10 s during market hours (silent outside — the snapshot
  // doesn't change when no exchange is open). 10 s is the same cadence
  // as the /positions poll so the two stay in step.
  const snapshotPoll = useMarketPollInterval(10_000, "ANY");
  const snapshotKey = subSymbols.length
    ? `/market/snapshot?symbols=${encodeURIComponent(subSymbols.join(","))}`
    : null;
  const { data: snapshotPrices } = useSWR<Record<string, { ltp: number | null }>>(
    snapshotKey,
    fetcher,
    { refreshInterval: snapshotPoll, keepPreviousData: true, shouldRetryOnError: false },
  );

  // Apply LTP (live > snapshot > backend last_price) and recompute
  // unrealised P&L. The "max useful information" precedence means RMS
  // sees a real number even when the broker WS is briefly silent.
  const rows = useMemo(
    () =>
      displayRows.map((p) => {
        const live = livePrices[p.internal_symbol];
        const snap = snapshotPrices?.[p.internal_symbol]?.ltp;
        const ltp =
          (typeof live === "number" && live > 0) ? live
          : (typeof snap === "number" && snap > 0) ? snap
          : (typeof p.last_price === "number" && p.last_price > 0) ? p.last_price
          : null;
        if (ltp == null) return p;
        return {
          ...p,
          last_price: ltp,
          unrealized_pnl: (ltp - p.avg_price) * p.qty,
        };
      }),
    [displayRows, livePrices, snapshotPrices],
  );

  const totalUnrealized = rows.reduce((s, p) => s + Number(p.unrealized_pnl || 0), 0);
  const totalRealized = rows.reduce((s, p) => s + Number(p.realized_pnl || 0), 0);
  const { page, pageSize, pageRows, setPage, setPageSize } = usePagination(rows, 20);
  const selectedRow = useMemo(
    () => (selectedRowId ? rows.find((r) => r.id === selectedRowId) || null : null),
    [selectedRowId, rows],
  );

  async function closeRow(p: Position) {
    const label = displayName(p);
    if (!p.broker_account_id) {
      toast.error(`${label}: no broker account on record — restart backend to expose broker_account_id`);
      return;
    }
    const acct = brokerById.get(p.broker_account_id);
    // The displayed row may aggregate multiple raw rows (different products on
    // the same broker). Fan back out so each product gets its own close order.
    const matching = rawRows.filter(
      (r) => r.broker_account_id === p.broker_account_id && r.internal_symbol === p.internal_symbol && r.qty !== 0,
    );
    if (matching.length === 0) return;
    // A paper-mode strategy on a LIVE broker account leaves a strategy_run_id
    // on the row; the OMS will route the exit through the paper adapter.
    // Reflect that in the confirm so the user doesn't see a "live exit"
    // warning for what is actually a simulated trade.
    const isPaperExit = !!acct?.is_paper || matching.some((r) => r.strategy_run_id);
    const paperTag = isPaperExit ? " (PAPER)" : "";
    const acctLabel = acct
      ? `${acct.broker} · ${acct.client_id}${paperTag}`
      : "this broker";
    const totalQty = matching.reduce((s, r) => s + r.qty, 0);
    const ok = await confirm({
      title: `Close ${label}?`,
      message:
        matching.length === 1
          ? `Place a MARKET ${totalQty > 0 ? "SELL" : "BUY"} for ${Math.abs(totalQty)} ${label} on ${acctLabel}. Market orders execute at current liquidity — slippage applies.`
          : `${label} on ${acctLabel} is split across ${matching.length} product types. This sends opposite MARKET orders for each. Market orders execute at current liquidity — slippage applies.`,
      confirmLabel: "Send square-off",
      cancelLabel: "Keep open",
      variant: isPaperExit ? "warning" : "danger",
    });
    if (!ok) return;
    let okCount = 0;
    for (const r of matching) {
      try {
        await api.post("/orders", {
          broker_account_id: r.broker_account_id,
          internal_symbol: r.internal_symbol,
          side: r.qty > 0 ? "SELL" : "BUY",
          qty: Math.abs(r.qty),
          order_type: "MARKET",
          product: r.product,
          variety: "REGULAR",
          strategy_run_id: r.strategy_run_id ?? null,
        });
        okCount++;
      } catch (e: any) {
        toast.error(e?.response?.data?.error?.message || "close failed");
      }
    }
    if (okCount > 0) toast.success(`square-off sent to ${acctLabel}`);
    mutate();
  }

  async function closeAll() {
    const openRaw = rawRows.filter((p) => p.qty !== 0);
    if (openRaw.length === 0) {
      toast.error("no open positions");
      return;
    }
    // If any row is missing broker_account_id, the user has a stale backend that
    // doesn't serialize it yet — bail loudly instead of letting orders land on
    // whichever broker the server happens to fall back to.
    const orphan = openRaw.find((p) => !p.broker_account_id);
    if (orphan) {
      toast.error("backend not returning broker_account_id — restart uvicorn first");
      return;
    }
    const ok = await confirm({
      title: `Close ${openRaw.length} open position${openRaw.length === 1 ? "" : "s"}?`,
      message:
        `For every open position this sends a MARKET order in the opposite direction to the SAME broker the position is held on (paper positions stay on paper, live stays on live). ` +
        `Net unrealised P&L right now: ${fmtUSD(totalUnrealized)}. ` +
        `Market orders execute at current liquidity — slippage applies. ` +
        `Type CLOSE ALL to confirm.`,
      confirmLabel: "Send square-off orders",
      cancelLabel: "Keep open",
      variant: "danger",
      requireTyped: "CLOSE ALL",
    });
    if (!ok) return;

    setClosing(true);
    let okCount = 0;
    try {
      for (const p of openRaw) {
        try {
          await api.post("/orders", {
            broker_account_id: p.broker_account_id,
            internal_symbol: p.internal_symbol,
            side: p.qty > 0 ? "SELL" : "BUY",
            qty: Math.abs(p.qty),
            order_type: "MARKET",
            product: p.product,
            variety: "REGULAR",
            strategy_run_id: p.strategy_run_id ?? null,
          });
          okCount++;
        } catch (e: any) {
          const acct = p.broker_account_id ? brokerById.get(p.broker_account_id) : null;
          const acctLabel = acct ? `${acct.broker} · ${acct.client_id}` : "?";
          toast.error(
            `${displayName(p)} @ ${acctLabel}: ${e?.response?.data?.error?.message || "close failed"}`,
          );
        }
      }
      if (okCount > 0) {
        toast.success(`square-off sent for ${okCount} position${okCount === 1 ? "" : "s"}`);
      }
      mutate();
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Positions</h1>
          <p className="text-sm text-muted-foreground font-mono">
            {rows.length} {view === "closed" ? "closed" : view === "all" ? "" : "open"} position{rows.length === 1 ? "" : "s"}
            {view !== "closed" && (
              <>
                {" · "}
                <span className={totalUnrealized >= 0 ? "text-profit" : "text-loss"}>
                  Unrealised {fmtUSD(totalUnrealized)}
                </span>
              </>
            )}
            {(view === "closed" || view === "all") && (
              <>
                {" · "}
                <span className={totalRealized >= 0 ? "text-profit" : "text-loss"}>
                  Realised {fmtUSD(totalRealized)}
                </span>
              </>
            )}
          </p>
        </div>
        {view !== "closed" && (
          <button
            className="btn-danger inline-flex items-center gap-1.5"
            onClick={closeAll}
            disabled={closing || rawRows.every((p) => p.qty === 0)}
          >
            <XCircle className="w-4 h-4" />
            {closing ? "Closing…" : "Close all"}
          </button>
        )}
      </header>

      {/* Open / Closed / All tab strip — sits above the table so the user
          can switch quickly without leaving the page. Closed positions are
          stored alongside open ones; the backend filter is opt-in. */}
      <div className="border-b border-border/50 flex gap-1 overflow-x-auto">
        {(["open", "closed", "all"] as PositionsView[]).map((v) => {
          const isActive = view === v;
          const label = v === "open" ? "Open" : v === "closed" ? "Closed" : "All";
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="card">
        {rows.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={rows.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            className="mb-2 border-b border-border/50"
          />
        )}
        <table className="table">
          <thead>
            <tr>
              <th>Exchange</th>
              <th>Symbol</th>
              <th>Broker</th>
              <th>Strategy</th>
              <th>Product</th>
              <th>Qty</th>
              <th>Avg</th>
              <th>LTP</th>
              <th>Unrealised</th>
              <th>Realised</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((p) => {
              const acct = p.broker_account_id ? brokerById.get(p.broker_account_id) : null;
              return (
                <tr
                  key={p.id}
                  onClick={() => setSelectedRowId(p.id)}
                  className="hover:bg-accent/30 transition-colors cursor-pointer"
                >
                  <td>{p.exchange || "—"}</td>
                  <td className="font-mono">
                    <div className="inline-flex items-center gap-1.5">
                      <span>{displayName(p)}</span>
                      {p.qty < 0 && (
                        <span
                          className="pill bg-loss/20 text-loss text-[9px]"
                          title={
                            p.segment === "OPT"
                              ? "Written option — short premium"
                              : "Short position — SELL first, BUY to close"
                          }
                        >
                          {p.segment === "OPT" ? "WRITE" : "SHORT"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    {acct ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">
                          {acct.broker} · {acct.client_id}
                        </span>
                        {acct.is_paper && (
                          <span className="pill bg-warning/20 text-warning text-[9px]">PAPER</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {p.strategy_name ? (
                      <span
                        className="font-medium"
                        title={p.strategy_id ?? undefined}
                      >
                        {p.strategy_name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic">Manual</span>
                    )}
                  </td>
                  <td>{p.product}</td>
                  <td
                    className={cn(
                      "font-mono",
                      p.qty < 0 && "text-loss",
                      p.qty > 0 && "text-profit",
                    )}
                  >
                    {p.qty > 0 ? `+${p.qty}` : p.qty}
                  </td>
                  <td className="font-mono">{fmtUSD(p.avg_price)}</td>
                  <td className="font-mono">{fmtUSD(p.last_price)}</td>
                  <td className={cn("font-mono", p.unrealized_pnl >= 0 ? "text-profit" : "text-loss")}>
                    {fmtUSD(p.unrealized_pnl)}
                  </td>
                  <td className={cn("font-mono", p.realized_pnl >= 0 ? "text-profit" : "text-loss")}>
                    {fmtUSD(p.realized_pnl)}
                  </td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRow(p);
                      }}
                      disabled={closing || !p.broker_account_id || p.qty === 0}
                      title={
                        !p.broker_account_id
                          ? "broker missing"
                          : p.qty === 0
                            ? "already flat"
                            : "Square off this position"
                      }
                      className="p-1 rounded-md text-muted-foreground hover:text-loss hover:bg-loss/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                      aria-label="Close position"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="text-center text-muted-foreground py-4">
                  {view === "closed"
                    ? "No closed positions"
                    : view === "all"
                      ? "No positions"
                      : "No open positions"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={rows.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>

      <Dialog open={!!selectedRow} onOpenChange={(o) => !o && setSelectedRowId(null)}>
        <DialogContent className="max-w-lg">
          {selectedRow && (
            <PositionDetail
              p={selectedRow}
              broker={selectedRow.broker_account_id ? brokerById.get(selectedRow.broker_account_id) : null}
              busy={closing}
              onExit={async () => {
                // Dismiss the detail popup BEFORE firing the confirm dialog.
                // Both modals were claiming z-50; the shadcn Dialog's overlay
                // ended up on top and ate the confirm's clicks.
                const row = selectedRow;
                setSelectedRowId(null);
                if (row) await closeRow(row);
              }}
              onClose={() => setSelectedRowId(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ====================================================================
// Position detail panel — inside the dialog. All-in-one read-out + Exit.
// ====================================================================
function PositionDetail({
  p,
  broker,
  busy,
  onExit,
  onClose,
}: {
  p: Position;
  broker: BrokerAccount | null | undefined;
  busy: boolean;
  onExit: () => void | Promise<void>;
  onClose: () => void;
}) {
  const isPaper = !!broker?.is_paper;
  return (
    <>
      <DialogHeader className="sr-only">
        <DialogTitle>
          {displayName(p)} on {broker ? `${broker.broker} · ${broker.client_id}` : "unknown broker"}
        </DialogTitle>
        <DialogDescription>Position detail</DialogDescription>
      </DialogHeader>

      {/* Broker info — top-of-popup banner so the user can confirm which
          account this position lives on at a glance. */}
      <div className="rounded-md border border-border bg-accent/40 p-3 pr-12">
        {broker ? (
          <div className="flex items-start gap-3">
            <div className={cn(
              "shrink-0 w-9 h-9 rounded-md flex items-center justify-center",
              isPaper ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary",
            )}>
              <Plug className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="text-sm font-semibold leading-tight">{broker.broker}</div>
              <div className="text-xs font-mono text-muted-foreground">
                {broker.client_id}
                {broker.label && <span> · {broker.label}</span>}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {isPaper ? "Paper trading account" : "Live trading account"}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-loss">
            Broker not on record — restart backend so /positions returns broker_account_id.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm mt-5">
        {p.trading_symbol && (
          <DetailRow label="Trading symbol" value={p.trading_symbol} mono />
        )}
        {/* Underlying is only meaningful for F&O — for plain equity it's the
            same name as the trading symbol, so we suppress it. */}
        {(p.expiry || p.strike != null || p.option_type) &&
          p.underlying &&
          p.underlying !== p.trading_symbol && (
            <DetailRow label="Underlying" value={p.underlying} mono />
          )}
        <DetailRow label="Exchange" value={p.exchange || "—"} />
        {p.segment && <DetailRow label="Segment" value={p.segment} />}
        {p.option_type && <DetailRow label="Option type" value={p.option_type} />}
        {p.expiry && <DetailRow label="Expiry" value={fmtExpiry(p.expiry)} mono />}
        {p.strike != null && (
          <DetailRow label="Strike" value={fmtUSD(p.strike)} mono />
        )}
        <DetailRow
          label="Strategy"
          value={p.strategy_name || "Manual"}
          className={p.strategy_name ? "" : "italic text-muted-foreground"}
        />
        <DetailRow label="Product" value={p.product} />
        <DetailRow label="Quantity" value={String(p.qty)} mono />
        <DetailRow label="Side" value={p.qty > 0 ? "LONG" : p.qty < 0 ? "SHORT" : "FLAT"} />
        <DetailRow label="Avg price" value={fmtUSD(p.avg_price)} mono />
        <DetailRow label="LTP" value={fmtUSD(p.last_price)} mono />
        <DetailRow
          label="Unrealised P&L"
          value={fmtUSD(p.unrealized_pnl)}
          mono
          className={p.unrealized_pnl >= 0 ? "text-profit" : "text-loss"}
        />
        <DetailRow
          label="Realised P&L"
          value={fmtUSD(p.realized_pnl)}
          mono
          className={p.realized_pnl >= 0 ? "text-profit" : "text-loss"}
        />
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t border-border mt-5">
        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button
          type="button"
          className="btn-danger inline-flex items-center gap-1.5"
          onClick={onExit}
          disabled={busy || p.qty === 0 || !p.broker_account_id}
          title={
            !p.broker_account_id
              ? "broker missing"
              : p.qty === 0
                ? "already flat"
                : `Square off ${Math.abs(p.qty)} ${displayName(p)}`
          }
        >
          <XCircle className="w-4 h-4" />
          Exit position
        </button>
      </div>
    </>
  );
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn("mt-0.5", mono && "font-mono", className)}>{value}</div>
    </div>
  );
}
