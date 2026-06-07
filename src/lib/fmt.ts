export const fmtUSD = (n: number | null | undefined, frac = 2) =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });

export const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(2)}%`;

const MONTH_ABBR = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/**
 * Format a broker/server timestamp as `DD-MMM-YYYY HH:MM:SS` in the requested
 * IANA timezone (defaults to the browser local zone). Used for live ticks and
 * any other server-emitted instant where the user wants to pin the display to
 * a specific market timezone — e.g. IST for Indian markets, regardless of the
 * laptop's clock.
 */
export const fmtTs = (s: string | Date, tz?: string): string => {
  const d = s instanceof Date ? s : new Date(s);
  if (isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || undefined,
    hour12: false,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // 24-hour intl can produce "24" at midnight in some engines — normalise.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("day")}-${get("month").toUpperCase()}-${get("year")} ${hour}:${get("minute")}:${get("second")}`;
};

/**
 * Format an expiry date (ISO `YYYY-MM-DD`, JS Date, or null) as
 * `DD-MMM-YYYY` — e.g. `26-MAY-2026`. Used everywhere expiries are shown
 * in the UI (option chain, picker dropdown, order/position tables) so the
 * user never has to mentally parse `2026-05-26` vs `26/05/2026`.
 *
 * Returns "—" for null/undefined/empty/invalid inputs.
 */
