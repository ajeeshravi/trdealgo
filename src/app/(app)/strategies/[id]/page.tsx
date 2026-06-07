"use client";
/**
 * Edit an existing strategy.
 *
 * Hydrates <EquityStrategyBuilder> from `GET /strategies/{id}` so every
 * setting the user picked at creation time is preloaded. Saving calls
 * `PUT /strategies/{id}` with the same payload shape as create.
 *
 * The page also shows a "Run history" section beneath the form so the
 * user keeps a single home for everything about one strategy.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import toast from "react-hot-toast";
import clsx from "clsx";
import { api } from "@/lib/api";
import { fmtUSD, fmtTs } from "@/lib/fmt";
import { useMarketPollInterval } from "@/lib/marketHours";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  EquityStrategyBuilder,
  buildPayload,
  validateForm,
} from "@/components/strategy/EquityStrategyBuilder";
import {
  EquityStrategyForm,
  defaultForm,
  fromDefinition,
} from "@/components/strategy/types";

interface StrategyDetail {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  symbols: string[];
  timeframe_min: number | null;
  capital: number;
  definition: Record<string, unknown>;
  code: string | null;
  risk: Partial<EquityStrategyForm["risk"]> | null;
  auto_start_on_login?: boolean | null;
  auto_start_broker_account_id?: string | null;
  auto_start_is_paper?: boolean | null;
}

interface StrategyRun {
  id: string;
  status: string;
  started_at: string | null;
  stopped_at: string | null;
  is_paper: boolean;
  pnl: number;
  realized_pnl: number;
}

const fetcher = (u: string) => api.get(u).then((r) => r.data);

const RUN_STATUS_STYLES: Record<string, string> = {
  LIVE:    "bg-primary/20 text-primary",
  PAPER:   "bg-yellow-500/20 text-yellow-300",
  PAUSED:  "bg-orange-500/20 text-orange-300",
  STOPPED: "bg-panel2 text-muted-foreground",
};

export default function EditStrategyPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const router = useRouter();
  const confirm = useConfirm();
  const { data: detail, error: detailErr, mutate: mutateDetail } = useSWR<StrategyDetail>(
    `/strategies/${id}`,
    fetcher,
  );
  // Runs are gated to any market open (covers MCX/CDS too).
  const runsPoll = useMarketPollInterval(15000, "ANY");
  const { data: runs, mutate: mutateRuns } = useSWR<StrategyRun[]>(
    `/strategies/${id}/runs`,
    fetcher,
    { refreshInterval: runsPoll },
  );

  const [form, setForm] = useState<EquityStrategyForm>(defaultForm);
  const [pendingSymbol, setPendingSymbol] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** True when any LIVE/PAPER run exists. Edit + Delete are blocked
   *  (UI + backend) until every run is stopped. */
  const hasActiveRuns = (runs || []).some(
    (r) => r.status === "LIVE" || r.status === "PAPER",
  );

  // Hydrate the form once the detail call returns. We do this once
  // (gate with `hydrated`) so the user's in-progress edits aren't blown
  // away by a background SWR revalidation.
  useEffect(() => {
    if (!detail || hydrated) return;
    setForm(fromDefinition(detail));
    setHydrated(true);
  }, [detail, hydrated]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (hasActiveRuns) {
      toast.error("stop all runs before saving changes");
      return;
    }
    const err = validateForm(form);
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      await api.put(`/strategies/${id}`, buildPayload(form));
      toast.success("changes saved");
      mutateDetail();
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message || "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (hasActiveRuns) {
      toast.error("stop all runs before deleting");
      return;
    }
    const name = detail?.name ?? "this strategy";
    const ok = await confirm({
      title: `Delete "${name}"?`,
      message:
        "This permanently removes the strategy, its risk rules, every past run, " +
        "and the linked signal/order history. This cannot be undone.",
      confirmLabel: "Delete strategy",
      cancelLabel: "Keep",
      variant: "danger",
      requireTyped: name,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/strategies/${id}`);
      toast.success("deleted");
      router.push("/strategies");
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message || "delete failed");
      setDeleting(false);
    }
  }

  async function stopRun(runId: string) {
    try {
      await api.post(`/strategies/${id}/stop/${runId}`);
      toast.success("stopped");
      mutateRuns();
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message || "stop failed");
    }
  }

  if (detailErr) {
    return (
      <div className="card text-danger">
        Failed to load strategy. {detailErr?.response?.data?.error?.message ?? ""}
      </div>
    );
  }
  if (!detail || !hydrated) return <div className="card">Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link href="/strategies" className="hover:underline">← Strategies</Link>
          </div>
          <h1 className="text-2xl font-semibold mt-1">
            {hasActiveRuns ? `View: ${detail.name}` : `Edit: ${detail.name}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {hasActiveRuns
              ? "Strategy is live — settings are read-only until all runs are stopped."
              : "Changes take effect on the next run start."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="pill text-[10px] uppercase tracking-wide bg-panel2 text-gray-300"
            title="Instrument class — fixed once a strategy is created"
          >
            {form.instrument_class === "FUTURES"
              ? "FUTURES"
              : form.instrument_class === "OPTIONS"
                ? "OPTIONS"
                : "EQUITY"}
          </span>
          <span
            className={clsx(
              "pill text-[10px] uppercase tracking-wide",
              RUN_STATUS_STYLES[detail.status] ?? "bg-panel2 text-muted-foreground",
            )}
          >
            {detail.status}
          </span>
        </div>
      </header>

      {hasActiveRuns && (
        <div className="rounded-md border border-orange-500/50 bg-orange-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-orange-300 text-lg leading-none">⚠</span>
          <div className="flex-1 text-sm">
            <div className="text-orange-200 font-semibold">Editing locked</div>
            <p className="text-orange-200/80 text-xs mt-0.5">
              This strategy has {(runs || []).filter((r) => r.status === "LIVE" || r.status === "PAPER").length}{" "}
              active run(s). Stop them in the Run history table below (or from the
              Strategies page) before changing settings or deleting.
            </p>
          </div>
        </div>
      )}

      <form
        onSubmit={save}
        className={clsx("space-y-5", hasActiveRuns && "opacity-70")}
      >
        {/* When running, freeze the form: no clicks, no keystrokes, no
            scroll-jacking. The user can still read it. */}
        <fieldset
          disabled={hasActiveRuns}
          className={clsx(hasActiveRuns && "pointer-events-none select-none")}
        >
          <EquityStrategyBuilder
            value={form}
            onChange={setForm}
            pendingSymbol={pendingSymbol}
            onPendingSymbolChange={setPendingSymbol}
          />
        </fieldset>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            className="btn-primary"
            disabled={saving || hasActiveRuns}
            title={hasActiveRuns ? "stop all runs to edit" : undefined}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            className="btn-outline"
            disabled={hasActiveRuns}
            title={hasActiveRuns ? "stop all runs to edit" : undefined}
            onClick={() => {
              setForm(fromDefinition(detail));
              toast.success("reverted to last saved settings");
            }}
          >
            Revert
          </button>
          <button
            type="button"
            className="btn-ghost text-danger ml-auto"
            onClick={remove}
            disabled={deleting || hasActiveRuns}
            title={hasActiveRuns ? "stop all runs to delete" : undefined}
          >
            {deleting ? "Deleting…" : "Delete strategy"}
          </button>
        </div>
      </form>

      {/* ---------------------- Run history --------------------------- */}
      <section className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Run history</h2>
          <Link href="/strategies" className="text-xs text-primary hover:underline">
            Start a run from the Strategies page →
          </Link>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Stopped</th>
              <th>Mode</th>
              <th>Status</th>
              <th className="text-right">P&amp;L</th>
              <th className="text-right">Realised</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(runs || []).map((r) => (
              <tr key={r.id}>
                <td>{r.started_at ? fmtTs(r.started_at) : "—"}</td>
                <td>{r.stopped_at ? fmtTs(r.stopped_at) : "—"}</td>
                <td>{r.is_paper ? "Paper" : "Live"}</td>
                <td>
                  <span
                    className={clsx(
                      "pill text-[10px]",
                      RUN_STATUS_STYLES[r.status] ?? "bg-panel2 text-muted-foreground",
                    )}
                  >
                    {r.status}
                  </span>
                </td>
                <td className={clsx("text-right", r.pnl >= 0 ? "text-primary" : "text-danger")}>
                  {fmtUSD(r.pnl)}
                </td>
                <td className="text-right text-muted-foreground">{fmtUSD(r.realized_pnl)}</td>
                <td>
                  {(r.status === "LIVE" || r.status === "PAPER") && (
                    <button className="btn-outline text-xs" onClick={() => stopRun(r.id)}>
                      Stop
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(!runs || runs.length === 0) && (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-4">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
