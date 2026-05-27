"use client";
/**
 * Institutional Flows — FII / DII / MF cash market activity + F&O
 * participant positioning.
 *
 * Five panels, each fed by one of the new /institutional endpoints:
 *   1. Summary hero    GET /institutional/cash-flow/summary
 *   2. Daily flow chart GET /institutional/cash-flow/daily?from=&to=
 *   3. Monthly bars    GET /institutional/cash-flow/monthly?year=
 *   4. Participant OI grid + L/S gauge   GET /institutional/participant-oi/{date}
 *   5. Time-series of one participant×metric (e.g. FII index futures long)
 *      GET /institutional/participant-oi/series?…
 *
 * No mocks — every chart hides itself with a calm empty state if the
 * relevant ingest hasn't populated rows yet, so a fresh install
 * doesn't look broken.
 */
import useSWR from "swr";
import { useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Building2,
  Landmark,
  PiggyBank,
  Scale,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

// ---------------------------------------------------------------------------
// Types (mirror backend response shapes)
// ---------------------------------------------------------------------------

type Category = "FII" | "DII" | "MF";

type CashFlow = {
  trade_date: string;
  category: Category;
  buy_value: number;
  sell_value: number;
  net_value: number;
};

type SummaryRow = {
  category: Category;
  buy_value: number;
  sell_value: number;
  net_value: number;
};

type SummaryPayload = {
  latest_date: string | null;
  daily: CashFlow[];
  mtd: SummaryRow[];
  ytd: SummaryRow[];
};

type MonthlyRow = {
  month: string;       // ISO YYYY-MM-DD
  category: Category;
  buy_value: number;
  sell_value: number;
  net_value: number;
};

type ParticipantRow = {
  trade_date: string;
  participant: "CLIENT" | "DII" | "FII" | "PRO" | "TOTAL";
  fut_idx_long: number;       fut_idx_short: number;
  fut_stk_long: number;       fut_stk_short: number;
  opt_idx_call_long: number;  opt_idx_call_short: number;
  opt_idx_put_long: number;   opt_idx_put_short: number;
  opt_stk_call_long: number;  opt_stk_call_short: number;
  opt_stk_put_long: number;   opt_stk_put_short: number;
  fut_idx_ls_ratio: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCr(n: number): string {
  // INR crores → "₹+12,346 Cr" with sign + thousands separator.
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString("en-IN")} Cr`;
}

function fmtCount_short(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-IN");
}

const CATEGORY_META: Record<Category, { icon: any; color: string; label: string }> = {
  FII: { icon: Building2, color: "#60a5fa", label: "FII / FPI" },
  DII: { icon: Landmark,  color: "#22c55e", label: "DII"       },
  MF:  { icon: PiggyBank, color: "#f59e0b", label: "Mutual Funds" },
};


// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InstitutionalPage() {
  const today = new Date();
  const [year, setYear] = useState<number>(today.getFullYear());
  const [participantDate, setParticipantDate] = useState<string>(() => {
    // Default to yesterday — same heuristic as the EOD page; the data
    // doesn't exist until NSE publishes around 6 PM IST.
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          Institutional Flows
        </h1>
        <p className="text-sm text-muted-foreground">
          FII / DII / MF cash activity and F&amp;O participant positioning —
          fed from NSE&apos;s daily reports.
        </p>
      </header>

      <SummaryHero />

      <DailyFlowCard />

      <MonthlyCard year={year} onChangeYear={setYear} />

      <ParticipantSnapshotCard
        date={participantDate}
        onChangeDate={setParticipantDate}
      />

      <ParticipantSeriesCard />
    </div>
  );
}


// ---------------------------------------------------------------------------
// 1. Summary hero (latest day + MTD + YTD per category)
// ---------------------------------------------------------------------------

function SummaryHero() {
  const { data, isLoading } = useSWR<SummaryPayload>(
    "/institutional/cash-flow/summary", fetcher,
  );

  if (isLoading) return null;
  if (!data || data.latest_date === null) {
    return (
      <EmptyState
        icon={<Building2 className="w-4 h-4" />}
        title="No institutional cash data yet"
        hint="The FII/DII ingest may not have run yet — Admin → NSE EOD ingest → Download now."
      />
    );
  }

  // Index each window by category for easy access.
  const byCat = (rows: SummaryRow[] | CashFlow[]) =>
    Object.fromEntries(rows.map((r) => [r.category, r])) as Record<Category, any>;
  const daily = byCat(data.daily);
  const mtd = byCat(data.mtd);
  const ytd = byCat(data.ytd);

  // Categories that actually have any data in any window (so we don't
  // show three empty MF cards when NSE hasn't published MF separately).
  const categories: Category[] = ["FII", "DII", "MF"].filter(
    (c) => daily[c as Category] || mtd[c as Category] || ytd[c as Category],
  ) as Category[];

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold">
          Latest activity
        </h2>
        <span className="text-xs text-muted-foreground">
          As of <span className="font-mono">{data.latest_date}</span>
        </span>
      </div>

      <div className={cn(
        "grid gap-3",
        categories.length === 1 ? "md:grid-cols-1" :
        categories.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3",
      )}>
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat];
          const Icon = meta.icon;
          const d = daily[cat];
          const m = mtd[cat];
          const y = ytd[cat];
          return (
            <div key={cat} className="rounded border border-white/10 bg-white/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Icon className="w-4 h-4" style={{ color: meta.color }} />
                <span className="text-sm font-semibold">{meta.label}</span>
              </div>
              <BigNet label="Latest"  value={d?.net_value} />
              <BigNet label="MTD"    value={m?.net_value} muted />
              <BigNet label="YTD"    value={y?.net_value} muted />
            </div>
          );
        })}
      </div>
    </div>
  );
}


function BigNet({
  label, value, muted = false,
}: { label: string; value: number | undefined; muted?: boolean }) {
  const cls = value == null ? "text-muted-foreground" :
              value > 0 ? "text-profit" : value < 0 ? "text-loss" :
              "text-muted-foreground";
  return (
    <div className={cn("flex items-baseline justify-between", muted ? "mt-1" : "mt-2")}>
      <span className={cn("text-xs", muted ? "text-muted-foreground" : "")}>{label}</span>
      <span className={cn("font-mono", muted ? "text-xs" : "text-lg font-bold", cls)}>
        {value == null ? "—" : fmtCr(value)}
      </span>
    </div>
  );
}


// ---------------------------------------------------------------------------
// 2. Daily flow chart (last 30 days, FII vs DII overlay)
// ---------------------------------------------------------------------------

function DailyFlowCard() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);
  const fromISO = from.toISOString().slice(0, 10);
  const toISO   = today.toISOString().slice(0, 10);

  const { data, isLoading } = useSWR<CashFlow[]>(
    `/institutional/cash-flow/daily?from=${fromISO}&to=${toISO}`,
    fetcher,
  );

  // Pivot: one row per date with `FII`, `DII`, `MF` columns of net values.
  const series = useMemo(() => {
    const map = new Map<string, any>();
    (data || []).forEach((r) => {
      if (!map.has(r.trade_date)) map.set(r.trade_date, { date: r.trade_date });
      map.get(r.trade_date)[r.category] = r.net_value;
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Daily net flows (30d)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Daily net buy/sell in cash market. Bars above zero = net buying.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : series.length === 0 ? (
        <EmptyState
          icon={<Activity className="w-4 h-4" />}
          title="No daily flow data"
          hint="Run the EOD ingest — the FII/DII section pulls from NSE's live JSON API."
        />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 10 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }}
                     tickFormatter={(v) => fmtCount_short(v)} />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number) => fmtCr(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Bar dataKey="FII" fill={CATEGORY_META.FII.color} />
              <Bar dataKey="DII" fill={CATEGORY_META.DII.color} />
              <Bar dataKey="MF"  fill={CATEGORY_META.MF.color}  />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// 3. Monthly aggregated bars
// ---------------------------------------------------------------------------

function MonthlyCard({
  year, onChangeYear,
}: { year: number; onChangeYear: (y: number) => void }) {
  const { data, isLoading } = useSWR<MonthlyRow[]>(
    `/institutional/cash-flow/monthly?year=${year}`, fetcher,
  );

  // Pivot to one row per month.
  const series = useMemo(() => {
    const map = new Map<string, any>();
    (data || []).forEach((r) => {
      const monthKey = r.month.slice(0, 7); // YYYY-MM
      if (!map.has(monthKey)) map.set(monthKey, { month: monthLabel(monthKey) });
      map.get(monthKey)[r.category] = r.net_value;
    });
    return Array.from(map.values());
  }, [data]);

  const years = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1];
  }, []);

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Monthly aggregates
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Net inflows / outflows per calendar month. Useful for spotting
            regime shifts.
          </p>
        </div>
        <select
          className="input text-xs w-24"
          value={year}
          onChange={(e) => onChangeYear(Number(e.target.value))}
        >
          {years.map((y: number) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : series.length === 0 ? (
        <EmptyState
          icon={<BarChart3 className="w-4 h-4" />}
          title={`No monthly data for ${year}`}
          hint="Backfill historical dates to populate."
        />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="month" stroke="#6b7280" tick={{ fontSize: 11 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }}
                     tickFormatter={(v) => fmtCount_short(v)} />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number) => fmtCr(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#6b7280" />
              <Bar dataKey="FII" fill={CATEGORY_META.FII.color} />
              <Bar dataKey="DII" fill={CATEGORY_META.DII.color} />
              <Bar dataKey="MF"  fill={CATEGORY_META.MF.color} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// 4. Participant snapshot — table + L/S gauge for FII index futures
// ---------------------------------------------------------------------------

function ParticipantSnapshotCard({
  date, onChangeDate,
}: { date: string; onChangeDate: (d: string) => void }) {
  const { data, isLoading } = useSWR<ParticipantRow[]>(
    `/institutional/participant-oi/${date}`, fetcher,
  );

  const fii = data?.find((r) => r.participant === "FII");

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Scale className="w-4 h-4 text-primary" />
            F&amp;O participant positioning
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Long/short contract counts. Index-future L/S ratio for FII is the
            classic short-term sentiment proxy.
          </p>
        </div>
        <input
          type="date"
          className="input text-xs w-40"
          value={date}
          onChange={(e) => onChangeDate(e.target.value)}
        />
      </div>

      {/* FII gauge — only renders when FII row exists. */}
      {fii && (
        <div className="mb-4 rounded border border-primary/40 bg-primary/5 p-3">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">FII · Index Futures</span>
            <span className="text-xs text-muted-foreground">
              {fmtCount_short(fii.fut_idx_long)} long ·{" "}
              {fmtCount_short(fii.fut_idx_short)} short
            </span>
          </div>
          <LongShortBar long={fii.fut_idx_long} short={fii.fut_idx_short} />
          <div className="mt-2 text-xs">
            L/S ratio:{" "}
            <span className="font-mono font-semibold">
              {fii.fut_idx_ls_ratio == null ? "—" : fii.fut_idx_ls_ratio.toFixed(2)}
            </span>
            {fii.fut_idx_ls_ratio != null && (
              <span className={cn(
                "ml-2",
                fii.fut_idx_ls_ratio > 1.2 ? "text-profit" :
                fii.fut_idx_ls_ratio < 0.8 ? "text-loss" : "text-muted-foreground",
              )}>
                {fii.fut_idx_ls_ratio > 1.2 ? "Bullish (net long)" :
                 fii.fut_idx_ls_ratio < 0.8 ? "Bearish (net short)" : "Neutral"}
              </span>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<Scale className="w-4 h-4" />}
          title="No participant-OI for this date"
          hint="NSE may not have published yet, or it's a holiday."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Participant</th>
                <th className="text-right">Idx-Fut Long</th>
                <th className="text-right">Idx-Fut Short</th>
                <th className="text-right">Stk-Fut Long</th>
                <th className="text-right">Stk-Fut Short</th>
                <th className="text-right">Idx-Opt CE Long</th>
                <th className="text-right">Idx-Opt PE Long</th>
                <th className="text-right">Idx-Opt CE Short</th>
                <th className="text-right">Idx-Opt PE Short</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.participant}
                    className={cn(
                      "hover:bg-accent/30",
                      r.participant === "TOTAL" && "border-t-2 border-white/20 font-semibold",
                    )}>
                  <td className="font-mono">{r.participant}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.fut_idx_long)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.fut_idx_short)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.fut_stk_long)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.fut_stk_short)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.opt_idx_call_long)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.opt_idx_put_long)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.opt_idx_call_short)}</td>
                  <td className="font-mono text-right">{fmtCount_short(r.opt_idx_put_short)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function LongShortBar({ long: l, short: s }: { long: number; short: number }) {
  const total = l + s;
  const lPct = total > 0 ? (l / total) * 100 : 50;
  return (
    <div className="h-3 rounded overflow-hidden flex border border-white/10">
      <div className="bg-profit" style={{ width: `${lPct}%` }} title={`Long: ${l}`} />
      <div className="bg-loss"   style={{ width: `${100 - lPct}%` }} title={`Short: ${s}`} />
    </div>
  );
}


// ---------------------------------------------------------------------------
// 5. Participant time-series — pick a participant + a metric column
// ---------------------------------------------------------------------------

const METRIC_OPTIONS: { value: string; label: string }[] = [
  { value: "fut_idx_long",       label: "Index Futures · Long"       },
  { value: "fut_idx_short",      label: "Index Futures · Short"      },
  { value: "fut_stk_long",       label: "Stock Futures · Long"       },
  { value: "fut_stk_short",      label: "Stock Futures · Short"      },
  { value: "opt_idx_call_long",  label: "Index Options · Call Long"  },
  { value: "opt_idx_call_short", label: "Index Options · Call Short" },
  { value: "opt_idx_put_long",   label: "Index Options · Put Long"   },
  { value: "opt_idx_put_short",  label: "Index Options · Put Short"  },
];

function ParticipantSeriesCard() {
  const [participant, setParticipant] = useState<string>("FII");
  const [metric, setMetric] = useState<string>("fut_idx_long");

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 60);
  const fromISO = from.toISOString().slice(0, 10);
  const toISO   = today.toISOString().slice(0, 10);

  const { data, isLoading } = useSWR<{ trade_date: string; value: number }[]>(
    `/institutional/participant-oi/series?from=${fromISO}&to=${toISO}` +
    `&participant=${participant}&metric=${metric}`,
    fetcher,
  );

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Position trend (60d)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pick a participant and a metric to see how their positioning has
            evolved.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <select
            className="input text-xs w-28"
            value={participant}
            onChange={(e) => setParticipant(e.target.value)}
          >
            {(["CLIENT", "DII", "FII", "PRO"] as const).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            className="input text-xs w-56"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
          >
            {METRIC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<Activity className="w-4 h-4" />}
          title="No data in window"
          hint="Backfill participant-OI to populate, or try a different participant."
        />
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
              <XAxis dataKey="trade_date" stroke="#6b7280" tick={{ fontSize: 10 }} />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }}
                     tickFormatter={(v) => fmtCount_short(v)} />
              <Tooltip
                contentStyle={{ background: "#171b22", border: "1px solid #222831" }}
                formatter={(v: number) => fmtCount_short(v)}
              />
              <Line type="monotone" dataKey="value"
                    stroke="#60a5fa" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

function EmptyState({
  icon, title, hint,
}: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="rounded border border-dashed border-white/10 p-6 text-center">
      <div className="mx-auto w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div className="mt-2 text-sm">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </div>
  );
}


function monthLabel(yyyymm: string): string {
  // "2026-01" → "Jan 26"
  const [y, m] = yyyymm.split("-").map(Number);
  if (!y || !m) return yyyymm;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${MONTHS[m - 1]} ${String(y).slice(-2)}`;
}
