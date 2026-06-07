// TODO: backend wiring — CRUD /trade-journal endpoints not implemented.
"use client";
import { useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Entry = {
  id: string;
  date: string;
  symbol: string;
  side: "BUY" | "SELL";
  pnl: number;
  emotion: "calm" | "anxious" | "greedy" | "fearful" | "confident";
  notes: string;
};

const SEED: Entry[] = [
  { id: "1", date: "2026-05-12", symbol: "RELIANCE", side: "BUY", pnl: 1240, emotion: "confident", notes: "Clean breakout above 2900. Held through chop." },
  { id: "2", date: "2026-05-11", symbol: "INFY", side: "SELL", pnl: -380, emotion: "anxious", notes: "Cut early on a wick. Should have held to SL." },
  { id: "3", date: "2026-05-10", symbol: "BANKNIFTY 48000 CE", side: "BUY", pnl: 2150, emotion: "calm", notes: "ATM call on bounce off support. Took 1R off table at 11am." },
];

const EMOTION_COLOR: Record<Entry["emotion"], string> = {
  calm: "bg-primary/20 text-primary",
  confident: "bg-profit/20 text-profit",
  anxious: "bg-warning/20 text-warning",
  greedy: "bg-warning/20 text-warning",
  fearful: "bg-loss/20 text-loss",
};

export default function TradeJournalPage() {
  const [entries, setEntries] = useState<Entry[]>(SEED);
  const [draft, setDraft] = useState({ symbol: "", side: "BUY" as "BUY" | "SELL", pnl: "", emotion: "calm" as Entry["emotion"], notes: "" });

  const add = () => {
    if (!draft.symbol) return;
    setEntries([
      { id: String(Date.now()), date: new Date().toISOString().slice(0, 10), symbol: draft.symbol, side: draft.side, pnl: Number(draft.pnl) || 0, emotion: draft.emotion, notes: draft.notes },
      ...entries,
    ]);
    setDraft({ symbol: "", side: "BUY", pnl: "", emotion: "calm", notes: "" });
  };

  const remove = (id: string) => setEntries(entries.filter((e) => e.id !== id));

  const totalPnl = entries.reduce((s, e) => s + e.pnl, 0);
  const wins = entries.filter((e) => e.pnl > 0).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-primary" />
          Trade Journal
        </h1>
        <p className="text-sm text-muted-foreground">Log trades with emotion and lessons</p>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <div className="card">
          <div className="text-xs text-muted-foreground uppercase">Total P&L</div>
          <div className={cn("font-mono text-2xl font-bold mt-1", totalPnl >= 0 ? "text-profit" : "text-loss")}>
            ${totalPnl.toLocaleString()}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-muted-foreground uppercase">Win rate</div>
          <div className="font-mono text-2xl font-bold mt-1">
            {entries.length ? ((wins / entries.length) * 100).toFixed(0) : 0}%
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-muted-foreground uppercase">Entries</div>
          <div className="font-mono text-2xl font-bold mt-1">{entries.length}</div>
        </div>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Add entry</h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <input className="input" placeholder="Symbol" value={draft.symbol} onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })} />
          <select className="input" value={draft.side} onChange={(e) => setDraft({ ...draft, side: e.target.value as "BUY" | "SELL" })}>
            <option>BUY</option><option>SELL</option>
          </select>
          <input className="input" type="number" placeholder="P&L" value={draft.pnl} onChange={(e) => setDraft({ ...draft, pnl: e.target.value })} />
          <select className="input" value={draft.emotion} onChange={(e) => setDraft({ ...draft, emotion: e.target.value as Entry["emotion"] })}>
            <option value="calm">calm</option><option value="confident">confident</option>
            <option value="anxious">anxious</option><option value="greedy">greedy</option><option value="fearful">fearful</option>
          </select>
          <input className="input col-span-2 md:col-span-1" placeholder="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          <button className="btn-primary flex items-center justify-center gap-1" onClick={add}>
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold mb-3">Recent entries</h2>
        <table className="table">
          <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>P&L</th><th>Emotion</th><th>Notes</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-accent/30 transition-colors">
                <td className="font-mono text-xs">{e.date}</td>
                <td className="font-mono font-semibold">{e.symbol}</td>
                <td className={cn("font-mono", e.side === "BUY" ? "text-profit" : "text-loss")}>{e.side}</td>
                <td className={cn("font-mono", e.pnl >= 0 ? "text-profit" : "text-loss")}>${e.pnl.toLocaleString()}</td>
                <td><span className={cn("pill font-mono", EMOTION_COLOR[e.emotion])}>{e.emotion}</span></td>
                <td className="text-xs text-muted-foreground">{e.notes}</td>
                <td>
                  <button onClick={() => remove(e.id)} className="p-1 text-muted-foreground hover:text-destructive" aria-label="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
