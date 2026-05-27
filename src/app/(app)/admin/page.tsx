"use client";
import useSWR from "swr";
import { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "@/lib/api";
import { isNonTradingDay, maxAvailableEodDateISO } from "@/lib/eodSchedule";

const BASE = (process.env.NEXT_PUBLIC_API_BASE || "") + "/api/v1";
const BROKERS = ["ZERODHA", "ANGEL", "UPSTOX", "SHOONYA", "DHAN", "FYERS"];
const fetcher = (u: string) => api.get(u).then((r) => r.data);

type Health = {
  total: number;
  active: number;
  mappings_per_broker: Record<string, number>;
  last_sync_per_broker: Record<string, string | null>;
};

type SyncRun = {
  id: string;
  broker: string;
  status: "RUNNING" | "OK" | "FAILED";
  started_at: string | null;
  finished_at: string | null;
  upserts: number;
  skipped: number;
  seen: number;
  error: string | null;
};

type Settings = {
  broker_auto_login_enabled: boolean;
  broker_auto_login_time: string;   // HH:MM
  broker_auto_logout_enabled: boolean;
  broker_auto_logout_time: string;  // HH:MM
  eod_ingest_enabled: boolean;
  eod_ingest_time: string;          // HH:MM
  updated_at: string | null;
};

type EodReport = {
  queued?: boolean;
  trade_date: string;
  cm_candles?: number;
  cm_skipped?: number;
  fo_candles?: number;
  fo_oi_rows?: number;
  fo_skipped?: number;
  delivery_rows?: number;
  delivery_skipped?: number;
  index_candles?: number;
  index_skipped?: number;
  // BSE indices (SENSEX / BANKEX / SENSEX 50). Fetched via broker
  // historical API, so this is 0 when no active Fyers account exists.
  bse_index_candles?: number;
  errors?: string[];
};

export default function AdminPage() {
  const { data: users, mutate: refreshUsers } = useSWR<any[]>("/admin/users", fetcher);
  const { data: health, mutate: refreshHealth } = useSWR<Health>("/admin/symbol-master/health", fetcher);
  const { data: runs, mutate: refreshRuns } = useSWR<SyncRun[]>(
    "/admin/symbol-master/sync-runs?limit=20", fetcher,
  );
  const { data: settings, mutate: refreshSettings } = useSWR<Settings>("/admin/settings", fetcher);
  const [busy, setBusy] = useState<string | null>(null);

  // ---- Full master download state ------------------------------------
  const [syncAllBusy, setSyncAllBusy] = useState(false);
  const [syncAllLogs, setSyncAllLogs] = useState<string[]>([]);
  const [syncAllDone, setSyncAllDone] = useState<"idle" | "ok" | "error">("idle");
  const logBoxRef = useRef<HTMLDivElement>(null);

  async function runSyncAll(force = false) {
    setSyncAllBusy(true);
    setSyncAllLogs([]);
    setSyncAllDone("idle");

    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    const url = `${BASE}/admin/symbol-master/sync-all?force=${force}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok || !res.body) {
        setSyncAllLogs((p) => [...p, `HTTP ${res.status}: ${res.statusText}`]);
        setSyncAllDone("error");
        setSyncAllBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const msg = line.slice(6);
          if (msg === "__DONE__") {
            setSyncAllDone((prev) => prev === "error" ? "error" : "ok");
            setSyncAllBusy(false);
            refreshHealth();
            refreshRuns();
            return;
          }
          const isErr = msg.startsWith("ERROR:");
          if (isErr) setSyncAllDone("error");
          setSyncAllLogs((p) => {
            const next = [...p, msg];
            // Auto-scroll
            setTimeout(() => {
              if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
            }, 0);
            return next;
          });
        }
      }
    } catch (e: any) {
      setSyncAllLogs((p) => [...p, `ERROR: ${e?.message ?? e}`]);
      setSyncAllDone("error");
    }
    setSyncAllBusy(false);
  }

  async function disable(id: string) {
    try {
      await api.post(`/admin/users/${id}/disable`);
      toast.success("disabled");
      refreshUsers();
    } catch {
      toast.error("failed");
    }
  }

  async function syncBroker(b: string, inline = true) {
    setBusy(b);
    const tId = toast.loading(`syncing ${b}…  (this can take 1–4 min — Redis bulk writes)`);
    try {
      // Override the shared 20s axios timeout. Inline syncs do a full
      // CSV/JSON download + parse + Redis bulk write (~150k entries);
      // with multiple brokers contending on the Redis pipeline this can
      // run for several minutes. Backend already has its own 600s
      // safety guard, so 600s here matches.
      const { data } = await api.post(
        `/admin/symbol-master/sync/${b}?inline=${inline}`,
        undefined,
        { timeout: 600_000 },
      );
      toast.dismiss(tId);
      if (data.queued) {
        toast.success(`${b} sync queued (Celery)`);
      } else {
        toast.success(`${b} sync OK — upserts ${data.upserts}, skipped ${data.skipped}`);
      }
      refreshHealth();
      refreshRuns();
    } catch (e: any) {
      toast.dismiss(tId);
      const msg = e?.code === "ECONNABORTED"
        ? `${b} sync timed out (still running — check Sync Runs in a minute)`
        : e?.response?.data?.error?.message || `${b} sync failed`;
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Admin</h1>

      <BrokerScheduleCard
        settings={settings}
        onSaved={refreshSettings}
      />

      <EodIngestCard
        settings={settings}
        onSaved={refreshSettings}
      />

      <NotificationSettingsCard />

      <TradingHolidaysCard />

      <InstitutionalIngestCard />

      {/* ---- Full Master Download ------------------------------------ */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">Full Master Download</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Downloads all brokers in parallel, writes combined CSV + JSON, loads Redis.
              Skipped automatically if already done today (use Force to override).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-primary text-xs"
              disabled={syncAllBusy}
              onClick={() => runSyncAll(false)}
            >
              {syncAllBusy ? "Running…" : "Download All Brokers"}
            </button>
            <button
              className="btn-outline text-xs"
              disabled={syncAllBusy}
              onClick={() => runSyncAll(true)}
              title="Force re-sync even if already done today"
            >
              Force Re-sync
            </button>
          </div>
        </div>

        {/* Status badge */}
        {syncAllDone !== "idle" && (
          <div className={`mb-2 text-xs font-medium ${syncAllDone === "ok" ? "text-primary" : "text-danger"}`}>
            {syncAllDone === "ok" ? "✓ Sync complete" : "✗ Sync ended with errors"}
          </div>
        )}

        {/* Live log */}
        {syncAllLogs.length > 0 && (
          <div
            ref={logBoxRef}
            className="bg-black/40 rounded border border-white/10 p-3 h-56 overflow-y-auto font-mono text-xs leading-5 text-gray-300"
          >
            {syncAllLogs.map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("ERROR") ? "text-red-400" :
                  line.startsWith("  Redis") ? "text-green-400" :
                  line.startsWith("[") ? "text-yellow-300" :
                  ""
                }
              >
                {line}
              </div>
            ))}
            {syncAllBusy && <div className="text-muted-foreground animate-pulse">▋</div>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Symbol master</h2>
          <div className="text-xs text-muted-foreground">
            Total: <span className="text-gray-200">{health?.total ?? "—"}</span> ·
            Active: <span className="text-gray-200">{health?.active ?? "—"}</span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Broker</th>
              <th>Mappings</th>
              <th>Last successful sync</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {BROKERS.map((b) => {
              const count = health?.mappings_per_broker?.[b] ?? 0;
              const last = health?.last_sync_per_broker?.[b];
              return (
                <tr key={b}>
                  <td className="font-mono">{b}</td>
                  <td>{count.toLocaleString()}</td>
                  <td className="text-xs text-muted-foreground">
                    {last
                      ? new Date(last).toLocaleString()
                      : <span className="text-yellow-400">never (using seed data)</span>}
                  </td>
                  <td className="text-right">
                    <button
                      className="btn-primary text-xs"
                      disabled={busy === b}
                      onClick={() => syncBroker(b, true)}
                      title="Run inline (no Celery worker needed)"
                    >
                      {busy === b ? "Syncing…" : "Sync now"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 text-xs text-muted-foreground">
          Sync downloads the broker&apos;s official instrument file (CSV/JSON) and overwrites the
          per-broker mappings with the real broker_symbol + token. Until you sync, the platform
          uses synthetic seed values which won&apos;t resolve against real broker APIs (e.g.
          <span className="font-mono"> NSE:NIFTY-INDEX</span> vs the real
          <span className="font-mono"> NSE:NIFTY50-INDEX</span>).
        </div>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Recent sync runs</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Broker</th><th>Status</th><th>Started</th><th>Duration</th>
              <th>Upserts</th><th>Skipped</th><th>Error</th>
            </tr>
          </thead>
          <tbody>
            {(runs || []).map((r) => {
              const dur = r.started_at && r.finished_at
                ? `${Math.round((+new Date(r.finished_at) - +new Date(r.started_at)) / 1000)}s`
                : "—";
              return (
                <tr key={r.id}>
                  <td className="font-mono">{r.broker}</td>
                  <td>
                    <span className={`pill ${
                      r.status === "OK" ? "bg-primary/20 text-primary" :
                      r.status === "FAILED" ? "bg-danger/30 text-danger" :
                      "bg-yellow-700/40 text-yellow-300"
                    }`}>{r.status}</span>
                  </td>
                  <td className="text-xs">{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</td>
                  <td>{dur}</td>
                  <td>{r.upserts.toLocaleString()}</td>
                  <td>{r.skipped.toLocaleString()}</td>
                  <td className="text-xs text-danger truncate max-w-xs">{r.error}</td>
                </tr>
              );
            })}
            {!(runs || []).length && (
              <tr><td colSpan={7} className="text-center text-muted-foreground py-4">No sync runs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Users</h2>
        <table className="table">
          <thead>
            <tr><th>Email</th><th>Role</th><th>Active</th><th /></tr>
          </thead>
          <tbody>
            {(users || []).map((u: any) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{u.is_active ? "Yes" : "No"}</td>
                <td>
                  {u.is_active && (
                    <button className="btn-outline text-xs" onClick={() => disable(u.id)}>Disable</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Broker auto-login / auto-logout schedule
// ---------------------------------------------------------------------------
function BrokerScheduleCard({
  settings,
  onSaved,
}: {
  settings: Settings | undefined;
  onSaved: () => void;
}) {
  // Local form state mirrors the server until the user clicks Save; that
  // way the time inputs don't snap back to the server value mid-edit when
  // SWR revalidates.
  const [loginEnabled, setLoginEnabled] = useState(true);
  const [loginTime, setLoginTime] = useState("08:55");
  const [logoutEnabled, setLogoutEnabled] = useState(false);
  const [logoutTime, setLogoutTime] = useState("15:35");
  const [busy, setBusy] = useState(false);
  // Hydrate from server once data arrives.
  const hydratedFor = useRef<string | null>(null);
  if (settings && hydratedFor.current !== settings.updated_at) {
    hydratedFor.current = settings.updated_at;
    setLoginEnabled(settings.broker_auto_login_enabled);
    setLoginTime(settings.broker_auto_login_time);
    setLogoutEnabled(settings.broker_auto_logout_enabled);
    setLogoutTime(settings.broker_auto_logout_time);
  }

  async function save() {
    setBusy(true);
    try {
      await api.patch("/admin/settings", {
        broker_auto_login_enabled: loginEnabled,
        broker_auto_login_time: loginTime,
        broker_auto_logout_enabled: logoutEnabled,
        broker_auto_logout_time: logoutTime,
      });
      toast.success("schedule saved");
      onSaved();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">Broker auto-login / logout</h2>
          {/* <p className="text-xs text-muted-foreground mt-0.5">
            Times in IST. Changes apply on the next scheduler tick (within ~5 min) — no restart needed.
            Auto-login uses each broker&apos;s stored TOTP + MPIN (Fyers) or password + TOTP (Angel One).
          </p> */}
        </div>
        <button className="btn-primary text-xs" onClick={save} disabled={busy || !settings}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Enabled</th>
            <th>Time (IST)</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="font-mono">Auto-login</td>
            <td>
              <input
                type="checkbox"
                checked={loginEnabled}
                onChange={(e) => setLoginEnabled(e.target.checked)}
              />
            </td>
            <td>
              <input
                type="time"
                className="input text-xs w-28"
                value={loginTime}
                onChange={(e) => setLoginTime(e.target.value)}
                disabled={!loginEnabled}
              />
            </td>
            <td className="text-xs text-muted-foreground">
              Weekdays only. Skipped if account is missing TOTP/MPIN.
            </td>
          </tr>
          <tr>
            <td className="font-mono">Auto-logout</td>
            <td>
              <input
                type="checkbox"
                checked={logoutEnabled}
                onChange={(e) => setLogoutEnabled(e.target.checked)}
              />
            </td>
            <td>
              <input
                type="time"
                className="input text-xs w-28"
                value={logoutTime}
                onChange={(e) => setLogoutTime(e.target.value)}
                disabled={!logoutEnabled}
              />
            </td>
            <td className="text-xs text-muted-foreground">
              Stops feeds + clears tokens. Off by default.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}


// ---------------------------------------------------------------------------
// NSE EOD ingest — schedule + manual one-off download
// ---------------------------------------------------------------------------
function EodIngestCard({
  settings,
  onSaved,
}: {
  settings: Settings | undefined;
  onSaved: () => void;
}) {
  // Schedule form state — same hydrate-once-from-server pattern as the
  // broker schedule card so SWR revalidations don't snap inputs back.
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState("19:30");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const hydratedFor = useRef<string | null>(null);
  if (settings && hydratedFor.current !== settings.updated_at) {
    hydratedFor.current = settings.updated_at;
    setEnabled(settings.eod_ingest_enabled);
    setTime(settings.eod_ingest_time);
  }

  // Manual download state — defaults to the most recent date that
  // *should* have data (i.e., NSE has published and the scheduler has
  // ingested). Tracks the live ingest time so admins who push it later
  // (say 20:30 for safety) automatically get the picker following along.
  const cutoffHHMM = settings?.eod_ingest_time;
  // Holidays for the surrounding year — same source the EOD page reads.
  const today = new Date();
  const { data: holidayList } = useSWR<string[]>(
    `/eod/holidays?from=${today.getFullYear()}-01-01&to=${today.getFullYear() + 1}-01-01`,
    (u: string) => api.get(u).then((r) => r.data),
  );
  const holidaySet = new Set<string>(holidayList || []);
  const maxManualDate = maxAvailableEodDateISO(cutoffHHMM, holidaySet);
  const [manualDate, setManualDate] = useState<string>(() => maxAvailableEodDateISO());
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<EodReport | null>(null);

  // When the cutoff resolves / changes, snap the picker forward unless
  // the user has already moved it to a past date deliberately.
  if (settings && manualDate > maxManualDate) {
    setManualDate(maxManualDate);
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    try {
      await api.patch("/admin/settings", {
        eod_ingest_enabled: enabled,
        eod_ingest_time: time,
      });
      toast.success("EOD schedule saved");
      onSaved();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "save failed");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setReport(null);
    const tId = toast.loading(`ingesting ${manualDate}…  (10–60s, depends on NSE)`);
    try {
      // inline=true → backend runs in-process and returns the report
      // synchronously, so we can show actual row counts instead of a
      // task id the user can't follow up on without a Celery worker.
      const { data } = await api.post<EodReport>(
        `/eod/ingest/${manualDate}?inline=true`,
      );
      toast.dismiss(tId);
      setReport(data);
      const errs = data.errors?.length ?? 0;
      if (errs) {
        toast.error(`${manualDate}: completed with ${errs} file error(s)`);
      } else {
        toast.success(`${manualDate}: ingest OK`);
      }
    } catch (e: any) {
      toast.dismiss(tId);
      toast.error(e?.response?.data?.error?.message || "ingest failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">NSE EOD ingest</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Time in IST. NSE publishes CM bhavcopy by ~18:15, FO by ~18:45;
            19:30 is a safe default. Changes apply within ~5 min — no restart.
            Daily candles, delivery %, FO open-interest, and BSE indices
            (SENSEX / BANKEX) land in the DB for backtests and screeners.
            BSE rows need an active Fyers session — they&apos;ll be 0 if
            no broker is connected.
          </p>
        </div>
      </div>

      {/* ---- Schedule ----------------------------------------------- */}
      <table className="table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Enabled</th>
            <th>Time (IST)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="font-mono">NSE EOD ingest</td>
            <td>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            </td>
            <td>
              <input
                type="time"
                className="input text-xs w-28"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={!enabled}
              />
            </td>
            <td className="text-right">
              <button
                className="btn-primary text-xs"
                onClick={saveSchedule}
                disabled={savingSchedule || !settings}
              >
                {savingSchedule ? "Saving…" : "Save schedule"}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      {/* ---- Manual one-off download -------------------------------- */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium">Manual download</span>
          <input
            type="date"
            className="input text-xs w-40"
            value={manualDate}
            onChange={(e) => {
              const v = e.target.value;
              // Holidays bounce — same UX as the EOD page.
              if (v && isNonTradingDay(v, holidaySet)) return;
              setManualDate(v);
            }}
            max={maxManualDate}
          />
          <button
            className="btn-primary text-xs"
            onClick={runNow}
            disabled={running || !manualDate}
          >
            {running ? "Downloading…" : "Download now"}
          </button>
          <span className="text-xs text-muted-foreground">
            Latest available: <span className="font-mono">{maxManualDate}</span>
            {cutoffHHMM && <> · today opens after {cutoffHHMM} IST</>}.
            Re-runs are safe — every row is upserted on its natural key.
          </span>
        </div>

        {report && (
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <ReportStat label="CM candles"    value={report.cm_candles} />
            <ReportStat label="CM skipped"    value={report.cm_skipped} muted />
            <ReportStat label="FO candles"    value={report.fo_candles} />
            <ReportStat label="FO OI rows"    value={report.fo_oi_rows} />
            <ReportStat label="FO skipped"    value={report.fo_skipped} muted />
            <ReportStat label="Delivery"      value={report.delivery_rows} />
            <ReportStat label="Index candles" value={report.index_candles} />
            <ReportStat label="BSE indices"   value={report.bse_index_candles}
                        muted={(report.bse_index_candles ?? 0) === 0} />
            <ReportStat label="Errors"        value={report.errors?.length ?? 0}
                        warn={(report.errors?.length ?? 0) > 0} />
          </div>
        )}

        {report?.errors && report.errors.length > 0 && (
          <div className="mt-2 text-xs text-danger font-mono">
            {report.errors.map((e, i) => <div key={i}>· {e}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}


function ReportStat({
  label, value, muted = false, warn = false,
}: {
  label: string;
  value: number | undefined;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div className={`px-2 py-1.5 rounded border ${
      warn ? "border-danger/40 bg-danger/10"
           : muted ? "border-white/5 bg-white/2"
                   : "border-white/10 bg-white/5"
    }`}>
      <div className={`text-[10px] uppercase tracking-wide ${
        warn ? "text-danger" : "text-muted-foreground"
      }`}>{label}</div>
      <div className={`font-mono ${warn ? "text-danger" : ""}`}>
        {value?.toLocaleString() ?? "—"}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Trading holidays — admin-managed; used by the EOD scheduler + pickers
// ---------------------------------------------------------------------------
type Holiday = {
  exchange: string;
  holiday_date: string;       // YYYY-MM-DD
  description: string | null;
  created_at: string | null;
};

function TradingHolidaysCard() {
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const { data: holidays, mutate: refresh } = useSWR<Holiday[]>(
    `/admin/holidays?exchange=NSE&year=${year}`,
    (u: string) => api.get(u).then((r) => r.data),
  );

  // Single-add inputs
  const [addDate, setAddDate] = useState<string>("");
  const [addDesc, setAddDesc] = useState<string>("");
  const [adding, setAdding] = useState(false);

  // Bulk upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadReport, setUploadReport] = useState<null | {
    parsed: number; inserted: number; updated: number; skipped: string[];
  }>(null);

  async function addOne() {
    if (!addDate) return;
    setAdding(true);
    try {
      await api.post("/admin/holidays?exchange=NSE", {
        holiday_date: addDate,
        description: addDesc || null,
      });
      toast.success(`added ${addDate}`);
      setAddDate("");
      setAddDesc("");
      refresh();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "add failed");
    } finally {
      setAdding(false);
    }
  }

  async function deleteOne(d: string) {
    if (!confirm(`Delete holiday ${d}?`)) return;
    try {
      await api.delete(`/admin/holidays/${d}?exchange=NSE`);
      toast.success(`removed ${d}`);
      refresh();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "delete failed");
    }
  }

  async function uploadCsv(file: File) {
    setUploading(true);
    setUploadReport(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post(
        "/admin/holidays/bulk?exchange=NSE",
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setUploadReport(data);
      toast.success(`imported: ${data.inserted} added, ${data.updated} updated`);
      refresh();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const years = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1];
  }, []);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">NSE trading holidays</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            The EOD scheduler + backfill skip these dates, and the EOD-Analysis
            date picker greys them out. Add one at a time or bulk-upload NSE&apos;s
            official CSV.
          </p>
        </div>
        <select
          className="input text-xs w-24"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {years.map((y: number) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* ---- Single-add row -------------------------------------- */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <input
          type="date"
          className="input text-xs w-40"
          value={addDate}
          onChange={(e) => setAddDate(e.target.value)}
        />
        <input
          type="text"
          className="input text-xs flex-1 min-w-[200px]"
          placeholder="Description (optional, e.g. Diwali)"
          value={addDesc}
          onChange={(e) => setAddDesc(e.target.value)}
          maxLength={120}
        />
        <button
          className="btn-primary text-xs"
          onClick={addOne}
          disabled={adding || !addDate}
        >
          {adding ? "Adding…" : "Add holiday"}
        </button>
      </div>

      {/* ---- Bulk upload row ------------------------------------- */}
      <div className="border-t border-white/10 pt-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">Bulk upload</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="text-xs"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadCsv(f);
            }}
          />
          <span className="text-xs text-muted-foreground">
            Accepts YYYY-MM-DD, DD-MM-YYYY, DD-MMM-YYYY, or DD/MM/YYYY.
            Optional 2nd column = description.
          </span>
        </div>
        {uploadReport && (
          <div className="mt-2 text-xs">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Parsed"   value={uploadReport.parsed} />
              <Stat label="Inserted" value={uploadReport.inserted} />
              <Stat label="Updated"  value={uploadReport.updated} />
              <Stat label="Skipped"  value={uploadReport.skipped.length}
                    warn={uploadReport.skipped.length > 0} />
            </div>
            {uploadReport.skipped.length > 0 && (
              <div className="mt-2 text-danger font-mono">
                {uploadReport.skipped.slice(0, 20).map((s, i) => (
                  <div key={i}>· {s}</div>
                ))}
                {uploadReport.skipped.length > 20 && (
                  <div>· … and {uploadReport.skipped.length - 20} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- Holiday list ---------------------------------------- */}
      {!holidays || holidays.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No holidays recorded for {year}.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.holiday_date} className="hover:bg-accent/30">
                <td className="font-mono">{h.holiday_date}</td>
                <td className="text-xs text-muted-foreground">
                  {new Date(h.holiday_date + "T00:00:00Z").toLocaleDateString("en-US", {
                    weekday: "short", timeZone: "UTC",
                  })}
                </td>
                <td>{h.description || <span className="text-muted-foreground">—</span>}</td>
                <td className="text-right">
                  <button
                    className="btn-outline text-xs"
                    onClick={() => deleteOne(h.holiday_date)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


function Stat({
  label, value, warn = false,
}: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`px-2 py-1.5 rounded border ${
      warn ? "border-danger/40 bg-danger/10"
           : "border-white/10 bg-white/5"
    }`}>
      <div className={`text-[10px] uppercase tracking-wide ${
        warn ? "text-danger" : "text-muted-foreground"
      }`}>{label}</div>
      <div className={`font-mono ${warn ? "text-danger" : ""}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Institutional flow ingest — focused FII/DII + participant-OI download
// ---------------------------------------------------------------------------
type InstReport = {
  from: string;
  to:   string;
  days_attempted: number;
  days_ok: number;
  days_partial: number;
  days_skipped_non_trading: number;
  cash_rows_total: number;
  participant_rows_total: number;
  per_day: {
    date: string;
    cash_rows?: number;
    participant_rows?: number;
    errors?: string[];
    fatal?: string;
  }[];
};

function InstitutionalIngestCard() {
  // Default to "last 60 days ending yesterday" since NSE publishes
  // each day's institutional reports in the evening (so today's data
  // doesn't exist until ~7 PM IST).
  const [from, setFrom] = useState<string>(() => isoDaysAgo(60));
  const [to,   setTo]   = useState<string>(() => isoDaysAgo(1));
  const [running, setRunning] = useState(false);
  const [report,  setReport]  = useState<InstReport | null>(null);

  async function runRange(rangeFrom: string, rangeTo: string) {
    setRunning(true);
    setReport(null);
    const tId = toast.loading(
      `Downloading institutional data ${rangeFrom} → ${rangeTo}…`,
    );
    try {
      const { data } = await api.post<InstReport>(
        `/admin/institutional/ingest?from=${rangeFrom}&to=${rangeTo}`,
      );
      setReport(data);
      toast.dismiss(tId);
      const failed = data.days_attempted - data.days_ok;
      if (failed === 0) {
        toast.success(`OK: ${data.days_ok} days, ${data.participant_rows_total} participant rows`);
      } else {
        toast.error(
          `Done with ${data.days_partial} partial day(s). ` +
          `Cash rows often fail on older dates (NSE live API limit).`,
        );
      }
    } catch (e: any) {
      toast.dismiss(tId);
      toast.error(e?.response?.data?.error?.message || "ingest failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Institutional flow ingest</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Backfill FII/DII cash + F&amp;O participant-wise OI for a date
            range. Skips weekends and NSE holidays automatically.
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Note: NSE&apos;s live JSON for cash data only exposes the latest
            1–2 trading days. Participant OI works for all historical
            dates. Older cash rows in the range will appear under
            errors[].
          </p>
        </div>
      </div>

      {/* ---- Range controls + shortcuts ----------------------------- */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-sm font-medium">From</span>
        <input
          type="date" className="input text-xs w-40"
          value={from} onChange={(e) => setFrom(e.target.value)}
        />
        <span className="text-sm font-medium">To</span>
        <input
          type="date" className="input text-xs w-40"
          value={to} onChange={(e) => setTo(e.target.value)}
        />
        <button
          className="btn-primary text-xs"
          disabled={running || !from || !to}
          onClick={() => runRange(from, to)}
        >
          {running ? "Downloading…" : "Download range"}
        </button>
        <span className="text-xs text-muted-foreground">·</span>
        <button
          className="btn-outline text-xs"
          disabled={running}
          onClick={() => {
            const f = isoDaysAgo(60), t = isoDaysAgo(1);
            setFrom(f); setTo(t); runRange(f, t);
          }}
          title="Backfill the most recent two months"
        >
          Last 2 months
        </button>
        <button
          className="btn-outline text-xs"
          disabled={running}
          onClick={() => {
            const f = isoDaysAgo(1), t = isoDaysAgo(1);
            setFrom(f); setTo(t); runRange(f, t);
          }}
          title="Re-download only yesterday's data"
        >
          Yesterday
        </button>
      </div>

      {/* ---- Report ------------------------------------------------- */}
      {report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mb-3">
            <Stat label="Days attempted"     value={report.days_attempted} />
            <Stat label="Days OK"            value={report.days_ok} />
            <Stat label="Days partial"       value={report.days_partial}
                  warn={report.days_partial > 0} />
            <Stat label="Non-trading skipped" value={report.days_skipped_non_trading} />
            <Stat label="Cash rows"          value={report.cash_rows_total} />
            <Stat label="Participant rows"   value={report.participant_rows_total} />
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Per-day detail ({report.per_day.length} rows)
            </summary>
            <div className="mt-2 max-h-64 overflow-y-auto border border-white/10 rounded">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="text-right">Cash</th>
                    <th className="text-right">Participant</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {report.per_day.map((d) => (
                    <tr key={d.date}
                        className={d.fatal || (d.errors && d.errors.length)
                          ? "text-danger" : ""}>
                      <td className="font-mono">{d.date}</td>
                      <td className="font-mono text-right">{d.cash_rows ?? 0}</td>
                      <td className="font-mono text-right">{d.participant_rows ?? 0}</td>
                      <td className="text-xs">
                        {d.fatal
                          ? d.fatal
                          : (d.errors || []).join("; ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {/* ---- JSON upload (bulk-import pre-fetched history) -------- */}
      <div className="border-t border-white/10 pt-3 mt-4">
        <HistoryJsonImporter />
      </div>
    </div>
  );
}


type HistoryReport = {
  dates_seen: number;
  first_date: string | null;
  last_date:  string | null;
  cash_rows_total: number;
  participant_rows_total: number;
  errors: string[];
};

function HistoryJsonImporter() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<HistoryReport | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setReport(null);
    const tId = toast.loading(`Importing ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post<HistoryReport>(
        "/admin/institutional/import-json",
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setReport(data);
      toast.dismiss(tId);
      toast.success(
        `Imported ${data.dates_seen} day(s) — ${data.cash_rows_total} cash + ${data.participant_rows_total} participant rows`,
      );
    } catch (e: any) {
      toast.dismiss(tId);
      toast.error(e?.response?.data?.error?.message || "import failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-sm font-medium">Bulk JSON import</span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="text-xs"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        <span className="text-xs text-muted-foreground">
          For pre-fetched FII/DII history (denormalized JSON array, one
          object per date). Idempotent — re-uploading the same file just
          overwrites.
        </span>
      </div>
      {report && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <Stat label="Dates imported"     value={report.dates_seen} />
          <Stat label="Cash rows"          value={report.cash_rows_total} />
          <Stat label="Participant rows"   value={report.participant_rows_total} />
          <Stat label="Errors"             value={report.errors.length}
                warn={report.errors.length > 0} />
          {report.first_date && report.last_date && (
            <div className="col-span-2 md:col-span-4 text-muted-foreground">
              Range: <span className="font-mono">{report.first_date}</span>
              {" → "}
              <span className="font-mono">{report.last_date}</span>
            </div>
          )}
          {report.errors.length > 0 && (
            <div className="col-span-2 md:col-span-4 text-danger font-mono">
              {report.errors.slice(0, 10).map((e, i) => <div key={i}>· {e}</div>)}
              {report.errors.length > 10 && (
                <div>· … and {report.errors.length - 10} more</div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}


// ---------------------------------------------------------------------------
// Notification settings — global per-event toggles + popup duration
//
// Lists every event in the in-code catalogue (returned by the backend at
// /admin/notification-settings). Each event has:
//   - an Enabled toggle (admin can globally suppress an event for all users)
//   - a Popup duration field (0 = bell-only; >0 = transient on-screen popup
//     that auto-dismisses after that many seconds)
// Reset → null clears the popup override so the event reverts to its
// in-code default (visible in the "Default" column for reference).
// ---------------------------------------------------------------------------
type NotificationEvent = {
  event_key: string;
  title: string;
  message: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";
  category: string;
  action_status: string | null;
  default_popup_seconds: number;
  enabled: boolean;
  popup_seconds: number;
  note: string | null;
  overridden: boolean;
};

function NotificationSettingsCard() {
  const { data: events, mutate } = useSWR<NotificationEvent[]>(
    "/admin/notification-settings",
    fetcher,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");

  // Group by category so the giant flat list scans cleanly.
  const grouped = useMemo(() => {
    const filtered = (events || []).filter((e) => {
      if (categoryFilter !== "ALL" && e.category !== categoryFilter) return false;
      if (!search) return true;
      const needle = search.toLowerCase();
      return (
        e.event_key.toLowerCase().includes(needle) ||
        e.title.toLowerCase().includes(needle) ||
        e.message.toLowerCase().includes(needle)
      );
    });
    const buckets: Record<string, NotificationEvent[]> = {};
    for (const e of filtered) {
      (buckets[e.category] ||= []).push(e);
    }
    return buckets;
  }, [events, categoryFilter, search]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const e of events || []) s.add(e.category);
    return ["ALL", ...Array.from(s).sort()];
  }, [events]);

  async function patch(
    eventKey: string,
    body: Partial<Pick<NotificationEvent, "enabled" | "popup_seconds" | "note">>,
  ) {
    setBusy(eventKey);
    try {
      await api.patch(`/admin/notification-settings/${eventKey}`, body);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "save failed");
    } finally {
      setBusy(null);
    }
  }

  const totalCount = events?.length ?? 0;
  const enabledCount = (events || []).filter((e) => e.enabled).length;
  const popupCount = (events || []).filter((e) => e.enabled && e.popup_seconds > 0).length;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold">Notification settings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Globally enable/disable each event for ALL users, and set
            how long the on-screen popup stays visible. Disabled events
            also skip Email / Telegram / Discord / Webhook delivery —
            so this is the master switch. Per-user channel preferences
            still apply on top of whatever is enabled here.
          </p>
        </div>
        <div className="text-xs text-muted-foreground text-right">
          <div>Events: <span className="text-gray-200 font-mono">{totalCount}</span></div>
          <div>Enabled: <span className="text-primary font-mono">{enabledCount}</span></div>
          <div>With popup: <span className="text-gray-200 font-mono">{popupCount}</span></div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <input
          type="text"
          className="input text-xs flex-1 min-w-[200px]"
          placeholder="Search event key, title, message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input text-xs w-40"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {!events ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          Loading event catalogue…
        </div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No events match the filter.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                {cat}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Severity</th>
                    <th>Enabled</th>
                    <th>Popup (sec)</th>
                    <th>Default</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <NotificationEventRow
                      key={e.event_key}
                      event={e}
                      busy={busy === e.event_key}
                      onPatch={(body) => patch(e.event_key, body)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationEventRow({
  event,
  busy,
  onPatch,
}: {
  event: NotificationEvent;
  busy: boolean;
  onPatch: (body: Partial<Pick<NotificationEvent, "enabled" | "popup_seconds" | "note">>) => Promise<void> | void;
}) {
  // Local mirror of popup_seconds so the input doesn't snap back to
  // server value mid-edit while debouncing.
  const [popupDraft, setPopupDraft] = useState<string>(String(event.popup_seconds));
  // Re-sync when the parent re-fetches.
  const lastServer = useRef<number>(event.popup_seconds);
  if (lastServer.current !== event.popup_seconds) {
    lastServer.current = event.popup_seconds;
    setPopupDraft(String(event.popup_seconds));
  }

  const sevColor =
    event.severity === "CRITICAL" || event.severity === "ERROR" ? "text-danger" :
    event.severity === "WARNING" ? "text-warning" :
    event.severity === "SUCCESS" ? "text-primary" :
    "text-muted-foreground";

  function commitPopup() {
    const n = Number(popupDraft);
    if (!Number.isFinite(n) || n < 0 || n > 60) {
      toast.error("popup must be 0-60 seconds");
      setPopupDraft(String(event.popup_seconds));
      return;
    }
    if (n === event.popup_seconds) return;
    onPatch({ popup_seconds: n });
  }

  return (
    <tr className={!event.enabled ? "opacity-60" : ""}>
      <td>
        <div className="font-mono text-xs">{event.event_key}</div>
        <div className="text-[11px] text-muted-foreground truncate max-w-md">
          {event.title}
        </div>
      </td>
      <td className={`text-xs font-medium ${sevColor}`}>{event.severity}</td>
      <td>
        <input
          type="checkbox"
          checked={event.enabled}
          disabled={busy}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={60}
          className="input text-xs w-16"
          value={popupDraft}
          disabled={busy || !event.enabled}
          onChange={(e) => setPopupDraft(e.target.value)}
          onBlur={commitPopup}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </td>
      <td className="text-xs font-mono text-muted-foreground">
        {event.default_popup_seconds}s
      </td>
      <td className="text-right">
        {event.overridden && (
          <button
            className="btn-outline text-xs"
            disabled={busy}
            onClick={() => onPatch({ enabled: true, popup_seconds: event.default_popup_seconds })}
            title="Reset to defaults (enable + default popup)"
          >
            Reset
          </button>
        )}
      </td>
    </tr>
  );
}


function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
