"use client";
import useSWR from "swr";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetcher } from "@/lib/us/api";

interface CatalogEntry {
  key: string;
  display_name: string;
  asset_classes: string[];
  param_schema: Record<string, { type: string; default: unknown }>;
}

export default function StrategiesPage() {
  const { data } = useSWR<{ strategies: CatalogEntry[] }>("/strategies/catalog", fetcher);
  const strategies = data?.strategies ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Strategies</h1>
        <p className="text-sm text-muted-foreground">
          Plugin strategy catalog from the backend. Each runs through the risk engine before any order is routed.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {strategies.map((s) => (
          <Card key={s.key}>
            <CardHeader>
              <CardTitle className="text-base">{s.display_name}</CardTitle>
              <div className="flex flex-wrap gap-1 pt-1">
                {s.asset_classes.map((a) => (
                  <Badge key={a} variant="secondary" className="text-xs">{a}</Badge>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Parameters</div>
                {Object.entries(s.param_schema).map(([name, spec]) => (
                  <div key={name} className="flex justify-between">
                    <span>{name}</span>
                    <span>{String(spec.default)}</span>
                  </div>
                ))}
                {Object.keys(s.param_schema).length === 0 && <div>—</div>}
              </div>
            </CardContent>
          </Card>
        ))}
        {strategies.length === 0 && (
          <p className="text-sm text-muted-foreground">No strategies returned (is the backend running?).</p>
        )}
      </div>
    </div>
  );
}
