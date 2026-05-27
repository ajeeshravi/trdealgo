"use client";
/**
 * Typeahead picker for universal internal_symbols.
 *
 * - Debounced search against /api/v1/symbols/search.
 * - Keyboard nav (↑/↓/Enter/Esc).
 * - Forces selection from suggestions: the controlled `value` only changes
 *   when the user clicks a row or presses Enter on a focused option.
 * - Shows a small ✓ badge when the current `value` matches an exact symbol
 *   in the dropdown (visual confirmation it's valid).
 *
 * Usage:
 *   <SymbolPicker value={sym} onChange={setSym} placeholder="Search…" />
 *
 * Optional filters narrow the search:
 *   <SymbolPicker segment="EQUITY" exchange="NSE" ... />
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { fmtExpiry } from "@/lib/fmt";

type Segment = "EQUITY" | "FUT" | "OPT" | "INDEX" | "COMMODITY" | "CURRENCY";
type Exchange = "NSE" | "BSE" | "MCX" | "NFO" | "BFO" | "CDS";

export type SymbolHit = {
  internal_symbol: string;     // backend value — what we send on submit
  trading_symbol: string;      // primary display string (taken from a broker)
  underlying: string;
  segment: Segment;
  exchange: Exchange;
  expiry?: string | null;
  strike?: number | null;
  option_type?: "CE" | "PE" | null;
  lot_size: number;
};

interface Props {
  value: string;
  onChange: (internalSymbol: string) => void;
  placeholder?: string;
  segment?: Segment;
  exchange?: Exchange;
  /** F&O narrowing — passed to /symbols/search as exact-match filters. */
  optionType?: "CE" | "PE";
  expiry?: string;             // ISO date `YYYY-MM-DD`
  strike?: number | "";
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

export function SymbolPicker({
  value, onChange, placeholder = "Search RELIANCE, NIFTY …",
  segment, exchange, optionType, expiry, strike,
  disabled, className, autoFocus,
}: Props) {
  // The "input" the user is typing. Until they pick a row, this differs from `value`.
  const [query, setQuery] = useState(value);
  // After pick(), `value` becomes the picked internal_symbol. We don't want
  // the value-sync useEffect to then overwrite the displayed trading_symbol
  // back to the internal_symbol, so we remember which internal_symbol we
  // just picked and skip the re-sync in that case.
  const [pickedInternal, setPickedInternal] = useState<string | null>(null);
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-sync if parent updates value externally (e.g. form reset). Skip if the
  // new value matches what the user just picked from the dropdown — the
  // input already shows the friendly trading_symbol for that.
  useEffect(() => {
    if (value === pickedInternal) return;
    setQuery(value);
    setPickedInternal(null);
  }, [value, pickedInternal]);

  // Debounced fetch
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 1) { setHits([]); return; }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: "25" });
        if (segment)            params.set("segment",     segment);
        if (exchange)           params.set("exchange",    exchange);
        if (optionType)         params.set("option_type", optionType);
        if (expiry)             params.set("expiry",      expiry);
        if (strike !== undefined && strike !== "" && !isNaN(Number(strike))) {
          params.set("strike", String(strike));
        }
        const { data } = await api.get(`/symbols/search?${params}`);
        if (!cancelled) {
          setHits(data || []);
          setActive(0);
        }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open, segment, exchange, optionType, expiry, strike]);

  // Close on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Keep active row in view
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(h: SymbolHit) {
    onChange(h.internal_symbol);
    setQuery(h.trading_symbol);
    setPickedInternal(h.internal_symbol);
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
      if (open && hits[active]) {
        e.preventDefault();
        pick(hits[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // ✓ badge: parent has an internal_symbol AND it matches the picked hit
  //   whose trading_symbol is currently shown in the input.
  const matchingHit = hits.find((h) => h.internal_symbol === value);
  const isValid = !!matchingHit;
  const showBadge =
    !!value &&
    (query === value || (matchingHit && query === matchingHit.trading_symbol));

  return (
    <div ref={wrapRef} className={clsx("relative", className)}>
      <div className="relative">
        <input
          className="input font-mono pr-12"
          value={query}
          onChange={(e) => { setQuery(e.target.value.toUpperCase()); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          autoFocus={autoFocus}
          spellCheck={false}
        />
        <div className="absolute inset-y-0 right-2 flex items-center text-xs">
          {busy && <span className="text-muted-foreground">…</span>}
          {!busy && showBadge && isValid && <span className="text-primary">✓</span>}
          {!busy && showBadge && !isValid && hits.length > 0 && (
            <span className="text-yellow-400" title="Pick from dropdown">!</span>
          )}
        </div>
      </div>

      {open && (
        <div
          ref={listRef}
          className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-md border border-border bg-panel shadow-lg"
        >
          {!hits.length && !busy && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {query.length < 1 ? "Type to search…" : "No matches"}
            </div>
          )}
          {hits.map((h, i) => (
            <button
              type="button"
              key={h.internal_symbol}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
              className={clsx(
                "block w-full text-left px-3 py-1.5 text-sm border-b border-border/40 last:border-0",
                i === active ? "bg-panel2" : "hover:bg-panel2/60",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-gray-100 truncate">{h.trading_symbol}</span>
                <SegBadge segment={h.segment} />
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {h.underlying} · {h.exchange} · lot {h.lot_size}
                {h.expiry && <> · exp {fmtExpiry(h.expiry)}</>}
                {h.strike != null && <> · strike {h.strike}</>}
                {h.option_type && <> · {h.option_type}</>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SegBadge({ segment }: { segment: SymbolHit["segment"] }) {
  const cls = {
    EQUITY:    "bg-blue-700/40 text-blue-300",
    INDEX:     "bg-purple-700/40 text-purple-300",
    FUT:       "bg-yellow-700/40 text-yellow-300",
    OPT:       "bg-green-700/40 text-green-300",
    COMMODITY: "bg-orange-700/40 text-orange-300",
    CURRENCY:  "bg-pink-700/40 text-pink-300",
  }[segment] ?? "bg-gray-700 text-gray-300";
  return <span className={`pill text-[10px] ${cls}`}>{segment}</span>;
}
