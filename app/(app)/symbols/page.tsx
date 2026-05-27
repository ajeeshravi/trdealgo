"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtExpiry } from "@/lib/fmt";

type Segment = "EQUITY" | "FUT" | "OPT" | "INDEX" | "COMMODITY" | "CURRENCY";
type Exchange = "NSE" | "BSE" | "MCX" | "NFO" | "BFO" | "CDS";
type OptionType = "CE" | "PE";

type SymRow = {
  internal_symbol: string;
  trading_symbol: string;
  underlying: string;
  segment: Segment;
  exchange: Exchange;
  expiry?: string | null;
  strike?: number | null;
  option_type?: OptionType | null;
  lot_size: number;
  tick_size: number;
};

type FilterOptions = {
  exchanges: Exchange[];
  segments: Segment[];
  option_types: OptionType[];
  total: number;
};

type Mapping = {
  broker: string;
  display_name: string;
  order_keying: "symbol" | "token" | "symbol+token" | "instrument_key";
  subscribe_keying: "symbol" | "token" | "symbol+token" | "instrument_key";
  keying_example: string;
  keying_note: string;
  mapped: boolean;
  broker_symbol: string | null;
  token: string | null;
  exchange_code: string | null;
};

// Segments for which strike/expiry/option_type fields are meaningful.
// (Used as a UI gate, not as a backend gate — the backend simply ignores
// filters that don't apply.)
const FNO_SEGMENTS: Segment[] = ["FUT", "OPT"];

