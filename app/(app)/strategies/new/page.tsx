"use client";
/**
 * New strategy — thin wrapper around <EquityStrategyBuilder>.
 *
 * Owns only the form state, the instrument-class tab toggle, and the
 * POST /strategies submit. All form rendering lives in the shared
 * builder component which the edit page also reuses.
 *
 * Switching the instrument-class tab is destructive in two ways:
 *   - Resets the form to the new class's defaults (sizing mode, product,
 *     etc. differ between Equity and Futures).
 *   - Clears the symbol list because equity vs futures internal_symbols
 *     are mutually exclusive (NSE_RELIANCE-EQ won't validate as a future).
 *
 * Using the themed confirm dialog so the user doesn't lose work
 * accidentally if they click the wrong tab mid-build.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  EquityStrategyBuilder,
  buildPayload,
  validateForm,
} from "@/components/strategy/EquityStrategyBuilder";
import {
  EquityStrategyForm,
  InstrumentClass,
  defaultForm,
} from "@/components/strategy/types";
import {
  PlanBasedBuilder,
  PlanBasedForm,
  defaultPlanForm,
  buildPlanPayload,
  validatePlanForm,
} from "@/components/strategy/PlanBasedBuilder";

// "PLAN" is a tab kind only — not stored on the backend as an
// instrument_class. It selects the PLAN_BASED strategy kind in the
// payload instead. Kept in the same tab list so users discover it
// alongside the other strategy types.
type BuilderTab = InstrumentClass | "PLAN";

const TABS: { kind: BuilderTab; label: string; hint: string }[] = [
  {
    kind: "EQUITY",
    label: "Equity",
    hint: "Cash-segment NSE / BSE stocks",
  },
  {
    kind: "FUTURES",
    label: "Futures",
    hint: "Single-contract NFO / BFO / MCX / CDS futures",
  },
  {
    kind: "OPTIONS",
    label: "Options",
    hint: "Single-leg options on an index or stock — strike picked at signal time",
  },
  {
    kind: "PLAN",
    label: "Plan Auto-Trader",
    hint: "Auto-execute the top-N ideas from Tomorrow's Plan at 09:15 IST (market open) every weekday",
  },
];

export default function NewStrategyPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [tab, setTab] = useState<BuilderTab>("EQUITY");
  const [form, setForm] = useState<EquityStrategyForm>(() => defaultForm("EQUITY"));
  const [planForm, setPlanForm] = useState<PlanBasedForm>(() => defaultPlanForm());
  const [pendingSymbol, setPendingSymbol] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function switchTab(kind: BuilderTab) {
    if (kind === tab) return;
    // Only block-and-confirm if the user has done meaningful work that
    // would be lost. A pristine form (no name, no symbols, default
    // entry/exit) can be reset silently.
    const equityDirty =
      form.name.trim() !== "" ||
      form.symbols.length > 0 ||
      form.description.trim() !== "";
    const planDirty =
      planForm.name.trim() !== "" || planForm.description.trim() !== "";
    const dirty = tab === "PLAN" ? planDirty : equityDirty;
    if (dirty) {
      const labels: Record<BuilderTab, string> = {
        EQUITY: "Equity",
        FUTURES: "Futures",
        OPTIONS: "Options",
        PLAN: "Plan Auto-Trader",
      };
      const ok = await confirm({
        title: `Switch to ${labels[kind]}?`,
        message:
          "Switching builder resets the form to defaults. Each kind has its own " +
          "configuration shape — equity / futures / options strategies define entry " +
          "rules and symbols, plan auto-traders read from the daily Tomorrow's Plan.",
        confirmLabel: "Reset and switch",
        cancelLabel: "Stay here",
        variant: "warning",
      });
      if (!ok) return;
    }
    setTab(kind);
    if (kind === "PLAN") {
      setPlanForm(defaultPlanForm());
    } else {
      setForm(defaultForm(kind));
      setPendingSymbol("");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (tab === "PLAN") {
      const err = validatePlanForm(planForm);
      if (err) {
        toast.error(err);
        return;
      }
      setSubmitting(true);
      try {
        await api.post("/strategies", buildPlanPayload(planForm));
        toast.success("plan auto-trader created");
        // Return to the strategies list so the user sees their new
        // entry appear in the card grid alongside their existing ones.
        router.push("/strategies");
      } catch (err: any) {
        toast.error(err?.response?.data?.error?.message || "create failed");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const err = validateForm(form);
    if (err) {
      toast.error(err);
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/strategies", buildPayload(form));
      toast.success("strategy created");
      router.push("/strategies");
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message || "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  const activeTab = TABS.find((t) => t.kind === tab) ?? TABS[0];

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold">New strategy</h1>
          <p className="text-sm text-muted-foreground">{activeTab.hint}</p>
        </div>

        <div role="tablist" className="inline-flex rounded-md border border-border bg-panel2 p-1 gap-1">
          {TABS.map((t) => {
            const active = t.kind === tab;
            return (
              <button
                key={t.kind}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchTab(t.kind)}
                className={clsx(
                  "px-3 py-1.5 text-sm rounded transition-colors",
                  active
                    ? "bg-primary/90 text-black font-medium"
                    : "text-gray-300 hover:bg-panel",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </header>

      <form onSubmit={submit} className="space-y-5">
        {tab === "PLAN" ? (
          <PlanBasedBuilder value={planForm} onChange={setPlanForm} />
        ) : (
          <EquityStrategyBuilder
            value={form}
            onChange={setForm}
            pendingSymbol={pendingSymbol}
            onPendingSymbolChange={setPendingSymbol}
          />
        )}

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create strategy"}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => router.push("/strategies")}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
