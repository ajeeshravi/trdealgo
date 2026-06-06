"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAccounts } from "@/lib/us/account";
import { apiError, fetcher, usApi } from "@/lib/us/api";
import { fmtUSD, fmtNum, num, pnlClass } from "@/lib/us/fmt";

interface Position {
  symbol: string; asset_class: string; qty: string;
  avg_price: string; market_price: string; unrealized_pnl: string;
}

function Metric({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${cls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { selected, selectedId } = useAccounts();
  const [acct, setAcct] = useState<{ equity?: string; buying_power?: string } | null>(null);
  const [err, setErr] = useState("");

  const { data: positions } = useSWR<Position[]>(
    selectedId ? `/broker-accounts/${selectedId}/positions` : null,
    fetcher,
  );

  async function loadAccount() {
    if (!selectedId) return;
    setErr("");
    try {
      const { data } = await usApi.post(`/broker-accounts/${selectedId}/connect`);
      setAcct(data);
    } catch (e) {
      setErr(apiError(e));
    }
  }

  const totalUnrealized = (positions ?? []).reduce((s, p) => s + (num(p.unrealized_pnl) ?? 0), 0);

  if (!selectedId) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          No broker account selected.{" "}
          <Link href="/us/brokers" className="text-primary underline">Link a broker →</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button size="sm" variant="outline" onClick={loadAccount}>Refresh account</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Equity" value={acct?.equity ? fmtUSD(num(acct.equity)) : "—"} />
        <Metric label="Buying Power" value={acct?.buying_power ? fmtUSD(num(acct.buying_power)) : "—"} />
        <Metric label="Unrealized P&L" value={fmtUSD(totalUnrealized)} cls={pnlClass(totalUnrealized)} />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!acct && (
        <p className="text-xs text-muted-foreground">
          Click “Refresh account” to connect to {selected?.broker.toUpperCase()} and load balances.
        </p>
      )}

      <Card>
        <CardHeader><CardTitle>Open Positions</CardTitle></CardHeader>
        <CardContent>
          {!positions || positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg</TableHead>
                  <TableHead className="text-right">Market</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.symbol}>
                    <TableCell className="font-medium">{p.symbol}</TableCell>
                    <TableCell className="text-right">{fmtNum(num(p.qty), 0)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(num(p.avg_price))}</TableCell>
                    <TableCell className="text-right">{fmtUSD(num(p.market_price))}</TableCell>
                    <TableCell className={`text-right ${pnlClass(num(p.unrealized_pnl))}`}>
                      {fmtUSD(num(p.unrealized_pnl))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