export default function SymbolsPage() {
  // ---- filter state -------------------------------------------------------
  const [q, setQ] = useState("");
  const [exchange, setExchange] = useState<Exchange | "">("");
  const [segment, setSegment] = useState<Segment | "">("");
  const [underlying, setUnderlying] = useState("");
  const [strike, setStrike] = useState("");
  const [optionType, setOptionType] = useState<OptionType | "">("");
  const [expiry, setExpiry] = useState("");

  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [results, setResults] = useState<SymRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [openMap, setOpenMap] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [mapBusy, setMapBusy] = useState(false);

  // Fetch the dropdown options once on mount — derived from Redis, not hardcoded.
  useEffect(() => {
    api.get<FilterOptions>("/symbols/filters")
      .then(({ data }) => setOptions(data))
      .catch(() => setOptions({ exchanges: [], segments: [], option_types: [], total: 0 }));
  }, []);

  // Show F&O-only filter inputs when the user has scoped to F&O (or hasn't
  // scoped at all but the result set has F&O rows).
  const showFnoFilters = useMemo(() => {
    if (segment) return FNO_SEGMENTS.includes(segment);
    return false;
  }, [segment]);

  // Show F&O-only columns when at least one row in the current results is F&O.
  const showFnoColumns = useMemo(
    () => results.some((r) => FNO_SEGMENTS.includes(r.segment)),
    [results],
  );

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    setBusy(true);
    try {
      const params = new URLSearchParams({ q, limit: "50" });
      if (exchange)            params.set("exchange", exchange);
      if (segment)             params.set("segment", segment);
      if (underlying.trim())   params.set("underlying", underlying.trim().toUpperCase());
      // F&O-only filters only get sent when the user has scoped to F&O — otherwise
      // they'd over-narrow against EQUITY rows that have no strike/expiry.
      if (showFnoFilters && strike.trim())   params.set("strike", strike.trim());
      if (showFnoFilters && optionType)      params.set("option_type", optionType);
      if (showFnoFilters && expiry)          params.set("expiry", expiry);
      const { data } = await api.get<SymRow[]>(`/symbols/search?${params}`);
      setResults(data);
    } finally {
      setBusy(false);
    }
  }

  function resetFilters() {
    setExchange("");
    setSegment("");
    setUnderlying("");
    setStrike("");
    setOptionType("");
    setExpiry("");
  }

  async function viewMappings(internal: string) {
    if (openMap === internal) {
      setOpenMap(null);
      setMappings(null);
      return;
    }
    setOpenMap(internal);
    setMappings(null);
    setMapBusy(true);
    try {
      const { data } = await api.get(
        `/symbols/by-internal/${encodeURIComponent(internal)}/brokers`,
      );
      setMappings(data);
    } finally {
      setMapBusy(false);
    }
  }

  const totalLabel = options
    ? `${options.total.toLocaleString()} symbols loaded`
    : "loading…";

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Symbol explorer</h1>
        <span className="text-xs text-muted-foreground">{totalLabel}</span>
      </div>

      <form onSubmit={search} className="card space-y-3">
        {/* Row 1: free-text + segment/exchange (always visible) */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            className="input md:col-span-2"
            placeholder="Search RELIANCE, NIFTY, BANKNIFTY…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="input"
            value={exchange}
            onChange={(e) => setExchange(e.target.value as Exchange | "")}
          >
            <option value="">All exchanges</option>
            {(options?.exchanges ?? []).map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
          <select
            className="input"
            value={segment}
            onChange={(e) => setSegment(e.target.value as Segment | "")}
          >
            <option value="">All segments</option>
            {(options?.segments ?? []).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Row 2: underlying (always) + strike/opt/expiry (F&O only) */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            className="input"
            placeholder="Underlying (RELIANCE)"
            value={underlying}
            onChange={(e) => setUnderlying(e.target.value)}
          />
          {showFnoFilters ? (
            <>
              <input
                className="input"
                placeholder="Strike (24500)"
                inputMode="decimal"
                value={strike}
                onChange={(e) => setStrike(e.target.value)}
              />
              <select
                className="input"
                value={optionType}
                onChange={(e) => setOptionType(e.target.value as OptionType | "")}
              >
                <option value="">Any type</option>
                {(options?.option_types ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <input
                className="input"
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </>
          ) : (
            <div className="md:col-span-3 text-xs text-muted-foreground self-center">
              Pick segment <span className="font-mono">FUT</span> or <span className="font-mono">OPT</span> to filter by strike / expiry / type.
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
          <button type="button" className="btn-outline" onClick={resetFilters}>
            Clear filters
          </button>
        </div>
      </form>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Trading symbol</th>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Segment</th>
              {showFnoColumns && <th>Expiry</th>}
              {showFnoColumns && <th>Strike</th>}
              {showFnoColumns && <th>Type</th>}
              <th>Lot</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((s) => (
              <Row
                key={s.internal_symbol}
                sym={s}
                showFnoColumns={showFnoColumns}
                isOpen={openMap === s.internal_symbol}
                mappings={openMap === s.internal_symbol ? mappings : null}
                mapBusy={mapBusy}
                onToggle={() => viewMappings(s.internal_symbol)}
              />
            ))}
            {!results.length && (
              <tr>
                <td colSpan={showFnoColumns ? 9 : 6} className="text-center text-muted-foreground py-4">
                  {busy ? "Searching…" : "No results yet — type a query and hit Search."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  sym, showFnoColumns, isOpen, mappings, mapBusy, onToggle,
}: {
  sym: SymRow;
  showFnoColumns: boolean;
  isOpen: boolean;
  mappings: Mapping[] | null;
  mapBusy: boolean;
  onToggle: () => void;
}) {
  const colSpan = showFnoColumns ? 9 : 6;
  return (
    <>
      <tr>
        <td className="font-mono text-gray-100">{sym.trading_symbol}</td>
        <td>{sym.underlying}</td>
        <td>{sym.exchange}</td>
        <td><SegBadge segment={sym.segment} /></td>
        {showFnoColumns && <td>{fmtExpiry(sym.expiry)}</td>}
        {showFnoColumns && <td>{sym.strike ?? "—"}</td>}
        {showFnoColumns && <td>{sym.option_type || "—"}</td>}
        <td>{sym.lot_size}</td>
        <td className="text-right">
          <button className="btn-outline text-xs" onClick={onToggle}>
            {isOpen ? "Hide brokers" : "View brokers"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={colSpan} className="bg-panel2/40 p-0">
            <div className="p-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                Internal key (backend matching only):{" "}
                <span className="font-mono text-gray-300">{sym.internal_symbol}</span>
              </div>
              {mapBusy && <div className="text-xs text-muted-foreground">loading…</div>}
              {!mapBusy && mappings && <MappingTable mappings={mappings} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function MappingTable({ mappings }: { mappings: Mapping[] }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        How each broker identifies this instrument when placing orders or subscribing to ticks.
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Broker</th>
            <th>Mapped?</th>
            <th>broker_symbol</th>
            <th>token</th>
            <th>exch</th>
            <th>order keying</th>
            <th>subscribe keying</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((m) => (
            <tr key={m.broker}>
              <td className="font-mono">{m.broker}</td>
              <td>
                {m.mapped
                  ? <span className="pill bg-primary/20 text-primary">YES</span>
                  : <span className="pill bg-danger/30 text-danger">NO</span>}
              </td>
              <td className="font-mono text-xs">{m.broker_symbol || "—"}</td>
              <td className="font-mono text-xs">{m.token || "—"}</td>
              <td className="font-mono text-xs">{m.exchange_code || "—"}</td>
              <td className="text-xs"><KeyingPill kind={m.order_keying} /></td>
              <td className="text-xs"><KeyingPill kind={m.subscribe_keying} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="text-xs text-muted-foreground">
        <summary>Per-broker keying notes</summary>
        <ul className="space-y-1 mt-2">
          {mappings.map((m) => (
            <li key={m.broker} className="border-l-2 border-border pl-2">
              <div className="font-mono text-gray-300">{m.broker}</div>
              <div>{m.keying_note}</div>
              {m.keying_example && (
                <div className="text-gray-500 font-mono">e.g. {m.keying_example}</div>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function SegBadge({ segment }: { segment: Segment }) {
  const cls = {
    EQUITY:    "bg-blue-700/40 text-blue-300",
    INDEX:     "bg-purple-700/40 text-purple-300",
    FUT:       "bg-yellow-700/40 text-yellow-300",
    OPT:       "bg-green-700/40 text-green-300",
    COMMODITY: "bg-orange-700/40 text-orange-300",
    CURRENCY:  "bg-pink-700/40 text-pink-300",
  }[segment] ?? "bg-gray-700 text-gray-300";
  return <span className={`pill ${cls}`}>{segment}</span>;
}

function KeyingPill({ kind }: { kind: Mapping["order_keying"] }) {
  const colour = {
    symbol: "bg-blue-700/40 text-blue-300",
    token: "bg-purple-700/40 text-purple-300",
    "symbol+token": "bg-yellow-700/40 text-yellow-300",
    instrument_key: "bg-green-700/40 text-green-300",
  }[kind];
  return <span className={`pill ${colour}`}>{kind}</span>;
}
