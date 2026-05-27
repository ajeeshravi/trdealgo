"use client";
/**
 * Three advanced position-management panels:
 *
 *   - Pyramiding     scale into a winning position with N additional adds
 *   - Re-entry       allow N new entries after a stop / target / generic exit
 *   - Partial Exits  ladder out of a position at successive % targets
 *
 * These map to `params.pyramiding`, `params.reentry`, `params.partial_exits`
 * in the JSON sent to the backend.
 */
import {
  PartialExitConfig,
  PartialExitLeg,
  PyramidingConfig,
  ReentryConfig,
  newId,
} from "./types";

/* ----------------------------- Pyramiding ----------------------------- */

interface PyramidingProps {
  value: PyramidingConfig;
  onChange: (next: PyramidingConfig) => void;
}

export function PyramidingPanel({ value, onChange }: PyramidingProps) {
  return (
    <details className="card" open={value.enabled}>
      <summary className="cursor-pointer text-sm font-semibold flex items-center justify-between">
        <span>Pyramiding (scale-in)</span>
        <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          Enable
        </label>
      </summary>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
        <div>
          <div className="label mb-1">Max additional adds</div>
          <input
            className="input"
            type="number"
            min={1}
            value={value.max_adds}
            onChange={(e) => onChange({ ...value, max_adds: Number(e.target.value) })}
            disabled={!value.enabled}
          />
        </div>
        <div>
          <div className="label mb-1">Trigger</div>
          <select
            className="input"
            value={value.trigger}
            onChange={(e) =>
              onChange({ ...value, trigger: e.target.value as PyramidingConfig["trigger"] })
            }
            disabled={!value.enabled}
          >
            <option value="price_step">Every N% price move</option>
            <option value="same_signal">Same entry signal fires again</option>
          </select>
        </div>
        {value.trigger === "price_step" && (
          <div>
            <div className="label mb-1">Price step (%)</div>
            <input
              className="input"
              type="number"
              step={0.001}
              value={value.price_step_pct ?? 0.01}
              onChange={(e) => onChange({ ...value, price_step_pct: Number(e.target.value) })}
              disabled={!value.enabled}
            />
          </div>
        )}
        <div>
          <div className="label mb-1">Add size multiplier</div>
          <input
            className="input"
            type="number"
            step={0.1}
            value={value.qty_multiplier ?? 1}
            onChange={(e) => onChange({ ...value, qty_multiplier: Number(e.target.value) })}
            disabled={!value.enabled}
          />
        </div>
      </div>
    </details>
  );
}

/* ------------------------------ Re-entry ------------------------------ */

interface ReentryProps {
  value: ReentryConfig;
  onChange: (next: ReentryConfig) => void;
}

export function ReentryPanel({ value, onChange }: ReentryProps) {
  return (
    <details className="card" open={value.enabled}>
      <summary className="cursor-pointer text-sm font-semibold flex items-center justify-between">
        <span>Re-entry</span>
        <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          Enable
        </label>
      </summary>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
        <div>
          <div className="label mb-1">Re-enter after</div>
          <select
            className="input"
            value={value.after}
            onChange={(e) => onChange({ ...value, after: e.target.value as ReentryConfig["after"] })}
            disabled={!value.enabled}
          >
            <option value="any_exit">Any exit</option>
            <option value="sl_hit">Stop-loss hit</option>
            <option value="target_hit">Target hit</option>
          </select>
        </div>
        <div>
          <div className="label mb-1">Max re-entries / day</div>
          <input
            className="input"
            type="number"
            min={1}
            value={value.max_per_day}
            onChange={(e) => onChange({ ...value, max_per_day: Number(e.target.value) })}
            disabled={!value.enabled}
          />
        </div>
        <div>
          <div className="label mb-1">Cooldown (candles)</div>
          <input
            className="input"
            type="number"
            min={0}
            value={value.cooldown_candles}
            onChange={(e) => onChange({ ...value, cooldown_candles: Number(e.target.value) })}
            disabled={!value.enabled}
          />
        </div>
      </div>
    </details>
  );
}

/* --------------------------- Partial exits ---------------------------- */

interface PartialExitProps {
  value: PartialExitConfig;
  onChange: (next: PartialExitConfig) => void;
}

export function PartialExitsPanel({ value, onChange }: PartialExitProps) {
  function setLeg(i: number, leg: PartialExitLeg) {
    const next = value.legs.slice();
    next[i] = leg;
    onChange({ ...value, legs: next });
  }
  function removeLeg(i: number) {
    onChange({ ...value, legs: value.legs.filter((_, idx) => idx !== i) });
  }
  function addLeg() {
    onChange({
      ...value,
      legs: [...value.legs, { id: newId("leg"), qty_pct: 25, target_pct: 0.03 }],
    });
  }

  const totalPct = value.legs.reduce((s, l) => s + l.qty_pct, 0);

  return (
    <details className="card" open={value.enabled}>
      <summary className="cursor-pointer text-sm font-semibold flex items-center justify-between">
        <span>Partial exits (ladder)</span>
        <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          Enable
        </label>
      </summary>
      <div className="mt-3 space-y-2">
        {value.legs.map((leg, i) => (
          <div key={leg.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <div>
              <div className="label mb-1">Leg {i + 1} — qty %</div>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={leg.qty_pct}
                onChange={(e) => setLeg(i, { ...leg, qty_pct: Number(e.target.value) })}
                disabled={!value.enabled}
              />
            </div>
            <div>
              <div className="label mb-1">Trigger at % move</div>
              <input
                className="input"
                type="number"
                step={0.001}
                value={leg.target_pct}
                onChange={(e) => setLeg(i, { ...leg, target_pct: Number(e.target.value) })}
                disabled={!value.enabled}
              />
            </div>
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => removeLeg(i)}
              disabled={!value.enabled}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            className="btn-outline text-xs"
            onClick={addLeg}
            disabled={!value.enabled}
          >
            + Add leg
          </button>
          <div className={`text-xs ${totalPct > 100 ? "text-danger" : "text-muted-foreground"}`}>
            Total exit qty: {totalPct}% {totalPct > 100 && "(must be ≤ 100)"}
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-xs pt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value.trail_remainder}
            onChange={(e) => onChange({ ...value, trail_remainder: e.target.checked })}
            disabled={!value.enabled}
          />
          Trail the remaining position after the last leg
        </label>
      </div>
    </details>
  );
}
