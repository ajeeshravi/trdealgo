"use client";
/**
 * Visual builder for an equity strategy form. Stateless about persistence
 * — the parent owns the form state and the submit handler. Used by both
 * the create page (/strategies/new) and the edit page (/strategies/[id]).
 */
import useSWR from "swr";
import { ExchangeSymbolPicker } from "@/components/ExchangeSymbolPicker";
import { RuleGroup } from "@/components/strategy/RuleGroup";
import { SizingPanel } from "@/components/strategy/SizingPanel";
import {
  PartialExitsPanel,
  PyramidingPanel,
  ReentryPanel,
} from "@/components/strategy/AdvancedPanels";
import { BasketImporter } from "@/components/strategy/BasketImporter";
import { MultiLegOptionsPanel } from "@/components/strategy/MultiLegOptionsPanel";
import { api } from "@/lib/api";
import { EquityStrategyForm, toDefinition } from "@/components/strategy/types";

const brokerFetcher = (u: string) => api.get(u).then((r) => r.data);

type BrokerAccount = {
  id: string;
  broker: string;
  client_id: string;
  label?: string | null;
  is_active: boolean;
  session_valid_until?: string | null;
};

function brokerLabel(a: BrokerAccount): string {
  return `${a.broker} · ${a.client_id}${a.label ? ` (${a.label})` : ""}`;
}

const TIMEFRAMES = [1, 3, 5, 15, 30, 60, 240, 1440];

interface Props {
  value: EquityStrategyForm;
  onChange: (next: EquityStrategyForm) => void;
  pendingSymbol: string;
  onPendingSymbolChange: (v: string) => void;
}

