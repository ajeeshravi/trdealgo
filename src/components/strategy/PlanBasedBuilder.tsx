"use client";
/**
 * Builder for PLAN_BASED strategies — auto-traders that read from the
 * EOD-derived "Tomorrow's Plan" sections and submit the top-N ideas at
 * 09:15 IST (NSE/BSE market open).
 *
 * Intentionally NOT routed through `EquityStrategyBuilder` because this
 * kind has no per-symbol universe and no entry/exit conditions — the
 * "universe" is the entire plan output, and the "conditions" are the
 * filters (section, min confidence, min R:R). Keeping the form
 * standalone keeps both builders simple.
 *
 * Submits to POST /strategies with `kind: "PLAN_BASED"` and a
 * `definition` JSON that the backend's `PlanDefinition.from_dict`
 * validates.
 */
import { useMemo, useState } from "react";

type Section = "fno_opportunities" | "intraday" | "index_options";

export interface PlanBasedForm {
  name: string;
  description: string;
  section: Section;
  top_n: number;
  min_confidence: number;
  min_rr: number;
  risk_pct_per_trade: number;   // stored as fraction (0.01 = 1%)
  entry_slippage_bps: number;
  product: "MIS" | "NRML";
  capital: number;
}

export function defaultPlanForm(): PlanBasedForm {
  return {
    name: "",
    description: "",
    section: "fno_opportunities",
    top_n: 5,
    min_confidence: 2,
    min_rr: 2.5,
    risk_pct_per_trade: 0.01,
    entry_slippage_bps: 50,
    product: "MIS",
    capital: 100000,
  };
}

export function validatePlanForm(f: PlanBasedForm): string | null {
  if (f.name.trim().length < 2) return "name is required";
  if (f.top_n < 1 || f.top_n > 15) return "top_n must be 1..15";
  if (f.min_confidence < 0 || f.min_confidence > 4) return "min_confidence must be 0..4";
  if (f.min_rr < 1) return "min_rr must be at least 1.0";
  if (f.risk_pct_per_trade <= 0 || f.risk_pct_per_trade > 0.1)
    return "risk per trade must be in (0%, 10%]";
  if (f.entry_slippage_bps < 0 || f.entry_slippage_bps > 500)
    return "slippage must be 0..500 bps";
  if (f.capital <= 0) return "capital must be > 0";
  return null;
}

export function buildPlanPayload(f: PlanBasedForm) {
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    kind: "PLAN_BASED",
    symbols: [],
    timeframe_min: null,
    capital: f.capital,
    code: null,
    definition: {
      instrument_class: "EQUITY",
      section: f.section,
      top_n: f.top_n,
      min_confidence: f.min_confidence,
      min_rr: f.min_rr,
      risk_pct_per_trade: f.risk_pct_per_trade,
      entry_slippage_bps: f.entry_slippage_bps,
      product: f.product,
    },
  };
}

const SECTIONS: { value: Section; label: string; hint: string }[] = [
  {
    value: "fno_opportunities",
    label: "F&O Opportunities",
    hint: "Single-stock F&O setups with R:R ≥ 2.5 and aligned buildup / EMA / delivery signals.",
  },
  {
    value: "intraday",
    label: "Intraday Stocks",
    hint: "Long / short / breakout cash-equity candidates from the Nifty 500. Tight stops.",
  },
  {
    value: "index_options",
    label: "Index Options",
    hint: "NIFTY / BANKNIFTY / SENSEX bias verdicts. Auto-execution not supported in v1 — preview only.",
  },
];

interface Props {
  value: PlanBasedForm;
  onChange: (next: PlanBasedForm) => void;
}

