"use client";
/**
 * Single-condition editor row.
 *
 * The kind dropdown lets the user pick between two generic forms
 *   - compare   indicator OP indicator-or-constant
 *   - crossover indicator-crosses-indicator (up/down)
 * and the legacy "shortcut" condition types that are simpler one-liners.
 *
 * Each branch renders its own params block, plus a shared
 * symbol-override + timeframe selector at the bottom.
 */
import {
  ComparisonOp,
  Condition,
  ConditionKind,
  Direction,
  defaultCondition,
} from "./types";
import { IndicatorExprEditor } from "./IndicatorExprEditor";
import { ArithExprEditor } from "./ArithExprEditor";

const KIND_LABELS: Record<ConditionKind, string> = {
  compare:        "Compare (indicator vs indicator/value)",
  crossover:      "Crossover (indicator crosses indicator)",
  ema_cross:      "Shortcut: EMA crossover",
  rsi:            "Shortcut: RSI threshold",
  supertrend:     "Shortcut: Supertrend flip",
  vwap_break:     "Shortcut: VWAP break",
  macd_cross:     "Shortcut: MACD crossover",
  breakout:       "Shortcut: N-bar breakout",
  volume_spike:   "Shortcut: Volume spike",
  candle_pattern: "Shortcut: Candle pattern",
  time_trigger:   "Time of day (fires at HH:MM, once per day)",
  dte:            "Days to expiry (OPTIONS only — 0DTE, 1DTE, ...)",
};

const TF_OPTIONS = ["same", "5m", "15m", "1h", "1d"];

interface Props {
  value: Condition;
  symbols: string[];
  onChange: (next: Condition) => void;
  onRemove: () => void;
}

