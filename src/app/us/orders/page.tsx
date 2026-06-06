"use client";
import { useState } from "react";
import useSWR from "swr";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAccounts } from "@/lib/us/account";
import { apiError, fetcher, usApi } from "@/lib/us/api";
import { fmtUSD, num } from "@/lib/us/fmt";

interface Order {
  id: string; symbol: string; side: string; order_type: string;
  qty: string; filled_qty: string; status: string; avg_fill_price: string | null;
}

const ORDER_TYPES = ["market", "limit", "stop", "stop_limit", "trailing_stop"];

export default function OrdersPage() {
  const { selectedId } = useAccounts();
  const key = selectedId ? `/orders?account_id=${selectedId}&open_only=false` : null;
  const { data: orders, mutate } = useSWR<Order[]>(key, fetcher);

  const [symbol, setSymbol] = useState("AAPL");
  const [side, setSide] = useState("buy");
  const [orderType, setOrderType] = useState("market");
  const [qty, setQty] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function place(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setMsg("");
    try {
      const body: Record<string, unknown> = {
        account_id: selectedId,
        symbol: symbol.toUpperCase(),
        asset_class: "stock",
        side,
        qty: Number(qty),
        order_type: orderType,
      };
      if (limitPrice) body.limit_price = Number(limitPrice);
      if (stopPrice) body.stop_price = Number(stopPrice);
      const { data } = await usApi.post("/orders", body, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setMsg(`Order ${data.status} — ${data.symbol} ${data.side} ${data.qty}`);
      mutate();
    } catch (err) {
      // Risk-engine rejections come back as 422 with {rule, reason}.
      setMsg(`Rejected — ${apiError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!selectedId) return;
    try {
      await usApi.delete(`/orders/${id}?account_id=${selectedId}`);
      mutate();
    } catch (err) {
      setMsg(apiError(err));
    }
  }

  const needsLimit = orderType === "limit" || orderType === "stop_limit";
  const needsStop = orderType === "stop" || orderType === "stop_limit";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Orders</h1>

      <Card>
        <CardHeader><CardTitle>Order Entry</CardTitle></CardHeader>
        <CardContent>
          {!selectedId ? (
            <p className="text-sm text-muted-foreground">Select or link a broker account first.</p>
          ) : (
            <form onSubmit={place} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <Label>Symbol</Label>
                <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Side</Label>
                <select value={side} onChange={(e) => setSide(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <select value={orderType} onChange={(e) => setOrderType(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  {ORDER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Quantity</Label>
                <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              {needsLimit && (
                <div className="space-y-1">
                  <Label>Limit Price</Label>
                  <Input type="number" step="0.01" value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)} />
                </div>
              )}
              {needsStop && (
                <div className="space-y-1">
                  <Label>Stop Price</Label>
                  <Input type="number" step="0.01" value={stopPrice}
                    onChange={(e) => setStopPrice(e.target.value)} />
                </div>
              )}
              <div className="flex items-end">
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "…" : "Place order"}
                </Button>
              </div>
            </form>
          )}
          {msg && <p className="mt-3 text-sm">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Order Book</CardTitle></CardHeader>
        <CardContent>
          {!orders || orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Filled</TableHead>
                  <TableHead className="text-right">Avg Fill</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.symbol}</TableCell>
                    <TableCell className="uppercase">{o.side}</TableCell>
                    <TableCell>{o.order_type}</TableCell>
                    <TableCell className="text-right">{o.qty}</TableCell>
                    <TableCell className="text-right">{o.filled_qty}</TableCell>
                    <TableCell className="text-right">{fmtUSD(num(o.avg_fill_price))}</TableCell>
                    <TableCell>{o.status}</TableCell>
                    <TableCell className="text-right">
                      {["new", "accepted", "partially_filled", "pending"].includes(o.status) && (
                        <Button size="sm" variant="ghost" onClick={() => cancel(o.id)}>Cancel</Button>
                      )}
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
