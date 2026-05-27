"use client";
/**
 * Watchlist (basket) importer — picks one of the user's watchlists and
 * merges its symbols into the strategy's universe.
 *
 * The merge is a snapshot: changes the user later makes to the watchlist
 * don't propagate to strategies that imported it. The basket name+id are
 * still stored on the strategy (`params.basket_source`) so the UI can
 * show "imported from X".
 */
import { useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import { api } from "@/lib/api";
import { BasketSource } from "./types";

interface Watchlist {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
}

const fetcher = (u: string) => api.get(u).then((r) => r.data);

interface Props {
  existingSymbols: string[];
  basketSource?: BasketSource;
  onImport: (newSymbols: string[], source: BasketSource) => void;
  onClearSource: () => void;
}

export function BasketImporter({ existingSymbols, basketSource, onImport, onClearSource }: Props) {
  const { data, error } = useSWR<Watchlist[]>("/watchlists", fetcher);
  const [picked, setPicked] = useState("");

  function doImport() {
    if (!picked) return;
    const wl = (data || []).find((w) => w.id === picked);
    if (!wl) return;
    const merged = [...existingSymbols];
    let added = 0;
    for (const s of wl.symbols) {
      if (!merged.includes(s)) {
        merged.push(s);
        added++;
      }
    }
    onImport(merged, { basket_id: wl.id, basket_name: wl.name });
    toast.success(`imported ${added} new symbol${added === 1 ? "" : "s"} from ${wl.name}`);
  }

  return (
    <div className="rounded-md border border-border/60 bg-panel2/30 p-3 space-y-2">
      <div className="text-xs label">Import from watchlist</div>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="input flex-1 min-w-[14rem]"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={!data}
        >
          <option value="">
            {error
              ? "failed to load watchlists"
              : !data
              ? "loading…"
              : (data || []).length === 0
              ? "no watchlists yet"
              : "pick a watchlist…"}
          </option>
          {(data || []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.symbols.length})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-outline text-xs"
          onClick={doImport}
          disabled={!picked}
        >
          Import symbols
        </button>
        <a
          href="/watchlists"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline whitespace-nowrap"
        >
          Manage watchlists →
        </a>
      </div>
      {basketSource && (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          Linked basket:{" "}
          <span className="font-mono text-primary">{basketSource.basket_name}</span>
          <button
            type="button"
            className="text-danger hover:underline"
            onClick={onClearSource}
          >
            unlink
          </button>
        </div>
      )}
    </div>
  );
}
