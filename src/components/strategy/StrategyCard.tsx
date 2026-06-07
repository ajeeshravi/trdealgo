"use client";
/**
 * Strategy card — one tile per Strategy on the /strategies list page.
 *
 * Validation surfaced on the card:
 *   - Structural issues (no symbols, no timeframe, zero capital, no broker
 *     accounts) appear as a warning/error banner before the broker picker.
 *   - Brokers already running this strategy are disabled in the checkbox
 *     list with a "Running" badge so the user can't double-start.
 *   - The Start button is disabled with an explicit reason in its tooltip
 *     when validation fails or when nothing can actually be started.
 *   - Delete is gated while any run is LIVE / PAPER (with a hint line).
 *
 * Actions:
 *   - Start  (multi-broker checkbox list + paper toggle, one POST per broker)
 *   - Stop   (stops every LIVE / PAPER run for this strategy)
 *   - Edit   (routes to /strategies/{id})
 *   - Details (routes to /strategies/{id}/details)
 *   - Delete (DELETE /strategies/{id})
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import toast from "react-hot-toast";
import clsx from "clsx";
import { BarChart3, Eye, Pencil, Play, Square, Trash2, Users, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { fmtUSD, prettySymbol } from "@/lib/fmt";
import { useConfirm } from "@/components/ConfirmDialog";
import { useLivePrices } from "@/lib/useLivePrices";
import { useMarketPollInterval } from "@/lib/marketHours";

interface Strategy {
  id: string;
  name: string;
  description?: string | null;
  kind: string;
  status: string;
  symbols: string[];
  timeframe_min: number | null;
  capital: number;
  instrument_class?: "EQUITY" | "FUTURES" | "OPTIONS";
  /** LONG = entry BUY → exit SELL · SHORT = entry SELL → exit BUY. */
  side?: "LONG" | "SHORT";
  /** Only meaningful when instrument_class === "OPTIONS". BUY = long the
   *  CE/PE leg, SELL = write the leg. */
  option_action?: "BUY" | "SELL";
  /** Sticky broker selection — persisted server-side so the user doesn't
   *  re-pick brokers every page load. Hydrated into `selectedBrokers` on
   *  mount; written back via PATCH /strategies/{id}/preferences whenever
   *  the user toggles a checkbox. */
  preferred_broker_account_ids?: string[];
  /** Auto-start on broker login — see backend strategies.auto_start_*. */
  auto_start_on_login?: boolean;
  auto_start_broker_account_id?: string | null;
  auto_start_is_paper?: boolean;
}

interface BrokerAccount {
  id: string;
  broker: string;
  client_id: string;
  label?: string | null;
  is_active: boolean;
  is_paper: boolean;
  /** ISO-8601 timestamp at which the broker's auth token stops working.
   *  Most brokers (Fyers, Zerodha) issue daily tokens that expire at end-
   *  of-day, so this is checked at every Start to fail fast on stale auth. */
  session_valid_until?: string | null;
}

function isSessionValid(b: BrokerAccount): boolean {
  if (!b.session_valid_until) return false;
  return new Date(b.session_valid_until).getTime() > Date.now();
}

interface StrategyRun {
  id: string;
  strategy_id: string;
  broker_account_id: string | null;
  status: string;
  started_at: string | null;
  is_paper: boolean;
  pnl: number;
}

interface Issue {
  level: "error" | "warn";
  message: string;
}

/** Subset of /strategies/{id}/symbols-resolved we need on the card to map
 *  what the user stored (which may be a logical alias like @CURRENT_FUT)
 *  to the concrete contract the tick stream actually publishes on. */
interface ResolvedSym {
  display_symbol: string;
  internal_symbol: string | null;
}

const RUNNING_STATUSES = new Set(["LIVE", "PAPER"]);

const fetcher = (u: string) => api.get(u).then((r) => r.data);

interface Props {
  strategy: Strategy;
  brokers: BrokerAccount[];
  onChanged: () => void;                  // parent refetches /strategies
  onDelete: (deletedId: string) => void;  // parent should drop this id from its list cache
}

