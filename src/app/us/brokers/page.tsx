"use client";
import { useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccounts } from "@/lib/us/account";
import { apiError, fetcher, usApi } from "@/lib/us/api";

interface BrokersResp {
  supported: string[];
  capabilities: Record<string, { options?: boolean; futures?: boolean; status: string }>;
}

export default function BrokersPage() {
  const { accounts, refresh } = useAccounts();
  const { data: brokers } = useSWR<BrokersResp>("/brokers", fetcher);
  const [broker, setBroker] = useState("alpaca");
  const [alias, setAlias] = useState("");
  const [paper, setPaper] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      const credentials =
        broker === "alpaca"
          ? { api_key: apiKey, api_secret: apiSecret }
          : { host: "127.0.0.1", port: 7497 };
      await usApi.post("/broker-accounts", { broker, alias, paper, credentials });
      setMsg("Broker linked.");
      setApiKey("");
      setApiSecret("");
      refresh();
    } catch (err) {
      setMsg(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function connect(id: string) {
    setMsg("");
    try {
      const { data } = await usApi.post(`/broker-accounts/${id}/connect`);
      setMsg(`Connected · equity ${data.equity}, buying power ${data.buying_power}`);
      refresh();
    } catch (err) {
      setMsg(apiError(err));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Brokers</h1>

      <Card>
        <CardHeader><CardTitle>Linked accounts</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">No broker accounts linked yet.</p>
          )}
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md border p-3">
              <div>
                <span className="font-medium">{a.broker.toUpperCase()}</span>{" "}
                {a.alias && <span className="text-muted-foreground">({a.alias})</span>}{" "}
                <Badge variant="secondary">{a.paper ? "paper" : "live"}</Badge>{" "}
                <Badge variant={a.status === "connected" ? "default" : "outline"}>{a.status}</Badge>
              </div>
              <Button size="sm" onClick={() => connect(a.id)}>Connect</Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Link a broker</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={link} className="grid max-w-md gap-4">
            <div className="space-y-1">
              <Label>Broker</Label>
              <select value={broker} onChange={(e) => setBroker(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                {(brokers?.supported ?? ["alpaca", "ibkr"]).map((b) => (
                  <option key={b} value={b}>{b.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Alias (optional)</Label>
              <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="My paper account" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={paper} onChange={(e) => setPaper(e.target.checked)} />
              Paper trading
            </label>
            {broker === "alpaca" && (
              <>
                <div className="space-y-1">
                  <Label>API Key</Label>
                  <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label>API Secret</Label>
                  <Input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} required />
                </div>
              </>
            )}
            {broker === "ibkr" && (
              <p className="text-xs text-muted-foreground">
                IBKR uses a local TWS / IB Gateway connection (127.0.0.1:7497).
              </p>
            )}
            <Button type="submit" disabled={busy}>{busy ? "…" : "Link broker"}</Button>
          </form>
        </CardContent>
      </Card>

      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
