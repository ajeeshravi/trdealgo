"use client";
/**
 * Pending Triggers — the user-facing window onto the `managed_triggers`
 * table populated by Phase 1–4 of the client-side trigger work.
 *
 * Each row in this table represents a level the app is watching for
 * the user. When the LTP crosses the trigger price the backend places
 * the actual broker order — so until that moment, the broker order
 * book stays clean and the only state lives here. Cancel buttons go
 * through `DELETE /triggers/{id}` (or `POST /triggers/cancel-all` for
 * the bulk path).
 *
 * Layout:
 *   - Top: status counters + bulk-cancel button.
 *   - Filter bar: state (Live/ARMED/PENDING/TRIGGERED/Show history),
 *     symbol search.
 *   - Table: state pill, role (ENTRY/SL/TARGET), symbol, side, qty,
 *     trigger, limit, current LTP-cross diff (when armed), age, cancel.
 */
import useSWR from "swr";
import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, Filter, X, RefreshCw, Zap, Target as TargetIcon, ShieldAlert } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtTs, prettyError, prettySymbol } from "@/lib/fmt";
import { useMarketPollInterval } from "@/lib/marketHours";
import { useLivePrices } from "@/lib/useLivePrices";
import { useConfirm } from "@/components/ConfirmDialog";

type TriggerState =
  | "PENDING"
  | "ARMED"
  | "TRIGGERED"
  | "FILLED"
  | "CANCELLED"
  | "FAILED";

type TriggerRole = "ENTRY" | "SL" | "TARGET";

