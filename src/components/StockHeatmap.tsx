"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Radio } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import IndexTechnicals from "@/components/IndexTechnicals";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMarketPollInterval } from "@/lib/marketHours";
import type { MarketIndex, SectorStockRow } from "@/lib/marketTypes";

interface Props {
  index: MarketIndex | null;
  open: boolean;
  onClose: () => void;
}

type FilterType = "all" | "-3" | "-2" | "-1" | "+1" | "+2" | "+3";

const filterLabels: Record<FilterType, string> = {
  "-3": "< -3%",
  "-2": "< -2%",
  "-1": "< -1%",
  all: "All",
  "+1": "> +1%",
  "+2": "> +2%",
  "+3": "> +3%",
};
const filterOrder: FilterType[] = ["-3", "-2", "-1", "all", "+1", "+2", "+3"];

/** 9-tier heat color matching the previous app exactly. Stocks with no
 * live data get a separate dark-gray tile so they're visually distinct
 * from a true neutral. */
const getHeatColor = (cp: number | null, hasData: boolean): string => {
  if (!hasData || cp == null) return "#1a1a1a";
  if (cp >= 3) return "#00c853";
  if (cp >= 2) return "#2e7d32";
  if (cp >= 1) return "#1b5e20";
  if (cp >= 0.3) return "#2d4a2d";
  if (cp > -0.3) return "#3a3a3a";
  if (cp > -1) return "#5a2a2a";
  if (cp > -2) return "#8b1a1a";
  if (cp > -3) return "#c62828";
  return "#ff1744";
};

interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  stock: SectorStockRow;
}

/** Recursive split treemap — same algorithm as the reference. When all
 * market_cap values are missing (our backend doesn't store cap yet) it
 * falls back to equal weights, which produces a uniform grid. Drop in
 * a real cap column later and tiles will automatically size by weight. */
function treemap(stocks: SectorStockRow[], x: number, y: number, w: number, h: number): TreemapRect[] {
  if (stocks.length === 0) return [];
  if (stocks.length === 1) return [{ x, y, w, h, stock: stocks[0] }];

  const totalCap = stocks.reduce((s, st) => s + (st.market_cap || 0), 0);
  const weightOf = (st: SectorStockRow) => (totalCap > 0 ? st.market_cap || 0 : 1);

  if (stocks.length === 2) {
    const total = weightOf(stocks[0]) + weightOf(stocks[1]);
    const r = weightOf(stocks[0]) / total;
    if (w >= h) {
      return [
        { x, y, w: w * r, h, stock: stocks[0] },
        { x: x + w * r, y, w: w * (1 - r), h, stock: stocks[1] },
      ];
    }
    return [
      { x, y, w, h: h * r, stock: stocks[0] },
      { x, y: y + h * r, w, h: h * (1 - r), stock: stocks[1] },
    ];
  }

  const sorted = totalCap > 0 ? [...stocks].sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0)) : [...stocks];
  const total = sorted.reduce((s, st) => s + weightOf(st), 0);

  let cumSum = 0;
  let splitIdx = 1;
  let bestDiff = Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    cumSum += weightOf(sorted[i]);
    const diff = Math.abs(cumSum / total - 0.5);
    if (diff < bestDiff) {
      bestDiff = diff;
      splitIdx = i + 1;
    }
  }

  const left = sorted.slice(0, splitIdx);
  const right = sorted.slice(splitIdx);
  const leftTotal = left.reduce((s, st) => s + weightOf(st), 0);
  const leftRatio = leftTotal / total;

  if (w >= h) {
    return [
      ...treemap(left, x, y, w * leftRatio, h),
      ...treemap(right, x + w * leftRatio, y, w * (1 - leftRatio), h),
    ];
  }
  return [
    ...treemap(left, x, y, w, h * leftRatio),
    ...treemap(right, x, y + h * leftRatio, w, h * (1 - leftRatio)),
  ];
}

