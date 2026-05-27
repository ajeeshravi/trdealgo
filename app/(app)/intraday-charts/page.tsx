"use client";
/**
 * Intraday OI / IV / Greeks charts.
 *
 * Two tiers of detail:
 *   - NIFTY / SENSEX / BANKNIFTY: full chart suite (LTP, OI, OI Chg,
 *     IV, Delta, Gamma, Theta, Vega per strike + aggregate Call/Put OI
 *     and PCR). These three underlyings are snapshotted every minute
 *     by the `intraday_oi.snapshot` Celery task.
 *   - Other underlyings: only OI + OI Chg charts. The intraday snapshot
 *     task also covers any underlying with active broker subscriptions
 *     (i.e. legs being live-streamed because the user opened the chain
 *     page), so stock options the user is watching show up here too.
 *
 * Data flow:
 *   /eod/intraday-oi/underlyings-today    → underlying picker
 *   /eod/intraday-oi-series/{u}?strike=…  → per-strike time-series
 *   /eod/intraday-oi-aggregate/{u}        → Call vs Put OI + PCR
 *   /eod/intraday-oi/{u}                  → latest per-strike row (to
 *                                            find ATM at the moment)
 */
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useMarketPollInterval } from "@/lib/marketHours";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

const FULL_SUITE_UNDERLYINGS = new Set(["NIFTY", "NIFTYBANK", "SENSEX"]);

const LABEL_OVERRIDES: Record<string, string> = {
  NIFTYBANK: "BANKNIFTY",
};

type UnderlyingToday = {
  underlying: string;
  expiry: string | null;
  snap_count: number;
};

type Series = {
  underlying: string;
  expiry: string | null;
  strike: number;
  option_type: "CE" | "PE";
  ts: string[];
  ltp: number[];
  oi: number[];
  chg_in_oi: (number | null)[];
  volume: number[];
  spot: (number | null)[];
  iv: (number | null)[];
  delta: (number | null)[];
  gamma: (number | null)[];
  theta: (number | null)[];
  vega: (number | null)[];
};

type Aggregate = {
  ts: string;
  call_oi_total: number;
  put_oi_total: number;
  pcr_oi: number | null;
};

type LatestRow = {
  snapshot_ts: string;
  internal_symbol: string;
  strike: number;
  option_type: "CE" | "PE";
  expiry: string;
  ltp: number;
  open_interest: number;
  chg_in_oi: number | null;
  volume: number;
  spot_price: number | null;
};

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
  fontSize: "12px",
  fontFamily: "monospace",
};

const REFRESH_MS = 60_000;

// Strip the date prefix off the ISO `ts` so charts render compact
// HH:MM labels. Aggregate API returns full ISO; series returns HH:MM:SS.
function toHHMM(ts: string): string {
  if (!ts) return "";
  if (ts.includes("T")) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toTimeString().slice(0, 5);
  }
  return ts.slice(0, 5);
}

