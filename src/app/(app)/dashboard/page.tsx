"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import dynamic from "next/dynamic";
import toast from "react-hot-toast";
import { ExternalLink, BarChart3 } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtUSD, prettySymbol } from "@/lib/fmt";
import { useLivePrices } from "@/lib/useLivePrices";
import { useMarketPollInterval } from "@/lib/marketHours";
import marketDataService from "@/services/marketDataService";
import type { MarketIndex } from "@/lib/marketTypes";
import { useLiveMarketIndices } from "@/hooks/useLiveMarketIndices";

import IndexCard from "@/components/IndexCard";

// Heavy widgets — kept out of the initial dashboard chunk so the page's
// "Market Overview" strip paints fast. They mount asynchronously once
// the route's main shell is on screen.
//   - StockHeatmap pulls in a custom treemap + Tooltip provider + a 17 KB
//     IndexTechnicals component (six speedometer SVGs).
//   - MarketSentimentWidget runs its own polling chain.
//   - ExchangeSymbolPicker is ~30 KB on its own (cascading SWR fetches).
//   - Recharts is ~120 KB and only used inside the equity-curve dialog.
const StockHeatmap = dynamic(() => import("@/components/StockHeatmap"), { ssr: false });
const MarketSentimentWidget = dynamic(() => import("@/components/MarketSentimentWidget"), { ssr: false });
const ExchangeSymbolPicker = dynamic(
  () => import("@/components/ExchangeSymbolPicker").then((m) => m.ExchangeSymbolPicker),
  { ssr: false },
);
const EquityCurveChart = dynamic(() => import("@/components/EquityCurveChart"), { ssr: false });

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CardType = "positions" | "pnl" | "strategies" | "capital" | "vix" | "pcr" | "fiidii" | "advdec" | null;

const fetcher = (url: string) => api.get(url).then((r) => r.data);

// Total account capital — surfaced as a constant until a real account
// equity endpoint exists. Update in the user's preferences page when
// the broker margin endpoint is wired.
const TOTAL_CAPITAL = 620000;