export default function StockHeatmap({ index, open, onClose }: Props) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [activeTab, setActiveTab] = useState("heatmap");
  const { mutate } = useSWRConfig();

  // sector_key comes from the registry in marketDataService.ts. When an
  // index has no constituents (e.g. INDIA VIX, a pure volatility number),
  // the field is absent and the heatmap shows a clear empty state instead
  // of attempting a fetch.
  const sectorKey = index?.sector_key ?? null;
  const seededError = index && !sectorKey ? `No constituent list available for ${index.name}.` : null;
  const swrKey = open && sectorKey ? `/eod/sector-constituents/${encodeURIComponent(sectorKey)}` : null;

  // Poll every 10s while the dialog is open. Sector constituent rows
  // come from a list scan + per-symbol LTP join — heavier than the
  // dashboard's snapshot call, and the user is staring at one sector so
  // sub-10s updates aren't perceptible. The treemap re-layout itself is
  // expensive (recursive split across all stocks) which is why polling
  // any faster was the dominant cost when the dialog was open.
  //
  // `keepPreviousData` is deliberately OFF: it would otherwise keep the
  // last sector's tiles on screen when the user switches to a different
  // index, producing a "wrong sector flashing for 1-2 seconds" bug.
  // Heatmap reflects NSE/BSE cash sector breadth — silent outside
  // 09:15–15:30 IST Mon-Fri.
  const heatmapPoll = useMarketPollInterval(10000, "EQ_FO");
  const { data, error, isLoading } = useSWR<{ rows: SectorStockRow[] }>(
    swrKey,
    (url: string) => api.get(url).then((r) => r.data),
    { refreshInterval: heatmapPoll, revalidateOnFocus: false, keepPreviousData: false },
  );
  const rows = data?.rows ?? [];
  const fetchError = error ? (error as any)?.response?.data?.detail ?? (error as any).message : null;
  const displayError = seededError ?? fetchError;

  // Hard reset on close — wipe local UI state AND drop SWR's cache for
  // every sector-constituents entry so the next open is a fresh fetch
  // for whichever index the user clicks next.
  useEffect(() => {
    if (open) return;
    setFilter("all");
    setActiveTab("heatmap");
    // matcher form: invalidate every key that starts with the constituents path.
    mutate(
      (k) => typeof k === "string" && k.startsWith("/eod/sector-constituents/"),
      undefined,
      { revalidate: false },
    );
  }, [open, mutate]);

  const filtered = useMemo(() => {
    let s = [...rows];
    switch (filter) {
      case "-3": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) < -3); break;
      case "-2": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) < -2); break;
      case "-1": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) < -1); break;
      case "+1": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) > 1); break;
      case "+2": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) > 2); break;
      case "+3": s = s.filter((r) => (r.ltp ?? 0) > 0 && (r.change_pct ?? 0) > 3); break;
      default: break;
    }
    return s;
  }, [rows, filter]);

  const rects = useMemo(() => treemap(filtered, 0, 0, 100, 100), [filtered]);

  const advances = rows.filter((r) => (r.change_pct ?? 0) > 0).length;
  const declines = rows.filter((r) => (r.change_pct ?? 0) < 0).length;
  const unchanged = rows.length - advances - declines;
  const liveCount = rows.filter((r) => r.data_source === "live").length;
  const eodCount = rows.filter((r) => r.data_source === "eod").length;

  if (!index) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[92vw] max-w-[92vw] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-shrink-0 px-5 pt-4 pb-2 border-b border-border/50">
          <DialogHeader>
            <div className="flex items-center gap-3 pr-8">
              <DialogTitle className="font-mono text-base">{index.name}</DialogTitle>
              {index.value != null ? (
                <span className="text-sm font-mono">
                  ₹{index.value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}{" "}
                  {index.change != null && index.change_pct != null && (
                    <span className={index.change >= 0 ? "text-profit" : "text-loss"}>
                      {index.change >= 0 ? "+" : ""}{index.change.toFixed(2)} (
                      {index.change_pct >= 0 ? "+" : ""}{index.change_pct.toFixed(2)}%)
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm font-mono text-muted-foreground">no live data</span>
              )}
            </div>
            <DialogDescription className="sr-only">{index.name} analysis</DialogDescription>
          </DialogHeader>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
            <TabsList className="h-8">
              <TabsTrigger value="heatmap" className="font-mono text-xs h-7 px-4">Heatmap</TabsTrigger>
              <TabsTrigger value="technicals" className="font-mono text-xs h-7 px-4">Technicals</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === "heatmap" && (
            <div className="h-full flex flex-col p-4 pt-2">
              {/* Filters */}
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2 flex-shrink-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    {advances} advancing · {declines} declining · {unchanged} unchanged
                  </span>
                  {/* Live / EOD source indicator. Green dot = broker WS is feeding;
                   * amber = falling back to last EOD close while the broker feed
                   * warms up or sits idle (e.g. after-hours). */}
                  {rows.length > 0 && (
                    <span className="text-[10px] font-mono flex items-center gap-2">
                      <span className="flex items-center gap-1 text-profit">
                        <Radio className="w-3 h-3 animate-pulse" /> {liveCount} live
                      </span>
                      {eodCount > 0 && (
                        <span className="flex items-center gap-1 text-warning">
                          <span className="w-1.5 h-1.5 rounded-full bg-warning" /> {eodCount} EOD
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex gap-1 flex-wrap">
                  {filterOrder.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                        filter === f
                          ? f.startsWith("+")
                            ? "bg-profit text-primary-foreground"
                            : f.startsWith("-")
                            ? "bg-loss text-primary-foreground"
                            : "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {filterLabels[f]}
                    </button>
                  ))}
                </div>
              </div>

              {isLoading && rows.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono">Loading…</div>
              ) : displayError ? (
                <div className="flex-1 flex items-center justify-center text-loss text-sm font-mono">{displayError}</div>
              ) : filtered.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono">
                  No stocks match this filter
                </div>
              ) : (
                <TooltipProvider delayDuration={0}>
                  <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden">
                    {rects.map((rect) => {
                      const isLarge = rect.w > 8 && rect.h > 8;
                      const isMedium = rect.w > 5 && rect.h > 5;
                      const hasData = (rect.stock.ltp ?? 0) > 0;
                      const cp = rect.stock.change_pct ?? 0;
                      return (
                        <Tooltip key={rect.stock.internal_symbol}>
                          <TooltipTrigger asChild>
                            <div
                              style={{
                                position: "absolute",
                                left: `${rect.x}%`,
                                top: `${rect.y}%`,
                                width: `${rect.w}%`,
                                height: `${rect.h}%`,
                                backgroundColor: getHeatColor(rect.stock.change_pct, hasData),
                              }}
                              className="border border-background/20 flex flex-col justify-center items-center text-center transition-opacity hover:opacity-80 cursor-default overflow-hidden"
                            >
                              {isMedium && (
                                <>
                                  <span
                                    className={`font-mono font-bold leading-tight truncate w-full px-1 ${
                                      isLarge ? "text-sm" : "text-[10px]"
                                    } ${hasData ? "text-white" : "text-white/40"}`}
                                  >
                                    {rect.stock.symbol}
                                  </span>
                                  {hasData ? (
                                    <span
                                      className={`font-mono leading-tight text-white/80 ${
                                        isLarge ? "text-xs" : "text-[9px]"
                                      }`}
                                    >
                                      {cp >= 0 ? "+" : ""}{cp.toFixed(2)}%
                                    </span>
                                  ) : (
                                    <span
                                      className={`font-mono leading-tight text-white/30 ${
                                        isLarge ? "text-xs" : "text-[9px]"
                                      }`}
                                    >
                                      No Data
                                    </span>
                                  )}
                                </>
                              )}
                              {!isMedium && (
                                <span
                                  className={`font-mono text-[7px] font-bold truncate w-full px-0.5 ${
                                    hasData ? "text-white/70" : "text-white/30"
                                  }`}
                                >
                                  {rect.stock.symbol}
                                </span>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="bg-card border-border p-3 shadow-xl">
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="font-mono text-sm font-bold">{rect.stock.symbol}</p>
                                <span
                                  className={cn(
                                    "text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded",
                                    rect.stock.data_source === "live" && "bg-profit/15 text-profit",
                                    rect.stock.data_source === "eod" && "bg-warning/15 text-warning",
                                    rect.stock.data_source === "none" && "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {rect.stock.data_source}
                                </span>
                              </div>
                              <p className="text-[10px] text-muted-foreground font-mono">{rect.stock.internal_symbol}</p>
                              {hasData ? (
                                <>
                                  <div className="pt-1 space-y-1">
                                    <div className="font-mono text-sm">
                                      LTP: ₹{rect.stock.ltp!.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                                    </div>
                                    <div className={`font-mono text-xs ${cp >= 0 ? "text-profit" : "text-loss"}`}>
                                      {cp >= 0 ? "+" : ""}{cp.toFixed(2)}%
                                      {rect.stock.prev_close != null && (
                                        <>
                                          {" "}
                                          (₹{rect.stock.prev_close.toLocaleString("en-IN", { maximumFractionDigits: 2 })})
                                        </>
                                      )}
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] font-mono">
                                    <div>
                                      <div className="text-muted-foreground">Open</div>
                                      <div>{rect.stock.open != null ? `₹${rect.stock.open.toLocaleString("en-IN")}` : "-"}</div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground">High</div>
                                      <div className="text-profit">
                                        {rect.stock.high != null ? `₹${rect.stock.high.toLocaleString("en-IN")}` : "-"}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground">Low</div>
                                      <div className="text-loss">
                                        {rect.stock.low != null ? `₹${rect.stock.low.toLocaleString("en-IN")}` : "-"}
                                      </div>
                                    </div>
                                  </div>
                                  {rect.stock.data_source === "eod" && (
                                    <p className="text-[10px] text-warning pt-1 font-mono">
                                      Last close — broker WS warming up
                                    </p>
                                  )}
                                </>
                              ) : (
                                <p className="text-xs text-warning pt-1">Live price data not available</p>
                              )}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </TooltipProvider>
              )}
            </div>
          )}

          {activeTab === "technicals" && (
            <div className="h-full overflow-y-auto p-4 pt-2">
              <IndexTechnicals index={index} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
