"use client";
/**
 * Strategies — card grid.
 *
 * Each strategy is rendered as a StrategyCard with inline broker
 * multi-select + Start / Stop / Edit / Delete actions. The detail page
 * at /strategies/{id} remains available for run history and deeper edits.
 */
import { useCallback, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { api } from "@/lib/api";
import { StrategyCard } from "@/components/strategy/StrategyCard";

const fetcher = (u: string) => api.get(u).then((r) => r.data);
const EMPTY_BROKERS: any[] = [];

export default function StrategiesPage() {
  const { data: strategies, mutate } = useSWR("/strategies", fetcher);
  const { data: brokers } = useSWR("/brokers", fetcher);

  const list = strategies || [];
  // Stable identity for the brokers prop so StrategyCard's memo isn't
  // invalidated on every parent re-render (SWR returns the same array
  // ref while the data is unchanged; the `|| EMPTY_BROKERS` fallback
  // was previously creating a fresh `[]` per render).
  const brokerList = brokers || EMPTY_BROKERS;

  // Stable callbacks — passing inline arrow functions defeats React.memo
  // on the card and causes every card to re-render on every parent
  // refresh (every 15s the per-card runs poll triggers a parent SWR
  // revalidation).
  const handleChanged = useCallback(() => { mutate(); }, [mutate]);
  const handleDelete = useCallback((id: string) => {
    mutate(
      (cur: any[] | undefined) => (cur || []).filter((x) => x.id !== id),
      { revalidate: true },
    );
  }, [mutate]);

  const cards = useMemo(
    () => list.map((s: any) => (
      <StrategyCard
        key={s.id}
        strategy={s}
        brokers={brokerList}
        onChanged={handleChanged}
        onDelete={handleDelete}
      />
    )),
    [list, brokerList, handleChanged, handleDelete],
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Strategies</h1>
        </div>
        <Link href="/strategies/new" className="btn-primary">+ New strategy</Link>
      </header>

      {list.length === 0 ? (
        <div className="card text-center text-muted-foreground py-12">
          <p className="mb-3">No strategies yet.</p>
          <Link href="/strategies/new" className="btn-primary">
            Build your first strategy
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards}
        </div>
      )}
    </div>
  );
}