export default function Dashboard() {
  const router = useRouter();

  // ---- Live indices ----
  // 2.5s polls keep cards visibly ticking without re-rendering 30 cards
  // every second. With React.memo on IndexCard, only the cards whose LTP
  // actually changed re-paint.
  const { primaryIndices, secondaryIndices, loading: indicesLoading, error: indicesError } =
    useLiveMarketIndices({ refreshInterval: 2500 });

  const [selectedIndex, setSelectedIndex] = useState<MarketIndex | null>(null);
  const [heatmapOpen, setHeatmapOpen] = useState(false);
  const [showMoreIndices, setShowMoreIndices] = useState(false);

  // ---- Portfolio data ----
  // Positions are the most "live" item on the dashboard but still safe
  // to refresh every 15s — actual LTP updates flow through the WS tick
  // stream, this only re-fetches qty/avg_price/realised PnL when an
  // order fills.
  // include_closed=true so we get realised P&L from positions that were
  // squared off today — without it the dashboard tile can never show the
  // day's realised number. The downstream `openPositions` map filters back
  // to qty != 0 for everything that needs open-only.
  // Polls below are gated to "any Indian market open" (09:00-23:30 IST
  // Mon-Fri) — positions/orders span NSE/BSE/F&O/MCX/CDS so we use the
  // union session. Outside those hours nothing on screen changes, so the
  // polls collapse to 0 (= no refetch). The user can still reload to
  // force a refresh.
  const positionsPoll = useMarketPollInterval(15_000, "ANY");
  const strategiesPoll = useMarketPollInterval(60_000, "ANY");
  const ordersPoll = useMarketPollInterval(30_000, "ANY");
  const pnlPoll = useMarketPollInterval(120_000, "ANY");
  const { data: positionsData } = useSWR<any[]>("/positions?include_closed=true", fetcher, { refreshInterval: positionsPoll });
  const { data: strategiesData } = useSWR<any[]>("/strategies", fetcher, { refreshInterval: strategiesPoll });
  // Pull a generous window of recent fills, then narrow client-side to
  // the latest *trading session* — today if the trader has traded today,
  // otherwise the most recent day with fills. A strict "since IST
  // midnight" filter would show 0 every weekend / market holiday, which
  // is unhelpful when the trader opens the dashboard to review.
  const { data: filledOrdersData } = useSWR<any[]>(
    "/orders?state=FILLED&limit=500",
    fetcher,
    { refreshInterval: ordersPoll },
  );
  const { data: pnlSummary } = useSWR<any>("/analytics/pnl?days=30", fetcher, { refreshInterval: pnlPoll });

  const positions = positionsData ?? [];
  const strategies = strategiesData ?? [];
  // Narrow the raw fills to a single trading session. Cutover is 08:00
  // IST — before that the trader is still reviewing yesterday's session,
  // so we keep showing yesterday's fills; from 08:00 onwards (well
  // before the 09:15 market open) we flip to today's date even if no
  // fill has arrived yet, so the tile zeros out cleanly for the new day.
  const allFilledOrders = filledOrdersData ?? [];
  const { filledOrders, sessionDateLabel } = useMemo(() => {
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const toIstDateKey = (iso?: string | null): string | null => {
      if (!iso) return null;
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return null;
      const ist = new Date(ms + IST_OFFSET_MS);
      return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
    };
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    // Step back one calendar day when we're still before the 08:00 IST
    // cutover so the session resolves to yesterday's IST date.
    if (nowIst.getUTCHours() < 8) {
      nowIst.setUTCDate(nowIst.getUTCDate() - 1);
    }
    const sessionKey = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowIst.getUTCDate()).padStart(2, "0")}`;
    return {
      filledOrders: allFilledOrders.filter((o: any) => toIstDateKey(o.created_at) === sessionKey),
      sessionDateLabel: sessionKey,
    };
  }, [allFilledOrders]);

  // Live tick subscription for open-position symbols. Without this, the
  // "Today's P&L" tile is stuck at the price of the last fill — the
  // backend's `last_price` column is only written by OMS when a trade
  // executes. Mirrors the Positions page approach so the two screens
  // stay in agreement on unrealized P&L.
  const openPositionSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          positions
            .filter((p: any) => (p.qty ?? 0) !== 0)
            .map((p: any) => p.internal_symbol)
            .filter(Boolean),
        ),
      ).sort(),
    [positions],
  );
  const livePrices = useLivePrices(openPositionSymbols);

  // Snapshot fallback — fills in LTP when the broker WS hasn't started
  // streaming a symbol yet (e.g. broker just logged in, or the symbol
  // isn't claimed by any strategy). Without this the dashboard P&L
  // tile and RMS depend purely on live ticks, which can lag for a
  // minute or two after broker auth.
  const snapshotPositionsPoll = useMarketPollInterval(10_000, "ANY");
  const positionSnapshotKey = openPositionSymbols.length
    ? `/market/snapshot?symbols=${encodeURIComponent(openPositionSymbols.join(","))}`
    : null;
  const { data: positionSnapshot } = useSWR<Record<string, { ltp: number | null }>>(
    positionSnapshotKey,
    fetcher,
    { refreshInterval: snapshotPositionsPoll, keepPreviousData: true, shouldRetryOnError: false },
  );

  // Map open positions only (qty != 0) to the design's expected shape.
  // LTP precedence: live tick > snapshot > stored last_price > avg_price.
  // The snapshot tier is critical for RMS — it ensures `pnl` is a real
  // number the moment positions appear, not 0 until WS ticks land.
  const openPositions = useMemo(
    () =>
      positions
        .filter((p: any) => (p.qty ?? 0) !== 0)
        .map((p: any) => {
          const qty = Number(p.qty ?? 0);
          const avg = Number(p.avg_price ?? 0);
          const live = livePrices[p.internal_symbol];
          const snap = positionSnapshot?.[p.internal_symbol]?.ltp;
          const ltp = Number(
            (typeof live === "number" && live > 0) ? live
            : (typeof snap === "number" && snap > 0) ? snap
            : (p.last_price != null && Number(p.last_price) > 0) ? p.last_price
            : avg,
          );
          const haveQuote = ltp > 0 && avg > 0;
          const mtm = haveQuote ? (ltp - avg) * qty : Number(p.unrealized_pnl ?? 0);
          return {
            id: p.id,
            symbol: p.trading_symbol ?? prettySymbol(p.internal_symbol),
            type: p.product ?? "—",
            side: qty >= 0 ? "LONG" : "SHORT",
            quantity: Math.abs(qty),
            avgPrice: avg,
            ltp,
            pnl: mtm,
            pnlPercent: haveQuote ? ((ltp - avg) / avg) * 100 * (qty >= 0 ? 1 : -1) : 0,
          };
        }),
    [positions, livePrices, positionSnapshot],
  );

  const recentTrades = useMemo(
    () =>
      filledOrders.map((o: any) => ({
        id: o.id,
        time: o.created_at ? new Date(o.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
        symbol: o.trading_symbol ?? prettySymbol(o.internal_symbol),
        side: o.side as "BUY" | "SELL",
        quantity: o.qty ?? 0,
        price: o.avg_price ?? o.price ?? 0,
        // P&L per trade isn't stored — would need a matched-fill engine.
        // Leave as 0 so the per-row column renders neutrally; the Total
        // row at the bottom will be 0 too.
        pnl: 0,
        strategy: o.strategy_run_id ? "Strategy" : "Manual",
      })),
    [filledOrders],
  );

  // Map our strategies → the design's expected shape. Resilient to
  // missing fields (`run_count`, `win_rate`, etc. may not be on the
  // base /strategies response yet).
  const mappedStrategies = useMemo(
    () =>
      strategies.map((s: any) => {
        // Trust the backend's `is_running` flag — it's resolved from
        // active StrategyRun rows, not the denormalised Strategy.status
        // mirror (which can drift if a stop crashed mid-flight).
        // Backend only resolves running/stopped today, but "starting" is a
        // valid transient state the UI renders, so keep the property typed as
        // the full union (a plain shorthand would narrow it to running|stopped).
        const status: "running" | "starting" | "stopped" = s.is_running
          ? "running"
          : "stopped";
        return {
          id: s.id,
          name: s.name ?? "—",
          type: s.strategy_type ?? s.type ?? s.kind ?? "—",
          status: status as "running" | "starting" | "stopped",
          pnl: s.total_pnl ?? 0,
          pnlPercent: s.pnl_pct ?? 0,
          winRate: s.win_rate ?? 0,
          trades: s.trade_count ?? 0,
          allocation: s.allocation ?? s.capital ?? 0,
        };
      }),
    [strategies],
  );

  // Equity curve — built from the analytics PnL daily series when the
  // backend returns one. When it's absent we render a "no data" panel
  // rather than fabricating a flat line.
  const equityCurveData = useMemo(() => {
    const daily: Array<{ d: string; pnl: number }> | undefined = pnlSummary?.daily;
    if (!daily || !Array.isArray(daily) || daily.length === 0) return null;
    let running = TOTAL_CAPITAL;
    return daily.map((row, i) => {
      running += row.pnl ?? 0;
      return { day: row.d ?? `D${i + 1}`, equity: Math.round(running) };
    });
  }, [pnlSummary]);

  // ---- Announcements ticker ----
  // Pulls NSE corporate announcements (5-min server-side cache). Each
  // row keeps a `detail_url` so the click-through can open the full
  // announcement on NSE — and a `file_url` for direct PDF access when
  // NSE attached one.
  const [liveNewsEvents, setLiveNewsEvents] = useState<
    Array<{ id: number; symbol: string; text: string; time: string; detail_url?: string; file_url?: string }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const announcements = await marketDataService.getNewsAnnouncements(30);
        if (cancelled) return;
        const formatted = announcements.map((a: any, idx: number) => {
          const timeStr = a.timestamp
            ? new Date(a.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
            : "";
          return {
            id: idx + 1,
            symbol: a.symbol ?? "",
            text: a.subject || a.description || a.type || "",
            time: timeStr,
            detail_url: a.detail_url,
            file_url: a.file_url,
          };
        });
        setLiveNewsEvents(formatted);
      } catch {
        /* swallow — the UI shows "Loading announcements..." */
      }
    };
    load();
    const id = setInterval(load, 180_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- Card dialogs ----
  const [activeCard, setActiveCard] = useState<CardType>(null);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<
    | { id: number; symbol: string; text: string; time: string; detail_url?: string; file_url?: string }
    | null
  >(null);
  const goTo = (path: string) => {
    setActiveCard(null);
    router.push(path);
  };

  // ---- Quick Order ----
  // Same shape and submission path as the Orders page's New-Order dialog —
  // POST /orders directly so the user can place from the dashboard
  // without navigating away. Broker accounts come from /brokers.
  const { data: brokerAccounts } = useSWR<any[]>("/brokers", fetcher);
  const activeBrokers = useMemo(
    () => (brokerAccounts ?? []).filter((b: any) => b.is_active !== false),
    [brokerAccounts],
  );

  const [orderForm, setOrderForm] = useState({
    broker_account_id: "",
    internal_symbol: "",
    qty: 1,
    order_type: "MARKET" as "MARKET" | "LIMIT" | "SL" | "SLM",
    product: "MIS" as "MIS" | "CNC" | "NRML",
    variety: "REGULAR" as "REGULAR" | "AMO" | "BRACKET" | "ICEBERG",
    price: "",
    trigger_price: "",
  });
  const [orderBusy, setOrderBusy] = useState(false);

  // Default to the first active broker as soon as the list resolves.
  useEffect(() => {
    if (!orderForm.broker_account_id && activeBrokers.length > 0) {
      setOrderForm((f) => ({ ...f, broker_account_id: activeBrokers[0].id }));
    }
  }, [activeBrokers, orderForm.broker_account_id]);

  async function placeQuickOrder(side: "BUY" | "SELL") {
    if (!orderForm.broker_account_id) {
      toast.error("pick a broker");
      return;
    }
    if (!orderForm.internal_symbol) {
      toast.error("pick a symbol");
      return;
    }
    setOrderBusy(true);
    try {
      const payload: any = {
        broker_account_id: orderForm.broker_account_id,
        internal_symbol:   orderForm.internal_symbol,
        side,
        qty:               Number(orderForm.qty),
        order_type:        orderForm.order_type,
        product:           orderForm.product,
        variety:           orderForm.variety,
      };
      if (orderForm.price) payload.price = Number(orderForm.price);
      if (orderForm.trigger_price) payload.trigger_price = Number(orderForm.trigger_price);
      await api.post("/orders", payload);
      toast.success(`${side} order submitted`);
      // Reset symbol-side details, keep broker / product so the trader
      // can fire another quick order in the same context.
      setOrderForm((f) => ({
        ...f,
        internal_symbol: "",
        qty: 1,
        price: "",
        trigger_price: "",
      }));
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "order failed");
    } finally {
      setOrderBusy(false);
    }
  }

  // ---- Derived totals (used by the snapshot cards and dialogs) ----
  const profitPositions = openPositions.filter((p) => p.pnl >= 0);
  const lossPositions = openPositions.filter((p) => p.pnl < 0);
  // Today's P&L follows the same 08:00 IST session rule as Today's
  // Trades — realised P&L is summed only from positions touched during
  // the current session, so the tile is consistent across the snapshot.
  // Unrealised stays live (current open positions reflect what's held
  // right now, regardless of which session label is in effect).
  const openMtm = openPositions.reduce((sum, p) => sum + p.pnl, 0);
  // Positions touched during the current session — used for both the
  // realised total and the "Closed Today" table in the P&L popup.
  const sessionPositions = useMemo(() => {
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const toIstDateKey = (iso?: string | null): string | null => {
      if (!iso) return null;
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return null;
      const ist = new Date(ms + IST_OFFSET_MS);
      return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
    };
    return positions.filter((p: any) => toIstDateKey(p.updated_at) === sessionDateLabel);
  }, [positions, sessionDateLabel]);
  const todayRealized = sessionPositions.reduce(
    (sum: number, p: any) => sum + Number(p.realized_pnl ?? 0),
    0,
  );
  const closedTodayPositions = useMemo(
    () =>
      sessionPositions
        .filter((p: any) => (p.qty ?? 0) === 0 && Number(p.realized_pnl ?? 0) !== 0)
        .map((p: any) => ({
          id: p.id,
          symbol: p.trading_symbol ?? prettySymbol(p.internal_symbol),
          type: p.product ?? "—",
          avgPrice: Number(p.avg_price ?? 0),
          realizedPnl: Number(p.realized_pnl ?? 0),
        })),
    [sessionPositions],
  );
  const todayPnl = openMtm + todayRealized;
  const totalInvested = openPositions.reduce((sum, p) => sum + p.avgPrice * p.quantity, 0) || 1;
  const runningStrategies = mappedStrategies.filter((s) => s.status === "running");
  const startingStrategies = mappedStrategies.filter((s) => s.status === "starting");
  const stoppedStrategies = mappedStrategies.filter((s) => s.status === "stopped");
  // Margin should reflect what's actually deployed *right now*, not the
  // capital allocation on every strategy the user ever drafted. Only
  // running strategies count toward the deployed/used totals.
  const capitalDeployed = runningStrategies.reduce((sum, s) => sum + (s.allocation ?? 0), 0);
  const marginUsed = Math.min(100, Math.round((capitalDeployed / TOTAL_CAPITAL) * 100));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Market Overview</h2>
        </div>
        {!indicesLoading && secondaryIndices.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMoreIndices(!showMoreIndices)}
            className="gap-1.5"
          >
            <BarChart3 className="w-4 h-4" />
            {showMoreIndices ? "Show Less" : `View All (${secondaryIndices.length})`}
          </Button>
        )}
      </div>

      {/* Index error banner */}
      {indicesError && (
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-4 text-center">
          <p className="text-sm text-loss">⚠️ Failed to fetch live market data: {indicesError}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Make sure the backend API and a broker feed are running.
          </p>
        </div>
      )}

      {/* Primary Indices */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {indicesLoading && primaryIndices.length === 0
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border/50 bg-card p-4 animate-pulse">
                <div className="h-4 bg-muted rounded w-20 mb-2" />
                <div className="h-6 bg-muted rounded w-32 mb-3" />
                <div className="h-12 bg-muted rounded" />
              </div>
            ))
          : primaryIndices.map((idx) => (
              <IndexCard
                key={idx.id}
                index={idx}
                onClick={() => {
                  setSelectedIndex(idx);
                  setHeatmapOpen(true);
                }}
              />
            ))}
      </div>

      {/* Secondary Indices (toggle) */}
      {showMoreIndices && secondaryIndices.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {secondaryIndices.map((idx) => (
            <IndexCard
              key={idx.id}
              index={idx}
              onClick={() => {
                setSelectedIndex(idx);
                setHeatmapOpen(true);
              }}
            />
          ))}
        </div>
      )}

      <StockHeatmap index={selectedIndex} open={heatmapOpen} onClose={() => setHeatmapOpen(false)} />

      {/* Market Sentiment */}
      <MarketSentimentWidget onCardClick={(c) => setActiveCard(c as CardType)} />

      {/* Portfolio Snapshot */}
      <div>
        <h2 className="text-xl font-bold mb-3">Portfolio Snapshot</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Today's Trades */}
          <button
            type="button"
            onClick={() => setActiveCard("positions")}
            className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
          >
            <p className="text-xs text-muted-foreground mb-1">
              Today&apos;s Trades
              {(() => {
                const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
                const nowIst = new Date(Date.now() + IST_OFFSET_MS);
                const todayKey = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowIst.getUTCDate()).padStart(2, "0")}`;
                return sessionDateLabel && sessionDateLabel !== todayKey ? (
                  <span className="ml-1 text-[10px] opacity-60">({sessionDateLabel})</span>
                ) : null;
              })()}
            </p>
            <p className="font-mono text-2xl font-bold">{recentTrades.length}</p>
            <p className="text-xs font-mono mt-1">
              <span className="text-profit">{recentTrades.filter((t) => t.side === "BUY").length} Buy</span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-loss">{recentTrades.filter((t) => t.side === "SELL").length} Sell</span>
            </p>
          </button>

          {/* Today's P&L */}
          <button
            type="button"
            onClick={() => setActiveCard("pnl")}
            className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
          >
            <p className="text-xs text-muted-foreground mb-1">Today&apos;s P&amp;L</p>
            <p className={cn("font-mono text-2xl font-bold", todayPnl >= 0 ? "text-profit" : "text-loss")}>
              {todayPnl >= 0 ? "+" : ""}${Math.round(todayPnl).toLocaleString("en-US")}
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-1">
              {openPositions.length} positions
              {openPositions.length > 0 && (
                <>
                  {" · "}
                  {todayPnl >= 0 ? "+" : ""}
                  {((todayPnl / totalInvested) * 100).toFixed(2)}%
                </>
              )}
              {openPositions.length === 0 && todayRealized !== 0 && " · realized"}
            </p>
          </button>

          {/* Strategies Running */}
          <button
            type="button"
            onClick={() => setActiveCard("strategies")}
            className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
          >
            <p className="text-xs text-muted-foreground mb-1">Strategies Running</p>
            <div className="flex items-center gap-2">
              <p className="font-mono text-2xl font-bold">{runningStrategies.length}</p>
              <span className="w-2 h-2 rounded-full bg-profit animate-pulse-glow" />
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-1">
              {startingStrategies.length} Starting · {stoppedStrategies.length} Stopped
            </p>
          </button>

          {/* Capital Deployed */}
          <button
            type="button"
            onClick={() => setActiveCard("capital")}
            className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
          >
            <p className="text-xs text-muted-foreground mb-1">Capital Deployed</p>
            <p className="font-mono text-2xl font-bold">${capitalDeployed.toLocaleString("en-US")}</p>
            <p className="text-xs text-muted-foreground font-mono mt-1">Margin Used: {marginUsed}%</p>
          </button>
        </div>
      </div>

      {/* Quick Order + Announcements */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-bold mb-3">Quick Order</h2>
          <div className="rounded-lg border border-border/50 bg-card p-5 space-y-3">
            {/* Broker — required, defaulted to the first active account. */}
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Broker</label>
              <Select
                value={orderForm.broker_account_id}
                onValueChange={(v) => setOrderForm({ ...orderForm, broker_account_id: v })}
              >
                <SelectTrigger className="font-mono text-sm h-9">
                  <SelectValue placeholder="Select broker" />
                </SelectTrigger>
                <SelectContent>
                  {activeBrokers.length === 0 ? (
                    <SelectItem value="__none">
                      No active brokers — add one in Brokers
                    </SelectItem>
                  ) : (
                    activeBrokers.map((b: any) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.broker} · {b.client_id}{b.is_paper ? " (paper)" : ""}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Cascading symbol picker — same component as Orders page. */}
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Symbol</label>
              <ExchangeSymbolPicker
                value={orderForm.internal_symbol}
                onChange={(v) => setOrderForm({ ...orderForm, internal_symbol: v })}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Qty</label>
                <Input
                  type="number"
                  min={1}
                  value={orderForm.qty}
                  onChange={(e) => setOrderForm({ ...orderForm, qty: Number(e.target.value) })}
                  className="font-mono text-sm h-9"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Order type</label>
                <Select
                  value={orderForm.order_type}
                  onValueChange={(v) => setOrderForm({ ...orderForm, order_type: v as any })}
                >
                  <SelectTrigger className="font-mono text-sm h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MARKET">MARKET</SelectItem>
                    <SelectItem value="LIMIT">LIMIT</SelectItem>
                    <SelectItem value="SL">SL</SelectItem>
                    <SelectItem value="SLM">SL-M</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Product</label>
                <Select
                  value={orderForm.product}
                  onValueChange={(v) => setOrderForm({ ...orderForm, product: v as any })}
                >
                  <SelectTrigger className="font-mono text-sm h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MIS">MIS</SelectItem>
                    <SelectItem value="CNC">CNC</SelectItem>
                    <SelectItem value="NRML">NRML</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Variety</label>
                <Select
                  value={orderForm.variety}
                  onValueChange={(v) => setOrderForm({ ...orderForm, variety: v as any })}
                >
                  <SelectTrigger className="font-mono text-sm h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="REGULAR">REGULAR</SelectItem>
                    <SelectItem value="AMO">AMO</SelectItem>
                    <SelectItem value="BRACKET">BRACKET</SelectItem>
                    <SelectItem value="ICEBERG">ICEBERG</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {orderForm.order_type !== "MARKET" && (
              <div className="grid grid-cols-2 gap-2">
                {(orderForm.order_type === "LIMIT" || orderForm.order_type === "SL") && (
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Price (LIMIT)</label>
                    <Input
                      type="number"
                      placeholder="—"
                      value={orderForm.price}
                      onChange={(e) => setOrderForm({ ...orderForm, price: e.target.value })}
                      className="font-mono text-sm h-9"
                    />
                  </div>
                )}
                {(orderForm.order_type === "SL" || orderForm.order_type === "SLM") && (
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Trigger</label>
                    <Input
                      type="number"
                      placeholder="—"
                      value={orderForm.trigger_price}
                      onChange={(e) => setOrderForm({ ...orderForm, trigger_price: e.target.value })}
                      className="font-mono text-sm h-9"
                    />
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                onClick={() => placeQuickOrder("BUY")}
                disabled={orderBusy}
                className="bg-profit hover:bg-profit/80 text-background font-mono text-sm h-9 font-bold"
              >
                {orderBusy ? "Sending…" : "BUY"}
              </Button>
              <Button
                onClick={() => placeQuickOrder("SELL")}
                disabled={orderBusy}
                className="bg-loss hover:bg-loss/80 text-background font-mono text-sm h-9 font-bold"
              >
                {orderBusy ? "Sending…" : "SELL"}
              </Button>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold">Announcements</h2>
            <Button
              variant="ghost"
              size="sm"
              className="font-mono text-xs gap-1.5"
              onClick={() => router.push("/market-news")}
            >
              View all <ExternalLink className="w-3 h-3" />
            </Button>
          </div>
          <div className="rounded-lg border border-border/50 bg-card overflow-hidden h-[220px] relative">
            <div className="animate-ticker-vertical hover:[animation-play-state:paused] absolute w-full">
              {liveNewsEvents.length === 0 ? (
                <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm">
                  Loading announcements...
                </div>
              ) : (
                [...liveNewsEvents, ...liveNewsEvents].map((news, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedAnnouncement(news)}
                    className="w-full text-left flex items-start gap-3 px-4 py-3 border-b border-border/20 cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap mt-0.5">
                      {news.time}
                    </span>
                    {news.symbol && (
                      <span className="text-[10px] font-mono font-bold text-primary whitespace-nowrap mt-0.5">
                        {news.symbol}
                      </span>
                    )}
                    <span className="text-xs leading-relaxed line-clamp-2">{news.text}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== POPUP DIALOGS ===== */}

      {/* Today's Trades Dialog */}
      <Dialog open={activeCard === "positions"} onOpenChange={() => setActiveCard(null)}>
        <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-mono text-lg">Today&apos;s Trades ({recentTrades.length})</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto mt-4">
            <table className="w-full text-sm font-mono">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase tracking-wider">
                  <th className="text-left py-3 px-4">Time</th>
                  <th className="text-left py-3 px-4">Symbol</th>
                  <th className="text-left py-3 px-4">Side</th>
                  <th className="text-right py-3 px-4">Qty</th>
                  <th className="text-right py-3 px-4">Price</th>
                  <th className="text-left py-3 px-4">Strategy</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((t) => (
                  <tr key={t.id} className="border-b border-border/20 hover:bg-muted/30 transition-colors">
                    <td className="py-3.5 px-4 text-muted-foreground">{t.time}</td>
                    <td className="py-3.5 px-4 font-semibold">{t.symbol}</td>
                    <td className={cn("py-3.5 px-4 font-medium", t.side === "BUY" ? "text-profit" : "text-loss")}>
                      {t.side}
                    </td>
                    <td className="py-3.5 px-4 text-right">{t.quantity}</td>
                    <td className="py-3.5 px-4 text-right">${fmtUSD(t.price)}</td>
                    <td className="py-3.5 px-4 text-muted-foreground">{t.strategy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
            <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => goTo("/orders")}>
              View All Orders <ExternalLink className="w-3 h-3" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Today's P&L Dialog */}
      <Dialog open={activeCard === "pnl"} onOpenChange={() => setActiveCard(null)}>
        <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-mono text-lg flex items-center gap-2">
              Today&apos;s P&amp;L
              {(() => {
                const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
                const nowIst = new Date(Date.now() + IST_OFFSET_MS);
                const todayKey = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowIst.getUTCDate()).padStart(2, "0")}`;
                return sessionDateLabel && sessionDateLabel !== todayKey ? (
                  <span className="text-xs font-normal text-muted-foreground">({sessionDateLabel})</span>
                ) : null;
              })()}
            </DialogTitle>
          </DialogHeader>

          {/* Breakdown tiles — always render so the popup is meaningful
              even when there are no rows. */}
          <div className="grid grid-cols-3 gap-3 mt-4 shrink-0">
            <div className="rounded-lg border border-border/50 bg-card p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Unrealised</p>
              <p className={cn("font-mono text-lg font-bold mt-1", openMtm >= 0 ? "text-profit" : "text-loss")}>
                {openMtm >= 0 ? "+" : ""}${Math.round(openMtm).toLocaleString("en-US")}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                {openPositions.length} open
              </p>
            </div>
            <div className="rounded-lg border border-border/50 bg-card p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Realised</p>
              <p className={cn("font-mono text-lg font-bold mt-1", todayRealized >= 0 ? "text-profit" : "text-loss")}>
                {todayRealized >= 0 ? "+" : ""}${Math.round(todayRealized).toLocaleString("en-US")}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                {closedTodayPositions.length} closed
              </p>
            </div>
            <div className="rounded-lg border border-border/50 bg-card p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Net</p>
              <p className={cn("font-mono text-lg font-bold mt-1", todayPnl >= 0 ? "text-profit" : "text-loss")}>
                {todayPnl >= 0 ? "+" : ""}${Math.round(todayPnl).toLocaleString("en-US")}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                {recentTrades.length} fills
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-auto mt-4 space-y-6">
            {/* Open positions section */}
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-mono mb-2">
                Open Positions ({openPositions.length})
              </p>
              {openPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/40 py-8 text-center text-sm text-muted-foreground">
                  No open positions right now.
                </div>
              ) : (
                <table className="w-full text-sm font-mono">
                  <thead className="sticky top-0 bg-background z-10">
                    <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="text-left py-3 px-4">Symbol</th>
                      <th className="text-left py-3 px-4">Type</th>
                      <th className="text-left py-3 px-4">Side</th>
                      <th className="text-right py-3 px-4">Qty</th>
                      <th className="text-right py-3 px-4">Avg Price</th>
                      <th className="text-right py-3 px-4">LTP</th>
                      <th className="text-right py-3 px-4">P&amp;L</th>
                      <th className="text-right py-3 px-4">P&amp;L %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map((p) => (
                      <tr key={p.id} className="border-b border-border/20 hover:bg-muted/30 transition-colors">
                        <td className="py-3.5 px-4 font-semibold">{p.symbol}</td>
                        <td className="py-3.5 px-4 text-muted-foreground">{p.type}</td>
                        <td className={cn("py-3.5 px-4 font-medium", p.side === "LONG" ? "text-profit" : "text-loss")}>
                          {p.side}
                        </td>
                        <td className="py-3.5 px-4 text-right">{p.quantity}</td>
                        <td className="py-3.5 px-4 text-right">${fmtUSD(p.avgPrice)}</td>
                        <td className="py-3.5 px-4 text-right">${fmtUSD(p.ltp)}</td>
                        <td className={cn("py-3.5 px-4 text-right font-semibold", p.pnl >= 0 ? "text-profit" : "text-loss")}>
                          {p.pnl >= 0 ? "+" : ""}${Math.round(p.pnl).toLocaleString("en-US")}
                        </td>
                        <td className={cn("py-3.5 px-4 text-right", p.pnl >= 0 ? "text-profit" : "text-loss")}>
                          {p.pnl >= 0 ? "+" : ""}
                          {p.pnlPercent.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Closed-in-this-session section */}
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-mono mb-2">
                Closed in this Session ({closedTodayPositions.length})
              </p>
              {closedTodayPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/40 py-6 text-center text-sm text-muted-foreground">
                  No positions were closed in this session.
                </div>
              ) : (
                <table className="w-full text-sm font-mono">
                  <thead className="sticky top-0 bg-background z-10">
                    <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="text-left py-3 px-4">Symbol</th>
                      <th className="text-left py-3 px-4">Type</th>
                      <th className="text-right py-3 px-4">Avg Price</th>
                      <th className="text-right py-3 px-4">Realised P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedTodayPositions.map((p) => (
                      <tr key={p.id} className="border-b border-border/20 hover:bg-muted/30 transition-colors">
                        <td className="py-3.5 px-4 font-semibold">{p.symbol}</td>
                        <td className="py-3.5 px-4 text-muted-foreground">{p.type}</td>
                        <td className="py-3.5 px-4 text-right">${fmtUSD(p.avgPrice)}</td>
                        <td className={cn("py-3.5 px-4 text-right font-semibold", p.realizedPnl >= 0 ? "text-profit" : "text-loss")}>
                          {p.realizedPnl >= 0 ? "+" : ""}${Math.round(p.realizedPnl).toLocaleString("en-US")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
            <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => goTo("/positions")}>
              View All Positions <ExternalLink className="w-3 h-3" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Strategies Dialog */}
      <Dialog open={activeCard === "strategies"} onOpenChange={() => setActiveCard(null)}>
        <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-mono text-lg">All Strategies</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto mt-4">
            <table className="w-full text-sm font-mono">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase tracking-wider">
                  <th className="text-left py-3 px-4">Status</th>
                  <th className="text-left py-3 px-4">Strategy</th>
                  <th className="text-left py-3 px-4">Type</th>
                  <th className="text-right py-3 px-4">P&amp;L</th>
                  <th className="text-right py-3 px-4">P&amp;L %</th>
                  <th className="text-right py-3 px-4">Win Rate</th>
                  <th className="text-right py-3 px-4">Trades</th>
                  <th className="text-right py-3 px-4">Allocation</th>
                </tr>
              </thead>
              <tbody>
                {mappedStrategies.map((s) => (
                  <tr key={s.id} className="border-b border-border/20 hover:bg-muted/30 transition-colors">
                    <td className="py-3.5 px-4">
                      <span
                        className={cn(
                          "text-xs font-mono px-2 py-1 rounded",
                          s.status === "running" && "bg-profit/20 text-profit",
                          s.status === "starting" && "bg-warning/20 text-warning",
                          s.status === "stopped" && "bg-loss/20 text-loss",
                        )}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-semibold">{s.name}</td>
                    <td className="py-3.5 px-4 text-muted-foreground">{s.type}</td>
                    <td className={cn("py-3.5 px-4 text-right font-semibold", s.pnl >= 0 ? "text-profit" : "text-loss")}>
                      {s.pnl >= 0 ? "+" : ""}${Math.round(s.pnl).toLocaleString("en-US")}
                    </td>
                    <td className={cn("py-3.5 px-4 text-right", s.pnl >= 0 ? "text-profit" : "text-loss")}>
                      {s.pnlPercent >= 0 ? "+" : ""}
                      {s.pnlPercent}%
                    </td>
                    <td className="py-3.5 px-4 text-right">{s.winRate}%</td>
                    <td className="py-3.5 px-4 text-right">{s.trades}</td>
                    <td className="py-3.5 px-4 text-right">${s.allocation.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-xs gap-1.5"
              onClick={() => goTo("/strategies")}
            >
              View All Strategies <ExternalLink className="w-3 h-3" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Capital Deployed Dialog */}
      <Dialog open={activeCard === "capital"} onOpenChange={() => setActiveCard(null)}>
        <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-mono text-lg">Capital Overview</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto mt-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Total Capital</p>
                <p className="font-mono text-2xl font-bold">${TOTAL_CAPITAL.toLocaleString("en-US")}</p>
              </div>
              <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Deployed</p>
                <p className="font-mono text-2xl font-bold">${capitalDeployed.toLocaleString("en-US")}</p>
              </div>
              <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Available</p>
                <p className="font-mono text-2xl font-bold">
                  ${(TOTAL_CAPITAL - capitalDeployed).toLocaleString("en-US")}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-medium">Margin Utilization</span>
                <span className="font-mono text-sm font-bold">{marginUsed}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-3">
                <div className="bg-primary h-3 rounded-full transition-all" style={{ width: `${marginUsed}%` }} />
              </div>
            </div>

            <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-primary" />
                <h4 className="text-sm font-semibold">Equity Curve (30 Days)</h4>
              </div>
              {equityCurveData ? (
                <>
                  <div className="h-[200px]">
                    <EquityCurveChart variant="equity" data={equityCurveData} />
                  </div>
                  <div className="flex items-center gap-6 mt-3 text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-0.5 bg-primary rounded" />
                      <span className="text-muted-foreground">Portfolio</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground font-mono">
                  No daily P&amp;L series yet — equity curve will populate after the first day of trading data.
                </div>
              )}
            </div>

            <div>
              <h4 className="text-sm font-semibold mb-3 uppercase tracking-wider text-muted-foreground">
                Per Strategy Allocation
              </h4>
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left py-3 px-4">Strategy</th>
                    <th className="text-left py-3 px-4">Type</th>
                    <th className="text-left py-3 px-4">Status</th>
                    <th className="text-right py-3 px-4">Allocation</th>
                    <th className="text-right py-3 px-4">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {mappedStrategies.map((s) => (
                    <tr key={s.id} className="border-b border-border/20 hover:bg-muted/30 transition-colors">
                      <td className="py-3.5 px-4 font-semibold">{s.name}</td>
                      <td className="py-3.5 px-4 text-muted-foreground">{s.type}</td>
                      <td className="py-3.5 px-4">
                        <span
                          className={cn(
                            "text-xs font-mono px-2 py-1 rounded",
                            s.status === "running" && "bg-profit/20 text-profit",
                            s.status === "starting" && "bg-warning/20 text-warning",
                            s.status === "stopped" && "bg-loss/20 text-loss",
                          )}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right">${s.allocation.toLocaleString("en-US")}</td>
                      <td className="py-3.5 px-4 text-right">
                        {((s.allocation / TOTAL_CAPITAL) * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border/50 font-bold">
                    <td colSpan={3} className="py-3.5 px-4">
                      Total
                    </td>
                    <td className="py-3.5 px-4 text-right">${capitalDeployed.toLocaleString("en-US")}</td>
                    <td className="py-3.5 px-4 text-right">{((capitalDeployed / TOTAL_CAPITAL) * 100).toFixed(1)}%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* India VIX Dialog */}
      <SentimentVixDialog open={activeCard === "vix"} onClose={() => setActiveCard(null)} />

      {/* PCR Dialog */}
      <SentimentPcrDialog open={activeCard === "pcr"} onClose={() => setActiveCard(null)} onOpen={goTo} />

      {/* FII/DII Dialog */}
      <SentimentFiiDiiDialog open={activeCard === "fiidii"} onClose={() => setActiveCard(null)} onOpen={goTo} />

      {/* Adv/Decline Dialog */}
      <SentimentAdvDecDialog
        open={activeCard === "advdec"}
        onClose={() => setActiveCard(null)}
        onOpen={goTo}
      />

      {/* Announcement detail */}
      <Dialog
        open={selectedAnnouncement !== null}
        onOpenChange={(o) => !o && setSelectedAnnouncement(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-lg flex items-center gap-2">
              {selectedAnnouncement?.symbol && (
                <span className="px-2 py-0.5 rounded text-xs bg-primary/15 text-primary">
                  {selectedAnnouncement.symbol}
                </span>
              )}
              <span>Corporate Announcement</span>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Time</p>
              <p className="font-mono text-sm">{selectedAnnouncement?.time || "—"}</p>
            </div>
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Subject</p>
              <p className="text-sm leading-relaxed mt-1">{selectedAnnouncement?.text || "—"}</p>
            </div>
            <div className="flex gap-2 pt-2 border-t border-border/40">
              {selectedAnnouncement?.file_url && (
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs gap-1.5"
                  onClick={() => window.open(selectedAnnouncement.file_url, "_blank", "noopener,noreferrer")}
                >
                  Open attachment <ExternalLink className="w-3 h-3" />
                </Button>
              )}
              {selectedAnnouncement?.detail_url && (
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs gap-1.5"
                  onClick={() => window.open(selectedAnnouncement.detail_url, "_blank", "noopener,noreferrer")}
                >
                  Open on NSE <ExternalLink className="w-3 h-3" />
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs gap-1.5 ml-auto"
                onClick={() => {
                  setSelectedAnnouncement(null);
                  router.push("/market-news");
                }}
              >
                Open Market News <ExternalLink className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------
// Sentiment deep-dive dialogs. Kept in this file because they are tightly
// coupled to the dashboard's CardType state machine; promote to /components
// if reused elsewhere.
// ---------------------------------------------------------------------

function SentimentVixDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useSWR(open ? "/sentiment" : null, () => marketDataService.getMarketSentiment());
  const vix = data?.indiaVix;
  const history = data?.vixHistory ?? [];

  // Chart-ready, chronological (oldest → newest). The bhavcopy-fed
  // vixHistory already arrives chronologically from the backend; we
  // just project the fields Recharts needs.
  const chartData = history
    .map((row) => ({ d: row.d, close: row.v ?? null }))
    .filter((r) => r.close != null);

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle className="font-mono text-lg">India VIX — Volatility Index</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            {(vix
              ? [
                  { label: "Current", value: vix.value.toFixed(2), trend: "neutral" as const },
                  { label: "Day High", value: (vix.value + Math.abs(vix.change)).toFixed(2), trend: "neutral" as const },
                  { label: "Day Low", value: (vix.value - Math.abs(vix.change) * 0.5).toFixed(2), trend: "neutral" as const },
                  {
                    label: "Change",
                    value: `${vix.change > 0 ? "+" : ""}${vix.change.toFixed(2)} (${vix.changePercent > 0 ? "+" : ""}${vix.changePercent.toFixed(2)}%)`,
                    trend: (vix.change < 0 ? "profit" : "loss") as "profit" | "loss",
                  },
                ]
              : [
                  { label: "Current", value: "Loading...", trend: "neutral" as const },
                  { label: "Day High", value: "--", trend: "neutral" as const },
                  { label: "Day Low", value: "--", trend: "neutral" as const },
                  { label: "Change", value: "--", trend: "neutral" as const },
                ]
            ).map((item, i) => (
              <div key={i} className="rounded-lg border border-border/30 bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{item.label}</p>
                <p
                  className={cn(
                    "font-mono text-xl font-bold mt-1",
                    item.trend === "profit" && "text-profit",
                    item.trend === "loss" && "text-loss",
                  )}
                >
                  {item.value}
                </p>
              </div>
            ))}
          </div>

          {/* 30-day VIX chart — sourced from the bhavcopy via /eod/candles/NSE_INDIAVIX_IDX. */}
          <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold">India VIX — Last 30 Sessions</h4>
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                source: bhavcopy
              </span>
            </div>
            {chartData.length > 0 ? (
              <div className="h-[260px]">
                <EquityCurveChart variant="vix" data={chartData as any} />
              </div>
            ) : (
              <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground font-mono">
                Loading 30-day VIX data...
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border/30 bg-muted/30 p-4 space-y-3">
            <h4 className="text-sm font-semibold">VIX Interpretation</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded bg-profit/10 border border-profit/20">
                <p className="text-xs font-mono font-bold text-profit">0 - 15: Low Volatility</p>
                <p className="text-xs text-muted-foreground mt-1">Market is calm, bullish sentiment. Good for selling options.</p>
              </div>
              <div className="p-3 rounded bg-warning/10 border border-warning/20">
                <p className="text-xs font-mono font-bold text-warning">15 - 25: Moderate</p>
                <p className="text-xs text-muted-foreground mt-1">Caution advised. Mixed signals, hedging recommended.</p>
              </div>
              <div className="p-3 rounded bg-loss/10 border border-loss/20">
                <p className="text-xs font-mono font-bold text-loss">25+: High Volatility</p>
                <p className="text-xs text-muted-foreground mt-1">Fear in the market. Options premiums are high.</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
            <h4 className="text-sm font-semibold mb-2">Historical VIX (Last 10 Sessions)</h4>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground uppercase tracking-wider text-[10px]">
                  <th className="text-left py-2 px-3">Date</th>
                  <th className="text-right py-2 px-3">Open</th>
                  <th className="text-right py-2 px-3">High</th>
                  <th className="text-right py-2 px-3">Low</th>
                  <th className="text-right py-2 px-3">Close</th>
                  <th className="text-right py-2 px-3">Change %</th>
                </tr>
              </thead>
              <tbody>
                {history.length > 0 ? (
                  [...history]
                    .sort((a, b) => new Date(b.d).getTime() - new Date(a.d).getTime())
                    .slice(0, 10)
                    .map((item, i) => {
                      const change = item.change ?? 0;
                      return (
                        <tr key={i} className="border-b border-border/20">
                          <td className="py-2 px-3">{item.d}</td>
                          <td className="py-2 px-3 text-right">{item.o?.toFixed(2) ?? "--"}</td>
                          <td className="py-2 px-3 text-right">{item.h?.toFixed(2) ?? "--"}</td>
                          <td className="py-2 px-3 text-right">{item.l?.toFixed(2) ?? "--"}</td>
                          <td className="py-2 px-3 text-right">{item.v?.toFixed(2) ?? "--"}</td>
                          <td className={cn("py-2 px-3 text-right", change >= 0 ? "text-loss" : "text-profit")}>
                            {change >= 0 ? "+" : ""}
                            {change.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })
                ) : (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      Loading historical data...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SentimentPcrDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (p: string) => void;
}) {
  // Live PCR + interpretation guide. Strike-wise OI table is left
  // intentionally as a randomised demo until /eod/oi-by-strike is wired
  // through to a NIFTY-specific query here.
  const { data } = useSWR(open ? "/sentiment" : null, () => marketDataService.getMarketSentiment());
  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle className="font-mono text-lg">Put-Call Ratio Analysis</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">NIFTY PCR</p>
              <p className="font-mono text-xl font-bold mt-1">{data?.pcr?.value?.toFixed(2) ?? "—"}</p>
              <p
                className={cn(
                  "text-xs font-mono mt-1",
                  data?.pcr?.trend === "Bullish" && "text-profit",
                  data?.pcr?.trend === "Bearish" && "text-loss",
                  data?.pcr?.trend === "Neutral" && "text-warning",
                  !data?.pcr && "text-muted-foreground",
                )}
              >
                {data?.pcr?.trend ?? "—"}
              </p>
            </div>
            <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">BANKNIFTY PCR</p>
              <p className="font-mono text-xl font-bold mt-1 text-muted-foreground">—</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Needs a NIFTYBANK option-chain feed; not wired yet.
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/30 p-4 space-y-3">
            <h4 className="text-sm font-semibold">PCR Interpretation</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded bg-profit/10 border border-profit/20">
                <p className="text-xs font-mono font-bold text-profit">&gt; 1.0: Bullish</p>
                <p className="text-xs text-muted-foreground mt-1">More puts being written. Market makers expect upside.</p>
              </div>
              <div className="p-3 rounded bg-warning/10 border border-warning/20">
                <p className="text-xs font-mono font-bold text-warning">0.8 - 1.0: Neutral</p>
                <p className="text-xs text-muted-foreground mt-1">Balanced sentiment. No clear directional bias.</p>
              </div>
              <div className="p-3 rounded bg-loss/10 border border-loss/20">
                <p className="text-xs font-mono font-bold text-loss">&lt; 0.8: Bearish</p>
                <p className="text-xs text-muted-foreground mt-1">Heavy call writing. Market expects downside.</p>
              </div>
            </div>
          </div>
        </div>
        <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => onOpen("/option-chain")}>
            Open Option Chain <ExternalLink className="w-3 h-3" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SentimentFiiDiiDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (p: string) => void;
}) {
  // 30-day window — wide enough for the line chart, narrow enough that
  // the request stays cheap on the daily-flow table.
  const fromDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, []);
  const toDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const { data: history } = useSWR(
    open ? `/institutional/cash-flow/daily?from=${fromDate}&to=${toDate}` : null,
    fetcher,
  );
  const { data: summary } = useSWR(open ? "/institutional/cash-flow/summary" : null, fetcher);
  const daily: any[] = summary?.daily ?? [];
  const fii = daily.find((d: any) => d.category === "FII");
  const dii = daily.find((d: any) => d.category === "DII");

  // Group history by date → { date: {FII:{}, DII:{}} }
  const byDate: Record<string, any> = {};
  (history ?? []).forEach((r: any) => {
    (byDate[r.trade_date] ||= {})[r.category] = r;
  });
  // Chronological for the chart; reversed (latest first) for the table.
  const datesAsc = Object.keys(byDate).sort();
  const dates = [...datesAsc].reverse().slice(0, 30);
  const chartData = datesAsc.map((d) => {
    const r = byDate[d] || {};
    const f = r.FII?.net_value ?? 0;
    const i = r.DII?.net_value ?? 0;
    return { d, fii: Math.round(f), dii: Math.round(i), net: Math.round(f + i) };
  });

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle className="font-mono text-lg">FII / DII Activity</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "FII Cash", value: fii ? `${fii.net_value >= 0 ? "+" : ""}$${Math.round(fii.net_value)} Cr` : "—", trend: fii && fii.net_value >= 0 ? "profit" : "loss" },
              { label: "DII Cash", value: dii ? `${dii.net_value >= 0 ? "+" : ""}$${Math.round(dii.net_value)} Cr` : "—", trend: dii && dii.net_value >= 0 ? "profit" : "loss" },
              { label: "FII F&O", value: "—", trend: "neutral" },
              { label: "FII Index Fut", value: "—", trend: "neutral" },
            ].map((item, i) => (
              <div key={i} className="rounded-lg border border-border/30 bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{item.label}</p>
                <p
                  className={cn(
                    "font-mono text-xl font-bold mt-1",
                    item.trend === "profit" && "text-profit",
                    item.trend === "loss" && "text-loss",
                  )}
                >
                  {item.value}
                </p>
              </div>
            ))}
          </div>
          {/* 30-day FII / DII / Net line chart */}
          <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold">FII vs DII vs Net — Last 30 Sessions ($ Cr)</h4>
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                source: nse cash market
              </span>
            </div>
            {chartData.length > 0 ? (
              <>
                <div className="h-[260px]">
                  <EquityCurveChart variant="fii_dii" data={chartData as any} />
                </div>
                <div className="flex flex-wrap items-center gap-4 mt-3 text-xs font-mono">
                  <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-loss inline-block rounded" />FII Net</span>
                  <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-profit inline-block rounded" />DII Net</span>
                  <span className="flex items-center gap-2"><span className="w-3 h-0.5 bg-primary inline-block rounded" />Combined Net</span>
                </div>
              </>
            ) : (
              <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground font-mono">
                Loading FII / DII history...
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
            <h4 className="text-sm font-semibold mb-2">Last 30 Days FII/DII Flow ($ Cr)</h4>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground uppercase tracking-wider text-[10px]">
                  <th className="text-left py-2 px-3">Date</th>
                  <th className="text-right py-2 px-3">FII Buy</th>
                  <th className="text-right py-2 px-3">FII Sell</th>
                  <th className="text-right py-2 px-3">FII Net</th>
                  <th className="text-right py-2 px-3">DII Buy</th>
                  <th className="text-right py-2 px-3">DII Sell</th>
                  <th className="text-right py-2 px-3">DII Net</th>
                </tr>
              </thead>
              <tbody>
                {dates.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-muted-foreground">
                      Loading...
                    </td>
                  </tr>
                ) : (
                  dates.map((d) => {
                    const row = byDate[d];
                    const f = row.FII;
                    const di = row.DII;
                    return (
                      <tr key={d} className="border-b border-border/20">
                        <td className="py-2 px-3">{d}</td>
                        <td className="py-2 px-3 text-right">{Math.round(f?.buy_value ?? 0).toLocaleString("en-US")}</td>
                        <td className="py-2 px-3 text-right">{Math.round(f?.sell_value ?? 0).toLocaleString("en-US")}</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", (f?.net_value ?? 0) >= 0 ? "text-profit" : "text-loss")}>
                          {(f?.net_value ?? 0) >= 0 ? "+" : ""}
                          {Math.round(f?.net_value ?? 0).toLocaleString("en-US")}
                        </td>
                        <td className="py-2 px-3 text-right">{Math.round(di?.buy_value ?? 0).toLocaleString("en-US")}</td>
                        <td className="py-2 px-3 text-right">{Math.round(di?.sell_value ?? 0).toLocaleString("en-US")}</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", (di?.net_value ?? 0) >= 0 ? "text-profit" : "text-loss")}>
                          {(di?.net_value ?? 0) >= 0 ? "+" : ""}
                          {Math.round(di?.net_value ?? 0).toLocaleString("en-US")}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => onOpen("/eod-analysis")}>
            View EOD Analysis <ExternalLink className="w-3 h-3" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SentimentAdvDecDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (p: string) => void;
}) {
  // Live breadth across the broad-market universe — uses Redis LTPs
  // first, falls back to latest EOD candle for symbols with no live
  // tick. Re-polls every 5s while the dialog is open AND the NSE/BSE
  // cash session is live; outside 09:15–15:30 IST the breadth count
  // is locked, so polling just burns cycles.
  const breadthLivePoll = useMarketPollInterval(5_000, "EQ_FO");
  const breadthSectorPoll = useMarketPollInterval(30_000, "EQ_FO");
  const { data: live } = useSWR(
    open ? "/eod/breadth/live" : null,
    () => marketDataService.getBreadthLive(),
    { refreshInterval: breadthLivePoll },
  );
  const { data: sectorRows } = useSWR(
    open ? "/eod/breadth/by-sector" : null,
    () => marketDataService.getBreadthBySector(),
    { refreshInterval: breadthSectorPoll },
  );

  const ad = live ?? { advances: 0, declines: 0, unchanged: 0, missing: 0, live_count: 0, eod_count: 0 };
  const total = Math.max(1, ad.advances + ad.declines + ad.unchanged);
  const liveTotal = (ad.live_count ?? 0) + (ad.eod_count ?? 0);
  const fallbackTone = ad.live_count > 0 ? "profit" : "warning";

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="font-mono text-lg">Market Breadth — Advance / Decline</DialogTitle>
            <span
              className={cn(
                "text-[10px] font-mono px-2 py-1 rounded uppercase tracking-wider",
                fallbackTone === "profit" ? "bg-profit/15 text-profit" : "bg-warning/15 text-warning",
              )}
            >
              {ad.live_count > 0
                ? `${ad.live_count} live · ${ad.eod_count} eod`
                : `${ad.eod_count} eod (no live ticks yet)`}
            </span>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-auto mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-profit/30 bg-profit/10 p-5 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Advancing</p>
              <p className="font-mono text-3xl font-bold text-profit mt-1">{ad.advances}</p>
            </div>
            <div className="rounded-lg border border-loss/30 bg-loss/10 p-5 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Declining</p>
              <p className="font-mono text-3xl font-bold text-loss mt-1">{ad.declines}</p>
            </div>
            <div className="rounded-lg border border-border/30 bg-muted/30 p-5 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Unchanged</p>
              <p className="font-mono text-3xl font-bold mt-1">{ad.unchanged}</p>
            </div>
          </div>
          <div className="rounded-lg border border-border/30 bg-muted/30 p-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold">Breadth Ratio</h4>
              <span className="text-[10px] font-mono text-muted-foreground">
                universe: {liveTotal} stocks
              </span>
            </div>
            <div className="w-full h-6 rounded-full overflow-hidden flex">
              <div
                className="bg-profit h-full flex items-center justify-center text-[10px] font-mono font-bold text-background"
                style={{ width: `${(ad.advances / total) * 100}%` }}
              >
                {((ad.advances / total) * 100).toFixed(1)}%
              </div>
              <div
                className="bg-loss h-full flex items-center justify-center text-[10px] font-mono font-bold text-background"
                style={{ width: `${(ad.declines / total) * 100}%` }}
              >
                {((ad.declines / total) * 100).toFixed(1)}%
              </div>
              <div className="bg-muted-foreground/30 h-full" />
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-2">
              A/D Ratio: {(ad.advances / Math.max(1, ad.declines)).toFixed(2)} —{" "}
              {ad.advances / Math.max(1, ad.declines) > 1.5
                ? " Strong Bullish Breadth"
                : ad.advances / Math.max(1, ad.declines) > 1
                ? " Mildly Bullish"
                : " Bearish Breadth"}
            </p>
          </div>

          {/* Sector-wise breakdown — sorted by absolute skew so the
              widest spreads surface first. */}
          <div className="rounded-lg border border-border/30 bg-muted/30 p-4">
            <h4 className="text-sm font-semibold mb-2">Sector-wise Advance / Decline</h4>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground uppercase tracking-wider text-[10px]">
                  <th className="text-left py-2 px-3">Sector</th>
                  <th className="text-right py-2 px-3">Stocks</th>
                  <th className="text-right py-2 px-3">Adv</th>
                  <th className="text-right py-2 px-3">Dec</th>
                  <th className="text-right py-2 px-3">Unch</th>
                  <th className="text-right py-2 px-3">Net</th>
                  <th className="text-right py-2 px-3">Bias</th>
                </tr>
              </thead>
              <tbody>
                {!sectorRows || sectorRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-muted-foreground">
                      Loading sector breakdown...
                    </td>
                  </tr>
                ) : (
                  sectorRows.map((row) => {
                    const net = row.advances - row.declines;
                    const denom = Math.max(1, row.advances + row.declines + row.unchanged);
                    const biasPct = (net / denom) * 100;
                    return (
                      <tr key={row.sector} className="border-b border-border/20 hover:bg-muted/40 transition-colors">
                        <td className="py-2 px-3 font-semibold">{row.sector}</td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{row.stock_count}</td>
                        <td className="py-2 px-3 text-right text-profit">{row.advances}</td>
                        <td className="py-2 px-3 text-right text-loss">{row.declines}</td>
                        <td className="py-2 px-3 text-right">{row.unchanged}</td>
                        <td className={cn("py-2 px-3 text-right font-semibold", net >= 0 ? "text-profit" : "text-loss")}>
                          {net >= 0 ? "+" : ""}{net}
                        </td>
                        <td className={cn("py-2 px-3 text-right", biasPct >= 0 ? "text-profit" : "text-loss")}>
                          {biasPct >= 0 ? "+" : ""}{biasPct.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex justify-end pt-4 shrink-0 border-t border-border/30">
          <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => onOpen("/eod-analysis")}>
            View EOD Analysis <ExternalLink className="w-3 h-3" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
