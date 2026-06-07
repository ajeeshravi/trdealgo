"use client";
import useSWR from "swr";
import { Briefcase, ListOrdered, Percent, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";
import { fmtUSD, prettySymbol } from "@/lib/fmt";
import { MetricCard } from "@/components/MetricCard";
import { StatePill } from "@/components/StatePill";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export default function Dashboard() {
  const { data: pnl } = useSWR("/analytics/pnl?days=30", fetcher);
  const { data: fill } = useSWR("/analytics/fill-ratio?days=7", fetcher);
  const { data: positions } = useSWR("/positions", fetcher);
  const { data: orders } = useSWR("/orders?limit=20", fetcher);

  const openOrders = (orders || []).filter((o: any) => ["NEW", "SENT", "OPEN", "PARTIAL"].includes(o.state));
  const totalPnl = pnl?.total_pnl ?? 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Live overview of P&amp;L, positions and recent activity</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          label="P&L (30d)"
          value={fmtUSD(totalPnl)}
          trend={totalPnl >= 0 ? "up" : "down"}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <MetricCard
          label="Open positions"
          value={String((positions || []).length)}
          icon={<Briefcase className="w-4 h-4" />}
        />
        <MetricCard
          label="Open orders"
          value={String(openOrders.length)}
          icon={<ListOrdered className="w-4 h-4" />}
        />
        <MetricCard
          label="Fill ratio (7d)"
          value={`${fill?.fill_ratio_pct ?? 0}%`}
          icon={<Percent className="w-4 h-4" />}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Open positions</h2>
        </div>
        <table className="table">
          <thead>
            <tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Unrealised</th></tr>
          </thead>
          <tbody>
            {(positions || []).map((p: any) => (
              <tr key={p.id} className="hover:bg-accent/30 transition-colors">
                <td className="font-mono" title={p.internal_symbol}>
                  {p.trading_symbol || prettySymbol(p.internal_symbol)}
                </td>
                <td className="font-mono">{p.qty}</td>
                <td className="font-mono">{fmtUSD(p.avg_price)}</td>
                <td className="font-mono">{fmtUSD(p.last_price)}</td>
                <td className={cn("font-mono", p.unrealized_pnl >= 0 ? "text-profit" : "text-loss")}>
                  {fmtUSD(p.unrealized_pnl)}
                </td>
              </tr>
            ))}
            {!(positions || []).length && (
              <tr><td colSpan={5} className="text-center text-muted-foreground py-4">No open positions</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Recent orders</h2>
        <table className="table">
          <thead>
            <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>State</th><th>Avg</th></tr>
          </thead>
          <tbody>
            {(orders || []).map((o: any) => (
              <tr key={o.id} className="hover:bg-accent/30 transition-colors">
                <td className="font-mono" title={o.internal_symbol}>
                  {o.trading_symbol || prettySymbol(o.internal_symbol)}
                </td>
                <td className={cn("font-mono font-semibold", o.side === "BUY" ? "text-profit" : "text-loss")}>
                  {o.side}
                </td>
                <td className="font-mono">{o.qty}</td>
                <td>{o.order_type}</td>
                <td><StatePill state={o.state} /></td>
                <td className="font-mono">{fmtUSD(o.avg_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

