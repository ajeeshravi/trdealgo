"use client";
import useSWR from "swr";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAccounts } from "@/lib/us/account";
import { fetcher } from "@/lib/us/api";
import { fmtNum, fmtUSD, num, pnlClass } from "@/lib/us/fmt";

interface Position {
  symbol: string;
  asset_class: string;
  qty: string;
  avg_price: string;
  market_price: string;
  unrealized_pnl: string;
}

export default function PositionsPage() {
  const { selectedId } = useAccounts();
  const { data, isLoading } = useSWR<Position[]>(
    selectedId ? `/broker-accounts/${selectedId}/positions` : null,
    fetcher,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Open Positions</h1>
      <Card>
        <CardHeader><CardTitle>Positions</CardTitle></CardHeader>
        <CardContent>
          {!selectedId ? (
            <p className="text-sm text-muted-foreground">Select or link a broker account.</p>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg Price</TableHead>
                  <TableHead className="text-right">Market</TableHead>
                  <TableHead className="text-right">Unrealized P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((p) => (
                  <TableRow key={p.symbol}>
                    <TableCell className="font-medium">{p.symbol}</TableCell>
                    <TableCell className="uppercase text-xs text-muted-foreground">{p.asset_class}</TableCell>
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
