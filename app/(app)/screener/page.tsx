// TODO: backend wiring — endpoint POST /screener/run not implemented.
"use client";
import { useState } from "react";
import { ScanSearch, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

type Row = { symbol: string; ltp: number; change: number; volume: number; rsi: number; pe: number };

const MOCK_RESULTS: Row[] = [
  { symbol: "RELIANCE", ltp: 2940, change: 1.8, volume: 4_120_000, rsi: 62, pe: 24.5 },
  { symbol: "TCS", ltp: 3820, change: -0.4, volume: 980_000, rsi: 48, pe: 31.2 },
  { symbol: "INFY", ltp: 1842, change: 2.1, volume: 2_350_000, rsi: 67, pe: 27.8 },
  { symbol: "HDFCBANK", ltp: 1545, change: -1.2, volume: 5_780_000, rsi: 42, pe: 19.1 },
  { symbol: "ICICIBANK", ltp: 1080, change: 0.9, volume: 3_200_000, rsi: 55, pe: 18.4 },
];

export default function ScreenerPage() {
  const [filters, setFilters] = useState({ minVolume: "1000000", rsiMin: "30", rsiMax: "70" });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ScanSearch className="w-5 h-5 text-primary" />
          Screener
        </h1>
        <p className="text-sm text-muted-foreground">Filter stocks by technical and fundamental criteria</p>
      </header>

      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Filters</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="space-y-1">
            <label className="label">Min Volume</label>
            <input className="input" type="number" value={filters.minVolume} onChange={(e) => setFilters({ ...filters, minVolume: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="label">RSI Min</label>
            <input className="input" type="number" value={filters.rsiMin} onChange={(e) => setFilters({ ...filters, rsiMin: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="label">RSI Max</label>
            <input className="input" type="number" value={filters.rsiMax} onChange={(e) => setFilters({ ...filters, rsiMax: e.target.value })} />
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full">Run screener</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">Results</h2>
          <span className="text-xs text-muted-foreground font-mono">{MOCK_RESULTS.length} matches</span>
        </div>
        <table className="table">
          <thead>
            <tr><th>Symbol</th><th>LTP</th><th>Change %</th><th>Volume</th><th>RSI</th><th>P/E</th></tr>
          </thead>
          <tbody>
            {MOCK_RESULTS.map((r) => (
              <tr key={r.symbol} className="hover:bg-accent/30 transition-colors">
                <td className="font-mono font-semibold">{r.symbol}</td>
                <td className="font-mono">{r.ltp.toLocaleString()}</td>
                <td className={cn("font-mono", r.change >= 0 ? "text-profit" : "text-loss")}>
                  {r.change >= 0 ? "+" : ""}{r.change.toFixed(2)}%
                </td>
                <td className="font-mono">{(r.volume / 1000).toFixed(0)}K</td>
                <td className="font-mono">{r.rsi}</td>
                <td className="font-mono">{r.pe.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