export default function IntradayChartsPage() {
  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);

  // Intraday OI snapshots are only written by Celery between 09:15–15:30
  // IST Mon-Fri (see `intraday-oi-snapshot` beat schedule). Outside that
  // window the data is frozen, so polling collapses to 0.
  const intradayPoll = useMarketPollInterval(REFRESH_MS, "EQ_FO");

  // List of underlyings that have snapshots today.
  const { data: underlyingsToday } = useSWR<UnderlyingToday[]>(
    "/eod/intraday-oi/underlyings-today", fetcher,
    { refreshInterval: intradayPoll },
  );

  // Always offer NIFTY / NIFTYBANK / SENSEX even if today's snapshots
  // haven't started yet (e.g. pre-market load). Other underlyings only
  // surface once data exists.
  const pickerOptions: UnderlyingToday[] = useMemo(() => {
    const known = new Set<string>();
    const out: UnderlyingToday[] = [];
    const ensureMandatory = (u: string) => {
      if (known.has(u)) return;
      known.add(u);
      out.push({ underlying: u, expiry: null, snap_count: 0 });
    };
    ensureMandatory("NIFTY");
    ensureMandatory("NIFTYBANK");
    ensureMandatory("SENSEX");
    for (const r of underlyingsToday ?? []) {
      if (!known.has(r.underlying)) {
        known.add(r.underlying);
        out.push(r);
      } else {
        // Merge snap_count into existing entry.
        const existing = out.find((x) => x.underlying === r.underlying);
        if (existing) {
          existing.expiry = r.expiry;
          existing.snap_count = r.snap_count;
        }
      }
    }
    return out;
  }, [underlyingsToday]);

  const isFullSuite = FULL_SUITE_UNDERLYINGS.has(underlying);

  // Latest per-strike rows — used to pick ATM and offer a strike picker.
  const { data: latest } = useSWR<LatestRow[]>(
    `/eod/intraday-oi/${underlying}`, fetcher,
    { refreshInterval: intradayPoll, shouldRetryOnError: false },
  );

  // Derive ATM + a sensible strike list (the snapshotted band, deduped).
  const { strikes, atmStrike } = useMemo(() => {
    const set = new Set<number>();
    let lastSpot: number | null = null;
    for (const r of latest ?? []) {
      set.add(r.strike);
      if (r.spot_price != null) lastSpot = r.spot_price;
    }
    const sorted = Array.from(set).sort((a, b) => a - b);
    let atm: number | null = null;
    if (lastSpot != null && sorted.length > 0) {
      let bestDiff = Infinity;
      for (const k of sorted) {
        const d = Math.abs(k - lastSpot);
        if (d < bestDiff) {
          bestDiff = d;
          atm = k;
        }
      }
    }
    return { strikes: sorted, atmStrike: atm };
  }, [latest]);

  // When underlying changes, reset the strike pick and let an effect
  // re-center on the new ATM once the latest rows arrive.
  useEffect(() => {
    setSelectedStrike(null);
  }, [underlying]);

  useEffect(() => {
    if (selectedStrike == null && atmStrike != null) {
      setSelectedStrike(atmStrike);
    }
  }, [atmStrike, selectedStrike]);

  // Pull CE + PE series for the selected strike.
  const seriesKey = selectedStrike != null
    ? `/eod/intraday-oi-series/${underlying}?strike=${selectedStrike}`
    : null;
  const { data: ceSeries } = useSWR<Series>(
    seriesKey ? `${seriesKey}&option_type=CE` : null,
    fetcher,
    { refreshInterval: intradayPoll, shouldRetryOnError: false },
  );
  const { data: peSeries } = useSWR<Series>(
    seriesKey ? `${seriesKey}&option_type=PE` : null,
    fetcher,
    { refreshInterval: intradayPoll, shouldRetryOnError: false },
  );

  // Aggregate Call vs Put OI for the underlying.
  const { data: aggregate } = useSWR<Aggregate[]>(
    isFullSuite ? `/eod/intraday-oi-aggregate/${underlying}` : null,
    fetcher,
    { refreshInterval: intradayPoll, shouldRetryOnError: false },
  );

  // Stitch CE/PE arrays into chart-friendly row shape.
  const combinedRows = useMemo(() => {
    const tsArr = ceSeries?.ts ?? peSeries?.ts ?? [];
    return tsArr.map((t, i) => ({
      t: toHHMM(t),
      ceLtp: ceSeries?.ltp[i] ?? null,
      peLtp: peSeries?.ltp[i] ?? null,
      ceOi: ceSeries?.oi[i] ?? null,
      peOi: peSeries?.oi[i] ?? null,
      ceChgOi: ceSeries?.chg_in_oi[i] ?? null,
      peChgOi: peSeries?.chg_in_oi[i] ?? null,
      ceIv: ceSeries?.iv[i] != null ? Number(ceSeries.iv[i]) * 100 : null,
      peIv: peSeries?.iv[i] != null ? Number(peSeries.iv[i]) * 100 : null,
      ceDelta: ceSeries?.delta[i] ?? null,
      peDelta: peSeries?.delta[i] ?? null,
      ceGamma: ceSeries?.gamma[i] ?? null,
      peGamma: peSeries?.gamma[i] ?? null,
      ceTheta: ceSeries?.theta[i] ?? null,
      peTheta: peSeries?.theta[i] ?? null,
      ceVega: ceSeries?.vega[i] ?? null,
      peVega: peSeries?.vega[i] ?? null,
      spot: ceSeries?.spot[i] ?? peSeries?.spot[i] ?? null,
    }));
  }, [ceSeries, peSeries]);

  const aggregateRows = useMemo(() => {
    if (!aggregate) return [];
    return aggregate.map((r) => ({
      t: toHHMM(r.ts),
      call_oi: r.call_oi_total,
      put_oi: r.put_oi_total,
      pcr: r.pcr_oi,
    }));
  }, [aggregate]);

  const noData = combinedRows.length === 0;
  const showLoading = selectedStrike != null && ceSeries === undefined && peSeries === undefined;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-semibold">Intraday Option Charts</h1>
        <span className="text-xs text-muted-foreground">
          1-min cadence • IST • {pickerOptions.length} underlyings tracked today
        </span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Underlying</span>
          <Select value={underlying} onValueChange={setUnderlying}>
            <SelectTrigger className="w-48 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pickerOptions.map((u) => (
                <SelectItem key={u.underlying} value={u.underlying}>
                  <div className="flex items-center justify-between gap-3 w-full">
                    <span>{LABEL_OVERRIDES[u.underlying] ?? u.underlying}</span>
                    {u.snap_count > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {u.snap_count}×
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {strikes.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Strike</span>
            <Select
              value={selectedStrike != null ? String(selectedStrike) : ""}
              onValueChange={(v) => setSelectedStrike(Number(v))}
            >
              <SelectTrigger className="w-32 h-9">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {strikes.map((k) => (
                  <SelectItem key={k} value={String(k)}>
                    {k.toLocaleString("en-IN")}
                    {atmStrike != null && k === atmStrike && (
                      <span className="ml-2 text-[10px] text-primary">ATM</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!isFullSuite && (
          <span className="text-xs text-warning">
            Limited view — full Greeks suite only for NIFTY / BANKNIFTY / SENSEX.
          </span>
        )}
      </div>

      {showLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {!showLoading && noData && (
        <div className="rounded-lg border border-border bg-muted/20 p-6 text-sm text-muted-foreground text-center">
          No intraday snapshots yet for{" "}
          <span className="font-semibold">
            {LABEL_OVERRIDES[underlying] ?? underlying}
          </span>{" "}
          today. Snapshots fire every minute between 09:15 and 15:30 IST while
          the broker feed is live.
        </div>
      )}

      {!showLoading && !noData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Always-shown: OI + OI Chg */}
          <ChartCard title="Open Interest (Calls vs Puts)">
            <LineChart data={combinedRows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v.toLocaleString("en-IN")} />
              <Line type="monotone" dataKey="ceOi" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE OI" />
              <Line type="monotone" dataKey="peOi" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE OI" />
            </LineChart>
          </ChartCard>

          <ChartCard title="OI Change vs Prior Snapshot">
            <BarChart data={combinedRows}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v.toLocaleString("en-IN")} />
              <Bar dataKey="ceChgOi" fill="hsl(var(--loss))" name="CE ΔOI" />
              <Bar dataKey="peChgOi" fill="hsl(var(--profit))" name="PE ΔOI" />
            </BarChart>
          </ChartCard>

          {isFullSuite && (
            <>
              <ChartCard title="LTP (Calls vs Puts)">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(2)} />
                  <Line type="monotone" dataKey="ceLtp" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE LTP" />
                  <Line type="monotone" dataKey="peLtp" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE LTP" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Spot Price">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(2)} />
                  <Line type="monotone" dataKey="spot" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Spot" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Implied Volatility (%)">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => `${v?.toFixed?.(2)}%`} />
                  <Line type="monotone" dataKey="ceIv" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE IV" />
                  <Line type="monotone" dataKey="peIv" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE IV" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Delta">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(3)} />
                  <Line type="monotone" dataKey="ceDelta" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE Δ" />
                  <Line type="monotone" dataKey="peDelta" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE Δ" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Gamma">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(5)} />
                  <Line type="monotone" dataKey="ceGamma" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE Γ" />
                  <Line type="monotone" dataKey="peGamma" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE Γ" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Theta (per day)">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(3)} />
                  <Line type="monotone" dataKey="ceTheta" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE Θ" />
                  <Line type="monotone" dataKey="peTheta" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE Θ" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Vega (per 1% vol)">
                <LineChart data={combinedRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(3)} />
                  <Line type="monotone" dataKey="ceVega" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="CE ν" />
                  <Line type="monotone" dataKey="peVega" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="PE ν" />
                </LineChart>
              </ChartCard>

              <ChartCard title="Aggregate Call vs Put OI (all strikes)">
                <LineChart data={aggregateRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v.toLocaleString("en-IN")} />
                  <Line type="monotone" dataKey="call_oi" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="Call OI" />
                  <Line type="monotone" dataKey="put_oi" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="Put OI" />
                </LineChart>
              </ChartCard>

              <ChartCard title="PCR (OI)">
                <LineChart data={aggregateRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => v?.toFixed?.(2)} />
                  <Line type="monotone" dataKey="pcr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="PCR" />
                </LineChart>
              </ChartCard>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className={cn(
      "rounded-lg border border-border bg-card",
      "p-3 flex flex-col gap-2",
    )}>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
