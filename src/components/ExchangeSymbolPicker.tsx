"use client";
/**
 * Five-step cascading symbol picker, fully driven by the Redis symbol master.
 *
 *   1. Exchange       (dropdown — /symbols/filters)
 *   2. Symbol         (typeahead on distinct underlyings — /symbols/underlyings)
 *   3. Expiry Date    (date input — F&O exchanges only)
 *   4. Option Type    (CE / PE / FUT — F&O exchanges only)
 *   5. Strike Price   (number input — only when Option Type is CE or PE)
 *
 * Resolution: once every required field for the chosen instrument type is
 * filled, the picker calls `POST /symbols/resolve` and propagates the
 * resulting `internal_symbol` to the parent via `onChange`.
 *
 *   * Cash exchanges (NSE / BSE)            → steps 1, 2 are enough.
 *   * Futures   (Option Type = FUT)         → steps 1, 2, 3, 4.
 *   * Options   (Option Type = CE or PE)    → steps 1, 2, 3, 4, 5.
 *
 * Changing any field clears every dependent field below it so a stale value
 * never participates in the resolution.
 */
import { useEffect, useState } from "react";
import useSWR from "swr";
import clsx from "clsx";
import { api } from "@/lib/api";
import { fmtExpiry, prettySymbol } from "@/lib/fmt";
import { UnderlyingPicker } from "@/components/UnderlyingPicker";

type Exchange = "NSE" | "BSE" | "MCX" | "NFO" | "BFO" | "CDS";
type OptType = "CE" | "PE" | "FUT";

type FilterOptions = {
  exchanges: Exchange[];
  segments: string[];
  option_types: string[];
  total: number;
};

type ResolveMatch = {
  internal_symbol: string;
  trading_symbol: string;
  exchange: string;
  segment: string;
  underlying: string;
};

type ResolveResponse = {
  exact: boolean;
  matches: ResolveMatch[];
};

const CASH_EXCHANGES = new Set<Exchange>(["NSE", "BSE"]);

interface Props {
  value: string;                                      // internal_symbol
  onChange: (internalSymbol: string) => void;
  exchange?: Exchange | "";
  onExchangeChange?: (e: Exchange | "") => void;
  className?: string;
  labels?: boolean;
  disabled?: boolean;
  /** Restrict the Exchange dropdown to cash exchanges (NSE / BSE) and hide
   *  every F&O field. Used by equity-only strategy builders. */
  equityOnly?: boolean;
  /** Restrict the Exchange dropdown to F&O exchanges (NFO / BFO / MCX / CDS)
   *  and lock the option-type to FUT (hides CE/PE/strike). Used by the
   *  Futures strategy builder. Mutually exclusive with `equityOnly`. */
  futuresOnly?: boolean;
  /** Options-underlying mode for the Options strategy builder. Like
   *  `futuresOnly` for the Exchange dropdown (F&O exchanges only), but
   *  hides the Expiry alias dropdown entirely — the strategy's option-leg
   *  config owns the expiry choice. The picker auto-emits the dedicated
   *  options-underlying alias `<EXCH>_<UND>_@OPT` as soon as Exchange +
   *  Symbol are filled in. Mutually exclusive with `equityOnly` /
   *  `futuresOnly`. */
  optionsUnderlyingOnly?: boolean;
}

const fetcher = (u: string) => api.get(u).then((r) => r.data);

