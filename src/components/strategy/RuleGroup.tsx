"use client";
/**
 * AND / OR rule group editor.
 *
 * Owns the list of conditions for one phase (entry or exit). The
 * "+ Add condition" row exposes the two generic kinds (Compare,
 * Crossover) plus a "Shortcut" dropdown for the one-liners.
 */
import { useState } from "react";
import {
  Condition,
  ConditionKind,
  RuleGroup as RuleGroupT,
  defaultCondition,
} from "./types";
import { ConditionRow } from "./ConditionRow";

const SHORTCUTS: { kind: ConditionKind; label: string }[] = [
  { kind: "ema_cross",      label: "EMA crossover" },
  { kind: "rsi",            label: "RSI threshold" },
  { kind: "supertrend",     label: "Supertrend flip" },
  { kind: "vwap_break",     label: "VWAP break" },
  { kind: "macd_cross",     label: "MACD crossover" },
  { kind: "breakout",       label: "N-bar breakout" },
  { kind: "volume_spike",   label: "Volume spike" },
  { kind: "candle_pattern", label: "Candle pattern" },
];

interface Props {
  title: string;
  hint?: string;
  value: RuleGroupT;
  symbols: string[];
  onChange: (next: RuleGroupT) => void;
}

export function RuleGroup({ title, hint, value, symbols, onChange }: Props) {
  const [shortcutPick, setShortcutPick] = useState<ConditionKind>("ema_cross");

  function setCondition(i: number, c: Condition) {
    const next = value.conditions.slice();
    next[i] = c;
    onChange({ ...value, conditions: next });
  }
  function removeCondition(i: number) {
    onChange({ ...value, conditions: value.conditions.filter((_, idx) => idx !== i) });
  }
  function addCondition(kind: ConditionKind) {
    onChange({ ...value, conditions: [...value.conditions, defaultCondition(kind)] });
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="label">Combine with</span>
          <select
            className="input w-24"
            value={value.combinator}
            onChange={(e) => onChange({ ...value, combinator: e.target.value as "all" | "any" })}
          >
            <option value="all">AND</option>
            <option value="any">OR</option>
          </select>
        </div>
      </div>

      <div className="space-y-2">
        {value.conditions.map((c, i) => (
          <ConditionRow
            key={c.id}
            value={c}
            symbols={symbols}
            onChange={(next) => setCondition(i, next)}
            onRemove={() => removeCondition(i)}
          />
        ))}
        {value.conditions.length === 0 && (
          <div className="text-xs text-muted-foreground italic text-center py-3">
            No conditions yet — add one below.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="label">+ Add:</span>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={() => addCondition("compare")}
        >
          Compare
        </button>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={() => addCondition("crossover")}
        >
          Crossover
        </button>
        <span className="label pl-2">or shortcut:</span>
        <select
          className="input w-44 py-1.5 text-xs"
          value={shortcutPick}
          onChange={(e) => setShortcutPick(e.target.value as ConditionKind)}
        >
          {SHORTCUTS.map((s) => (
            <option key={s.kind} value={s.kind}>{s.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={() => addCondition(shortcutPick)}
        >
          Add
        </button>
      </div>
    </div>
  );
}