export function PlanBasedBuilder({ value, onChange }: Props) {
  const sectionMeta = useMemo(
    () => SECTIONS.find((s) => s.value === value.section) ?? SECTIONS[0],
    [value.section],
  );
  const indexWarning = value.section === "index_options";

  function set<K extends keyof PlanBasedForm>(key: K, v: PlanBasedForm[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-muted-foreground">Name</label>
          <input
            className="input mt-1 w-full"
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. F&O Top-5 Auto-Trader"
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">Description (optional)</label>
          <input
            className="input mt-1 w-full"
            value={value.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What this strategy does, who it's for…"
          />
        </div>
      </section>

      <section>
        <div className="text-sm font-medium mb-2">Plan section</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {SECTIONS.map((s) => {
            const active = s.value === value.section;
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => set("section", s.value)}
                className={
                  "p-3 rounded border text-left transition-colors " +
                  (active
                    ? "border-primary bg-primary/10"
                    : "border-border bg-panel hover:bg-panel2")
                }
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-xs text-muted-foreground mt-1">{s.hint}</div>
              </button>
            );
          })}
        </div>
        {indexWarning && (
          <div className="mt-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-3 py-2">
            Heads-up: index_options is preview-only in v1. The strategy will save and the
            dispatcher will run, but orders for multi-leg structures (iron condor, spreads)
            are skipped — execute these manually from the Tomorrow's Plan page.
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-muted-foreground">Top N picks per day</label>
          <input
            type="number"
            min={1}
            max={15}
            className="input mt-1 w-full"
            value={value.top_n}
            onChange={(e) => set("top_n", parseInt(e.target.value || "0", 10))}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Highest-conviction ideas. Conviction = R:R × (confidence + 1).
          </p>
        </div>

        <div>
          <label className="text-sm text-muted-foreground">Min confidence (0–4)</label>
          <input
            type="number"
            min={0}
            max={4}
            className="input mt-1 w-full"
            value={value.min_confidence}
            onChange={(e) => set("min_confidence", parseInt(e.target.value || "0", 10))}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Count of aligned signals required. Ignored for index_options.
          </p>
        </div>

        <div>
          <label className="text-sm text-muted-foreground">Min R:R</label>
          <input
            type="number"
            step={0.1}
            min={1}
            max={10}
            className="input mt-1 w-full"
            value={value.min_rr}
            onChange={(e) => set("min_rr", parseFloat(e.target.value || "0"))}
          />
        </div>

        <div>
          <label className="text-sm text-muted-foreground">Product</label>
          <select
            className="input mt-1 w-full"
            value={value.product}
            onChange={(e) => set("product", e.target.value as "MIS" | "NRML")}
          >
            <option value="MIS">MIS (intraday)</option>
            <option value="NRML">NRML (carryforward)</option>
          </select>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="text-sm text-muted-foreground">Capital ($)</label>
          <input
            type="number"
            min={1}
            className="input mt-1 w-full"
            value={value.capital}
            onChange={(e) => set("capital", parseFloat(e.target.value || "0"))}
          />
        </div>

        <div>
          <label className="text-sm text-muted-foreground">Risk per trade (%)</label>
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={10}
            className="input mt-1 w-full"
            value={(value.risk_pct_per_trade * 100).toFixed(2)}
            onChange={(e) =>
              set("risk_pct_per_trade", (parseFloat(e.target.value || "0") || 0) / 100)
            }
          />
          <p className="text-xs text-muted-foreground mt-1">
            qty = floor((capital × risk%) / |entry − stop|)
          </p>
        </div>

        <div>
          <label className="text-sm text-muted-foreground">Entry slippage (bps)</label>
          <input
            type="number"
            min={0}
            max={500}
            className="input mt-1 w-full"
            value={value.entry_slippage_bps}
            onChange={(e) => set("entry_slippage_bps", parseFloat(e.target.value || "0"))}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Buffer above trigger for SL-L limit price.
          </p>
        </div>
      </section>

      <section className="rounded border border-border bg-panel2 px-4 py-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground mb-1">How it runs</div>
        <ol className="list-decimal list-inside space-y-1">
          <li>Strategy is dormant until you click Start.</li>
          <li>
            Each weekday at <span className="text-foreground">09:15 IST (market open)</span>, the dispatcher
            reads today's Tomorrow's Plan ({sectionMeta.label}), filters by your floors, and picks
            the top {value.top_n} by conviction.
          </li>
          <li>
            Each pick is sent as a BRACKET SL-L order — entry triggers when the breakout level
            prints; SL and target are placed as soon as entry fills.
          </li>
          <li>
            Use <span className="text-foreground">/strategies/&lt;id&gt;/plan-preview</span> to
            dry-run what will be placed before market open.
          </li>
        </ol>
      </section>
    </div>
  );
}
