/** US-market formatting helpers (USD, en-US). */

export const fmtUSD = (n: number | null | undefined, frac = 2): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: frac,
        maximumFractionDigits: frac,
      });

export const fmtNum = (n: number | null | undefined, frac = 2): string =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });

/** Takes a raw percent value (12.5 → "12.50%"). */
export const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n.toFixed(2)}%`;

/** Number → string, coercing common backend string-decimals. */
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? null : n;
};

/** Tailwind class for P&L sign. */
export const pnlClass = (n: number | null | undefined): string =>
  n == null ? "text-muted-foreground" : n > 0 ? "text-green-600" : n < 0 ? "text-red-600" : "";

/** Default US market symbols surfaced in pickers / quick lists. */
export const US_SYMBOLS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META"];
export const US_INDICES = [
  { symbol: "SPY", name: "S&P 500 ETF" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF" },
  { symbol: "DIA", name: "Dow Jones ETF" },
  { symbol: "IWM", name: "Russell 2000 ETF" },
];
