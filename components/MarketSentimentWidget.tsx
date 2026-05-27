"use client";
import { useEffect, useMemo, useState } from "react";
import { Activity, TrendingUp, ArrowUpDown, BarChart3 } from "lucide-react";
import marketDataService from "@/services/marketDataService";
import type { MarketSentiment } from "@/lib/marketTypes";
import { useLivePrices } from "@/lib/useLivePrices";
import { cn } from "@/lib/utils";

type Card = "vix" | "pcr" | "fiidii" | "advdec";

interface Props {
  onCardClick?: (card: Card) => void;
}

const VIX_SYMBOL = "NSE_INDIAVIX_IDX";

/**
 * The Dashboard's market-sentiment strip — four clickable cards:
 * India VIX, PCR, FII/DII flow, Advance/Decline. Each click opens
 * the corresponding deep-dive dialog (handled by parent via
 * `onCardClick`).
 *
 * Update strategy per card:
 *   - VIX     → WebSocket tick stream (NSE_INDIAVIX_IDX) for the live
 *               LTP. Prev-close baseline still comes from the slow
 *               sentiment payload, which is enough to compute the
 *               change% live as ticks arrive.
 *   - PCR     → poll the intraday-OI aggregate every 30 s (NSE
 *               doesn't push live PCR; an OI scraper updates a
 *               snapshot table roughly once a minute, so 30 s catches
 *               every new row).
 *   - FII/DII → slow daily metric; polled with the sentiment payload.
 *   - Adv/Dec → live-breadth poll every 15 s.
 */
