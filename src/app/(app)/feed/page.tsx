"use client";
/**
 * Live Feed page.
 *
 *   1. Pick a broker account that's currently logged in.
 *   2. Type a symbol (e.g. RELIANCE-EQ).
 *   3. Click Subscribe — backend opens a broker WebSocket and republishes ticks.
 *   4. Frontend opens /ws/stream and shows incoming ticks live.
 *
 * Each subscribed symbol's display columns (Trading symbol / Exchange / Segment /
 * Expiry / Strike / Type) come from /symbols/{internal_symbol} so the user
 * never sees the raw internal_symbol unless they want to.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import { api } from "@/lib/api";
import { getStream } from "@/lib/ws";
import { fmtExpiry, fmtINR, fmtTs } from "@/lib/fmt";
import { useMarketPollInterval } from "@/lib/marketHours";
import { ExchangeSymbolPicker } from "@/components/ExchangeSymbolPicker";
import { TimezoneSelector } from "@/components/TimezoneSelector";
import { usePrefs } from "@/store/prefs";
import {
  EMPTY_FILTERS,
  SymbolCells,
  SymbolFilterRow,
  SymbolHeaders,
  applySymbolFilters,
  hasNonCashRows,
  symbolColumnCount,
  type SymbolColumnsRow,
  type SymbolFilters,
} from "@/components/SymbolColumns";

type Account = {
  id: string;
  broker: string;
  client_id: string;
  is_paper: boolean;
  session_valid_until?: string | null;
};

type Tick = {
  s: string;        // internal_symbol
  ts: string;       // ISO timestamp
  ltp: number;
  v?: number | null;
  bid?: number | null;
  ask?: number | null;
  oi?: number | null;
};

// One row per subscribed symbol, augmented with its master columns.
type LiveRow = SymbolColumnsRow & {
  internal_symbol: string;
  tick?: Tick;
};

const fetcher = (u: string) => api.get(u).then((r) => r.data);

function sessionValid(a: Account): boolean {
  if (!a.session_valid_until) return false;
  return new Date(a.session_valid_until).getTime() > Date.now();
}

export default function FeedPage() {
  const { data: accounts } = useSWR<Account[]>("/brokers", fetcher);
  // Feed status reflects broker WS health — only meaningful while at
  // least one exchange is open, so gate to the union session.
  const feedStatusPoll = useMarketPollInterval(10000, "ANY");
  const { data: status, mutate: refreshStatus } = useSWR<any[]>("/market/feed-status", fetcher, {
    refreshInterval: feedStatusPoll,
  });
  const timezone = usePrefs((s) => s.timezone);
  const liveAccounts = useMemo(
    () => (accounts || []).filter(sessionValid),
    [accounts],
  );

  const [accountId, setAccountId] = useState<string>("");
  const [symbol, setSymbol] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [subscribed, setSubscribed] = useState<string[]>([]);
  // internal_symbol → master display columns (cached on first subscribe).
  const [meta, setMeta] = useState<Record<string, SymbolColumnsRow>>({});
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [history, setHistory] = useState<Tick[]>([]);
  const [filters, setFilters] = useState<SymbolFilters>(EMPTY_FILTERS);
  const unsubRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    if (!accountId && liveAccounts.length) setAccountId(liveAccounts[0].id);
  }, [liveAccounts, accountId]);

  async function fetchMeta(sym: string) {
    if (meta[sym]) return;
    try {
      const { data } = await api.get<SymbolColumnsRow>(`/symbols/${encodeURIComponent(sym)}`);
      setMeta((cur) => ({ ...cur, [sym]: data }));
    } catch {
      // Master not loaded yet — leave the row showing internal_symbol as fallback.
    }
  }

  async function subscribe() {
    if (!accountId) { toast.error("pick a logged-in broker"); return; }
    if (!symbol.trim()) return;
    setBusy(true);
    try {
      await api.post("/market/subscribe", {
        broker_account_id: accountId,
        symbols: [symbol.trim()],
      });
      const sym = symbol.trim();
      if (!subscribed.includes(sym)) {
        setSubscribed((c) => [...c, sym]);
        fetchMeta(sym);
        const off = getStream().subscribeTicks([sym], (t: Tick) => {
          setTicks((cur) => ({ ...cur, [t.s]: t }));
          setHistory((cur) => [t, ...cur].slice(0, 200));
        });
        unsubRef.current[sym] = off;
      }
      toast.success(`subscribed ${sym}`);
      refreshStatus();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "subscribe failed");
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe(sym: string) {
    try {
      await api.post("/market/unsubscribe", {
        broker_account_id: accountId,
        symbols: [sym],
      });
    } catch {}
    unsubRef.current[sym]?.();
    delete unsubRef.current[sym];
    setSubscribed((c) => c.filter((s) => s !== sym));
    setTicks((cur) => {
      const { [sym]: _, ...rest } = cur;
      return rest;
    });
    refreshStatus();
  }

  useEffect(() => {
    return () => {
      Object.values(unsubRef.current).forEach((off) => off());
    };
  }, []);

  // Build the per-row view: master metadata + latest tick.
  const rows: LiveRow[] = useMemo(() => subscribed.map((s) => ({
    internal_symbol: s,
    trading_symbol: meta[s]?.trading_symbol ?? s,
    exchange:    meta[s]?.exchange ?? null,
    segment:     meta[s]?.segment ?? null,
    underlying:  meta[s]?.underlying ?? null,
    expiry:      meta[s]?.expiry ?? null,
    strike:      meta[s]?.strike ?? null,
    option_type: meta[s]?.option_type ?? null,
    tick: ticks[s],
  })), [subscribed, meta, ticks]);

  const showFno = hasNonCashRows(rows);
  const filtered = applySymbolFilters(rows, filters);
  const symCols = symbolColumnCount(showFno);

  // Tick history rows (last 200) — defensively sort newest-first so ticks
  // that arrive slightly out of order (multi-broker fan-in, network jitter)
  // still render in strict descending time order. Then join with master meta.
  const historyRows = useMemo(() => [...history]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .map((t) => ({
      ...t,
      internal_symbol: t.s,
      trading_symbol: meta[t.s]?.trading_symbol ?? t.s,
      exchange:    meta[t.s]?.exchange ?? null,
      segment:     meta[t.s]?.segment ?? null,
      underlying:  meta[t.s]?.underlying ?? null,
      expiry:      meta[t.s]?.expiry ?? null,
      strike:      meta[t.s]?.strike ?? null,
      option_type: meta[t.s]?.option_type ?? null,
    })),
    [history, meta],
  );
  const filteredHistory = applySymbolFilters(historyRows, filters);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Live feed</h1>
          <p className="text-sm text-muted-foreground">
            Subscribe to a symbol, watch ticks stream from your broker in real time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Timezone</span>
          <TimezoneSelector />
        </div>
      </header>

      <div className="card grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div>
          <div className="label">Broker account</div>
          {liveAccounts.length === 0 ? (
            <div className="text-sm text-danger">
              No logged-in broker. Login to a broker on the Brokers page first.
            </div>
          ) : (
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {liveAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.broker} · {a.client_id} {a.is_paper ? "(paper)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="md:col-span-2">
          <ExchangeSymbolPicker
            value={symbol}
            onChange={setSymbol}
          />
        </div>
        <button className="btn-primary" onClick={subscribe} disabled={busy || !accountId}>
          {busy ? "Subscribing…" : "Subscribe"}
        </button>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">Latest tick per symbol</h2>
          <span className="text-xs text-muted-foreground">
            {filtered.length} of {rows.length} subscribed
          </span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <SymbolHeaders showFno={showFno} />
              <th>LTP</th><th>Bid</th><th>Ask</th><th>OI</th><th>Vol</th><th>Time</th><th />
            </tr>
            <SymbolFilterRow
              filters={filters}
              onChange={setFilters}
              showFno={showFno}
              trailingCols={7}   /* LTP, Bid, Ask, OI, Vol, Time, Unsub */
            />
          </thead>
          <tbody>
            {filtered.map((r) => {
              const t = r.tick;
              return (
                <tr key={r.internal_symbol}>
                  <SymbolCells row={r} showFno={showFno} />
                  <td className="font-mono">{t ? fmtINR(t.ltp, 2) : "—"}</td>
                  <td>{t?.bid != null ? fmtINR(t.bid, 2) : "—"}</td>
                  <td>{t?.ask != null ? fmtINR(t.ask, 2) : "—"}</td>
                  <td>{t?.oi ?? "—"}</td>
                  <td>{t?.v ?? "—"}</td>
                  <td className="text-xs">{t ? fmtTs(t.ts, timezone) : "waiting…"}</td>
                  <td className="text-right">
                    <button className="btn-ghost text-xs text-danger" onClick={() => unsubscribe(r.internal_symbol)}>
                      Unsubscribe
                    </button>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={symCols + 7} className="text-center text-muted-foreground py-4">
                  {rows.length ? "No matches for the current filters" : "No subscriptions yet"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Tick stream (last 200)</h2>
        <div className="overflow-y-auto max-h-72 font-mono text-xs space-y-0.5">
          {filteredHistory.length === 0 && <div className="text-muted-foreground">Waiting for ticks…</div>}
          {filteredHistory.map((t, i) => (
            <div key={i} className="flex gap-3 py-0.5 border-b border-border/30">
              <span className="text-muted-foreground w-44">{fmtTs(t.ts, timezone)}</span>
              <span className="w-16 text-muted-foreground">{t.exchange ?? "—"}</span>
              <span className="w-32" title={t.trading_symbol}>{t.underlying ?? t.s}</span>
              {t.option_type && <span className="w-10 text-muted-foreground">{t.option_type}</span>}
              {t.expiry && <span className="w-28 text-muted-foreground">{fmtExpiry(t.expiry)}</span>}
              {t.strike != null && <span className="w-16 text-muted-foreground">{t.strike}</span>}
              <span className="w-20 text-right text-primary">{fmtINR(t.ltp, 2)}</span>
              {t.v != null && <span className="text-muted-foreground">vol {t.v}</span>}
            </div>
          ))}
        </div>
      </div>

      <details className="text-xs text-muted-foreground">
        <summary>Server-side feed status</summary>
        <pre className="bg-panel2 p-3 rounded mt-2">{JSON.stringify(status || [], null, 2)}</pre>
      </details>
    </div>
  );
}