export function EquityStrategyBuilder({
  value: form,
  onChange,
  pendingSymbol,
  onPendingSymbolChange,
}: Props) {
  const set = <K extends keyof EquityStrategyForm>(k: K, v: EquityStrategyForm[K]) =>
    onChange({ ...form, [k]: v });

  function removeSymbol(s: string) {
    onChange({ ...form, symbols: form.symbols.filter((x) => x !== s) });
  }

  const definitionPreview = toDefinition(form);

  return (
    <div className="space-y-5">
      {/* ----------------------- Basics ------------------------------ */}
      <section className="card grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="col-span-2">
          <div className="label">Name</div>
          <input
            className="input"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. NIFTY-500 EMA cross"
            required
          />
        </div>
        <div>
          <div className="label">Timeframe</div>
          <select
            className="input"
            value={form.timeframe_min}
            onChange={(e) => set("timeframe_min", Number(e.target.value))}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf >= 1440 ? "Daily" : tf >= 60 ? `${tf / 60}h` : `${tf}m`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="label">Total capital (₹)</div>
          <input
            className="input"
            type="number"
            min={0}
            value={form.capital}
            onChange={(e) => set("capital", Number(e.target.value))}
          />
        </div>
        <div className="col-span-2 lg:col-span-4">
          <div className="label">Description</div>
          <input
            className="input"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What does this strategy do?"
          />
        </div>
      </section>

      {/* --------------------- Instruments --------------------------- */}
      <section className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {form.instrument_class === "FUTURES"
              ? "Futures contracts"
              : form.instrument_class === "OPTIONS"
                ? "Options underlying"
                : "Equity universe"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {form.instrument_class === "FUTURES"
              ? "NFO / BFO / MCX / CDS futures. Pick exchange → underlying → expiry; option-type is locked to FUT."
              : form.instrument_class === "OPTIONS"
                ? "Pick the F&O underlying (NFO / BFO / MCX / CDS). The engine uses this contract's price feed for indicators and picks the actual CE/PE strike at signal time from the matching option chain."
                : "Cash-segment NSE / BSE stocks only. Add symbols one-by-one, or import a watchlist below."}
          </p>
        </div>
        <ExchangeSymbolPicker
          equityOnly={form.instrument_class === "EQUITY"}
          futuresOnly={form.instrument_class === "FUTURES"}
          // Options-underlying mode: the picker hides its own expiry
          // dropdown (the strategy's option-leg block owns that choice)
          // and auto-emits the `<EXCH>_<UND>_@OPT` alias as soon as
          // Exchange + Symbol are filled.
          optionsUnderlyingOnly={form.instrument_class === "OPTIONS"}
          value={pendingSymbol}
          onChange={(v) => {
            onPendingSymbolChange(v);
            if (v && !form.symbols.includes(v)) {
              onChange({ ...form, symbols: [...form.symbols, v] });
              onPendingSymbolChange("");
            }
          }}
        />
        {/* Basket imports apply to equity / futures universes; options live
            in their own picker since each leg has CE/PE + strike + expiry
            that can't be expressed as a flat symbol list. */}
        {form.instrument_class !== "OPTIONS" && (
          <BasketImporter
            existingSymbols={form.symbols}
            basketSource={form.basket_source}
            onImport={(syms, source) =>
              onChange({ ...form, symbols: syms, basket_source: source })
            }
            onClearSource={() => onChange({ ...form, basket_source: undefined })}
          />
        )}
        {form.symbols.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {form.symbols.map((s) => (
              <span
                key={s}
                className="pill bg-primary/20 text-primary font-mono inline-flex items-center gap-1"
              >
                {s}
                <button
                  type="button"
                  className="text-primary/70 hover:text-primary"
                  onClick={() => removeSymbol(s)}
                  aria-label={`Remove ${s}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            No symbols yet — pick one above or import a watchlist.
          </div>
        )}

        {/* OPTIONS strategies: the picker above is intentionally limited
            to Exchange + Underlying (it emits `<EXCH>_<UND>_@OPT`).
            Every per-leg choice — CE/PE, strike, expiry alias, action,
            qty ratio — is owned by the MultiLegOptionsPanel below, which
            is the single source of truth for the strategy's legs and is
            what the backend reads from `definition.params.option_config`. */}
        {form.instrument_class === "OPTIONS" && (
          <div className="pt-2 border-t border-border/60">
            <MultiLegOptionsPanel
              value={form.options}
              onChange={(opts) => set("options", opts)}
              sizing={form.sizing}
              onLegLotsCommit={(opts, s) =>
                onChange({ ...form, options: opts, sizing: s })
              }
            />
            <p className="text-[10px] text-muted-foreground mt-2">
              Pyramiding, partial exits and premium-based trails apply per-leg and may
              behave differently across baskets — keep them off when first wiring up a
              multi-leg strategy.
            </p>
          </div>
        )}
      </section>

      {/* ----------------- Trading mode + sizing --------------------- */}
      <section className="card grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <div className="label">Product</div>
          <select
            className="input"
            value={form.product}
            onChange={(e) => {
              const product = e.target.value as EquityStrategyForm["product"];
              // CNC (delivery) doesn't allow short-selling — snap back to LONG
              // when the user flips an EQUITY strategy into delivery.
              if (
                form.instrument_class === "EQUITY"
                && product === "CNC"
                && form.side === "SHORT"
              ) {
                onChange({ ...form, product, side: "LONG" });
              } else {
                set("product", product);
              }
            }}
          >
            <option value="MIS">Intraday (MIS)</option>
            {form.instrument_class === "EQUITY" && <option value="CNC">Delivery (CNC)</option>}
            {(form.instrument_class === "FUTURES" || form.instrument_class === "OPTIONS") && (
              <option value="NRML">Carryforward (NRML)</option>
            )}
          </select>
        </div>
        {/* Side selector — EQUITY+CNC is long-only (no short-delivery
            on retail cash); options express direction via the leg's
            BUY/SELL action below, not via this top-level flag. */}
        {form.instrument_class !== "OPTIONS"
          && !(form.instrument_class === "EQUITY" && form.product === "CNC") && (
          <div>
            <div className="label">Side</div>
            <select
              className="input"
              value={form.side}
              onChange={(e) => set("side", e.target.value as EquityStrategyForm["side"])}
            >
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </div>
        )}
        <div>
          <div className="label">Order type</div>
          <select
            className="input"
            value={form.order_type}
            onChange={(e) => set("order_type", e.target.value as EquityStrategyForm["order_type"])}
          >
            <option value="MARKET">Market</option>
            <option value="LIMIT">Limit</option>
          </select>
        </div>
        {form.order_type === "LIMIT" && (
          <div>
            <div className="label">Limit offset (%)</div>
            <input
              className="input"
              type="number"
              step={0.001}
              value={form.limit_offset_pct}
              onChange={(e) => set("limit_offset_pct", Number(e.target.value))}
            />
          </div>
        )}
      </section>

      <SizingPanel
        value={form.sizing}
        onChange={(s) => set("sizing", s)}
        instrumentClass={form.instrument_class}
        optionsLegsTotalLots={
          form.instrument_class === "OPTIONS"
            ? form.options.legs.reduce(
                (sum, l) => sum + Math.round((form.sizing.lots ?? 1) * l.qty_ratio),
                0,
              )
            : undefined
        }
      />

      {/* --------------------- Time-window --------------------------- */}
      <section className="card space-y-2">
        <label className="inline-flex items-center gap-2 text-sm font-semibold cursor-pointer">
          <input
            type="checkbox"
            checked={form.time_filters.enabled}
            onChange={(e) =>
              set("time_filters", { ...form.time_filters, enabled: e.target.checked })
            }
          />
          Restrict entries to a time window
        </label>
        {form.time_filters.enabled && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <div className="label mb-1">Earliest entry (HH:MM)</div>
              <input
                className="input"
                placeholder="09:30"
                value={form.time_filters.entry_start ?? ""}
                onChange={(e) =>
                  set("time_filters", { ...form.time_filters, entry_start: e.target.value })
                }
              />
            </div>
            <div>
              <div className="label mb-1">Latest entry (HH:MM)</div>
              <input
                className="input"
                placeholder="15:00"
                value={form.time_filters.entry_end ?? ""}
                onChange={(e) =>
                  set("time_filters", { ...form.time_filters, entry_end: e.target.value })
                }
              />
            </div>
            <div className="col-span-2 lg:col-span-2 text-xs text-muted-foreground self-end pb-2">
              New entries fire only inside this window; exits and SL/Target run anytime.
            </div>
          </div>
        )}
      </section>

      <RuleGroup
        title="Entry conditions"
        hint={entryHint(form)}
        value={form.entry}
        symbols={form.symbols}
        onChange={(g) => set("entry", g)}
      />

      <RuleGroup
        title="Exit conditions"
        hint={exitHint(form)}
        value={form.exit}
        symbols={form.symbols}
        onChange={(g) => set("exit", g)}
      />

      {/* ----------------- SL/Target + risk rules -------------------- */}
      <section className="card grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <div className="label">Stop loss (%)</div>
          <input
            className="input"
            type="number"
            step={0.001}
            value={form.risk.stop_loss_pct ?? 0}
            onChange={(e) => set("risk", { ...form.risk, stop_loss_pct: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className="label">Target (%)</div>
          <input
            className="input"
            type="number"
            step={0.001}
            value={form.risk.target_pct ?? 0}
            onChange={(e) => set("risk", { ...form.risk, target_pct: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className="label">Trailing SL (%)</div>
          <input
            className="input"
            type="number"
            step={0.001}
            value={form.risk.trailing_sl_pct ?? 0}
            onChange={(e) =>
              set("risk", { ...form.risk, trailing_sl_pct: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <div className="label">Time-based exit</div>
          <input
            className="input"
            placeholder="15:15"
            value={form.risk.time_based_exit ?? ""}
            onChange={(e) =>
              set("risk", { ...form.risk, time_based_exit: e.target.value || undefined })
            }
          />
        </div>
        <div>
          <div className="label">Max qty / order</div>
          <input
            className="input"
            type="number"
            value={form.risk.max_qty_per_order ?? 0}
            onChange={(e) =>
              set("risk", { ...form.risk, max_qty_per_order: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <div className="label">Max open positions</div>
          <input
            className="input"
            type="number"
            value={form.risk.max_open_positions ?? 0}
            onChange={(e) =>
              set("risk", { ...form.risk, max_open_positions: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <div className="label">Max daily loss (₹)</div>
          <input
            className="input"
            type="number"
            value={form.risk.max_daily_loss ?? 0}
            onChange={(e) =>
              set("risk", { ...form.risk, max_daily_loss: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <div className="label">Max daily profit (₹)</div>
          <input
            className="input"
            type="number"
            value={form.risk.max_daily_profit ?? 0}
            onChange={(e) =>
              set("risk", { ...form.risk, max_daily_profit: Number(e.target.value) })
            }
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm col-span-2 lg:col-span-4">
          <input
            type="checkbox"
            checked={form.risk.force_square_off}
            onChange={(e) => set("risk", { ...form.risk, force_square_off: e.target.checked })}
          />
          Force square-off at time-based exit
        </label>
      </section>

      <PyramidingPanel value={form.pyramiding} onChange={(p) => set("pyramiding", p)} />
      <ReentryPanel value={form.reentry} onChange={(r) => set("reentry", r)} />
      <PartialExitsPanel value={form.partial_exits} onChange={(p) => set("partial_exits", p)} />

      <AutoStartPanel
        enabled={form.auto_start_on_login}
        brokerAccountId={form.auto_start_broker_account_id}
        isPaper={form.auto_start_is_paper}
        onChange={(next) =>
          onChange({
            ...form,
            auto_start_on_login: next.enabled,
            auto_start_broker_account_id: next.brokerAccountId,
            auto_start_is_paper: next.isPaper,
          })
        }
      />

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">
          JSON preview (what gets stored as `definition`)
        </summary>
        <pre className="text-xs mt-2 max-h-72 overflow-auto bg-panel2 p-2 rounded">
{JSON.stringify(definitionPreview, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** Shared client-side validation for both create and edit submits. Returns
 *  an error message, or null if the form is OK to send. */
export function validateForm(form: EquityStrategyForm): string | null {
  if (!form.name.trim()) return "name is required";
  if (form.symbols.length === 0) return "add at least one equity symbol";
  if (form.entry.conditions.length === 0) return "entry block needs at least one condition";
  if (form.partial_exits.enabled) {
    const total = form.partial_exits.legs.reduce((s, l) => s + l.qty_pct, 0);
    if (total > 100) return "partial-exit legs sum to more than 100%";
  }
  if (form.instrument_class === "EQUITY" && form.product === "CNC" && form.side === "SHORT") {
    return "EQUITY-CNC (delivery) does not allow short selling — switch to MIS or change side to LONG";
  }
  if (form.instrument_class === "OPTIONS") {
    if (form.options.legs.length === 0) {
      return "option basket needs at least one leg";
    }
    for (const leg of form.options.legs) {
      if (!(leg.qty_ratio > 0)) {
        return "every option leg needs a positive qty ratio";
      }
    }
  }
  if (form.auto_start_on_login && !form.auto_start_broker_account_id) {
    return "auto-start is enabled — pick a broker account or turn it off";
  }
  return null;
}

function entryHint(form: EquityStrategyForm): string {
  if (form.instrument_class === "OPTIONS") {
    const legs = form.options.legs;
    if (legs.length === 1) {
      return legs[0].action === "SELL"
        ? "Strategy writes (sells) the chosen CE/PE leg when these are satisfied."
        : "Strategy buys the chosen CE/PE leg when these are satisfied.";
    }
    return `Strategy opens all ${legs.length} legs of the basket when these are satisfied.`;
  }
  return form.side === "SHORT"
    ? "Strategy goes short when these are satisfied."
    : "Strategy goes long when these are satisfied.";
}

function exitHint(form: EquityStrategyForm): string {
  if (form.instrument_class === "OPTIONS") {
    const legs = form.options.legs;
    if (legs.length === 1) {
      return legs[0].action === "SELL"
        ? "Strategy buys back the written leg when any one of these fires (or SL/Target below trips first)."
        : "Strategy sells the bought leg when any one of these fires (or SL/Target below trips first).";
    }
    return `Strategy closes all ${legs.length} legs of the basket when any one of these fires (or SL/Target below trips first).`;
  }
  return form.side === "SHORT"
    ? "Strategy covers the short when any one of these fires (or SL/Target below trips first)."
    : "Strategy closes the long when any one of these fires (or SL/Target below trips first).";
}

/** Auto-start-on-broker-login panel. Self-contained because it needs to
 *  fetch the broker accounts list to render the dropdown — keeping that
 *  fetch inline (instead of plumbed through props) avoids forcing every
 *  caller of <EquityStrategyBuilder> to know about brokers. */
function AutoStartPanel({
  enabled,
  brokerAccountId,
  isPaper,
  onChange,
}: {
  enabled: boolean;
  brokerAccountId: string | null;
  isPaper: boolean;
  onChange: (next: { enabled: boolean; brokerAccountId: string | null; isPaper: boolean }) => void;
}) {
  const { data: accounts } = useSWR<BrokerAccount[]>("/brokers", brokerFetcher);
  const active = (accounts || []).filter((a) => a.is_active);

  // If the user disables the toggle we clear the broker picker so a stale
  // selection doesn't quietly persist if they re-enable later from a stale
  // browser tab. The backend re-validates anyway, but this keeps the UI
  // consistent.
  function setEnabled(v: boolean) {
    onChange({
      enabled: v,
      brokerAccountId: v ? brokerAccountId : null,
      isPaper,
    });
  }

  return (
    <section className="card">
      <header className="flex items-center justify-between gap-3 mb-2">
        <div>
          <h3 className="text-sm font-semibold">Auto-start on broker login</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            When the chosen broker auto-logs-in (configured on the Admin page),
            this strategy starts automatically — no manual click.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </header>

      {enabled && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
          <div className="lg:col-span-2">
            <div className="label">Broker account</div>
            <select
              className="input"
              value={brokerAccountId || ""}
              onChange={(e) =>
                onChange({
                  enabled,
                  brokerAccountId: e.target.value || null,
                  isPaper,
                })
              }
              required
            >
              <option value="" disabled>
                — pick a broker account —
              </option>
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {brokerLabel(a)}
                </option>
              ))}
            </select>
            {active.length === 0 && (
              <p className="text-[11px] text-warning mt-1">
                No active broker accounts. Add one on the Brokers page first.
              </p>
            )}
          </div>
          <div>
            <div className="label">Mode</div>
            <div className="flex items-center gap-3 pt-2">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="auto_start_mode"
                  checked={!isPaper}
                  onChange={() =>
                    onChange({ enabled, brokerAccountId, isPaper: false })
                  }
                />
                Live
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="auto_start_mode"
                  checked={isPaper}
                  onChange={() =>
                    onChange({ enabled, brokerAccountId, isPaper: true })
                  }
                />
                Paper
              </label>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** The wire-format payload accepted by POST /strategies and PUT /strategies/{id}. */
export function buildPayload(form: EquityStrategyForm) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    kind: "NO_CODE",
    symbols: form.symbols,
    timeframe_min: form.timeframe_min,
    capital: form.capital,
    definition: toDefinition(form),
    code: null,
    risk: form.risk,
    auto_start_on_login: form.auto_start_on_login,
    auto_start_broker_account_id: form.auto_start_broker_account_id,
    auto_start_is_paper: form.auto_start_is_paper,
  };
}
