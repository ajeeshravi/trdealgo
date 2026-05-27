"use client";
/**
 * Multi-leg options builder — Phase C.
 *
 * Renders the leg list for an OPTIONS strategy. The user can:
 *   - Pick a named preset (Straddle / Strangle / Bull Call Spread / Bear
 *     Put Spread / Iron Condor) to populate legs in one click.
 *   - Switch to Custom and add / remove / edit legs manually.
 *   - For each leg: option type (CE/PE), action (BUY/SELL), strike mode +
 *     offset, expiry alias, and a qty ratio that multiplies the strategy's
 *     base sizing (1 = base lots, 0.5 = half, 2 = double).
 *
 * The strategy-level `feed_source` (FUTURES / SPOT / PREMIUM) lives on this
 * panel too because all legs share the same indicator feed.
 *
 * The panel is stateless about persistence — the parent owns the
 * OptionsConfig in form state. Mutations call `onChange` with the new
 * config; the parent merges it back into `form.options`.
 */
import { Plus, X } from "lucide-react";
import {
  OptionAction,
  OptionLeg,
  OptionsConfig,
  OptionStrategyPreset,
  OptionType,
  ExpiryAlias,
  PositionSizing,
  defaultOptionLeg,
  legsForPreset,
} from "@/components/strategy/types";

/** Largest leg's lot count drives `sizing.lots`; every other leg's
 *  `qty_ratio` is `leg_lots / base_lots`. Picking max keeps the "primary
 *  leg" semantics of `sizing.lots` intact (so risk caps / margin estimators
 *  reading `sizing.lots` see the biggest leg, not 1). */
function normaliseLotsToBaseAndRatios(legLots: number[]): {
  base: number;
  ratios: number[];
} {
  const max = legLots.reduce((m, n) => (n > m ? n : m), 0);
  if (max <= 0) return { base: 1, ratios: legLots.map(() => 0) };
  return { base: max, ratios: legLots.map((l) => l / max) };
}

const PRESET_OPTIONS: { value: OptionStrategyPreset; label: string; tip: string }[] = [
  { value: "SINGLE", label: "Single leg", tip: "One CE or PE — same as Phase 1." },
  { value: "STRADDLE_LONG", label: "Long Straddle", tip: "BUY ATM CE + BUY ATM PE — bet on a big move either direction." },
  { value: "STRADDLE_SHORT", label: "Short Straddle", tip: "SELL ATM CE + SELL ATM PE — range-bound; high margin." },
  { value: "STRANGLE_LONG", label: "Long Strangle", tip: "BUY OTM CE + BUY OTM PE — cheaper than straddle; needs a bigger move." },
  { value: "STRANGLE_SHORT", label: "Short Strangle", tip: "SELL OTM CE + SELL OTM PE — range-bound; lower theta than short straddle." },
  { value: "BULL_CALL_SPREAD", label: "Bull Call Spread", tip: "BUY ATM CE + SELL OTM CE — defined-risk bullish." },
  { value: "BEAR_PUT_SPREAD", label: "Bear Put Spread", tip: "BUY ATM PE + SELL OTM PE — defined-risk bearish." },
  { value: "IRON_CONDOR", label: "Iron Condor", tip: "Short OTM strangle + long further-OTM wings — range-bound with capped wings." },
  { value: "CUSTOM", label: "Custom", tip: "Hand-pick the legs." },
];

const MAX_LEGS = 6;

interface Props {
  value: OptionsConfig;
  onChange: (next: OptionsConfig) => void;
  /** Strategy-level sizing. When `sizing.mode === "LOTS"`, the leg rows
   *  switch from a ratio multiplier to absolute "Lots" inputs. */
  sizing: PositionSizing;
  /** Called when a per-leg absolute-lots edit needs to update BOTH the
   *  options config and `sizing.lots` together. Parents MUST apply both
   *  in a single state write — two sequential `onChange`s in the same
   *  handler will see a stale form snapshot for the second and lose one
   *  of the updates. */
  onLegLotsCommit: (opts: OptionsConfig, sizing: PositionSizing) => void;
}