export function ConditionRow({ value, symbols, onChange, onRemove }: Props) {
  function switchKind(kind: ConditionKind) {
    const fresh = defaultCondition(kind);
    onChange({ ...fresh, id: value.id, timeframe: value.timeframe } as Condition);
  }

  const patch = <P extends Partial<Condition>>(p: P) =>
    onChange({ ...(value as Condition), ...p } as Condition);

  /* The shortcut conditions all carry a per-condition symbol override
   * directly on the condition object. The generic ones expose it via the
   * left/right IndicatorExprEditor instead. */
  const hasOwnSymbolField = value.type !== "compare" && value.type !== "crossover";

  return (
    <div className="rounded-md border border-border bg-panel2/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <select
          className="input"
          value={value.type}
          onChange={(e) => switchKind(e.target.value as ConditionKind)}
        >
          {(Object.keys(KIND_LABELS) as ConditionKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABELS[k]}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={onRemove}
          title="Remove this condition"
        >
          ×
        </button>
      </div>

      {/* ------------------- generic compare ------------------------ */}
      {/* Both sides are arbitrary arithmetic Exprs. The editor lets the
          user pick Indicator / Constant / a binary op / a unary function
          for each side, so formulas like `open > prev_day_close × 1.005`
          fit in one condition. */}
      {value.type === "compare" && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-2 items-start">
          <div>
            <div className="label mb-1">Left</div>
            <ArithExprEditor
              value={value.left}
              symbols={symbols}
              onChange={(left) => patch({ left })}
            />
          </div>
          <div className="lg:pt-7">
            <div className="label mb-1">Operator</div>
            <select
              className="input"
              value={value.op}
              onChange={(e) => patch({ op: e.target.value as ComparisonOp })}
            >
              {([">", "<", ">=", "<=", "==", "!="] as ComparisonOp[]).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="label mb-1">Right</div>
            <ArithExprEditor
              value={value.right}
              symbols={symbols}
              onChange={(right) => patch({ right })}
            />
          </div>
        </div>
      )}

      {/* ------------------- generic crossover ---------------------- */}
      {value.type === "crossover" && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <div>
              <div className="label mb-1">Left (crossing series)</div>
              <IndicatorExprEditor
                value={value.left}
                symbols={symbols}
                onChange={(left) => patch({ left })}
              />
            </div>
            <div>
              <div className="label mb-1">Right (reference series)</div>
              <IndicatorExprEditor
                value={value.right}
                symbols={symbols}
                onChange={(right) => patch({ right })}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="label mb-1">Direction</div>
              <select
                className="input"
                value={value.direction}
                onChange={(e) => patch({ direction: e.target.value as Direction })}
              >
                <option value="up">Left crosses above right</option>
                <option value="down">Left crosses below right</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* ------------------- shortcut types ------------------------- */}
      {value.type === "ema_cross" && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Fast" v={value.fast} on={(n) => patch({ fast: n })} />
          <Num label="Slow" v={value.slow} on={(n) => patch({ slow: n })} />
          <DirSel v={value.direction} on={(d) => patch({ direction: d })} />
        </div>
      )}

      {value.type === "rsi" && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Period" v={value.period} on={(n) => patch({ period: n })} />
          <CmpSel v={value.op} on={(op) => patch({ op })} />
          <Num label="Value" v={value.value} on={(n) => patch({ value: n })} step={0.1} />
        </div>
      )}

      {value.type === "supertrend" && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Period" v={value.period} on={(n) => patch({ period: n })} />
          <Num label="Multiplier" v={value.mult} on={(n) => patch({ mult: n })} step={0.1} />
          <DirSel v={value.direction} on={(d) => patch({ direction: d })} />
        </div>
      )}

      {value.type === "vwap_break" && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label mb-1">Direction</div>
            <select
              className="input"
              value={value.direction}
              onChange={(e) => patch({ direction: e.target.value as "above" | "below" })}
            >
              <option value="above">Cross above VWAP</option>
              <option value="below">Cross below VWAP</option>
            </select>
          </div>
        </div>
      )}

      {value.type === "macd_cross" && (
        <div className="grid grid-cols-4 gap-2">
          <Num label="Fast" v={value.fast} on={(n) => patch({ fast: n })} />
          <Num label="Slow" v={value.slow} on={(n) => patch({ slow: n })} />
          <Num label="Signal" v={value.signal} on={(n) => patch({ signal: n })} />
          <DirSel v={value.direction} on={(d) => patch({ direction: d })} />
        </div>
      )}

      {value.type === "breakout" && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Lookback" v={value.lookback} on={(n) => patch({ lookback: n })} />
          <DirSel v={value.direction} on={(d) => patch({ direction: d })} />
        </div>
      )}

      {value.type === "volume_spike" && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Lookback" v={value.lookback} on={(n) => patch({ lookback: n })} />
          <Num label="Factor" v={value.factor} on={(n) => patch({ factor: n })} step={0.1} />
        </div>
      )}

      {value.type === "dte" && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <CmpSel v={value.op} on={(op) => patch({ op })} />
            <Num
              label="Days"
              v={value.value}
              on={(n) => patch({ value: Math.max(0, Math.trunc(n)) })}
            />
            <div className="self-end pb-2 text-[10px] text-muted-foreground">
              <button
                type="button"
                className="text-primary hover:underline mr-2"
                onClick={() => patch({ op: "==", value: 0 })}
              >
                0DTE
              </button>
              <button
                type="button"
                className="text-primary hover:underline mr-2"
                onClick={() => patch({ op: "<=", value: 1 })}
              >
                ≤1
              </button>
              <button
                type="button"
                className="text-primary hover:underline mr-2"
                onClick={() => patch({ op: ">", value: 0 })}
              >
                Avoid expiry
              </button>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => patch({ op: ">=", value: 7 })}
              >
                ≥7
              </button>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Compares today against the basket&apos;s resolved-leg expiry. Examples:
            <span className="font-mono"> == 0</span> means expiry-day only;
            <span className="font-mono"> &gt; 0</span> means skip expiry day;
            <span className="font-mono"> &lt;= 7</span> means weekly window or shorter.
            Multi-leg with mixed expiries reads leg 0&apos;s expiry.
          </p>
        </div>
      )}

      {value.type === "time_trigger" && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label mb-1">Fire at (HH:MM, IST)</div>
            <input
              className="input"
              type="time"
              value={value.at}
              onChange={(e) => patch({ at: e.target.value })}
            />
          </div>
          <div className="self-end pb-2 text-[10px] text-muted-foreground">
            Fires true on the first candle of each day whose close-time crosses this
            target. Pure-time entry: use as the only entry rule for "open at 09:20".
          </div>
        </div>
      )}

      {value.type === "candle_pattern" && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label mb-1">Pattern</div>
            <select
              className="input"
              value={value.pattern}
              onChange={(e) => patch({ pattern: e.target.value as typeof value.pattern })}
            >
              <option value="bullish_engulfing">Bullish engulfing</option>
              <option value="bearish_engulfing">Bearish engulfing</option>
              <option value="doji">Doji</option>
            </select>
          </div>
        </div>
      )}

      {/* shared footer: symbol override (shortcuts only) + timeframe */}
      <div className="grid grid-cols-2 gap-2 pt-1">
        {hasOwnSymbolField && (
          <div>
            <div className="label mb-1">Apply to</div>
            <select
              className="input"
              value={(value as { symbol?: string }).symbol ?? ""}
              onChange={(e) =>
                patch({ symbol: e.target.value || undefined } as Partial<Condition>)
              }
            >
              <option value="">Current symbol (default)</option>
              {symbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
        <div className={hasOwnSymbolField ? "" : "col-span-2"}>
          <div className="label mb-1">Timeframe</div>
          <select
            className="input"
            value={value.timeframe ?? "same"}
            onChange={(e) =>
              patch({ timeframe: e.target.value === "same" ? undefined : e.target.value })
            }
          >
            {TF_OPTIONS.map((tf) => (
              <option key={tf} value={tf}>
                {tf === "same" ? "Same as strategy" : `Higher TF: ${tf}`}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function Num({ label, v, on, step }: { label: string; v: number; on: (n: number) => void; step?: number }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <input
        className="input"
        type="number"
        step={step ?? 1}
        value={v}
        onChange={(e) => on(Number(e.target.value))}
      />
    </div>
  );
}

function DirSel({ v, on }: { v: Direction; on: (d: Direction) => void }) {
  return (
    <div>
      <div className="label mb-1">Direction</div>
      <select className="input" value={v} onChange={(e) => on(e.target.value as Direction)}>
        <option value="up">Up</option>
        <option value="down">Down</option>
      </select>
    </div>
  );
}

function CmpSel({ v, on }: { v: ComparisonOp; on: (op: ComparisonOp) => void }) {
  return (
    <div>
      <div className="label mb-1">Comparison</div>
      <select className="input" value={v} onChange={(e) => on(e.target.value as ComparisonOp)}>
        {([">", "<", ">=", "<=", "==", "!="] as ComparisonOp[]).map((op) => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>
    </div>
  );
}
