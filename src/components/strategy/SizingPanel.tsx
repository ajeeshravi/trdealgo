"use client";
/**
 * Position sizing editor. Available modes depend on the strategy's
 * instrument class:
 *
 *   EQUITY:
 *     FIXED_QTY            user-provided share count
 *     CAPITAL_PER_SYMBOL   floor(capital_per_symbol / ltp)
 *     PCT_OF_CAPITAL       % of total capital per trade
 *     RISK_BASED           qty = (capital * risk_pct) / sl_distance
 *
 *   FUTURES (engine multiplies by lot_size on submit):
 *     LOTS                 fixed N lots
 *     CAPITAL_PER_SYMBOL   lots = floor(cap / (lot_size * ltp))
 *     PCT_OF_CAPITAL       lots = floor(cap_pct / (lot_size * ltp))
 *     RISK_BASED           lots = (capital * risk_pct) / (sl_distance * lot_size)
 */
import { InstrumentClass, PositionSizing, SizingMode } from "./types";

interface Props {
  value: PositionSizing;
  onChange: (next: PositionSizing) => void;
  /** Drives the available modes + label hints. Defaults to EQUITY for
   *  back-compat with any caller that hasn't been updated yet. */
  instrumentClass?: InstrumentClass;
  /** Total absolute lots summed across every option leg. Only used for
   *  OPTIONS + LOTS mode, where the per-leg panel owns each leg's lot
   *  count and this panel just shows the derived total so the user never
   *  has to keep `sizing.lots` consistent with the legs by hand. */
  optionsLegsTotalLots?: number;
}

export function SizingPanel({
  value,
  onChange,
  instrumentClass = "EQUITY",
  optionsLegsTotalLots,
}: Props) {
  // Futures and options both trade in lot-sized contracts — same sizing
  // modes, same UI. The runner pushes the option contract's lot_size into
  // `ctx.params["lot_sizes"]` so the engine math is identical.
  const isLotAware = instrumentClass === "FUTURES" || instrumentClass === "OPTIONS";
  const isFut = isLotAware;
  // For OPTIONS in Fixed-lots mode the legs panel owns the per-leg lot
  // counts directly; this panel hides its own lots input and shows the
  // summed total as a read-only badge to avoid a user-editable mismatch
  // between `sizing.lots` and the sum of leg lots.
  const isOptionsFixedLots = instrumentClass === "OPTIONS" && value.mode === "LOTS";

  return (
    <div className="card grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div>
        <div className="label mb-1">Sizing mode</div>
        <select
          className="input"
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as SizingMode })}
        >
          {isFut ? (
            <>
              <option value="LOTS">Fixed lots</option>
              <option value="CAPITAL_PER_SYMBOL">Capital per symbol</option>
              <option value="PCT_OF_CAPITAL">% of capital per trade</option>
              <option value="RISK_BASED">Risk-based (uses SL %)</option>
            </>
          ) : (
            <>
              <option value="FIXED_QTY">Fixed quantity</option>
              <option value="CAPITAL_PER_SYMBOL">Capital per symbol</option>
              <option value="PCT_OF_CAPITAL">% of capital per trade</option>
              <option value="RISK_BASED">Risk-based (uses SL %)</option>
            </>
          )}
        </select>
      </div>

      {value.mode === "LOTS" && isFut && !isOptionsFixedLots && (
        <div>
          <div className="label mb-1">Number of lots</div>
          <input
            className="input"
            type="number"
            min={1}
            value={value.lots ?? 1}
            onChange={(e) => onChange({ ...value, lots: Number(e.target.value) })}
          />
        </div>
      )}

      {isOptionsFixedLots && (
        <div>
          <div className="label mb-1">Total lots across legs</div>
          <div
            className="input flex items-center font-mono text-sm cursor-default select-none bg-panel2/60"
            title="Sum of each leg's Lots input below. Edit per-leg lot counts in the legs panel."
          >
            {optionsLegsTotalLots ?? 0}
          </div>
        </div>
      )}

      {value.mode === "FIXED_QTY" && !isFut && (
        <div>
          <div className="label mb-1">Quantity (shares)</div>
          <input
            className="input"
            type="number"
            min={1}
            value={value.fixed_qty ?? 0}
            onChange={(e) => onChange({ ...value, fixed_qty: Number(e.target.value) })}
          />
        </div>
      )}

      {value.mode === "CAPITAL_PER_SYMBOL" && (
        <div>
          <div className="label mb-1">Capital per symbol ($)</div>
          <input
            className="input"
            type="number"
            min={0}
            value={value.capital_per_symbol ?? 0}
            onChange={(e) => onChange({ ...value, capital_per_symbol: Number(e.target.value) })}
          />
        </div>
      )}

      {value.mode === "PCT_OF_CAPITAL" && (
        <div>
          <div className="label mb-1">% of total capital</div>
          <input
            className="input"
            type="number"
            step={0.001}
            value={value.pct_of_capital ?? 0.1}
            onChange={(e) => onChange({ ...value, pct_of_capital: Number(e.target.value) })}
          />
        </div>
      )}

      {value.mode === "RISK_BASED" && (
        <div>
          <div className="label mb-1">Risk per trade (%)</div>
          <input
            className="input"
            type="number"
            step={0.001}
            value={value.risk_pct ?? 0.01}
            onChange={(e) => onChange({ ...value, risk_pct: Number(e.target.value) })}
          />
        </div>
      )}

      {isFut && (
        <div className="col-span-2 lg:col-span-2 text-xs text-muted-foreground self-end pb-2">
          {isOptionsFixedLots ? (
            <>
              Set each leg&apos;s lot count in the legs panel below. Final order qty per
              leg = <span className="font-mono">lots × lot_size</span> at run-time.
            </>
          ) : (
            <>
              Final order qty = <span className="font-mono">lots × lot_size</span> per
              symbol — lot size is read from the symbol master at run-time.
            </>
          )}
        </div>
      )}
    </div>
  );
}
