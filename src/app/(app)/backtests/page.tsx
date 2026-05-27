"use client";
import useSWR from "swr";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import { api } from "@/lib/api";
import { fmtINR } from "@/lib/fmt";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

export default function BacktestsPage() {
  const searchParams = useSearchParams();
  // Allow the Strategies page to deep-link here with `?strategy=<id>` so
  // clicking "Backtest" on a card pre-fills the dropdown instead of forcing
  // the user to re-pick from a (potentially long) list.
  const prefilledStrategyId = searchParams.get("strategy") || "";

  const { data: backs, mutate } = useSWR("/backtests", fetcher);
  const { data: strategies } = useSWR("/strategies", fetcher);
  const [form, setForm] = useState({
    strategy_id: prefilledStrategyId,
    from_date: "2026-01-01",
    to_date: "2026-04-30",
    timeframe: "5m",
    capital: 100000,
    name: "",
  });
  // Keep the form in sync if the user navigates back and forth between
  // strategy cards (the page stays mounted under the same App Router segment).
  useEffect(() => {
    if (prefilledStrategyId && prefilledStrategyId !== form.strategy_id) {
      setForm((f) => ({ ...f, strategy_id: prefilledStrategyId }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefilledStrategyId]);
  const [running, setRunning] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    try {
      const { data } = await api.post("/backtests", form);
      toast.success(`backtest ${data.status}`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Backtests</h1>
      <form onSubmit={run} className="card grid grid-cols-2 lg:grid-cols-4 gap-3">
        <select className="input" value={form.strategy_id} onChange={(e) => setForm({ ...form, strategy_id: e.target.value })} required>
          <option value="">Strategy</option>
          {(strategies || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input className="input" type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} required />
        <input className="input" type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} required />
        <input className="input" value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })} />
        <input className="input" type="number" value={form.capital} onChange={(e) => setForm({ ...form, capital: Number(e.target.value) })} />
        <button className="btn-primary col-span-2 lg:col-span-1" disabled={running}>{running ? "Running…" : "Run backtest"}</button>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Range</th><th>TF</th><th>Status</th><th>P&amp;L</th><th>Win%</th><th>Sharpe</th><th>Max DD%</th></tr>
          </thead>
          <tbody>
            {(backs || []).map((b: any) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td className="text-xs">{b.from_date} → {b.to_date}</td>
                <td>{b.timeframe}</td>
                <td>{b.status}</td>
                <td className={(b.summary?.total_pnl ?? 0) >= 0 ? "text-primary" : "text-danger"}>{fmtINR(b.summary?.total_pnl)}</td>
                <td>{b.summary?.win_rate_pct ?? "—"}</td>
                <td>{b.summary?.sharpe ?? "—"}</td>
                <td>{b.summary?.max_drawdown_pct ?? "—"}</td>
              </tr>
            ))}
            {!(backs || []).length && <tr><td colSpan={8} className="text-center text-muted-foreground py-4">No backtests yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
