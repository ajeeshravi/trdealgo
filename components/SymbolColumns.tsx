"use client";
/**
 * Shared helpers for rendering symbol columns + per-column filters in tables
 * (Orders, Positions, Feed).
 *
 * Column order (user-specified):
 *   1. Exchange
 *   2. Symbol         (the underlying ticker; for F&O this is the F&O underlying)
 *   3. Option Type    \
 *   4. Expiry Date     >  F&O-only — hidden when the result set is cash-only
 *   5. Strike         /
 *
 * "Cash-only" means every row's `exchange` is in {NSE, BSE}. If any row sits
 * on an F&O / commodity / currency-derivative exchange (NFO, BFO, MCX, CDS),
 * the three trailing columns + their filter inputs show.
 *
 * The backend `/orders` and `/positions` endpoints already backfill these
 * fields from the Redis symbol master, so rows arrive with everything needed
 * to render the columns.
 */
import { useMemo, useState } from "react";
import { fmtExpiry } from "@/lib/fmt";

export type SymbolColumnsRow = {
  internal_symbol: string;
  trading_symbol?: string;
  exchange?: string | null;
  segment?: string | null;
  underlying?: string | null;
  expiry?: string | null;
  strike?: number | null;
  option_type?: string | null;
};

export type SymbolFilters = {
  exchange: string;
  underlying: string;
  option_type: string;
  expiry: string;
  strike: string;
};

export const EMPTY_FILTERS: SymbolFilters = {
  exchange: "", underlying: "", option_type: "",
  expiry: "", strike: "",
};

// Exchanges that carry ONLY cash-market instruments. Anything else (NFO,
// BFO, MCX, CDS) carries derivatives and triggers the F&O columns.
const CASH_EXCHANGES = new Set(["NSE", "BSE"]);

export function hasNonCashRows(rows: SymbolColumnsRow[]): boolean {
  return rows.some((r) => r.exchange && !CASH_EXCHANGES.has(r.exchange));
}

export function applySymbolFilters<T extends SymbolColumnsRow>(
  rows: T[],
  f: SymbolFilters,
): T[] {
  const ex = f.exchange.trim().toUpperCase();
  const ul = f.underlying.trim().toUpperCase();
  const ot = f.option_type.trim().toUpperCase();
  const exp = f.expiry.trim();
  const strikeNum = f.strike.trim() ? Number(f.strike.trim()) : NaN;
  return rows.filter((r) => {
    if (ex && (r.exchange || "").toUpperCase() !== ex) return false;
    if (ul && !((r.underlying || "").toUpperCase().includes(ul))) return false;
    if (ot && (r.option_type || "").toUpperCase() !== ot) return false;
    if (exp && (r.expiry || "") !== exp) return false;
    if (!isNaN(strikeNum) && Number(r.strike ?? NaN) !== strikeNum) return false;
    return true;
  });
}

/**
 * Per-column filter inputs as a single `<tr>`. `leadingCols`/`trailingCols`
 * add empty spacer cells for table columns that sit outside the symbol block.
 *
 * `showFno` should mirror `hasNonCashRows(rows)` (or pass `true` to force
 * the F&O inputs to appear, e.g. on a strategies-create page where the
 * user might want them up-front).
 */
export function SymbolFilterRow({
  filters, onChange, showFno, leadingCols = 0, trailingCols = 0,
}: {
  filters: SymbolFilters;
  onChange: (next: SymbolFilters) => void;
  showFno: boolean;
  leadingCols?: number;
  trailingCols?: number;
}) {
  function set<K extends keyof SymbolFilters>(k: K, v: string) {
    onChange({ ...filters, [k]: v });
  }
  return (
    <tr className="bg-panel2/60">
      {Array.from({ length: leadingCols }).map((_, i) => (
        <td key={`lead-${i}`} />
      ))}
      {/* 1. Exchange */}
      <td>
        <input
          className="input-xs"
          placeholder="NSE"
          value={filters.exchange}
          onChange={(e) => set("exchange", e.target.value)}
        />
      </td>
      {/* 2. Symbol (underlying) */}
      <td>
        <input
          className="input-xs"
          placeholder="Symbol"
          value={filters.underlying}
          onChange={(e) => set("underlying", e.target.value)}
        />
      </td>
      {/* 3. Option Type */}
      {showFno && (
        <td>
          <select
            className="input-xs"
            value={filters.option_type}
            onChange={(e) => set("option_type", e.target.value)}
          >
            <option value="">any</option>
            <option value="CE">CE</option>
            <option value="PE">PE</option>
          </select>
        </td>
      )}
      {/* 4. Expiry Date */}
      {showFno && (
        <td>
          <input
            className="input-xs"
            type="date"
            value={filters.expiry}
            onChange={(e) => set("expiry", e.target.value)}
          />
        </td>
      )}
      {/* 5. Strike */}
      {showFno && (
        <td>
          <input
            className="input-xs"
            placeholder="strike"
            inputMode="decimal"
            value={filters.strike}
            onChange={(e) => set("strike", e.target.value)}
          />
        </td>
      )}
      {Array.from({ length: trailingCols }).map((_, i) => (
        <td key={`trail-${i}`} />
      ))}
    </tr>
  );
}

/**
 * The `<td>` cells for one row, in the same order as SymbolHeaders /
 * SymbolFilterRow. We render the row's `trading_symbol` as a tooltip on
 * the Symbol cell so power-users can still see the broker-tradeable form
 * without giving it a dedicated column.
 */
export function SymbolCells({
  row, showFno,
}: {
  row: SymbolColumnsRow;
  showFno: boolean;
}) {
  const symbolText = row.underlying || row.internal_symbol;
  const tooltip = row.trading_symbol || row.internal_symbol;
  return (
    <>
      <td>{row.exchange || "—"}</td>
      <td className="font-mono" title={tooltip}>{symbolText}</td>
      {showFno && <td>{row.option_type || "—"}</td>}
      {showFno && <td>{fmtExpiry(row.expiry)}</td>}
      {showFno && <td>{row.strike ?? "—"}</td>}
    </>
  );
}

/** Header `<th>` cells matching SymbolCells. */
export function SymbolHeaders({ showFno }: { showFno: boolean }) {
  return (
    <>
      <th>Exchange</th>
      <th>Symbol</th>
      {showFno && <th>Option Type</th>}
      {showFno && <th>Expiry Date</th>}
      {showFno && <th>Strike</th>}
    </>
  );
}

/** Number of columns the symbol block occupies (2 cash, 5 F&O). */
export function symbolColumnCount(showFno: boolean): number {
  return showFno ? 5 : 2;
}

export function useSymbolFilters() {
  const [filters, setFilters] = useState<SymbolFilters>(EMPTY_FILTERS);
  const reset = () => setFilters(EMPTY_FILTERS);
  return { filters, setFilters, reset };
}

export function useFilteredRows<T extends SymbolColumnsRow>(
  rows: T[], filters: SymbolFilters,
): T[] {
  return useMemo(() => applySymbolFilters(rows, filters), [rows, filters]);
}
