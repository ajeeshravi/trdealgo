"use client";
/**
 * Editor for a single indicator expression: picks an indicator from the
 * catalog, renders its parameter inputs, and exposes an optional symbol
 * override + bar offset.
 *
 * Used by both sides of a `compare` / `crossover` condition.
 */
import {
  IndicatorExpr,
  IndicatorName,
  INDICATOR_CATALOG,
  indicatorMeta,
} from "./types";

interface Props {
  value: IndicatorExpr;
  symbols: string[];
  onChange: (next: IndicatorExpr) => void;
  /** Hide the offset/source fields for a tighter inline layout. */
  compact?: boolean;
}

export function IndicatorExprEditor({ value, symbols, onChange, compact }: Props) {
  function setIndicator(name: IndicatorName) {
    const meta = indicatorMeta(name);
    const params: Record<string, number> = {};
    for (const p of meta.params) params[p.key] = p.default;
    onChange({
      indicator: name,
      params,
      source: value.source ?? "close",
      offset: value.offset ?? 0,
      symbol: value.symbol,
    });
  }

  const meta = indicatorMeta(value.indicator);

  return (
    <div className="space-y-2 rounded border border-border/60 bg-panel/40 p-2">
      <select
        className="input"
        value={value.indicator}
        onChange={(e) => setIndicator(e.target.value as IndicatorName)}
      >
        {INDICATOR_CATALOG.map((i) => (
          <option key={i.name} value={i.name}>{i.label}</option>
        ))}
      </select>

      {meta.params.length > 0 && (
        <div className={`grid gap-2 ${meta.params.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {meta.params.map((p) => (
            <div key={p.key}>
              <div className="label mb-1">{p.label}</div>
              <input
                className="input"
                type="number"
                step={p.step ?? 1}
                value={value.params?.[p.key] ?? p.default}
                onChange={(e) =>
                  onChange({
                    ...value,
                    params: { ...(value.params ?? {}), [p.key]: Number(e.target.value) },
                  })
                }
              />
            </div>
          ))}
        </div>
      )}

      {!compact && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="label mb-1">Source</div>
            <select
              className="input"
              value={value.source ?? "close"}
              onChange={(e) => onChange({ ...value, source: e.target.value as IndicatorExpr["source"] })}
              disabled={meta.params.length === 0 /* raw price/volume — source is implied */}
            >
              {["close", "high", "low", "open", "volume"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="label mb-1">Bar offset</div>
            <input
              className="input"
              type="number"
              max={0}
              value={value.offset ?? 0}
              onChange={(e) => onChange({ ...value, offset: Number(e.target.value) })}
              title="0 = current bar, -1 = previous bar, etc."
            />
          </div>
          <div>
            <div className="label mb-1">Symbol</div>
            <select
              className="input"
              value={value.symbol ?? ""}
              onChange={(e) => onChange({ ...value, symbol: e.target.value || undefined })}
            >
              <option value="">Strategy default</option>
              {symbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