export function MultiLegOptionsPanel({
  value,
  onChange,
  sizing,
  onLegLotsCommit,
}: Props) {
  const lotsMode = sizing.mode === "LOTS";
  const baseLots = lotsMode ? (sizing.lots ?? 1) : 1;

  function patch(p: Partial<OptionsConfig>) {
    onChange({ ...value, ...p });
  }

  /** User typed an absolute lot count into one leg's "Lots" cell. Recompute
   *  base_lots (= max leg lots) and rescale every ratio so the wire format
   *  stays consistent — `leg_qty = base_lots × qty_ratio` keeps working
   *  unchanged on the backend, and `sizing.lots` reflects the largest leg.
   *  Both writes go out as a single combined commit to avoid the stale-form
   *  overwrite that two sequential setters would cause. */
  function setLegLots(idx: number, newLotsForLeg: number) {
    const next = Math.max(0, Math.trunc(newLotsForLeg) || 0);
    const currentLots = value.legs.map((l, i) =>
      i === idx ? next : Math.round(baseLots * l.qty_ratio),
    );
    const { base, ratios } = normaliseLotsToBaseAndRatios(currentLots);
    const newLegs = value.legs.map((l, i) => ({ ...l, qty_ratio: ratios[i] }));
    onLegLotsCommit(
      { ...value, legs: newLegs, preset: "CUSTOM" },
      { ...sizing, lots: base },
    );
  }

  function applyPreset(preset: OptionStrategyPreset) {
    patch({ preset, legs: legsForPreset(preset) });
  }

  function updateLeg(idx: number, p: Partial<OptionLeg>) {
    const legs = value.legs.map((leg, i) => (i === idx ? { ...leg, ...p } : leg));
    // Any leg edit knocks the preset off its canonical shape — flip the
    // label to CUSTOM so the user isn't misled by a stale preset name.
    patch({ legs, preset: value.preset === "CUSTOM" ? "CUSTOM" : "CUSTOM" });
  }

  function addLeg() {
    if (value.legs.length >= MAX_LEGS) return;
    patch({ legs: [...value.legs, defaultOptionLeg()], preset: "CUSTOM" });
  }

  function removeLeg(idx: number) {
    // Always keep at least one leg so the form stays renderable.
    if (value.legs.length <= 1) return;
    patch({
      legs: value.legs.filter((_, i) => i !== idx),
      preset: "CUSTOM",
    });
  }

  const activePreset = PRESET_OPTIONS.find((p) => p.value === value.preset) ?? PRESET_OPTIONS[0];

  return (
    <div className="space-y-3">
      {/* ---------------- preset row ---------------- */}
      <div>
        <div className="label">Basket shape</div>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_OPTIONS.map((p) => {
            const isActive = value.preset === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => applyPreset(p.value)}
                className={`pill text-[11px] px-2.5 py-1 cursor-pointer transition-colors ${
                  isActive
                    ? "bg-primary/25 text-primary border border-primary/50"
                    : "bg-panel2 text-muted-foreground border border-border hover:bg-panel hover:text-foreground"
                }`}
                title={p.tip}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">{activePreset.tip}</p>
      </div>

      {/* ---------------- legs list ---------------- */}
      <div className="rounded-md border border-border/60 bg-panel2/30 p-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold">
            {value.legs.length} leg{value.legs.length === 1 ? "" : "s"}
          </div>
          <button
            type="button"
            onClick={addLeg}
            disabled={value.legs.length >= MAX_LEGS}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              value.legs.length >= MAX_LEGS
                ? `Capped at ${MAX_LEGS} legs`
                : "Add another leg"
            }
          >
            <Plus className="w-3.5 h-3.5" />
            Add leg
          </button>
        </div>
        <div className="space-y-1.5">
          {value.legs.map((leg, idx) => (
            <LegRow
              key={leg.id}
              index={idx}
              leg={leg}
              canRemove={value.legs.length > 1}
              lotsMode={lotsMode}
              baseLots={baseLots}
              onChange={(p) => updateLeg(idx, p)}
              onRemove={() => removeLeg(idx)}
              onLegLotsChange={(lots) => setLegLots(idx, lots)}
            />
          ))}
        </div>
        {lotsMode && (
          <div className="flex items-center justify-end text-[11px] text-muted-foreground pt-1 border-t border-border/40">
            Total lots across legs:{" "}
            <span className="font-mono text-foreground ml-1">
              {value.legs.reduce((s, l) => s + Math.round(baseLots * l.qty_ratio), 0)}
            </span>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          ITM / OTM steps translate to the underlying&apos;s strike interval at signal time
          (e.g. OTM 2 on NIFTY = +100 from ATM).
        </p>
      </div>

      {/* ---------------- feed source ---------------- */}
      <div>
        <div className="label" title="Which price the indicators evaluate against">
          Signal source
        </div>
        <select
          className="input max-w-xs"
          value={value.feed_source}
          onChange={(e) =>
            patch({
              feed_source: e.target.value as OptionsConfig["feed_source"],
            })
          }
        >
          <option value="FUTURES">Futures price (default — front-month future of the underlying)</option>
          <option value="SPOT">Spot price (cash index or cash equity)</option>
          <option value="PREMIUM">Option premium (indicators on the option&apos;s own price)</option>
        </select>
        <p className="text-[10px] text-muted-foreground mt-1">
          Indicators evaluate on the chosen feed; each leg&apos;s order routes to its own resolved
          contract. PREMIUM mode is only meaningful for single-leg baskets.
        </p>
      </div>
    </div>
  );
}

function LegRow({
  index,
  leg,
  canRemove,
  lotsMode,
  baseLots,
  onChange,
  onRemove,
  onLegLotsChange,
}: {
  index: number;
  leg: OptionLeg;
  canRemove: boolean;
  lotsMode: boolean;
  baseLots: number;
  onChange: (p: Partial<OptionLeg>) => void;
  onRemove: () => void;
  onLegLotsChange: (lots: number) => void;
}) {
  const absoluteLots = Math.round(baseLots * leg.qty_ratio);
  return (
    <div className="grid grid-cols-12 gap-1.5 items-center text-xs">
      <div className="col-span-1 text-muted-foreground font-mono pl-1">
        #{index + 1}
      </div>
      <select
        className="input col-span-2 h-8 text-xs"
        value={leg.option_type}
        onChange={(e) => onChange({ option_type: e.target.value as OptionType })}
        title="Call or Put"
      >
        <option value="CE">CE</option>
        <option value="PE">PE</option>
      </select>
      <select
        className={`input col-span-2 h-8 text-xs font-semibold ${
          leg.action === "BUY" ? "text-profit" : "text-loss"
        }`}
        value={leg.action}
        onChange={(e) => onChange({ action: e.target.value as OptionAction })}
        title={leg.action === "BUY" ? "Long the leg" : "Write (sell) the leg — needs margin"}
      >
        <option value="BUY">BUY</option>
        <option value="SELL">SELL</option>
      </select>
      <select
        className="input col-span-3 h-8 text-xs"
        value={leg.strike_mode === "ATM" ? "0" : String(leg.strike_offset)}
        onChange={(e) => {
          const off = parseInt(e.target.value, 10);
          onChange(
            off === 0
              ? { strike_mode: "ATM", strike_offset: 0 }
              : { strike_mode: "OFFSET", strike_offset: off },
          );
        }}
        title="Strike relative to the at-the-money strike. ITM = in-the-money, OTM = out-of-the-money. Steps translate to the underlying's strike interval at signal time."
      >
        <option value="-10">ITM 10 (deep)</option>
        <option value="-9">ITM 9</option>
        <option value="-8">ITM 8</option>
        <option value="-7">ITM 7</option>
        <option value="-6">ITM 6</option>
        <option value="-5">ITM 5</option>
        <option value="-4">ITM 4</option>
        <option value="-3">ITM 3</option>
        <option value="-2">ITM 2</option>
        <option value="-1">ITM 1</option>
        <option value="0">ATM</option>
        <option value="1">OTM 1</option>
        <option value="2">OTM 2</option>
        <option value="3">OTM 3</option>
        <option value="4">OTM 4</option>
        <option value="5">OTM 5</option>
        <option value="6">OTM 6</option>
        <option value="7">OTM 7</option>
        <option value="8">OTM 8</option>
        <option value="9">OTM 9</option>
        <option value="10">OTM 10 (deep)</option>
      </select>
      <select
        className="input col-span-2 h-8 text-xs"
        value={leg.expiry_alias}
        onChange={(e) => onChange({ expiry_alias: e.target.value as ExpiryAlias })}
        title="CURRENT = nearest listed expiry, NEXT = the one after that."
      >
        <option value="CURRENT">CUR</option>
        <option value="NEXT">NEXT</option>
      </select>
      {lotsMode ? (
        <input
          type="number"
          className="input col-span-1 h-8 text-xs font-mono text-center"
          value={absoluteLots}
          step={1}
          min={1}
          onChange={(e) => onLegLotsChange(Number(e.target.value))}
          title="Lots for this leg. Final leg qty = lots × lot_size (lot_size read from the option contract at run-time)."
        />
      ) : (
        <input
          type="number"
          className="input col-span-1 h-8 text-xs font-mono text-center"
          value={leg.qty_ratio}
          step={0.5}
          min={0}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange({ qty_ratio: Number.isFinite(v) && v > 0 ? v : leg.qty_ratio });
          }}
          title="Multiplier of base sizing (1 = base, 2 = double, 0.5 = half). Switch sizing mode to 'Fixed lots' to enter absolute lot counts per leg."
        />
      )}
      <div className="col-span-1 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          className="p-1 rounded text-muted-foreground hover:text-loss hover:bg-loss/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          title={canRemove ? "Remove this leg" : "Last remaining leg — at least one is required"}
          aria-label={`Remove leg ${index + 1}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
