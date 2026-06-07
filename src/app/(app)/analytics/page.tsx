"use client";
import useSWR from "swr";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { api } from "@/lib/api";
import { fmtUSD } from "@/lib/fmt";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

export default function AnalyticsPage() {
  const { data: pnl } = useSWR("/analytics/pnl?days=60", fetcher);
  const { data: fill } = useSWR("/analytics/fill-ratio?days=30", fetcher);
  const { data: lat } = useSWR("/analytics/latency", fetcher);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Analytics</h1>
      <div className="grid lg:grid-cols-3 gap-4">
        <Stat title="60d P&L" value={fmtUSD(pnl?.total_pnl ?? 0)} />
        <Stat title="Fill ratio (30d)" value={`${fill?.fill_ratio_pct ?? 0}%`} />
        <Stat title="Latency p95" value={`${lat?.p95_ms ?? 0} ms`} />
      </div>

      <div className="card h-72">
        <h2 className="text-base font-semibold mb-2">Daily P&amp;L</h2>
        <ResponsiveContainer width="100%" height="90%">
          <LineChart data={pnl?.days || []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222831" />
            <XAxis dataKey="date" stroke="#6b7280" />
            <YAxis stroke="#6b7280" />
            <Tooltip contentStyle={{ background: "#171b22", border: "1px solid #222831" }} />
            <Line type="monotone" dataKey="pnl" stroke="#22c55e" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
