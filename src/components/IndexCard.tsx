"use client";
import { memo, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MarketIndex } from "@/lib/marketTypes";

interface Props {
  index: MarketIndex;
  onClick?: () => void;
}

const fmtNum = (n: number | null | undefined, frac = 2) =>
  n === undefined || n === null
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });

/**
 * Live price card.
 *
 * Each new value (compared to the previous render) triggers a brief
 * flash — green when LTP went up, red when it went down. The flash
 * decays over 600ms via opacity, so rapid ticks feel like a continuous
 * pulse rather than a chain of static jumps. The numeric value itself
 * uses tabular-nums + monospace so 23643.50 → 23643.55 doesn't shift
 * the layout by a pixel.
 */
function IndexCardImpl({ index, onClick }: Props) {
  const hasValue = index.value != null;
  const hasChange = index.change != null && index.change_pct != null;
  const up = hasChange ? (index.change as number) >= 0 : null;

  // Flash direction: "up" | "down" | null. Compared against the
  // previously-rendered value via a ref so we don't mis-fire on the
  // first render (where prev would be undefined).
  const prevValueRef = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const prev = prevValueRef.current;
    const curr = index.value;
    if (prev != null && curr != null && prev !== curr) {
      setFlash(curr > prev ? "up" : "down");
      const id = window.setTimeout(() => setFlash(null), 600);
      prevValueRef.current = curr;
      return () => window.clearTimeout(id);
    }
    prevValueRef.current = curr;
  }, [index.value]);

  return (
    <button
      onClick={onClick}
      type="button"
      className={cn(
        "group relative w-full overflow-hidden rounded-lg border border-border/50 bg-card p-4 text-left transition-all",
        "hover:border-primary/40 hover:bg-card/80 hover:shadow-lg",
        up === true && "hover:shadow-profit/10",
        up === false && "hover:shadow-loss/10",
      )}
    >
      {/* Tick-flash overlay — fades from 0.18 alpha back to 0 over 600ms. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 transition-opacity duration-500",
          flash === "up" && "bg-profit/20 opacity-100",
          flash === "down" && "bg-loss/20 opacity-100",
          !flash && "opacity-0",
        )}
      />

      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{index.short ?? index.name}</p>
          <p
            className={cn(
              "font-mono text-lg font-bold tracking-tight tabular-nums",
              !hasValue && "text-muted-foreground",
            )}
          >
            {hasValue ? fmtNum(index.value) : "—"}
          </p>
        </div>
        {up !== null && (
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full",
              up ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss",
            )}
          >
            {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
          </div>
        )}
      </div>
      <div className="relative mt-2 flex items-baseline gap-2 font-mono text-xs tabular-nums">
        {hasChange && up !== null ? (
          <>
            <span className={cn(up ? "text-profit" : "text-loss")}>
              {up ? "+" : ""}{fmtNum(index.change)}
            </span>
            <span className={cn(up ? "text-profit" : "text-loss")}>
              ({up ? "+" : ""}{fmtNum(index.change_pct)}%)
            </span>
          </>
        ) : (
          <span className="text-muted-foreground/70">no data</span>
        )}
      </div>
      {(index.high != null || index.low != null) && (
        <div className="relative mt-2 flex items-center gap-3 text-[10px] font-mono text-muted-foreground tabular-nums">
          <span>H {fmtNum(index.high)}</span>
          <span>L {fmtNum(index.low)}</span>
        </div>
      )}
    </button>
  );
}

// Custom equality: only re-render when one of the displayed fields
// changes. `useLiveMarketIndices` rebuilds the array on every poll, so
// without memo each tick would re-render all 30 IndexCards even when
// their numbers didn't move — the single biggest source of UI jank.
const arePropsEqual = (prev: Props, next: Props) => {
  if (prev.onClick !== next.onClick) return false;
  const a = prev.index;
  const b = next.index;
  return (
    a.id === b.id &&
    a.value === b.value &&
    a.change === b.change &&
    a.change_pct === b.change_pct &&
    a.high === b.high &&
    a.low === b.low &&
    a.short === b.short &&
    a.name === b.name
  );
};

const IndexCard = memo(IndexCardImpl, arePropsEqual);
export default IndexCard;
