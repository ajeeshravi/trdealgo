"use client";
import { useEffect, useRef, useState } from "react";
import { getStream } from "./ws";

/**
 * Subscribe to tick LTPs for a set of symbols and return `{ symbol: ltp }`.
 *
 * Throttles state updates to one flush per `throttleMs` (default 300ms).
 * Without throttling, a noisy broker can fire ticks at ~10Hz × N symbols,
 * which triggers a React re-render of every consumer for every tick —
 * the cause of the laggy positions / orders / strategy details pages.
 *
 * Pass an already-sorted `symbols` array (or rely on the join below) so the
 * effect doesn't churn the subscription when the same symbols re-arrive in
 * a different order.
 */
export function useLivePrices(symbols: string[], throttleMs = 300): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const pending = useRef<Record<string, number>>({});
  const timer = useRef<number | null>(null);
  const key = symbols.join("|");

  useEffect(() => {
    if (!key) {
      setPrices({});
      return;
    }
    const off = getStream().subscribeTicks(key.split("|"), (t: { s?: string; ltp?: number }) => {
      if (!t?.s || typeof t.ltp !== "number") return;
      pending.current[t.s] = t.ltp;
      if (timer.current == null) {
        timer.current = window.setTimeout(() => {
          const batch = pending.current;
          pending.current = {};
          timer.current = null;
          setPrices((cur) => {
            let changed = false;
            const next = { ...cur };
            for (const [s, ltp] of Object.entries(batch)) {
              if (next[s] !== ltp) {
                next[s] = ltp;
                changed = true;
              }
            }
            return changed ? next : cur;
          });
        }, throttleMs);
      }
    });
    return () => {
      off();
      if (timer.current != null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = {};
    };
  }, [key, throttleMs]);

  return prices;
}
