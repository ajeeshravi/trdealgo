"use client";
/**
 * Typeahead for *distinct underlyings* on one exchange.
 *
 * Backed by `GET /symbols/underlyings?exchange=…&q=…`. Where SymbolPicker
 * shows full internal_symbols (e.g. `NFO_NIFTY_290526_24500_CE`), this
 * shows just the underlying ticker (`NIFTY`, `RELIANCE`, `BANKNIFTY`).
 *
 * Disabled until an exchange is chosen — the parent must own the
 * `exchange` prop. Picking a new exchange clears the value via the
 * useEffect below.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";

type Exchange = "NSE" | "BSE" | "MCX" | "NFO" | "BFO" | "CDS";

interface Props {
  value: string;                              // selected underlying
  onChange: (underlying: string) => void;
  exchange: Exchange | "";
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export function UnderlyingPicker({
  value, onChange, exchange,
  placeholder, disabled, className, autoFocus,
}: Props) {
  const [query, setQuery] = useState(value);
  const [hits, setHits] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep input in sync with external value (form resets, etc.).
  useEffect(() => { setQuery(value); }, [value]);

  // Clear when the exchange changes — the previously-picked underlying may
  // not exist on the new exchange.
  useEffect(() => {
    if (value) onChange("");
    setQuery("");
    setHits([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange]);

  // Debounced fetch.
  useEffect(() => {
    if (!exchange) { setHits([]); return; }
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          exchange, q: query.trim(), limit: "30",
        });
        const { data } = await api.get<string[]>(`/symbols/underlyings?${params}`);
        if (!cancelled) { setHits(data || []); setActive(0); }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open, exchange]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(u: string) {
    onChange(u);
    setQuery(u);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && hits[active]) { e.preventDefault(); pick(hits[active]); }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const ph = placeholder ?? (exchange ? "Type RELIANCE, NIFTY…" : "Pick an exchange first");
  const fullyDisabled = disabled || !exchange;

  return (
    <div ref={wrapRef} className={clsx("relative", className)}>
      <input
        className="input font-mono"
        value={query}
        onChange={(e) => { setQuery(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={ph}
        disabled={fullyDisabled}
        autoComplete="off"
        autoFocus={autoFocus && !!exchange}
        spellCheck={false}
      />
      {open && exchange && (
        <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-md border border-border bg-panel shadow-lg">
          {!hits.length && !busy && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {query.length < 1 ? "Type to search…" : "No matches"}
            </div>
          )}
          {hits.map((u, i) => (
            <button
              type="button"
              key={u}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(u); }}
              className={clsx(
                "block w-full text-left px-3 py-1.5 text-sm font-mono border-b border-border/40 last:border-0",
                i === active ? "bg-panel2" : "hover:bg-panel2/60",
              )}
            >
              {u}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