function StrategyCardImpl({ strategy: s, brokers, onChanged, onDelete }: Props) {
  const confirm = useConfirm();
  // Gate per-card polls to "any market open" (covers MCX/CDS too, so a
  // commodity strategy still ticks at night). Outside those hours both
  // the runs status and the resolved contract list are stable, so the
  // polls collapse to 0 — silent SWR cache.
  const runsPoll = useMarketPollInterval(15000, "ANY");
  const resolvedPoll = useMarketPollInterval(60_000, "ANY");
  const { data: runs, mutate: mutateRuns } = useSWR<StrategyRun[]>(
    `/strategies/${s.id}/runs`,
    fetcher,
    { refreshInterval: runsPoll },
  );

  // Hydrate from the server-persisted preference so brokers stay selected
  // across reloads / new sessions / other devices. The effect just below
  // also prunes IDs that have since been deleted/disabled, so a stale
  // preference can't keep a bad ID checked.
  const [selectedBrokers, setSelectedBrokers] = useState<Set<string>>(
    () => new Set(s.preferred_broker_account_ids || []),
  );
  const [paper, setPaper] = useState(true);
  const [busy, setBusy] = useState(false);

  // Re-hydrate when the parent re-fetches /strategies and surfaces a new
  // preference for this card (e.g. after we PATCH-persist a change, SWR
  // revalidates the list and pushes the canonical list back down). We
  // compare against the current set to avoid an infinite loop with the
  // PATCH effect below.
  const lastHydratedRef = useRef<string>("");
  useEffect(() => {
    const incoming = (s.preferred_broker_account_ids || []).slice().sort().join(",");
    if (incoming === lastHydratedRef.current) return;
    lastHydratedRef.current = incoming;
    setSelectedBrokers(new Set(s.preferred_broker_account_ids || []));
  }, [s.preferred_broker_account_ids]);

  // Local mirror of the auto-start config, hydrated from the server on
  // every list refresh. Edits go straight to the PATCH endpoint — we
  // optimistically update local state for instant feedback and roll
  // back on failure.
  const [autoStartEnabled, setAutoStartEnabled] = useState<boolean>(
    Boolean(s.auto_start_on_login),
  );
  const [autoStartBrokerId, setAutoStartBrokerId] = useState<string | null>(
    s.auto_start_broker_account_id ?? null,
  );
  const [autoStartIsPaper, setAutoStartIsPaper] = useState<boolean>(
    Boolean(s.auto_start_is_paper),
  );
  const [autoStartSaving, setAutoStartSaving] = useState(false);
  // Track the last server-confirmed config so we can roll back on PATCH
  // failures and detect server-side changes from other tabs without
  // overwriting in-progress edits.
  const lastAutoStartRef = useRef<string>("");
  useEffect(() => {
    const sig = JSON.stringify({
      e: Boolean(s.auto_start_on_login),
      b: s.auto_start_broker_account_id ?? null,
      p: Boolean(s.auto_start_is_paper),
    });
    if (sig === lastAutoStartRef.current) return;
    lastAutoStartRef.current = sig;
    setAutoStartEnabled(Boolean(s.auto_start_on_login));
    setAutoStartBrokerId(s.auto_start_broker_account_id ?? null);
    setAutoStartIsPaper(Boolean(s.auto_start_is_paper));
  }, [s.auto_start_on_login, s.auto_start_broker_account_id, s.auto_start_is_paper]);

  // Keep auto-start config in sync with the manual section above.
  // When auto-start is ON, the saved (broker_id, is_paper) must mirror
  // what the user has selected for manual start — otherwise the user
  // would have to think about two different selections. Single broker
  // only (auto-start is single-broker on the backend); we use whichever
  // broker is "first" in the user's selected set.
  useEffect(() => {
    if (!autoStartEnabled) return;
    if (autoStartSaving) return;
    const firstSelected = Array.from(selectedBrokers)[0] ?? null;
    // Only push when there's actually drift to avoid an infinite loop
    // through onChanged → SWR refetch → hydration → effect.
    if (firstSelected === autoStartBrokerId && paper === autoStartIsPaper) return;
    // If the user deselected every broker we don't have anything to fire
    // on — keep auto-start "armed" locally (the warning text in the
    // toggle's label tells the user what's missing) but don't PATCH the
    // null broker, since the server rejects that combo.
    if (!firstSelected) return;
    saveAutoStart({
      enabled: true,
      brokerId: firstSelected,
      isPaper: paper,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBrokers, paper, autoStartEnabled]);

  async function saveAutoStart(next: {
    enabled: boolean;
    brokerId: string | null;
    isPaper: boolean;
  }) {
    const prev = {
      enabled: autoStartEnabled,
      brokerId: autoStartBrokerId,
      isPaper: autoStartIsPaper,
    };
    // Flip the local UI immediately so the toggle feels responsive.
    setAutoStartEnabled(next.enabled);
    setAutoStartBrokerId(next.brokerId);
    setAutoStartIsPaper(next.isPaper);

    // Skip the PATCH when the request is incomplete — toggle ON without a
    // broker picked yet. The backend (correctly) returns 422 for that
    // shape, and we don't want to surface a "requires picking a broker"
    // toast on every checkbox click. The save fires the moment the user
    // selects a broker. ALSO skip when nothing actually changed.
    const incomplete = next.enabled && !next.brokerId;
    const unchanged =
      prev.enabled === next.enabled
      && prev.brokerId === next.brokerId
      && prev.isPaper === next.isPaper;
    if (incomplete || unchanged) return;

    setAutoStartSaving(true);
    try {
      await api.patch(`/strategies/${s.id}/auto-start`, {
        enabled: next.enabled,
        broker_account_id: next.brokerId,
        is_paper: next.isPaper,
      });
      onChanged();
    } catch (e: any) {
      // Revert.
      setAutoStartEnabled(prev.enabled);
      setAutoStartBrokerId(prev.brokerId);
      setAutoStartIsPaper(prev.isPaper);
      toast.error(e?.response?.data?.error?.message || "auto-start save failed");
    } finally {
      setAutoStartSaving(false);
    }
  }

  const activeRuns = useMemo(
    () => (runs || []).filter((r) => RUNNING_STATUSES.has(r.status)),
    [runs],
  );
  const isRunning = activeRuns.length > 0;
  const totalPnl = (runs || []).reduce((sum, r) => sum + Number(r.pnl || 0), 0);

  // Logical-symbol resolution: when the strategy stores aliases like
  // `NFO_NIFTY_@CURRENT_FUT`, ticks arrive on the concrete contract
  // (`NFO_NIFTY_290526_FUT`). We need both — the logical form for the
  // pill label, the concrete form for the tick subscription.
  //
  // We also resolve for OPTIONS strategies regardless of run state so
  // the card's symbol row shows the actual CE/PE name even when the
  // strategy is stopped — otherwise `prettySymbol("NFO_NIFTY_@OPT")`
  // renders an unhelpful "NFO NIFTY Options".
  const shouldResolve =
    (s.symbols || []).length > 0
    && (isRunning || s.instrument_class === "OPTIONS");
  const { data: resolved } = useSWR<ResolvedSym[]>(
    shouldResolve ? `/strategies/${s.id}/symbols-resolved` : null,
    fetcher,
    { refreshInterval: resolvedPoll },
  );

  /** logical → concrete map. Falls back to identity for non-logical symbols. */
  const concreteFor = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sym of s.symbols || []) map[sym] = sym;
    for (const r of resolved || []) {
      if (r.internal_symbol) map[r.display_symbol] = r.internal_symbol;
    }
    return map;
  }, [s.symbols, resolved]);

  /** Symbols to actually subscribe to on the ticks WS. Sorted+joined so the
   *  effect's dep array doesn't re-fire on identical re-renders. */
  const subscribeSymbols = useMemo(
    () =>
      isRunning
        ? Array.from(new Set(Object.values(concreteFor).filter(Boolean))).sort()
        : [],
    [concreteFor, isRunning],
  );

  // Latest LTP per concrete symbol — populated by the live tick handler.
  // Throttled to one state flush per ~300ms so the strategy cards don't
  // re-render at the broker's raw tick rate.
  const livePrices = useLivePrices(subscribeSymbols);

  /** broker_account_ids currently servicing a LIVE/PAPER run for this strategy */
  const activeBrokerIds = useMemo(
    () => new Set(activeRuns.map((r) => r.broker_account_id || "")),
    [activeRuns],
  );

  /** Structural validation — independent of the user's current selection. */
  const isPlanBased = s.kind === "PLAN_BASED";
  const issues: Issue[] = useMemo(() => {
    const out: Issue[] = [];
    // PLAN_BASED strategies have no fixed symbol universe — the picks
    // are chosen dynamically each morning from Tomorrow's Plan — and no
    // candle timeframe because they're fired once-a-day by the Celery
    // dispatcher at 09:15 IST (market open). Skip those two checks for this kind.
    if (!isPlanBased) {
      if ((s.symbols || []).length === 0) {
        out.push({ level: "error", message: "no symbols configured" });
      }
      if (!s.timeframe_min || s.timeframe_min <= 0) {
        out.push({ level: "warn", message: "no timeframe set" });
      }
    }
    if ((s.capital ?? 0) <= 0) {
      out.push({ level: "warn", message: "capital is 0 — sizing modes that need capital will produce 0 qty" });
    }
    if (brokers.length === 0) {
      out.push({ level: "error", message: "no broker accounts connected" });
    } else if (brokers.every((b) => !b.is_active)) {
      out.push({ level: "error", message: "every broker account is disabled" });
    } else if (brokers.every((b) => !b.is_active || !isSessionValid(b))) {
      // Surface this as a warning, not a hard error — the user can still
      // re-login from the Brokers page; we want the card actionable, not
      // permanently red.
      out.push({
        level: "warn",
        message: "all broker accounts are logged out — log in on the Brokers page before starting",
      });
    }
    return out;
  }, [s.symbols, s.timeframe_min, s.capital, brokers]);

  const hasBlockingIssues = issues.some((i) => i.level === "error");

  /** Drop any selection that has since become invalid (broker disabled,
   *  logged out, deleted, or already running this strategy). The session
   *  poll on the parent refreshes broker data every 15s, so a token that
   *  expires mid-flight is detected without the user reloading. */
  useEffect(() => {
    setSelectedBrokers((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        const b = brokers.find((x) => x.id === id);
        if (!b || !b.is_active || !isSessionValid(b) || activeBrokerIds.has(id)) continue;
        next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [brokers, activeBrokerIds]);

  // Broker selection now lives in an explicit modal — `selectedBrokers`
  // mirrors the server-persisted value (`s.preferred_broker_account_ids`)
  // and only changes when the modal's Save handler commits a PATCH.
  // The hydration effect above re-syncs it whenever the parent refetches
  // and the value differs.
  const [brokerModalOpen, setBrokerModalOpen] = useState(false);
  // Modal-local "pending" selection. Initialised from the persisted
  // selection on every open so Cancel discards in-progress toggles.
  const [pendingBrokers, setPendingBrokers] = useState<Set<string>>(new Set());
  const [savingPrefs, setSavingPrefs] = useState(false);

  function openBrokerModal() {
    setPendingBrokers(new Set(selectedBrokers));
    setBrokerModalOpen(true);
  }

  function togglePending(id: string, disabled: boolean) {
    if (disabled) return;
    setPendingBrokers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveBrokerPrefs() {
    setSavingPrefs(true);
    try {
      const ids = Array.from(pendingBrokers);
      // Use the server response as the source of truth — the PATCH route
      // sanitises the list (drops broker IDs that don't belong to the
      // user, etc.) so what comes back may differ from what we sent. If
      // the backend silently drops everything, we want the UI to reflect
      // that, not optimistically pretend the save succeeded.
      const { data } = await api.patch<{
        preferred_broker_account_ids?: string[];
      }>(`/strategies/${s.id}/preferences`, { broker_account_ids: ids });
      const persisted = data?.preferred_broker_account_ids || [];
      // eslint-disable-next-line no-console
      console.log("[StrategyCard] saved broker prefs", {
        strategy: s.name,
        sent: ids,
        persisted,
      });
      lastHydratedRef.current = persisted.slice().sort().join(",");
      setSelectedBrokers(new Set(persisted));
      setBrokerModalOpen(false);
      onChanged();
      if (persisted.length === 0 && ids.length > 0) {
        // Server dropped everything we sent — surface this explicitly so
        // the user doesn't think a silent empty save was a success.
        toast.error(
          "Save did not persist any broker — make sure each selected " +
            "broker account is yours and still exists.",
        );
      } else if (persisted.length === 0) {
        toast.success("Broker selection cleared");
      } else {
        toast.success(
          `Saved ${persisted.length} broker${persisted.length === 1 ? "" : "s"}`,
        );
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[StrategyCard] save broker prefs FAILED", {
        strategy: s.name,
        status: e?.response?.status,
        data: e?.response?.data,
        err: e,
      });
      const status = e?.response?.status;
      const detail = e?.response?.data?.error?.message;
      toast.error(
        status === 404
          ? "Save endpoint not found — restart the backend so it picks up the new /preferences route."
          : detail || `save failed (HTTP ${status ?? "?"})`,
      );
    } finally {
      setSavingPrefs(false);
    }
  }

  /** Selected brokers that can actually be started — i.e. active, logged
   *  in, and not already running. Used both for the click handler and
   *  the button label. */
  const startableTargets = useMemo(
    () =>
      Array.from(selectedBrokers).filter((id) => {
        const b = brokers.find((x) => x.id === id);
        return b && b.is_active && isSessionValid(b) && !activeBrokerIds.has(id);
      }),
    [selectedBrokers, brokers, activeBrokerIds],
  );

  /** Why is Start disabled? Used as the button's title tooltip. Returns
   *  null when Start is allowed. */
  const startBlockReason: string | null = (() => {
    if (busy) return "busy";
    if (hasBlockingIssues) return "fix the issues above before starting";
    if (brokers.length === 0) return "connect a broker account first";
    if (selectedBrokers.size === 0) return "select at least one broker";
    if (startableTargets.length === 0) {
      // Could be already-running OR logged-out. Distinguish so the user
      // knows whether to wait for a Stop or visit /brokers.
      const selectedArr = Array.from(selectedBrokers);
      const loggedOutSel = selectedArr.some((id) => {
        const b = brokers.find((x) => x.id === id);
        return b && b.is_active && !isSessionValid(b);
      });
      if (loggedOutSel) {
        return "selected broker is logged out — log in on the Brokers page";
      }
      return "every selected broker is already running this strategy";
    }
    return null;
  })();

  function brokerLabel(b: BrokerAccount) {
    return `${b.broker} • ${b.label || b.client_id}`;
  }

  async function start() {
    if (startBlockReason) {
      toast.error(startBlockReason);
      return;
    }
    setBusy(true);
    let okCount = 0;
    let failCount = 0;
    try {
      for (const broker_account_id of startableTargets) {
        try {
          await api.post(`/strategies/${s.id}/start`, {
            broker_account_id,
            is_paper: paper,
          });
          okCount++;
        } catch (e: any) {
          failCount++;
          const b = brokers.find((x) => x.id === broker_account_id);
          toast.error(
            `${b ? brokerLabel(b) : broker_account_id}: ${
              e?.response?.data?.error?.message || "start failed"
            }`,
          );
        }
      }
      if (okCount > 0) toast.success(`started on ${okCount} broker${okCount === 1 ? "" : "s"}`);
      // Keep `selectedBrokers` populated after start — the sticky preference
      // means the user expects the same selection next time. (The old
      // implementation cleared this on success, which forced re-picking.)
      onChanged();
      mutateRuns();
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    const ok = await confirm({
      title: `Stop ${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"}?`,
      message:
        `"${s.name}" will stop trading on every broker it's running on. ` +
        "Open positions are left as-is unless your risk rules force a square-off.",
      confirmLabel: "Stop runs",
      cancelLabel: "Keep running",
      variant: "warning",
    });
    if (!ok) return;
    setBusy(true);
    let okCount = 0;
    try {
      for (const r of activeRuns) {
        try {
          await api.post(`/strategies/${s.id}/stop/${r.id}`);
          okCount++;
        } catch (e: any) {
          toast.error(e?.response?.data?.error?.message || "stop failed");
        }
      }
      if (okCount > 0) toast.success(`stopped ${okCount} run${okCount === 1 ? "" : "s"}`);
      onChanged();
      mutateRuns();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (isRunning) {
      toast.error("stop all runs before deleting");
      return;
    }
    const ok = await confirm({
      title: `Delete "${s.name}"?`,
      message:
        "This permanently removes the strategy, its risk rules, every past run, " +
        "and the linked signal/order history. This cannot be undone.",
      confirmLabel: "Delete strategy",
      cancelLabel: "Keep",
      variant: "danger",
      requireTyped: s.name,
    });
    if (!ok) return;
    try {
      await api.delete(`/strategies/${s.id}`);
      toast.success("deleted");
      // Pass the id so the parent can drop this card from its cache
      // immediately — otherwise SWR keeps the stale row visible until
      // the revalidation network round-trip completes.
      onDelete(s.id);
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "delete failed");
    }
  }

  return (
    <div className="card flex flex-col gap-4">
      {/* ---------------- header ---------------- */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            {/* Pulsing dot when the strategy is actually running; absent otherwise.
                Replaces the old DRAFT / STOPPED / LIVE / PAPER status pill — the
                lifecycle states don't mean anything to a trader, "is it running
                right now?" is what they actually want to see. */}
            {isRunning && (
              <span
                className="relative inline-flex shrink-0"
                title={activeRuns.some((r) => r.is_paper) ? "Running (paper)" : "Running"}
              >
                <span className="absolute inline-flex h-2 w-2 rounded-full bg-primary opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            )}
            <h3 className="text-base font-semibold truncate" title={s.name}>
              {s.name}
            </h3>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 font-mono">
            {isPlanBased
              ? "PLAN · daily @ 09:15 IST"
              : `${s.kind} · ${s.timeframe_min ? `${s.timeframe_min}m` : "tick"}`}
            {s.capital > 0 && ` · ${fmtUSD(s.capital)}`}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Direction pill — SHORT for SELL-first stock/futures; WRITE for
              option-writing strategies (BUY-the-leg is the default and
              isn't badged). PLAN strategies are direction-less. */}
          {s.kind !== "PLAN_BASED" && s.instrument_class === "OPTIONS" && s.option_action === "SELL" && (
            <span
              className="pill text-[10px] uppercase tracking-wide whitespace-nowrap bg-loss/20 text-loss"
              title="Writes (sells) the CE/PE leg — needs SPAN+exposure margin"
            >
              WRITE
            </span>
          )}
          {s.kind !== "PLAN_BASED" && s.instrument_class !== "OPTIONS" && s.side === "SHORT" && (
            <span
              className="pill text-[10px] uppercase tracking-wide whitespace-nowrap bg-loss/20 text-loss"
              title="Strategy enters SHORT (SELL first → BUY to close)"
            >
              SHORT
            </span>
          )}
          <span
            className={clsx(
              "pill text-[10px] uppercase tracking-wide whitespace-nowrap",
              s.kind === "PLAN_BASED"
                ? "bg-amber-500/20 text-amber-300"
                : s.instrument_class === "FUTURES"
                  ? "bg-blue-500/20 text-blue-300"
                  : s.instrument_class === "OPTIONS"
                    ? "bg-purple-500/20 text-purple-300"
                    : "bg-panel2 text-gray-300",
            )}
            title={
              s.kind === "PLAN_BASED"
                ? "Plan auto-trader — fires top-N ideas from Tomorrow's Plan at 09:15 IST (market open)"
                : s.instrument_class === "FUTURES"
                  ? "Futures strategy"
                  : s.instrument_class === "OPTIONS"
                    ? "Options strategy"
                    : "Equity strategy"
            }
          >
            {s.kind === "PLAN_BASED"
              ? "PLAN"
              : s.instrument_class === "FUTURES"
                ? "FUTURES"
                : s.instrument_class === "OPTIONS"
                  ? "OPTIONS"
                  : "EQUITY"}
          </span>
        </div>
      </div>

      {s.description && (
        <p className="text-xs text-muted-foreground line-clamp-1">{s.description}</p>
      )}

      {/* ---------------- symbol rows ----------------
          One row per symbol: name on the left, live LTP right-aligned on
          the same line. Vertical stack keeps long names from wrapping and
          the price column lined up across symbols. */}
      {isPlanBased ? (
        /* PLAN_BASED strategies don't have a static symbol list — the
           picks are chosen at 09:15 IST every weekday. Render a hint
           row instead of "no symbols" so the card doesn't look broken. */
        <div className="text-[11px] text-muted-foreground italic">
          Picks chosen daily from Tomorrow's Plan
        </div>
      ) : (
        <div className="space-y-1">
          {(s.symbols || []).slice(0, 4).map((sym) => {
            const concrete = concreteFor[sym] || sym;
            const ltp = livePrices[concrete];
            // Prefer the concrete contract's pretty name when it differs
            // from the stored alias. For OPTIONS strategies the stored
            // alias is `NFO_NIFTY_@OPT` (which prettifies to a useless
            // "NFO NIFTY Options"); the resolved CE/PE contract gives the
            // real "NFO NIFTY 26 May 26 23800 CE" label the user wants
            // to see on the card. Same upgrade applies to futures
            // aliases (`_@CURRENT_FUT` → today's actual contract).
            // Not gated on `isRunning` — for OPTIONS strategies we fetch
            // /symbols-resolved at rest too, so the concrete is available
            // before the strategy starts.
            const label =
              concrete && concrete !== sym
                ? prettySymbol(concrete)
                : prettySymbol(sym);
            // Hover-title: show the raw internal id (and the resolved
            // concrete contract for logical aliases) so power users can
            // still verify what the row is mapping to.
            const titleParts = [sym];
            if (concrete !== sym) titleParts.push(`→ ${prettySymbol(concrete)}`);
            return (
              <div
                key={sym}
                className="flex items-center justify-between gap-2 text-[11px] font-mono"
                title={titleParts.join(" ")}
              >
                <span className="text-gray-300 truncate">{label}</span>
                {isRunning && ltp !== undefined ? (
                  <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary shrink-0">
                    ${ltp.toFixed(2)}
                  </span>
                ) : (
                  <span className="text-muted-foreground shrink-0">—</span>
                )}
              </div>
            );
          })}
          {(s.symbols || []).length > 4 && (
            <div className="text-[10px] text-muted-foreground">
              +{s.symbols.length - 4} more
            </div>
          )}
          {(s.symbols || []).length === 0 && (
            <div className="text-xs text-muted-foreground italic">no symbols</div>
          )}
        </div>
      )}

      {/* ---------------- validation banner ---------------- */}
      {issues.length > 0 && (
        <div
          className={clsx(
            "rounded-md border px-2.5 py-2 text-xs space-y-1",
            hasBlockingIssues
              ? "border-danger/40 bg-danger/10"
              : "border-orange-500/40 bg-orange-500/10",
          )}
        >
          <div
            className={clsx(
              "font-semibold flex items-center gap-1.5",
              hasBlockingIssues ? "text-danger" : "text-orange-300",
            )}
          >
            <span>{hasBlockingIssues ? "⚠" : "ⓘ"}</span>
            <span>
              {hasBlockingIssues ? "Cannot start — fix these first" : "Heads up"}
            </span>
          </div>
          <ul className="space-y-0.5 pl-5 list-disc marker:text-muted-foreground">
            {issues.map((it, i) => (
              <li key={i} className={it.level === "error" ? "text-danger" : "text-orange-200"}>
                {it.message}
                {it.message.startsWith("no symbols") && (
                  <Link href={`/strategies/${s.id}`} className="ml-1 underline">
                    fix
                  </Link>
                )}
                {it.message.startsWith("no broker accounts") && (
                  <Link href="/brokers" className="ml-1 underline">
                    connect
                  </Link>
                )}
                {it.message.startsWith("all broker accounts are logged out") && (
                  <Link href="/brokers" className="ml-1 underline">
                    log in
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------- active runs strip (if any) ---------------- */}
      {isRunning && (
        <div className="rounded-md border border-border bg-panel2/40 p-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {activeRuns.map((r) => {
              const b = brokers.find((x) => x.id === r.broker_account_id);
              return (
                <span
                  key={r.id}
                  className={clsx(
                    "pill text-[10px] inline-flex items-center gap-1",
                    r.is_paper
                      ? "bg-yellow-500/20 text-yellow-300"
                      : "bg-primary/20 text-primary",
                  )}
                >
                  {b ? brokerLabel(b) : r.broker_account_id?.slice(0, 8)}
                  <span className="opacity-70">· {r.is_paper ? "Paper" : "Live"}</span>
                </span>
              );
            })}
          </div>
          <div className="flex items-center justify-end pt-0.5">
            <span
              className={clsx(
                "text-xs font-medium font-mono",
                totalPnl >= 0 ? "text-primary" : "text-danger",
              )}
            >
              P&L {fmtUSD(totalPnl)}
            </span>
          </div>
        </div>
      )}

      {/* ---------------- broker summary (compact; opens modal to edit) ----------------
          Replaces the always-on inline checkbox list. The user's broker
          selection is saved server-side (PATCH /preferences) and persists
          across reloads, browsers, and devices, so we don't need it
          taking up card real estate every render. Pills here mirror what
          the modal will show selected on next open. */}
      {!isRunning && brokers.length > 0 && (
        <div className="rounded-md border border-border bg-panel2/40 p-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="label">Brokers</div>
            <button
              type="button"
              onClick={openBrokerModal}
              className="text-[11px] inline-flex items-center gap-1 text-primary hover:underline"
              title="Open broker selection — saved permanently across reloads/devices"
            >
              <Users className="w-3 h-3" />
              {selectedBrokers.size === 0 ? "Choose brokers" : "Change"}
            </button>
          </div>
          {selectedBrokers.size === 0 ? (
            <div className="text-[11px] text-muted-foreground italic">
              No brokers selected — click <span className="text-primary">Choose brokers</span> to pick.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {Array.from(selectedBrokers).map((id) => {
                const b = brokers.find((x) => x.id === id);
                if (!b) {
                  return (
                    <span
                      key={id}
                      className="pill text-[10px] bg-panel text-muted-foreground line-through"
                      title="broker removed — open the picker to update"
                    >
                      {id.slice(0, 8)}
                    </span>
                  );
                }
                const inactive = !b.is_active;
                const loggedOut = !inactive && !isSessionValid(b);
                return (
                  <span
                    key={id}
                    className={clsx(
                      "pill text-[10px] inline-flex items-center gap-1",
                      inactive
                        ? "bg-panel text-muted-foreground"
                        : loggedOut
                          ? "bg-orange-500/20 text-orange-300"
                          : "bg-primary/15 text-primary",
                    )}
                    title={
                      inactive
                        ? "disabled — Start will skip this broker"
                        : loggedOut
                          ? "logged out — log in on the Brokers page before Start"
                          : "selected"
                    }
                  >
                    {brokerLabel(b)}
                    {loggedOut && <span className="opacity-70">· logged out</span>}
                    {inactive && <span className="opacity-70">· disabled</span>}
                  </span>
                );
              })}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs pt-0.5">
            <input
              type="checkbox"
              checked={paper}
              onChange={(e) => setPaper(e.target.checked)}
              disabled={hasBlockingIssues}
            />
            Paper trade (simulated, no real orders)
          </label>
        </div>
      )}

      {!isRunning && brokers.length === 0 && (
        <div className="rounded-md border border-border bg-panel2/40 p-2 text-xs text-muted-foreground">
          No broker accounts.{" "}
          <Link href="/brokers" className="text-primary hover:underline">
            Connect one →
          </Link>
        </div>
      )}

      {isRunning && (
        <p className="text-[10px] text-muted-foreground italic">
          Strategy is live — stop all runs to change brokers, edit settings, or delete.
        </p>
      )}

      {/* ---------------- auto-start on broker login ----------------
          Just a switch. Broker + Paper/Live are NOT duplicated here —
          they're inherited from the Brokers section above. The toggle
          is disabled until at least one broker is selected up there,
          so validation is upfront ("can't even click it") rather than
          after-the-fact ("clicked, but it didn't save"). */}
      {brokers.length > 0 && (() => {
        const hasSelection = selectedBrokers.size > 0;
        const disabled = autoStartSaving || !hasSelection;
        return (
          <label
            className={clsx(
              "rounded-md border border-border bg-panel2/40 p-2 flex items-center justify-between gap-2 text-xs",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
            title={
              !hasSelection
                ? "Select a broker above first — auto-start needs to know which broker's login to listen for"
                : undefined
            }
          >
            <span className="flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-primary" />
              <span className="font-semibold">Auto-start on broker login</span>
              {autoStartSaving && (
                <span className="text-[10px] text-muted-foreground italic">saving…</span>
              )}
              {!hasSelection && (
                <span className="text-[10px] text-muted-foreground">
                  · select a broker above first
                </span>
              )}
              {hasSelection && autoStartEnabled && (
                <span className="text-[10px] text-muted-foreground">
                  · armed ({autoStartIsPaper ? "paper" : "live"})
                </span>
              )}
            </span>
            <input
              type="checkbox"
              checked={autoStartEnabled && Boolean(autoStartBrokerId)}
              onChange={(e) => {
                const enabling = e.target.checked;
                const firstSelected = Array.from(selectedBrokers)[0] ?? null;
                saveAutoStart({
                  enabled: enabling,
                  brokerId: enabling ? firstSelected : null,
                  isPaper: enabling ? paper : false,
                });
              }}
              disabled={disabled}
            />
          </label>
        );
      })()}

      {/* ---------------- actions ----------------
          Icon-only buttons with native `title` tooltips. The action label
          appears on hover so the row stays compact even when every card has
          five buttons. Filled colour highlights the primary action (Start /
          Stop); the rest use the same outline style for visual consistency. */}
      <div className="flex items-center gap-1.5 pt-1 mt-auto">
        {isRunning ? (
          <IconButton
            variant="danger"
            label={busy ? "Stopping…" : `Stop ${activeRuns.length} run${activeRuns.length === 1 ? "" : "s"}`}
            icon={<Square className="w-4 h-4" />}
            onClick={stopAll}
            disabled={busy}
          />
        ) : (
          <IconButton
            variant="primary"
            label={
              startBlockReason
                ?? (busy
                  ? "Starting…"
                  : startableTargets.length > 1
                    ? `Start (${startableTargets.length})`
                    : "Start")
            }
            icon={<Play className="w-4 h-4" />}
            onClick={start}
            disabled={!!startBlockReason}
          />
        )}

        {/* Edit — disabled while any run is live so config can't change under the runner. */}
        {isRunning ? (
          <IconButton
            variant="outline"
            label="Stop all runs to edit settings"
            icon={<Pencil className="w-4 h-4" />}
            disabled
          />
        ) : (
          <IconLink
            href={`/strategies/${s.id}`}
            label="Edit"
            icon={<Pencil className="w-4 h-4" />}
          />
        )}

        <IconLink
          href={`/strategies/${s.id}/details`}
          label="Details"
          icon={<Eye className="w-4 h-4" />}
        />

        <IconLink
          href={`/backtests?strategy=${s.id}`}
          label="Backtest"
          icon={<BarChart3 className="w-4 h-4" />}
        />

        {/* Brokers — opens the picker modal. Disabled while any run is
            live: changing brokers mid-flight is dangerous (the user might
            think the new selection takes effect on the running run when
            it actually only applies to the next Start), so we just block
            it until they Stop. Same gating rule as Edit. */}
        <IconButton
          variant="outline"
          label={
            brokers.length === 0
              ? "Connect a broker first"
              : isRunning
                ? "Stop all runs to change brokers"
                : "Choose brokers"
          }
          icon={<Users className="w-4 h-4" />}
          onClick={openBrokerModal}
          disabled={brokers.length === 0 || isRunning}
        />

        <IconButton
          variant="ghost-danger"
          className="ml-auto"
          label={isRunning ? "Stop all runs to delete" : "Delete"}
          icon={<Trash2 className="w-4 h-4" />}
          onClick={remove}
          disabled={isRunning}
        />
      </div>

      {/* ---------------- broker picker modal ----------------
          Rendered inside the card root so it's scoped per-strategy.
          Backdrop click + Esc close. Save triggers PATCH /preferences,
          which the backend persists into definition._ui_prefs so the
          selection is sticky across browsers/devices/restarts. */}
      {brokerModalOpen && (
        <BrokerPickerModal
          strategyName={s.name}
          brokers={brokers}
          pending={pendingBrokers}
          onToggle={togglePending}
          onClose={() => setBrokerModalOpen(false)}
          onSave={saveBrokerPrefs}
          saving={savingPrefs}
          activeBrokerIds={activeBrokerIds}
        />
      )}
    </div>
  );
}

// Card data is per-strategy and tick updates flow through SWR/WS hooks
// inside the card. The parent re-renders on every /strategies poll (60s)
// and /brokers poll — without memo each tick re-renders every card,
// which is the main source of jank on the Strategies page and the reason
// clicking sidebar links feels delayed.
export const StrategyCard = memo(StrategyCardImpl, (prev, next) => {
  if (prev.strategy !== next.strategy) {
    // Deep-compare the fields the card actually renders so a no-op
    // SWR revalidation (same JSON, new object identity) doesn't blow
    // the memo. Cheaper than a full deep-equal.
    const a = prev.strategy;
    const b = next.strategy;
    if (
      a.id !== b.id
      || a.name !== b.name
      || a.description !== b.description
      || a.kind !== b.kind
      || a.status !== b.status
      || a.timeframe_min !== b.timeframe_min
      || a.capital !== b.capital
      || a.instrument_class !== b.instrument_class
      || a.side !== b.side
      || a.option_action !== b.option_action
      || a.auto_start_on_login !== b.auto_start_on_login
      || a.auto_start_broker_account_id !== b.auto_start_broker_account_id
      || a.auto_start_is_paper !== b.auto_start_is_paper
    ) return false;
    const aSyms = (a.symbols || []).join("|");
    const bSyms = (b.symbols || []).join("|");
    if (aSyms !== bSyms) return false;
    const aPref = (a.preferred_broker_account_ids || []).slice().sort().join("|");
    const bPref = (b.preferred_broker_account_ids || []).slice().sort().join("|");
    if (aPref !== bPref) return false;
  }
  if (prev.brokers !== next.brokers) {
    if ((prev.brokers?.length || 0) !== (next.brokers?.length || 0)) return false;
    for (let i = 0; i < prev.brokers.length; i++) {
      const a = prev.brokers[i];
      const b = next.brokers[i];
      if (
        a.id !== b.id
        || a.is_active !== b.is_active
        || a.is_paper !== b.is_paper
        || a.session_valid_until !== b.session_valid_until
        || a.label !== b.label
        || a.client_id !== b.client_id
        || a.broker !== b.broker
      ) return false;
    }
  }
  if (prev.onChanged !== next.onChanged) return false;
  if (prev.onDelete !== next.onDelete) return false;
  return true;
});

// ---- Broker picker modal ---------------------------------------------------
// Standalone component so the card stays readable. State (the pending
// selection) lives on the card so cancelling discards in-progress
// toggles without losing the committed selection.

function BrokerPickerModal({
  strategyName,
  brokers,
  pending,
  onToggle,
  onClose,
  onSave,
  saving,
  activeBrokerIds,
}: {
  strategyName: string;
  brokers: BrokerAccount[];
  pending: Set<string>;
  onToggle: (id: string, disabled: boolean) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  activeBrokerIds: Set<string>;
}) {
  // Esc to close, Enter to save (unless saving). Matches the
  // ConfirmDialog keyboard contract elsewhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !saving) {
        e.preventDefault();
        onSave();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onSave, saving]);

  const total = brokers.length;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="broker-picker-title"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md card shadow-xl animate-[fadeIn_0.15s_ease-out]">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-primary/15 text-primary">
            <Users className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="broker-picker-title" className="text-base font-semibold leading-snug pr-6">
              Choose brokers
            </h2>
            <p className="text-xs text-muted-foreground mt-1 truncate" title={strategyName}>
              for <span className="text-gray-300">{strategyName}</span>
            </p>
          </div>
          <button
            type="button"
            className="absolute top-3 right-3 text-muted-foreground hover:text-gray-200 text-sm"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mt-3 mb-2">
          Saved permanently — your selection comes back on every reload,
          new browser session, and other devices.
        </p>

        {total === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No broker accounts connected.{" "}
            <Link href="/brokers" className="text-primary hover:underline">
              Connect one →
            </Link>
          </div>
        ) : (
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {brokers.map((b) => {
              const inactive = !b.is_active;
              const loggedOut = !inactive && !isSessionValid(b);
              const running = activeBrokerIds.has(b.id);
              // The picker edits the *preference* — what Start will use
              // next time. That's independent of what's currently
              // running, so every broker is freely toggleable here.
              // Inactive / logged-out / running brokers all get info
              // badges so the user knows the state, but toggling is
              // never blocked (otherwise the user can't add a broker
              // back to the preference once it's already running, which
              // is exactly the trap that previously stored empty lists).
              const checked = pending.has(b.id);
              return (
                <label
                  key={b.id}
                  className={clsx(
                    "flex items-center gap-2 text-xs px-2 py-2 rounded border cursor-pointer",
                    checked
                      ? "bg-primary/10 border-primary/40"
                      : "border-border hover:bg-panel2",
                  )}
                  title={
                    running
                      ? "currently running this strategy — saving here only affects future Start"
                      : inactive
                        ? "broker disabled — Start will skip it"
                        : loggedOut
                          ? "logged out — log in on the Brokers page before Start"
                          : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(b.id, false)}
                  />
                  <span className="font-mono truncate">
                    {b.broker} • {b.label || b.client_id}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    {running && (
                      <span className="pill bg-primary/20 text-primary text-[9px]">
                        Running
                      </span>
                    )}
                    {inactive && !running && (
                      <span className="pill bg-panel text-muted-foreground text-[9px]">
                        Disabled
                      </span>
                    )}
                    {loggedOut && !running && (
                      <Link
                        href="/brokers"
                        className="pill bg-orange-500/20 text-orange-300 text-[9px] hover:underline"
                        title="open Brokers page to log in"
                      >
                        Logged out
                      </Link>
                    )}
                    {b.is_paper && (
                      <span className="pill bg-yellow-500/20 text-yellow-300 text-[9px]">
                        Paper
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-5">
          <span className="text-[11px] text-muted-foreground">
            {pending.size === 0 ? "None selected" : `${pending.size} selected`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onSave}
              disabled={saving || total === 0}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Icon-only button helpers ------------------------------------------------
// Pulled out so the action row stays readable. Both helpers share styling so
// the row reads as a single toolbar regardless of whether the action is a
// route navigation (`Link`) or a click handler (`button`).

const ICON_BTN_BASE =
  "inline-flex items-center justify-center w-9 h-9 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

const ICON_VARIANTS = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-border text-foreground hover:bg-accent",
  "ghost-danger":
    "border border-danger/40 text-danger hover:bg-danger/10 disabled:hover:bg-transparent",
} as const;

type IconVariant = keyof typeof ICON_VARIANTS;

function IconButton({
  variant,
  label,
  icon,
  className,
  ...rest
}: {
  variant: IconVariant;
  label: string;
  icon: React.ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={clsx(ICON_BTN_BASE, ICON_VARIANTS[variant], className)}
      {...rest}
    >
      {icon}
    </button>
  );
}

function IconLink({
  href,
  label,
  icon,
  variant = "outline",
  className,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  variant?: IconVariant;
  className?: string;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={clsx(ICON_BTN_BASE, ICON_VARIANTS[variant], className)}
    >
      {icon}
    </Link>
  );
}