export default function MarketSentimentWidget({ onCardClick }: Props) {
  const [data, setData] = useState<MarketSentiment | null>(null);
  const [liveAd, setLiveAd] = useState<{ advances: number; declines: number; unchanged: number } | null>(null);
  const [livePcr, setLivePcr] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const d = await marketDataService.getMarketSentiment();
      if (!cancelled) setData(d);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Live breadth — re-polls every 15 s. The endpoint fans out across the
  // broad-market universe (Nifty 500), so polling more aggressively than
  // this just queues backend work without changing what the user sees.
  // Falls back to the EOD breadth from getMarketSentiment when the live
  // count came back as zero across the board (pre-market, no broker subs).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const b = await marketDataService.getBreadthLive();
      if (!cancelled) setLiveAd(b);
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Live PCR — polls the intraday-OI aggregate (each row = one OI
  // snapshot, with `pcr_oi` already computed server-side). Falls back to
  // the EOD PCR from getMarketSentiment when the intraday series is
  // empty (pre-market, no option scrape yet).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const v = await marketDataService.getPcrLive("NIFTY");
      if (!cancelled) setLivePcr(v);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // VIX live tick subscription. The broker WS feed already streams
  // NSE_INDIAVIX_IDX (it's in the dashboard's index-card universe), so
  // adding it here is essentially free — the WS layer dedupes subs.
  const vixSubs = useMemo(() => [VIX_SYMBOL], []);
  const livePrices = useLivePrices(vixSubs);
  const liveVixLtp = livePrices[VIX_SYMBOL];

  // Compose the displayed VIX block. Prefer the live LTP and recompute
  // change% off the prev-close baseline that came down in the sentiment
  // payload; fall back to the payload value entirely when no tick has
  // arrived yet (cold start, market closed).
  const vix = useMemo(() => {
    const base = data?.indiaVix;
    if (typeof liveVixLtp !== "number") return base ?? null;
    // Derive prev close from base (value − change). When base is missing
    // we can't compute a change %, but still show the live tick.
    const prevClose = base ? base.value - base.change : undefined;
    if (typeof prevClose === "number" && prevClose !== 0) {
      const change = liveVixLtp - prevClose;
      return {
        value: liveVixLtp,
        change,
        changePercent: (change / prevClose) * 100,
      };
    }
    return { value: liveVixLtp, change: 0, changePercent: 0 };
  }, [data?.indiaVix, liveVixLtp]);

  // PCR — prefer the live intraday snapshot; fall back to the EOD value
  // from the sentiment payload. Trend label is derived locally from the
  // chosen value so the chip updates in lockstep with the number.
  const pcr = useMemo(() => {
    const v = typeof livePcr === "number" ? livePcr : data?.pcr?.value;
    if (typeof v !== "number") return null;
    const trend: "Bullish" | "Bearish" | "Neutral" =
      v > 1 ? "Bullish" : v < 0.8 ? "Bearish" : "Neutral";
    return { value: v, trend };
  }, [livePcr, data?.pcr?.value]);

  const fii = data?.fiiDii?.fii;
  const dii = data?.fiiDii?.dii;
  // Prefer the live count; fall back to EOD breadth on cold start.
  const ad =
    liveAd && liveAd.advances + liveAd.declines + liveAd.unchanged > 0
      ? liveAd
      : data?.advDecline;

  return (
    <div>
      <h2 className="text-xl font-bold mb-3">Market Sentiment</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          icon={<Activity className="w-3.5 h-3.5" />}
          label="India VIX"
          value={vix ? vix.value.toFixed(2) : "—"}
          sub={
            vix
              ? `${vix.change >= 0 ? "+" : ""}${vix.change.toFixed(2)} (${vix.changePercent >= 0 ? "+" : ""}${vix.changePercent.toFixed(2)}%)`
              : "Loading…"
          }
          subTone={vix && vix.change < 0 ? "profit" : "loss"}
          onClick={() => onCardClick?.("vix")}
        />
        <Card
          icon={<TrendingUp className="w-3.5 h-3.5" />}
          label="PCR (NIFTY)"
          value={pcr ? pcr.value.toFixed(2) : "—"}
          sub={pcr?.trend ?? "Loading…"}
          subTone={pcr?.trend === "Bullish" ? "profit" : pcr?.trend === "Bearish" ? "loss" : "warning"}
          onClick={() => onCardClick?.("pcr")}
        />
        <FiiDiiCard
          fii={fii}
          dii={dii}
          onClick={() => onCardClick?.("fiidii")}
        />
        <Card
          icon={<BarChart3 className="w-3.5 h-3.5" />}
          label="Adv / Decline"
          value={ad ? `${ad.advances} / ${ad.declines}` : "—"}
          sub={ad ? `Breadth: ${(ad.advances / Math.max(1, ad.declines)).toFixed(2)}` : "Loading…"}
          subTone={ad && ad.advances > ad.declines ? "profit" : "loss"}
          onClick={() => onCardClick?.("advdec")}
        />
      </div>
    </div>
  );
}

/**
 * FII/DII flow card — special layout because the value is two numbers
 * (FII + DII) of widely varying magnitudes ("FII -₹18,420 Cr" can
 * overflow the tile while DII shows "+₹2 Cr"). Renders both rows in a
 * compact mono font with abbreviated magnitudes (₹12.3K Cr → "12.3K")
 * so the tile keeps the same visual weight as the other three.
 */
function FiiDiiCard({
  fii,
  dii,
  onClick,
}: {
  fii?: number;
  dii?: number;
  onClick?: () => void;
}) {
  const fmt = (n?: number) => {
    if (n === undefined || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    const sign = n >= 0 ? "+" : "-";
    if (abs >= 10_000) return `${sign}₹${(abs / 1000).toFixed(1)}K Cr`;
    if (abs >= 1_000) return `${sign}₹${abs.toFixed(0)} Cr`;
    return `${sign}₹${abs.toFixed(0)} Cr`;
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <span className="opacity-70">
          <ArrowUpDown className="w-3.5 h-3.5" />
        </span>
        <span className="uppercase tracking-wider">FII / DII Flow</span>
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">FII</span>
          <span
            className={cn(
              "font-mono text-sm font-bold",
              fii === undefined ? "text-muted-foreground" : fii >= 0 ? "text-profit" : "text-loss",
            )}
          >
            {fmt(fii)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">DII</span>
          <span
            className={cn(
              "font-mono text-sm font-bold",
              dii === undefined ? "text-muted-foreground" : dii >= 0 ? "text-profit" : "text-loss",
            )}
          >
            {fmt(dii)}
          </span>
        </div>
      </div>
    </button>
  );
}

function Card({
  icon,
  label,
  value,
  sub,
  subTone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  subTone: "profit" | "loss" | "warning";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border border-border/50 bg-card p-4 hover:border-primary/40 transition-colors"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <span className="opacity-70">{icon}</span>
        <span className="uppercase tracking-wider">{label}</span>
      </div>
      <p className="font-mono text-2xl font-bold">{value}</p>
      <p
        className={cn(
          "text-xs font-mono mt-1",
          subTone === "profit" && "text-profit",
          subTone === "loss" && "text-loss",
          subTone === "warning" && "text-warning",
        )}
      >
        {sub}
      </p>
    </button>
  );
}