export function fmtExpiry(s: string | Date | null | undefined): string {
  if (s == null || s === "") return "—";
  // Avoid the local-timezone shift you get with `new Date("2026-05-26")` —
  // for our ISO-date strings the date parts are right there in the string.
  if (typeof s === "string") {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const [, y, mm, dd] = m;
      const idx = Number(mm) - 1;
      if (idx >= 0 && idx < 12) return `${dd}-${MONTH_ABBR[idx]}-${y}`;
    }
  }
  const d = s instanceof Date ? s : new Date(s);
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${MONTH_ABBR[d.getMonth()]}-${d.getFullYear()}`;
}

/** Canonical index ticker / ETF proxy → display name. Anything not listed
 * falls back to the ticker itself. Kept in sync with the US index roster in
 * `src/services/marketDataService.ts::US_INDEX_REGISTRY`. */
const INDEX_DISPLAY: Record<string, string> = {
  SPY:  "S&P 500",
  DIA:  "DOW JONES",
  QQQ:  "NASDAQ 100",
  IWM:  "RUSSELL 2000",
  VIXY: "VOLATILITY (VIX)",
  VTI:  "TOTAL MARKET",
  MDY:  "S&P MIDCAP 400",
  IJR:  "S&P SMALLCAP 600",
  ONEQ: "NASDAQ COMPOSITE",
};

/** `'290526'` → `'29 May 26'`. Returns the raw string on bad input. */
function fmtDdmmyyShort(s: string): string {
  if (!/^\d{6}$/.test(s)) return s;
  const dd = s.slice(0, 2);
  const mm = Number(s.slice(2, 4));
  const yy = s.slice(4, 6);
  if (mm < 1 || mm > 12) return s;
  const mon = MONTH_ABBR[mm - 1];
  // Title-case the month so it reads more like "29 May 26" than the
  // shoutier "29 MAY 26" we use for full DD-MMM-YYYY timestamps.
  const monTitle = mon[0] + mon.slice(1).toLowerCase();
  return `${dd} ${monTitle} ${yy}`;
}

/**
 * Internal_symbol → human-readable display string for tables / labels.
 *
 *   NSE_RELIANCE-EQ          → "RELIANCE-EQ"
 *   NSE_YESBANK-BE           → "YESBANK-BE"
 *   NSE_NIFTY50_IDX          → "NIFTY 50"
 *   NSE_INDIAVIX_IDX         → "INDIA VIX"
 *   NFO_NIFTY_290526_FUT     → "NFO NIFTY 29 May 26 Futures"
 *   MCX_GOLD_050626_FUT      → "MCX GOLD 05 Jun 26 Futures"
 *   NFO_NIFTY_@CURRENT_FUT          → "NFO NIFTY Futures (current)"
 *   NFO_NIFTY_@OPT                  → "NFO NIFTY Options"          (legacy)
 *   NFO_NIFTY_@CURRENT_ATM_CE       → "NFO NIFTY current ATM CE"
 *   NFO_NIFTY_@NEXT_ATM+2_PE        → "NFO NIFTY next ATM+2 PE"
 *   NFO_NIFTY_290526_24500_CE       → "NFO NIFTY 29 May 26 24500 CE"
 *   NFO_NIFTY_290526_24512.5_PE     → "NFO NIFTY 29 May 26 24512.5 PE"
 *
 * Unrecognized shapes (BSE codes, exotic exchanges, malformed strings)
 * fall back to the raw symbol — never breaks the UI.
 *
 * Click handlers should keep using the raw internal_symbol; this is for
 * *display only*. Hover-title is also useful so power users can still
 * see the internal id.
 */
export function prettySymbol(internal: string): string {
  if (!internal) return "";

  // Index: NSE_<TICKER>_IDX
  const idx = internal.match(/^(NSE|BSE)_([A-Z0-9&]+)_IDX$/);
  if (idx) {
    const ticker = idx[2];
    return INDEX_DISPLAY[ticker] ?? ticker;
  }

  // Option: <DERIV-EXCH>_<UND>_DDMMYY_<STRIKE>_<CE|PE>
  // Format: "Exchange Underlying ExpiryDate Strike OptionType"
  const opt = internal.match(
    /^(NFO|BFO|MCX|CDS)_([A-Z0-9&]+)_(\d{6})_(\d+(?:\.\d+)?)_(CE|PE)$/,
  );
  if (opt) {
    const [, exchange, underlying, exp, strike, type] = opt;
    return `${exchange} ${underlying} ${fmtDdmmyyShort(exp)} ${strike} ${type}`;
  }

  // Future: <DERIV-EXCH>_<UND>_DDMMYY_FUT
  // Format: "Exchange Underlying ExpiryDate Futures"
  const fut = internal.match(/^(NFO|BFO|MCX|CDS)_([A-Z0-9&]+)_(\d{6})_FUT$/);
  if (fut) {
    const [, exchange, underlying, exp] = fut;
    return `${exchange} ${underlying} ${fmtDdmmyyShort(exp)} Futures`;
  }

  // Logical future: <DERIV-EXCH>_<UND>_@<CURRENT|NEXT|FAR>_FUT
  // The `@` notation is the picker's way of saying "front-month / next-month /
  // far-month futures contract" so a strategy can keep running across rollovers
  // without the user editing the absolute expiry every week.
  const logical = internal.match(
    /^(NFO|BFO|MCX|CDS)_([A-Z0-9&]+)_@(CURRENT|NEXT|FAR)_FUT$/,
  );
  if (logical) {
    const [, exchange, underlying, alias] = logical;
    return `${exchange} ${underlying} Futures (${alias.toLowerCase()})`;
  }

  // Full single-leg option alias: <DERIV-EXCH>_<UND>_@<EXP>_ATM[+-N]?_<TYPE>
  // Carries the entire option spec — expiry, strike (ATM-relative), and
  // CE/PE — inline so the strategy doesn't need a separate config block.
  const optFull = internal.match(
    /^(NFO|BFO|MCX|CDS)_([A-Z0-9&]+)_@(CURRENT|NEXT)_ATM([+-]\d+)?_(CE|PE)$/,
  );
  if (optFull) {
    const [, exchange, underlying, exp, off, otype] = optFull;
    const strike = off ? `ATM${off}` : "ATM";
    return `${exchange} ${underlying} ${exp.toLowerCase()} ${strike} ${otype}`;
  }

  // Legacy bare-underlying option alias: <DERIV-EXCH>_<UND>_@OPT
  // Used by early Phase-1 strategies before the full alias landed. Kept so
  // existing rows don't fall through to the raw display.
  const optUnd = internal.match(/^(NFO|BFO|MCX|CDS)_([A-Z0-9&]+)_@OPT$/);
  if (optUnd) {
    const [, exchange, underlying] = optUnd;
    return `${exchange} ${underlying} Options`;
  }

  // Equity: NSE_<TICKER>-<SERIES> (e.g. NSE_RELIANCE-EQ)
  const eq = internal.match(/^(?:NSE|BSE)_([A-Z0-9&]+(?:-[A-Z0-9]+)+)$/);
  if (eq) return eq[1];

  // Anything else — return as-is so the user at least sees *something*.
  return internal;
}

/**
 * Surface only the human-readable reason from a broker error string.
 *
 * Broker adapters log the full protocol trace into `last_error`, e.g.:
 *
 *   "fyers POST /api/v3/orders/sync -> 400 | {\"code\":-50,\"message\":\"X\",\"s\":\"error\"}"
 *
 * The user shouldn't have to read that — they care about the reason ("X").
 * Handles a few common shapes:
 *   - "<prefix> | { ... \"message\": \"…\" }" → JSON.message / .error / .detail
 *   - "<prefix> | plain text reason"          → plain text
 *   - Plain string (no pipe)                  → unchanged
 */
/** Noise prefixes brokers tack onto an otherwise useful reason. */
const NOISE_PREFIXES = [
  /^request rejected\s*[:\-]\s*/i,
  /^order rejected\s*[:\-]\s*/i,
  /^error\s*[:\-]\s*/i,
  /^failed\s*[:\-]\s*/i,
  /^failure\s*[:\-]\s*/i,
];

function stripNoise(s: string): string {
  let out = s.trim();
  // Run multiple times in case there are stacked prefixes (rare).
  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const re of NOISE_PREFIXES) {
      const next = out.replace(re, "");
      if (next !== out) {
        out = next.trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

export function prettyError(s: string | null | undefined): string {
  if (!s) return "";
  const pipeIdx = s.indexOf("|");
  if (pipeIdx >= 0) {
    const tail = s.slice(pipeIdx + 1).trim();
    const start = tail.indexOf("{");
    const end = tail.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const obj: any = JSON.parse(tail.slice(start, end + 1));
        const msg =
          obj?.message ||
          obj?.error ||
          obj?.error_description ||
          obj?.detail ||
          obj?.errorMessage;
        if (typeof msg === "string" && msg.trim()) return stripNoise(msg);
      } catch {
        /* fall through to raw tail */
      }
    }
    if (tail) return stripNoise(tail);
  }
  // No pipe — strip a "broker METHOD /path -> NNN" prefix if it stands alone.
  const stripped = s.replace(/^\S+\s+(GET|POST|PUT|PATCH|DELETE)\s+\S+\s*->\s*\d+\s*$/i, "").trim();
  return stripNoise(stripped || s);
}