type Trigger = {
  id: string;
  user_id: string;
  broker_account_id: string | null;
  strategy_run_id: string | null;
  parent_id: string | null;
  role: TriggerRole;
  internal_symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  direction: "UP" | "DOWN";
  trigger_price: number;
  limit_price: number | null;
  limit_timeout_sec: number | null;
  product: string;
  is_paper: boolean;
  state: TriggerState;
  triggered_at: string | null;
  triggered_ltp: number | null;
  order_id: string | null;
  extras: Record<string, unknown>;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const STATE_STYLES: Record<TriggerState, string> = {
  PENDING: "bg-secondary text-secondary-foreground",
  ARMED: "bg-primary/20 text-primary",
  TRIGGERED: "bg-warning/20 text-warning",
  FILLED: "bg-profit/20 text-profit",
  CANCELLED: "bg-secondary text-muted-foreground",
  FAILED: "bg-loss/20 text-loss",
};

const ROLE_ICON: Record<TriggerRole, React.ComponentType<{ className?: string }>> = {
  ENTRY: Zap,
  SL: ShieldAlert,
  TARGET: TargetIcon,
};

const ROLE_DESCRIPTION: Record<TriggerRole, string> = {
  ENTRY: "Entry — fires the order when LTP crosses the trigger",
  SL: "Stop-loss — exits when the underlying moves against the entry",
  TARGET: "Target — exits when the planned profit level is hit",
};

const fetcher = (u: string) => api.get(u).then((r) => r.data as Trigger[]);

type ViewFilter = "live" | "ARMED" | "PENDING" | "TRIGGERED" | "history";

export default function TriggersPage() {
  const confirm = useConfirm();

  const [view, setView] = useState<ViewFilter>("live");
  const [symbolFilter, setSymbolFilter] = useState("");

  // The `managed_triggers` rows themselves only change when something
  // arms, cancels, or fires — but the LTP-distance column wants a
  // fresh number every few seconds, so we keep a brisk poll during
  // market hours and stop entirely outside (matches the rest of the
  // app's gating).
  const pollMs = useMarketPollInterval(5_000, "ANY");

  const swrKey = useMemo(() => {
    const params = new URLSearchParams();
    if (view === "live") {
      // Backend defaults to live set — leave the param off so the
      // server can short-circuit on its in-set check.
    } else if (view === "history") {
      params.set("include_history", "true");
    } else {
      params.set("state", view);
    }
    if (symbolFilter.trim()) params.set("internal_symbol", symbolFilter.trim());
    params.set("limit", "300");
    return `/triggers?${params.toString()}`;
  }, [view, symbolFilter]);

  const { data, isLoading, mutate } = useSWR<Trigger[]>(swrKey, fetcher, {
    refreshInterval: pollMs,
    keepPreviousData: true,
  });

  const triggers = data ?? [];

  // Counts across the live set — drives the chip bar regardless of the
  // currently-selected filter. We could query a stats endpoint instead;
  // for now reuse the same payload when `view === "live"` and fall
  // back to a separate light fetch otherwise.
  const liveStats = useSWR<Trigger[]>("/triggers?limit=1000", fetcher, {
    refreshInterval: pollMs,
    keepPreviousData: true,
  }).data ?? [];

  const counts = useMemo(() => {
    let armed = 0, pending = 0, triggered = 0;
    for (const t of liveStats) {
      if (t.state === "ARMED") armed++;
      else if (t.state === "PENDING") pending++;
      else if (t.state === "TRIGGERED") triggered++;
    }
    return { armed, pending, triggered, total: armed + pending + triggered };
  }, [liveStats]);

  // Live LTP subscription so the "Distance to trigger" column ticks
  // in real time. Subscribe to every armed/pending symbol on screen
  // — small set, deduped by useLivePrices internally.
  const subSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          triggers
            .filter((t) => t.state === "ARMED" || t.state === "PENDING")
            .map((t) => t.internal_symbol),
        ),
      ).sort(),
    [triggers],
  );
  const livePrices = useLivePrices(subSymbols);

  async function cancelOne(t: Trigger) {
    const lines: string[] = [
      `${prettySymbol(t.internal_symbol)} · ${t.side} ${t.qty} @ trigger ₹${Number(t.trigger_price).toFixed(2)}`,
    ];
    if (t.role === "ENTRY") {
      lines.push(
        "Cancelling an ENTRY also cancels its pending SL and Target children — they have nothing to attach to once the entry's gone.",
      );
    }
    const ok = await confirm({
      title: `Cancel ${t.role} trigger?`,
      message: lines.join("\n\n"),
      confirmLabel: "Cancel trigger",
      cancelLabel: "Keep",
      variant: "warning",
    });
    if (!ok) return;
    try {
      const { data: res } = await api.delete(`/triggers/${t.id}`);
      if (res.cancelled_count > 0) {
        toast.success(`${t.role} trigger cancelled`);
      } else {
        toast(`Trigger was already ${res.state}`);
      }
      mutate();
    } catch (e: any) {
      toast.error(prettyError(e?.response?.data?.error?.message || e?.message || "cancel failed"));
    }
  }

  async function cancelAll() {
    if (counts.total === 0) return;
    const ok = await confirm({
      title: `Cancel ${counts.armed + counts.pending} pending triggers?`,
      message:
        `Drops every ARMED and PENDING trigger across all your strategies. ` +
        `TRIGGERED rows (${counts.triggered}) keep their in-flight broker orders — ` +
        `cancel those from the Orders page if you need to.`,
      confirmLabel: "Cancel all",
      cancelLabel: "Keep",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const { data: res } = await api.post("/triggers/cancel-all");
      toast.success(`Cancelled ${res.cancelled_count} trigger${res.cancelled_count === 1 ? "" : "s"}`);
      mutate();
    } catch (e: any) {
      toast.error(prettyError(e?.response?.data?.error?.message || e?.message || "bulk cancel failed"));
    }
  }

  return (
    <div className="space-y-6">
      {/* ---------------- header ---------------- */}
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Zap className="w-6 h-6 text-primary" />
            Pending Triggers
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Levels the app is watching client-side. The broker order is
            placed only when the live LTP crosses the trigger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-outline text-xs"
            onClick={() => mutate()}
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="btn-outline text-xs"
            onClick={cancelAll}
            disabled={counts.total === 0}
            title={counts.total === 0 ? "Nothing to cancel" : "Cancel every pending trigger"}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Cancel all ({counts.armed + counts.pending})
          </button>
        </div>
      </header>

      {/* ---------------- status strip ---------------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatusCard label="ARMED" value={counts.armed} hint="Watching ticks now" tone="primary" />
        <StatusCard label="PENDING" value={counts.pending} hint="Waiting for parent fill" tone="muted" />
        <StatusCard label="TRIGGERED" value={counts.triggered} hint="Order placed at broker" tone="warning" />
        <StatusCard label="Total live" value={counts.total} hint="ARMED + PENDING + TRIGGERED" tone="muted" />
      </div>

      {/* ---------------- filters ---------------- */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        {(["live", "ARMED", "PENDING", "TRIGGERED", "history"] as ViewFilter[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              "text-xs font-mono px-2.5 py-1 rounded-md border",
              view === v
                ? "bg-primary/15 text-primary border-primary/40"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
            title={
              v === "live" ? "ARMED + PENDING + TRIGGERED"
                : v === "history" ? "Includes FILLED / CANCELLED / FAILED"
                : `Show only ${v} rows`
            }
          >
            {v === "live" ? "Live"
              : v === "history" ? "History"
              : v}
          </button>
        ))}
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
            placeholder="Symbol filter (exact match)…"
            className="text-xs px-2.5 py-1 pr-7 rounded-md border border-border bg-background w-56 font-mono"
          />
          {symbolFilter && (
            <button
              type="button"
              onClick={() => setSymbolFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent"
              aria-label="Clear filter"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* ---------------- table ---------------- */}
      <div className="card overflow-hidden p-0">
        {isLoading && triggers.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">Loading…</div>
        ) : triggers.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {view === "history"
              ? "No history yet."
              : "No pending triggers. Trades arming from plan-based strategies or manual SL/SL-M orders will appear here."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-muted-foreground uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Side · Qty</th>
                  <th className="px-3 py-2 text-right">Trigger</th>
                  <th className="px-3 py-2 text-right">Limit</th>
                  <th className="px-3 py-2 text-right">LTP</th>
                  <th className="px-3 py-2 text-right">Δ to trigger</th>
                  <th className="px-3 py-2 text-left">Age</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((t) => (
                  <TriggerRow
                    key={t.id}
                    trigger={t}
                    ltp={livePrices[t.internal_symbol] ?? null}
                    onCancel={() => cancelOne(t)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function StatusCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "primary" | "muted" | "warning";
}) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "text-xl font-bold font-mono mt-0.5",
          tone === "primary" && "text-primary",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
    </div>
  );
}

function TriggerRow({
  trigger: t,
  ltp,
  onCancel,
}: {
  trigger: Trigger;
  ltp: number | null;
  onCancel: () => void;
}) {
  const RoleIcon = ROLE_ICON[t.role];
  const isActionable = t.state === "ARMED" || t.state === "PENDING";

  // Distance to trigger. Sign matches the trigger's direction so a
  // long entry watching UP shows positive when above target. Hidden
  // for non-ARMED states (no longer meaningful).
  const distance =
    ltp != null && t.state === "ARMED"
      ? t.direction === "UP"
        ? ltp - t.trigger_price
        : t.trigger_price - ltp
      : null;
  const distancePct =
    distance != null && t.trigger_price > 0
      ? (distance / t.trigger_price) * 100
      : null;

  return (
    <tr className="border-t border-border/40 hover:bg-accent/30">
      <td className="px-3 py-2">
        <span className={cn("pill font-mono", STATE_STYLES[t.state])}>{t.state}</span>
        {t.is_paper && (
          <span className="ml-1 pill text-[9px] bg-yellow-500/20 text-yellow-300">PAPER</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-foreground" title={ROLE_DESCRIPTION[t.role]}>
          <RoleIcon className="w-3.5 h-3.5 text-muted-foreground" />
          {t.role}
        </span>
      </td>
      <td className="px-3 py-2 font-mono truncate max-w-[260px]" title={t.internal_symbol}>
        {prettySymbol(t.internal_symbol)}
      </td>
      <td className="px-3 py-2 font-mono">
        <span className={cn(t.side === "BUY" ? "text-profit" : "text-loss")}>{t.side}</span>{" "}
        <span className="text-muted-foreground">·</span>{" "}
        {t.qty}
      </td>
      <td className="px-3 py-2 text-right font-mono">
        ₹{Number(t.trigger_price).toFixed(2)}
        <div className="text-[10px] text-muted-foreground">
          {t.direction === "UP" ? "≥" : "≤"}
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono">
        {t.limit_price != null ? `₹${Number(t.limit_price).toFixed(2)}` : "MKT"}
      </td>
      <td className="px-3 py-2 text-right font-mono">
        {ltp != null ? `₹${ltp.toFixed(2)}` : "—"}
      </td>
      <td className={cn(
        "px-3 py-2 text-right font-mono",
        distance != null && distance >= 0 ? "text-primary" : distance != null ? "text-muted-foreground" : "",
      )}>
        {distance != null ? (
          <>
            {distance >= 0 ? "+" : ""}{distance.toFixed(2)}
            <div className="text-[10px] text-muted-foreground">
              {distancePct != null ? `${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%` : ""}
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground" title={fmtTs(t.created_at)}>
        {timeAgo(t.created_at)}
      </td>
      <td className="px-3 py-2 text-right">
        {isActionable ? (
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-loss/15 text-loss"
            title="Cancel this trigger"
            aria-label="Cancel trigger"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
