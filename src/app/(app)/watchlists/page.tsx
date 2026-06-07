"use client";
/**
 * Watchlist — single-page experience matching the reference design:
 *  - dropdown selector for the active watchlist
 *  - quick header actions: New Watchlist / From Sector / Add Script
 *  - tabular live LTP / change / OHL table
 *  - star, alert, remove row actions
 *  - All / Starred / Equity / F&O filter
 *  - debounced symbol search dialog for "Add Script"
 *  - sector-import dialog
 *
 * Adapted to our backend:
 *   GET    /watchlists                       — list baskets
 *   POST   /watchlists                       — create
 *   DELETE /watchlists/{id}                  — delete
 *   PUT    /watchlists/{id}/symbols          — replace member list
 *   GET    /symbols/search?q=…               — typeahead
 *   GET    /eod/sectors                      — sector roster
 *   GET    /eod/sector-constituents/{key}    — sector members
 *   GET    /market/snapshot?symbols=A,B,C    — LTP / OHL / prev_close
 *   live ticks via useLivePrices             — sub-second LTP between polls
 */
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import {
  Bell,
  ChevronDown,
  Filter,
  List,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { prettySymbol } from "@/lib/fmt";
import { useLivePrices } from "@/lib/useLivePrices";
import { useMarketPollInterval } from "@/lib/marketHours";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Watchlist {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
}

interface SymbolSearchResult {
  internal_symbol: string;
  trading_symbol: string;
  exchange: string;
  segment: string;
  underlying: string;
  option_type?: "CE" | "PE" | null;
  expiry?: string | null;
  strike?: number | null;
}

interface SectorInfo {
  key: string;
  description: string;
  stock_count: number;
}

interface SnapshotRow {
  ltp: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  source: "live" | "rest" | "eod" | "none";
}

type TabKey = "all" | "starred" | "equity" | "fno";

const STARRED_STORAGE_KEY = "watchlist:starred";
const ACTIVE_STORAGE_KEY = "watchlist:active";
const SHOW_DEFAULTS_STORAGE_KEY = "watchlist:show-defaults";
const SEEDED_FLAG_KEY = "watchlist:defaults-seeded";

/**
 * Built-in baskets seeded on first visit. Each maps to a sector key in
 * `backend/seed_data/sector_stock_mapping.json`, so the constituent list
 * stays in sync with whatever NSE last published (refreshed by the
 * weekly Celery job).
 *
 * A watchlist is treated as "default" purely by name match — there's no
 * `is_default` column server-side. Renaming a default un-marks it,
 * which is the right behaviour (the user took ownership).
 */
const DEFAULT_WATCHLISTS: ReadonlyArray<{ name: string; sectorKey: string }> = [
  { name: "NIFTY 50", sectorKey: "Nifty 50" },
  { name: "BANK NIFTY", sectorKey: "Nifty Bank" },
  { name: "SENSEX", sectorKey: "SENSEX" },
];
const DEFAULT_NAMES = new Set(DEFAULT_WATCHLISTS.map((d) => d.name));

const fetcher = (u: string) => api.get(u).then((r) => r.data);

/** Map an internal_symbol to a display name and an instrument-type pill. */
function symbolMeta(internal: string): { display: string; kind: "EQ" | "FUT" | "CE" | "PE" | "IDX" | "—" } {
  // NSE_RELIANCE-EQ        → EQ
  // NFO_NIFTY_280526_FUT   → FUT
  // NFO_NIFTY_280526_22000CE → CE
  // NSE_NIFTY50_IDX        → IDX
  let kind: "EQ" | "FUT" | "CE" | "PE" | "IDX" | "—" = "—";
  if (internal.endsWith("-EQ")) kind = "EQ";
  else if (internal.endsWith("_FUT")) kind = "FUT";
  else if (internal.endsWith("_IDX")) kind = "IDX";
  else if (internal.endsWith("CE")) kind = "CE";
  else if (internal.endsWith("PE")) kind = "PE";
  return { display: prettySymbol(internal), kind };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WatchlistPage() {
  const confirm = useConfirm();

  // ----- Watchlists -----
  const {
    data: watchlists,
    mutate: mutateWatchlists,
    isLoading: watchlistsLoading,
  } = useSWR<Watchlist[]>("/watchlists", fetcher);

  // Active watchlist id — persisted so reload returns to the same basket.
  const [activeId, setActiveId] = useState<string>("");
  useEffect(() => {
    if (typeof window !== "undefined") {
      setActiveId(localStorage.getItem(ACTIVE_STORAGE_KEY) ?? "");
    }
  }, []);
  useEffect(() => {
    if (!watchlists || watchlists.length === 0) return;
    const exists = activeId && watchlists.some((w) => w.id === activeId);
    if (!exists) {
      const next = watchlists[0].id;
      setActiveId(next);
      if (typeof window !== "undefined") {
        localStorage.setItem(ACTIVE_STORAGE_KEY, next);
      }
    }
  }, [watchlists, activeId]);

  const setActiveWatchlist = (id: string) => {
    setActiveId(id);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_STORAGE_KEY, id);
    }
  };

  const activeWatchlist = useMemo(
    () => watchlists?.find((w) => w.id === activeId) ?? null,
    [watchlists, activeId],
  );
  const symbols = activeWatchlist?.symbols ?? [];

  // ----- Show / hide default baskets in the dropdown -----
  const [showDefaults, setShowDefaults] = useState(true);
  useEffect(() => {
    if (typeof window !== "undefined") {
      const v = localStorage.getItem(SHOW_DEFAULTS_STORAGE_KEY);
      if (v != null) setShowDefaults(v === "1");
    }
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(SHOW_DEFAULTS_STORAGE_KEY, showDefaults ? "1" : "0");
    }
  }, [showDefaults]);

  // Which defaults are missing right now (matched by name).
  const missingDefaults = useMemo(() => {
    if (!watchlists) return [] as typeof DEFAULT_WATCHLISTS;
    const haveNames = new Set(watchlists.map((w) => w.name));
    return DEFAULT_WATCHLISTS.filter((d) => !haveNames.has(d.name));
  }, [watchlists]);

  // ----- Seed defaults (one-click + first-visit auto-seed) -----
  const [seedingDefaults, setSeedingDefaults] = useState(false);

  async function seedDefaults(opts: { silent?: boolean } = {}) {
    if (seedingDefaults) return;
    setSeedingDefaults(true);
    try {
      // Snapshot the list of names already present so we never duplicate
      // even if two of the three defaults are missing in the same run.
      const have = new Set((watchlists ?? []).map((w) => w.name));
      const toCreate = DEFAULT_WATCHLISTS.filter((d) => !have.has(d.name));
      if (toCreate.length === 0) return;

      const created: string[] = [];
      for (const d of toCreate) {
        try {
          const { data: cons } = await api.get<{ rows: Array<{ internal_symbol: string }> }>(
            `/eod/sector-constituents/${encodeURIComponent(d.sectorKey)}`,
          );
          const syms = cons.rows.map((r) => r.internal_symbol).filter(Boolean);
          await api.post("/watchlists", {
            name: d.name,
            description: `Default basket — ${d.sectorKey}`,
            symbols: syms,
          });
          created.push(d.name);
        } catch (e) {
          // Skip this default but keep going; the user may have a
          // partial network failure and we'd rather seed the rest.
          if (!opts.silent) {
            toast.error(`Failed to seed ${d.name}`);
          }
        }
      }
      if (created.length > 0) {
        mutateWatchlists();
        if (!opts.silent) {
          toast.success(`Added ${created.join(", ")}`);
        }
      }
    } finally {
      setSeedingDefaults(false);
    }
  }

  // First-visit auto-seed: when the user has zero watchlists AND we
  // haven't seeded before, drop in NIFTY 50 / BANK NIFTY / SENSEX so
  // there's something on the screen. Marker prevents re-seeding after
  // deletion (the user clearly didn't want them).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!watchlists) return;
    if (watchlists.length !== 0) return;
    if (localStorage.getItem(SEEDED_FLAG_KEY) === "1") return;
    localStorage.setItem(SEEDED_FLAG_KEY, "1");
    seedDefaults({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlists]);

  // ----- Search / filter -----
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<TabKey>("all");

  // ----- Star (client-side, persisted) -----
  const [starred, setStarred] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STARRED_STORAGE_KEY);
      if (raw) setStarred(new Set(JSON.parse(raw)));
    } catch {
      /* ignored */
    }
  }, []);
  const toggleStar = (s: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      if (typeof window !== "undefined") {
        localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      }
      return next;
    });
  };

  // ----- Live data — snapshot poll + tick stream -----
  // The shared WS feeds sub-second LTP via useLivePrices; the snapshot
  // poll covers prev_close + OHL and the cold-start case. Gate the poll
  // to the union session — watchlists can hold MCX/CDS symbols too, so
  // we don't stop until 23:30 IST.
  const snapPoll = useMarketPollInterval(5_000, "ANY");
  const snapKey = symbols.length > 0 ? symbols.join(",") : null;
  const { data: snap, isLoading: quotesLoading } = useSWR<Record<string, SnapshotRow>>(
    snapKey ? `/market/snapshot?symbols=${encodeURIComponent(snapKey)}` : null,
    fetcher,
    { refreshInterval: snapPoll, keepPreviousData: true },
  );
  const livePrices = useLivePrices(symbols);

  // ----- Display rows -----
  const rows = useMemo(() => {
    return symbols.map((s) => {
      const row = snap?.[s];
      const ltp = livePrices[s] ?? row?.ltp ?? null;
      const prev = row?.prev_close ?? null;
      const change = ltp != null && prev != null ? ltp - prev : null;
      const changePct = change != null && prev ? (change / prev) * 100 : null;
      const meta = symbolMeta(s);
      return {
        internal: s,
        display: meta.display,
        kind: meta.kind,
        ltp,
        change,
        changePct,
        open: row?.open ?? null,
        high: row?.high ?? null,
        low: row?.low ?? null,
        prev,
        starred: starred.has(s),
      };
    });
  }, [symbols, snap, livePrices, starred]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesSearch =
        !needle ||
        r.display.toLowerCase().includes(needle) ||
        r.internal.toLowerCase().includes(needle);
      if (!matchesSearch) return false;
      if (tab === "starred") return r.starred;
      if (tab === "equity") return r.kind === "EQ" || r.kind === "IDX";
      if (tab === "fno") return r.kind === "FUT" || r.kind === "CE" || r.kind === "PE";
      return true;
    });
  }, [rows, search, tab]);

  // -------------------------------------------------------------------------
  // Mutations: add / remove / create / delete / sector import
  // -------------------------------------------------------------------------

  async function replaceSymbols(next: string[]) {
    if (!activeWatchlist) return;
    // Optimistic update — flip locally first so the UI doesn't lag.
    const optimistic = watchlists!.map((w) =>
      w.id === activeWatchlist.id ? { ...w, symbols: next } : w,
    );
    mutateWatchlists(optimistic, { revalidate: false });
    try {
      await api.put(`/watchlists/${activeWatchlist.id}/symbols`, { symbols: next });
      mutateWatchlists();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "Failed");
      mutateWatchlists();
    }
  }

  async function removeSymbol(s: string) {
    if (!activeWatchlist) return;
    await replaceSymbols(symbols.filter((x) => x !== s));
  }

  // ----- New watchlist -----
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  async function createWatchlist() {
    const n = newName.trim();
    if (!n) return;
    setCreating(true);
    try {
      const { data: created } = await api.post("/watchlists", {
        name: n,
        description: null,
        symbols: [],
      });
      toast.success("Watchlist created");
      setNewName("");
      setNewOpen(false);
      mutateWatchlists();
      setActiveWatchlist(created.id);
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function deleteActive() {
    if (!activeWatchlist) return;
    const ok = await confirm({
      title: `Delete watchlist "${activeWatchlist.name}"?`,
      message:
        `Removes ${symbols.length} symbol${symbols.length === 1 ? "" : "s"} from this basket. ` +
        "Strategies that imported from this watchlist keep their own snapshot, so they will continue to run.",
      confirmLabel: "Delete watchlist",
      cancelLabel: "Keep",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.delete(`/watchlists/${activeWatchlist.id}`);
      toast.success("Deleted");
      mutateWatchlists();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "Delete failed");
    }
  }

  // ----- Add Script (debounced typeahead) -----
  const [addOpen, setAddOpen] = useState(false);
  const [scriptSearch, setScriptSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!addOpen) return;
    if (scriptSearch.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get<SymbolSearchResult[]>(
          `/symbols/search?q=${encodeURIComponent(scriptSearch.trim())}&limit=25`,
        );
        if (cancelled) return;
        // Exclude symbols already in the active watchlist.
        const filtered = data.filter((r) => !symbols.includes(r.internal_symbol));
        setSearchResults(filtered);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [scriptSearch, addOpen, symbols]);

  async function addScript(result: SymbolSearchResult) {
    if (!activeWatchlist) return;
    if (symbols.includes(result.internal_symbol)) {
      toast(`${result.trading_symbol} is already in this watchlist`);
      return;
    }
    await replaceSymbols([...symbols, result.internal_symbol]);
    setScriptSearch("");
    setAddOpen(false);
    toast.success(`Added ${result.trading_symbol}`);
  }

  // ----- From Sector -----
  const [sectorOpen, setSectorOpen] = useState(false);
  const [sectors, setSectors] = useState<SectorInfo[]>([]);
  const [loadingSectors, setLoadingSectors] = useState(false);
  const [busySector, setBusySector] = useState<string | null>(null);

  async function openSectorDialog() {
    setSectorOpen(true);
    setLoadingSectors(true);
    try {
      const { data } = await api.get<Array<{ key: string; description: string; stock_count: number }>>(
        "/eod/sectors",
      );
      setSectors(
        data.map((s) => ({
          key: s.key,
          description: s.description,
          stock_count: s.stock_count,
        })),
      );
    } catch (e: any) {
      toast.error("Failed to load sectors");
    } finally {
      setLoadingSectors(false);
    }
  }

  async function createFromSector(sector: SectorInfo) {
    setBusySector(sector.key);
    try {
      const { data: cons } = await api.get<{ rows: Array<{ internal_symbol: string }> }>(
        `/eod/sector-constituents/${encodeURIComponent(sector.key)}`,
      );
      const syms = cons.rows.map((r) => r.internal_symbol).filter(Boolean);
      const { data: created } = await api.post("/watchlists", {
        name: sector.key,
        description: sector.description || null,
        symbols: syms,
      });
      toast.success(`Created "${sector.key}" with ${syms.length} symbols`);
      setSectorOpen(false);
      mutateWatchlists();
      setActiveWatchlist(created.id);
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || `Failed to create from ${sector.key}`);
    } finally {
      setBusySector(null);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const visibleWatchlists = useMemo(() => {
    if (!watchlists) return [];
    return showDefaults
      ? watchlists
      : watchlists.filter((w) => !DEFAULT_NAMES.has(w.name));
  }, [watchlists, showDefaults]);

  const activeIsDefault = !!activeWatchlist && DEFAULT_NAMES.has(activeWatchlist.name);

  const tabLabel =
    tab === "all" ? "All" : tab === "starred" ? "★ Starred" : tab === "equity" ? "Equity" : "F&O";

  return (
    <div className="space-y-4">
      {/* -------- Header -------- */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold">
            Watchlist
            {quotesLoading && (
              <Loader2 className="inline-block w-4 h-4 ml-2 animate-spin text-muted-foreground" />
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            Track your favorite stocks &amp; F&amp;O instruments
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-1.5 border rounded-md bg-background">
            <Label
              htmlFor="defaults-toggle"
              className="text-xs font-mono cursor-pointer whitespace-nowrap"
            >
              Show Defaults
            </Label>
            <Switch
              id="defaults-toggle"
              checked={showDefaults}
              onCheckedChange={setShowDefaults}
              className="scale-75"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="font-mono text-xs gap-1.5"
            onClick={openSectorDialog}
          >
            <List className="w-3.5 h-3.5" /> From Sector
          </Button>
          <Button
            size="sm"
            className="font-mono text-xs gap-1.5"
            onClick={() => setAddOpen(true)}
            disabled={!activeWatchlist}
          >
            <Plus className="w-3.5 h-3.5" /> Add Script
          </Button>
        </div>
      </div>

      {/* -------- Selector row -------- */}
      <div className="flex items-center gap-2 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 font-mono text-xs gap-1.5 min-w-[160px] justify-between"
            >
              <span className="truncate">
                {activeWatchlist?.name || (watchlistsLoading ? "Loading…" : "Select")}
              </span>
              <ChevronDown className="w-3 h-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {visibleWatchlists.length === 0 ? (
              <DropdownMenuItem disabled className="font-mono text-xs text-muted-foreground">
                {watchlistsLoading ? "Loading…" : "No watchlists"}
              </DropdownMenuItem>
            ) : (
              visibleWatchlists.map((wl) => (
                <DropdownMenuItem
                  key={wl.id}
                  onClick={() => setActiveWatchlist(wl.id)}
                  className={cn(
                    "font-mono text-xs justify-between",
                    activeId === wl.id && "bg-accent",
                  )}
                >
                  <span className="truncate">{wl.name}</span>
                  <span className="text-muted-foreground text-[10px] ml-2">{wl.symbols.length}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setNewOpen(true)}
              className="font-mono text-xs gap-1.5 text-primary"
            >
              <Plus className="w-3 h-3" /> New Watchlist
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {activeWatchlist && !activeIsDefault && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0 text-muted-foreground hover:text-loss"
            onClick={deleteActive}
            title="Delete watchlist"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
        {activeIsDefault && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-2 py-1 rounded border border-border/50 bg-muted/30"
            title="Default basket — rename to customize, or click 'Add default baskets' below to restore"
          >
            <Sparkles className="w-3 h-3" /> default
          </span>
        )}

        <div className="h-6 w-px bg-border/50 mx-1" />

        <div className="relative flex-1 min-w-[140px] max-w-[240px]">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm h-9"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 font-mono text-xs gap-1.5">
              <Filter className="w-3 h-3" /> {tabLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => setTab("all")}
              className={cn("font-mono text-xs", tab === "all" && "bg-accent")}
            >
              All
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTab("starred")}
              className={cn("font-mono text-xs", tab === "starred" && "bg-accent")}
            >
              ★ Starred
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTab("equity")}
              className={cn("font-mono text-xs", tab === "equity" && "bg-accent")}
            >
              Equity
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTab("fno")}
              className={cn("font-mono text-xs", tab === "fno" && "bg-accent")}
            >
              F&amp;O
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* -------- Missing-defaults banner -------- */}
      {missingDefaults.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                Add default watchlists
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Pre-built baskets for{" "}
                <span className="font-mono">
                  {missingDefaults.map((d) => d.name).join(", ")}
                </span>{" "}
                — sourced from the latest NSE / BSE constituent list.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="font-mono text-xs gap-1.5 self-start sm:self-auto"
            onClick={() => seedDefaults()}
            disabled={seedingDefaults}
          >
            {seedingDefaults ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Adding…
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5" /> Add default baskets
              </>
            )}
          </Button>
        </div>
      )}

      {/* -------- Table -------- */}
      <div
        className="rounded-lg border border-border/50 overflow-hidden flex flex-col"
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        <table className="w-full text-xs font-mono table-fixed">
          <colgroup>
            <col style={{ width: "40px" }} />
            <col style={{ width: "200px" }} />
            <col style={{ width: "110px" }} />
            <col style={{ width: "120px" }} />
            <col className="hidden md:table-column" style={{ width: "90px" }} />
            <col className="hidden md:table-column" style={{ width: "90px" }} />
            <col className="hidden md:table-column" style={{ width: "90px" }} />
            <col style={{ width: "80px" }} />
          </colgroup>
          <thead className="bg-background">
            <tr className="border-b border-border/50 text-[10px] text-muted-foreground uppercase tracking-wider">
              <th className="text-center py-2.5 px-1.5"></th>
              <th className="text-left py-2.5 px-3">Symbol</th>
              <th className="text-right py-2.5 px-3">LTP</th>
              <th className="text-right py-2.5 px-3">Change</th>
              <th className="text-right py-2.5 px-3 hidden md:table-cell">Open</th>
              <th className="text-right py-2.5 px-3 hidden md:table-cell">High</th>
              <th className="text-right py-2.5 px-3 hidden md:table-cell">Low</th>
              <th className="text-center py-2.5 px-2">Action</th>
            </tr>
          </thead>
        </table>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono table-fixed">
            <colgroup>
              <col style={{ width: "40px" }} />
              <col style={{ width: "200px" }} />
              <col style={{ width: "110px" }} />
              <col style={{ width: "120px" }} />
              <col className="hidden md:table-column" style={{ width: "90px" }} />
              <col className="hidden md:table-column" style={{ width: "90px" }} />
              <col className="hidden md:table-column" style={{ width: "90px" }} />
              <col style={{ width: "80px" }} />
            </colgroup>
            <tbody>
              {filteredRows.map((r) => {
                const up = r.change != null ? r.change >= 0 : null;
                return (
                  <tr
                    key={r.internal}
                    className="border-b border-border/20 hover:bg-muted/30 transition-colors group"
                  >
                    <td className="py-3 px-2 text-center">
                      <button
                        onClick={() => toggleStar(r.internal)}
                        className="hover:scale-110 transition-transform"
                        aria-label={r.starred ? "Unstar" : "Star"}
                      >
                        <Star
                          className={cn(
                            "w-3.5 h-3.5",
                            r.starred
                              ? "fill-warning text-warning"
                              : "text-muted-foreground/40",
                          )}
                        />
                      </button>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{r.display}</span>
                        {r.kind !== "—" && (
                          <span
                            className={cn(
                              "text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold",
                              r.kind === "EQ" && "bg-blue-500/10 text-blue-500",
                              r.kind === "IDX" && "bg-slate-500/10 text-slate-400",
                              r.kind === "FUT" && "bg-orange-500/10 text-orange-500",
                              (r.kind === "CE" || r.kind === "PE") &&
                                "bg-purple-500/10 text-purple-500",
                            )}
                          >
                            {r.kind}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {r.internal}
                      </div>
                    </td>
                    <td
                      className={cn(
                        "py-3 px-3 text-right font-semibold text-sm tabular-nums",
                        r.ltp == null && "text-muted-foreground",
                      )}
                    >
                      {r.ltp != null
                        ? `$${r.ltp.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </td>
                    <td className="py-3 px-3 text-right">
                      {r.change != null && r.changePct != null ? (
                        <>
                          <div
                            className={cn(
                              "font-semibold tabular-nums",
                              up ? "text-profit" : "text-loss",
                            )}
                          >
                            {up ? "+" : ""}
                            {r.change.toFixed(2)}
                          </div>
                          <div
                            className={cn("text-[10px] tabular-nums", up ? "text-profit" : "text-loss")}
                          >
                            ({up ? "+" : ""}
                            {r.changePct.toFixed(2)}%)
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                      {r.open != null ? `$${r.open.toLocaleString("en-US")}` : "—"}
                    </td>
                    <td className="py-3 px-3 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                      {r.high != null ? `$${r.high.toLocaleString("en-US")}` : "—"}
                    </td>
                    <td className="py-3 px-3 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                      {r.low != null ? `$${r.low.toLocaleString("en-US")}` : "—"}
                    </td>
                    <td className="py-2.5 px-2">
                      <div className="flex items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          className="p-1 rounded hover:bg-muted"
                          title="Set alert (coming soon)"
                        >
                          <Bell className="w-3 h-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={() => removeSymbol(r.internal)}
                          className="p-1 rounded hover:bg-loss/20"
                          title="Remove"
                        >
                          <X className="w-3 h-3 text-loss" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {!activeWatchlist
                ? "No watchlist selected — create one from the dropdown."
                : symbols.length === 0
                ? `"${activeWatchlist.name}" is empty. Click "Add Script" to add instruments.`
                : "No instruments match your search."}
            </div>
          )}
        </div>
      </div>

      {/* -------- Add Script dialog -------- */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setScriptSearch("");
            setSearchResults([]);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-lg">
              Add Script to {activeWatchlist?.name ?? ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Type 2+ characters to search stocks, F&O…"
                value={scriptSearch}
                onChange={(e) => setScriptSearch(e.target.value)}
                className="pl-8 font-mono text-sm h-9"
                autoFocus
              />
              {searching && (
                <Loader2 className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground animate-spin" />
              )}
            </div>
            <div className="max-h-[300px] overflow-auto space-y-1">
              {scriptSearch.trim().length < 2 && (
                <p className="text-center py-6 text-sm text-muted-foreground">
                  Type at least 2 characters to search the symbol master
                </p>
              )}
              {scriptSearch.trim().length >= 2 && !searching && searchResults.length === 0 && (
                <p className="text-center py-6 text-sm text-muted-foreground">
                  No matching scripts found
                </p>
              )}
              {searchResults.map((r) => {
                const kind =
                  r.segment === "OPT" ? r.option_type ?? "OPT" :
                  r.segment === "FUT" ? "FUT" :
                  r.segment === "INDEX" ? "IDX" :
                  "EQ";
                return (
                  <div
                    key={r.internal_symbol}
                    onClick={() => addScript(r)}
                    className="flex items-center justify-between p-2.5 rounded-md hover:bg-muted/50 cursor-pointer transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-sm font-semibold truncate">
                          {r.trading_symbol}
                        </p>
                        <span
                          className={cn(
                            "text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold",
                            kind === "EQ" && "bg-blue-500/10 text-blue-500",
                            kind === "IDX" && "bg-slate-500/10 text-slate-400",
                            kind === "FUT" && "bg-orange-500/10 text-orange-500",
                            (kind === "CE" || kind === "PE") &&
                              "bg-purple-500/10 text-purple-500",
                          )}
                        >
                          {kind}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {r.exchange} · {r.underlying}
                      </p>
                    </div>
                    <Plus className="w-4 h-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </div>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* -------- New Watchlist dialog -------- */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-lg">Create Watchlist</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. My Picks, IT Stocks…"
              className="font-mono text-sm h-9"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && createWatchlist()}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs"
                onClick={() => setNewOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="font-mono text-xs"
                onClick={createWatchlist}
                disabled={!newName.trim() || creating}
              >
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* -------- From Sector dialog -------- */}
      <Dialog open={sectorOpen} onOpenChange={setSectorOpen}>
        <DialogContent className="max-w-lg max-h-[600px]">
          <DialogHeader>
            <DialogTitle className="font-mono text-lg">Create Watchlist from Sector</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Select a sector to create a watchlist with all stocks from that sector.
            </p>
            {loadingSectors ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto space-y-2 pr-2">
                {sectors.map((sector) => (
                  <button
                    key={sector.key}
                    onClick={() => createFromSector(sector)}
                    disabled={busySector === sector.key}
                    className="w-full flex items-center justify-between p-3 border rounded-md hover:bg-accent hover:border-primary transition-colors text-left disabled:opacity-60"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm font-medium truncate">{sector.key}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {sector.description}
                      </div>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground ml-3 shrink-0 flex items-center gap-2">
                      {busySector === sector.key && (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                      {sector.stock_count} stocks
                    </div>
                  </button>
                ))}
                {sectors.length === 0 && !loadingSectors && (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    No sectors available
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