export function ExchangeSymbolPicker({
  value, onChange,
  exchange: controlledExchange, onExchangeChange,
  className, labels = true, disabled,
  equityOnly = false,
  futuresOnly = false,
  optionsUnderlyingOnly = false,
}: Props) {
  const { data: filters } = useSWR<FilterOptions>("/symbols/filters", fetcher);

  // ---- field state ------------------------------------------------------
  const [internalExchange, setInternalExchange] = useState<Exchange | "">("");
  const exchange = controlledExchange ?? internalExchange;
  const [underlying, setUnderlying] = useState("");
  const [expiry, setExpiry] = useState("");
  const [optType, setOptType] = useState<"" | OptType>("");
  const [strikeStr, setStrikeStr] = useState("");
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Expiries available for the chosen (Exchange + Symbol). Fetched live from
  // /symbols/{underlying}/expiries (union of FUT+OPT) so the dropdown only
  // ever shows dates that actually exist in the master.
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiriesBusy, setExpiriesBusy] = useState(false);
  // Option types that actually exist for (underlying, expiry). Narrows the
  // Option Type dropdown so weekly-options expiries don't offer FUT and
  // monthly-only-futures expiries don't offer CE/PE.
  const [availableOptTypes, setAvailableOptTypes] = useState<OptType[]>([]);
  const [optTypesBusy, setOptTypesBusy] = useState(false);
  // Strikes available for (underlying, expiry) — populated when option type
  // is CE or PE. Strikes don't apply to FUT.
  const [strikes, setStrikes] = useState<number[]>([]);
  const [strikesBusy, setStrikesBusy] = useState(false);
  // Trading symbol shown on the "✓ Selected" line so the user sees the
  // friendly form (e.g. "NIFTY 28-MAY-2026 FUT") rather than the raw
  // internal_symbol (`NFO_NIFTY_280526_FUT`).
  const [resolvedTradingSymbol, setResolvedTradingSymbol] = useState("");

  // ---- futures-alias mode (relative expiry) ---------------------------
  // Instead of picking a specific date, the user picks "Current expiry",
  // "Next expiry" or "Far expiry". The picker emits a *logical* symbol
  // (e.g. NFO_NIFTY_@CURRENT_FUT). The runner resolves it daily so the
  // strategy keeps working as contracts roll over.
  const [expiryAlias, setExpiryAlias] = useState<"" | "CURRENT" | "NEXT" | "FAR">("");
  const [aliasPreview, setAliasPreview] = useState<{
    expiry: string | null;
    days_to_expiry: number | null;
    internal_symbol: string | null;
  } | null>(null);

  // ---- options-underlying mode --------------------------------------
  // The picker is the source of truth ONLY for the underlying — the
  // strategy's MultiLegOptionsPanel owns every per-leg detail (option
  // type, strike, expiry alias). As soon as Exchange + Underlying are
  // set, we emit `<EXCH>_<UND>_@OPT` and the backend resolves the
  // underlying's front-month future for the indicator feed.

  const isFno = !equityOnly && !!exchange && !CASH_EXCHANGES.has(exchange as Exchange);
  const needsStrike = optType === "CE" || optType === "PE";
  // Futures-style cascading flow (exchange → underlying → expiry alias)
  // applies to both futures-only and options-underlying modes. Options
  // mode skips the expiry-alias step.
  const isAliasCascade = futuresOnly || optionsUnderlyingOnly;

  // ---- mode-switch reset ----------------------------------------------
  // When the parent flips equityOnly ↔ futuresOnly (e.g. the strategy
  // builder's tab toggle), every cascading field must clear: the previously
  // chosen exchange may not exist in the new dropdown's filtered list,
  // and a leftover concrete expiry would cause the picker to render the
  // wrong (date) UI variant briefly.
  useEffect(() => {
    setInternalExchange("");
    setUnderlying("");
    setExpiry("");
    setExpiryAlias("");
    setAliasPreview(null);
    setOptType("");
    setStrikeStr("");
    setResolvedTradingSymbol("");
    setResolveError(null);
    if (value) onChange("");
    if (onExchangeChange) onExchangeChange("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equityOnly, futuresOnly, optionsUnderlyingOnly]);

  // ---- fetch expiries when Exchange + Symbol are both set --------------
  useEffect(() => {
    if (!isFno || !underlying) {
      setExpiries([]);
      setExpiriesBusy(false);
      return;
    }
    let cancelled = false;
    setExpiriesBusy(true);
    api.get<string[]>(`/symbols/${encodeURIComponent(underlying)}/expiries`)
      .then(({ data }) => {
        if (!cancelled) setExpiries((data || []).slice().sort());
      })
      .catch(() => { if (!cancelled) setExpiries([]); })
      .finally(() => { if (!cancelled) setExpiriesBusy(false); });
    return () => { cancelled = true; };
  }, [isFno, underlying]);

  // ---- fetch available option types when (underlying, expiry) are set --
  useEffect(() => {
    if (!underlying || !expiry) {
      setAvailableOptTypes([]);
      setOptTypesBusy(false);
      return;
    }
    let cancelled = false;
    setOptTypesBusy(true);
    const params = new URLSearchParams({ expiry });
    api.get<string[]>(`/symbols/${encodeURIComponent(underlying)}/option-types?${params}`)
      .then(({ data }) => {
        if (cancelled) return;
        const valid = (data || []).filter(
          (t): t is OptType => t === "FUT" || t === "CE" || t === "PE",
        );
        setAvailableOptTypes(valid);
        // Futures-only mode: skip the user clicking "FUT" — auto-pick it
        // when the expiry has a FUT contract. Other types are filtered
        // out of the visible UI anyway.
        if (futuresOnly && valid.includes("FUT") && optType !== "FUT") {
          setOptTypeAndReset("FUT");
          return;
        }
        // If the user had already picked an option type that's no longer
        // valid for this expiry, clear it so the resolver doesn't fail.
        if (optType && !valid.includes(optType as OptType)) {
          setOptTypeAndReset("");
        }
      })
      .catch(() => { if (!cancelled) setAvailableOptTypes([]); })
      .finally(() => { if (!cancelled) setOptTypesBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, expiry]);

  // ---- fetch strikes when (underlying, expiry, optType=CE/PE) are set --
  useEffect(() => {
    if (!underlying || !expiry || (optType !== "CE" && optType !== "PE")) {
      setStrikes([]);
      setStrikesBusy(false);
      return;
    }
    let cancelled = false;
    setStrikesBusy(true);
    const params = new URLSearchParams({ expiry, option_type: optType });
    api.get<number[]>(`/symbols/${encodeURIComponent(underlying)}/strikes?${params}`)
      .then(({ data }) => {
        if (!cancelled) setStrikes(Array.isArray(data) ? data.slice().sort((a, b) => a - b) : []);
      })
      .catch(() => { if (!cancelled) setStrikes([]); })
      .finally(() => { if (!cancelled) setStrikesBusy(false); });
    return () => { cancelled = true; };
  }, [underlying, expiry, optType]);

  // ---- cascading resets -------------------------------------------------
  // When a field changes, every dependent field below it is cleared so the
  // resolver never sees a half-stale combination.
  function setExchange(next: Exchange | "") {
    if (onExchangeChange) onExchangeChange(next);
    else setInternalExchange(next);
    setUnderlying("");
    setExpiry("");
    setExpiryAlias("");
    setAliasPreview(null);
    setOptType("");
    setStrikeStr("");
    if (value) onChange("");
  }

  // underlying / expiry / optType / strike resets are handled inside the
  // setters of the dependent fields below.
  function setUnderlyingAndReset(next: string) {
    setUnderlying(next);
    setExpiry("");
    setExpiryAlias("");
    setAliasPreview(null);
    setOptType("");
    setStrikeStr("");
    if (value) onChange("");
  }
  function setExpiryAndReset(next: string) {
    setExpiry(next);
    setOptType("");
    setStrikeStr("");
    if (value) onChange("");
  }
  function setOptTypeAndReset(next: "" | OptType) {
    setOptType(next);
    // FUT has no strike — clear any leftover value so it doesn't tag along.
    if (next !== "CE" && next !== "PE") setStrikeStr("");
    if (value) onChange("");
  }

  // ---- resolution effect ------------------------------------------------
  useEffect(() => {
    setResolveError(null);
    // futuresOnly is handled by the alias-resolution effect below.
    if (futuresOnly) return;
    if (!exchange || !underlying) {
      if (value) onChange("");
      return;
    }
    // Cash: a 2-field selection resolves immediately.
    // F&O FUT:    needs expiry + optType=FUT.
    // F&O CE/PE: needs expiry + optType + strike.
    if (isFno) {
      if (!expiry || !optType) {
        if (value) onChange("");
        return;
      }
      if (needsStrike && !strikeStr.trim()) {
        if (value) onChange("");
        return;
      }
    }

    const body: Record<string, unknown> = {
      exchange,
      underlying,
      limit: 5,
    };
    if (isFno) {
      body.expiry = expiry;
      if (optType === "FUT") {
        body.segment = "FUT";
      } else {
        body.segment = "OPT";
        body.option_type = optType;
        body.strike = Number(strikeStr);
      }
    } else {
      // No `segment` filter: resolve picks the best match the master has
      // (EQUITY for stocks, INDEX for indices).
    }

    let cancelled = false;
    setResolveBusy(true);
    api.post<ResolveResponse>("/symbols/resolve", body)
      .then(({ data }) => {
        if (cancelled) return;
        if (data.matches.length === 0) {
          onChange("");
          setResolvedTradingSymbol("");
          setResolveError("no symbol matches these inputs");
        } else {
          // For cash equities the resolver may return both EQ and BE series.
          // Prefer the EQ / A row when present; otherwise take the first.
          const equitySeries = data.matches.find((m) =>
            m.internal_symbol.endsWith("-EQ") || m.internal_symbol.endsWith("-A"),
          );
          const pick = equitySeries ?? data.matches[0];
          onChange(pick.internal_symbol);
          setResolvedTradingSymbol(pick.trading_symbol || pick.internal_symbol);
          setResolveError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          onChange("");
          setResolvedTradingSymbol("");
          setResolveError("resolve failed — check your inputs");
        }
      })
      .finally(() => { if (!cancelled) setResolveBusy(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, underlying, expiry, optType, strikeStr, futuresOnly]);

  // ---- options-underlying mode ----------------------------------------
  // Emit `<EXCH>_<UND>_@OPT` as soon as Exchange + Underlying are set.
  // The MultiLegOptionsPanel in the strategy form owns every per-leg
  // choice (CE/PE, strike, expiry alias, qty ratio). The backend treats
  // `_@OPT` as "subscribe the underlying's front-month future for the
  // indicator feed; pick the actual CE/PE strike from option_config.legs
  // at signal time" — see backend/app/services/symbols/store.py.
  useEffect(() => {
    if (!optionsUnderlyingOnly) return;
    setResolveError(null);
    setAliasPreview(null);
    if (!exchange || !underlying) {
      if (value) onChange("");
      return;
    }
    const logical = `${exchange}_${underlying}_@OPT`;
    onChange(logical);

    // Preview which front-month FUT contract the indicator feed will use
    // today by reusing the futures-alias resolver with CURRENT — same
    // path the runner takes when subscribing the feed.
    let cancelled = false;
    setResolveBusy(true);
    api.post<{
      logical_symbol: string;
      internal_symbol: string | null;
      alias: string;
      expiry: string | null;
      days_to_expiry: number | null;
      error?: string;
    }>("/symbols/resolve-alias", { exchange, underlying, alias: "CURRENT" })
      .then(({ data }) => {
        if (cancelled) return;
        if (!data.internal_symbol) {
          setResolveError(data.error || "no front-month future for this underlying");
          return;
        }
        setAliasPreview({
          internal_symbol: data.internal_symbol,
          expiry: data.expiry,
          days_to_expiry: data.days_to_expiry,
        });
      })
      .catch(() => {
        if (!cancelled) setResolveError("resolve-alias failed");
      })
      .finally(() => { if (!cancelled) setResolveBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, underlying, optionsUnderlyingOnly]);

  // ---- futures-alias resolution ---------------------------------------
  // For futuresOnly mode, pick CURRENT/NEXT/FAR and the picker emits a
  // *logical* internal_symbol like NFO_NIFTY_@CURRENT_FUT. We hit the
  // resolve-alias endpoint purely to preview which actual contract it
  // maps to today (and surface "no contract available" early).
  useEffect(() => {
    if (!futuresOnly) return;
    setResolveError(null);
    setAliasPreview(null);
    if (!exchange || !underlying || !expiryAlias) {
      if (value) onChange("");
      return;
    }
    let cancelled = false;
    setResolveBusy(true);
    api.post<{
      logical_symbol: string;
      internal_symbol: string | null;
      alias: string;
      expiry: string | null;
      days_to_expiry: number | null;
      lot_size?: number;
      error?: string;
    }>("/symbols/resolve-alias", { exchange, underlying, alias: expiryAlias })
      .then(({ data }) => {
        if (cancelled) return;
        if (!data.internal_symbol) {
          onChange("");
          setResolvedTradingSymbol("");
          setResolveError(data.error || "no contract available for this alias");
          return;
        }
        // Emit the *logical* symbol so the strategy survives rollovers.
        onChange(data.logical_symbol);
        setResolvedTradingSymbol(data.internal_symbol);
        setAliasPreview({
          internal_symbol: data.internal_symbol,
          expiry: data.expiry,
          days_to_expiry: data.days_to_expiry,
        });
      })
      .catch(() => {
        if (!cancelled) {
          onChange("");
          setResolvedTradingSymbol("");
          setResolveError("resolve-alias failed");
        }
      })
      .finally(() => { if (!cancelled) setResolveBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, underlying, expiryAlias, futuresOnly]);

  // ---- layout -----------------------------------------------------------
  // Fallback to a hardcoded list when the symbol master hasn't been
  // synced yet (Redis dim-set is empty). The downstream cascading
  // (symbol typeahead, expiries) will still need the master, but at
  // least the Exchange dropdown isn't a dead end.
  const FALLBACK_EXCHANGES: Exchange[] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];
  const allExchanges: Exchange[] =
    filters && filters.exchanges && filters.exchanges.length > 0
      ? filters.exchanges
      : FALLBACK_EXCHANGES;
  const masterMissing = !!filters && (filters.exchanges ?? []).length === 0;
  const exchanges: Exchange[] = equityOnly
    ? allExchanges.filter((x) => CASH_EXCHANGES.has(x))
    : isAliasCascade
    ? allExchanges.filter((x) => !CASH_EXCHANGES.has(x))
    : allExchanges;

  return (
    <div className={clsx("space-y-2", className)}>
      {masterMissing && (
        <div className="text-[11px] font-mono text-yellow-400/90 bg-yellow-400/5 border border-yellow-400/20 rounded px-2 py-1">
          Symbol master not synced. Exchanges shown are a fallback. Run
          {" "}
          <code className="font-mono">POST /admin/symbol-master/sync/&lt;broker&gt;</code>
          {" "}
          (or use the Brokers page) to enable symbol typeahead.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* 1. Exchange */}
        <div>
          {labels && <div className="label mb-1">Exchange</div>}
          <select
            className="input"
            value={exchange}
            onChange={(e) => setExchange(e.target.value as Exchange | "")}
            disabled={disabled}
          >
            <option value="">Select exchange…</option>
            {exchanges.map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </div>
        {/* 2. Symbol / Underlying */}
        <div>
          {labels && <div className="label mb-1">Symbol</div>}
          <UnderlyingPicker
            value={underlying}
            onChange={setUnderlyingAndReset}
            exchange={exchange}
            disabled={disabled || !exchange}
          />
        </div>
      </div>

      {/* Concrete F&O cascading row — not rendered in options-underlying
          mode (the strategy's MultiLegOptionsPanel owns leg detail). */}
      {isFno && !optionsUnderlyingOnly && (
        <div
          className={clsx(
            "grid gap-2",
            needsStrike
              ? "grid-cols-1 sm:grid-cols-3"
              : futuresOnly
              ? "grid-cols-1"
              : "grid-cols-1 sm:grid-cols-2",
          )}
        >
          {/* 3. Expiry — relative-alias dropdown for futuresOnly mode
              (Current/Next/Far), or absolute date for all other F&O paths.
              The relative form lets a strategy keep running across rollovers
              without the user editing the symbol every week. */}
          <div>
            {labels && (
              <div className="label mb-1">
                {futuresOnly ? "Expiry" : "Expiry Date"}
              </div>
            )}
            {futuresOnly ? (
              <select
                className="input"
                value={expiryAlias}
                onChange={(e) => {
                  setExpiryAlias(e.target.value as "" | "CURRENT" | "NEXT" | "FAR");
                  if (value) onChange("");
                }}
                disabled={disabled || !underlying}
              >
                <option value="">
                  {!underlying ? "Pick a symbol first" : "Select expiry…"}
                </option>
                <option value="CURRENT">Current expiry</option>
                <option value="NEXT">Next expiry</option>
                <option value="FAR">Far expiry</option>
              </select>
            ) : (
              <select
                className="input"
                value={expiry}
                onChange={(e) => setExpiryAndReset(e.target.value)}
                disabled={disabled || !underlying || expiriesBusy || expiries.length === 0}
              >
                <option value="">
                  {expiriesBusy
                    ? "Loading…"
                    : !underlying
                    ? "Pick a symbol first"
                    : expiries.length === 0
                    ? "No expiries"
                    : "Select expiry…"}
                </option>
                {expiries.map((d) => (
                  <option key={d} value={d}>{fmtExpiry(d)}</option>
                ))}
              </select>
            )}
          </div>
          {/* 4. Option Type — restricted to types that actually exist for
              the picked (underlying, expiry). NIFTY weekly options ⇒ only
              CE/PE; monthly futures-only expiry ⇒ only FUT. Hidden in
              futuresOnly mode (auto-set to FUT). */}
          {!futuresOnly && (
            <div>
              {labels && <div className="label mb-1">Option Type</div>}
              <select
                className="input"
                value={optType}
                onChange={(e) => setOptTypeAndReset(e.target.value as "" | OptType)}
                disabled={
                  disabled || !expiry || optTypesBusy || availableOptTypes.length === 0
                }
              >
                <option value="">
                  {optTypesBusy
                    ? "Loading…"
                    : !expiry
                    ? "Pick expiry first"
                    : availableOptTypes.length === 0
                    ? "No types"
                    : "Select…"}
                </option>
                {availableOptTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          )}
          {/* 5. Strike Price — dropdown populated from /strikes; CE / PE only */}
          {needsStrike && (
            <div>
              {labels && <div className="label mb-1">Strike Price</div>}
              <select
                className="input"
                value={strikeStr}
                onChange={(e) => { setStrikeStr(e.target.value); if (value) onChange(""); }}
                disabled={disabled || !expiry || strikesBusy || strikes.length === 0}
              >
                <option value="">
                  {strikesBusy
                    ? "Loading…"
                    : !expiry
                    ? "Pick expiry first"
                    : strikes.length === 0
                    ? "No strikes"
                    : "Select strike…"}
                </option>
                {strikes.map((s) => (
                  <option key={s} value={s}>
                    {/* Display whole strikes as integers, fractional as-is. */}
                    {s === Math.trunc(s) ? s.toLocaleString("en-US") : s}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Resolution feedback — shows the friendly trading symbol so the
          user can confirm at a glance that the right contract is selected.
          For futuresOnly aliases, the *logical* symbol is what's saved and
          what runs (auto-rolling on expiry). The concrete contract it maps
          to today is shown as small helper text underneath so the user
          knows what will trade right now without confusing them into
          thinking we stored a fixed date. */}
      <div className="text-xs min-h-[1rem] space-y-0.5">
        {resolveBusy && <span className="text-muted-foreground">Resolving…</span>}
        {!resolveBusy && resolveError && (
          <span className="text-yellow-400">{resolveError}</span>
        )}
        {!resolveBusy && !resolveError && value && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-primary" title={value}>
                {/* ✓ Selected:{" "} */}
                <span className="font-mono">
                  {isAliasCascade ? prettySymbol(value) : (resolvedTradingSymbol || value)}
                </span>
              </span>
            </div>
            {isAliasCascade && aliasPreview && aliasPreview.internal_symbol && (
              <div className="text-muted-foreground text-[11px] pl-3">
                ↳ {optionsUnderlyingOnly ? "Indicator feed uses" : "Today this maps to"}{" "}
                <span className="font-mono" title={aliasPreview.internal_symbol}>
                  {prettySymbol(aliasPreview.internal_symbol)}
                </span>
                {aliasPreview.expiry && (
                  <> (expires {aliasPreview.expiry}
                    {aliasPreview.days_to_expiry !== null && (
                      <>, {aliasPreview.days_to_expiry}d away</>
                    )})
                  </>
                )}
                . Auto-rolls to the next contract on expiry.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
