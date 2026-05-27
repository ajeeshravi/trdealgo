/**
 * Black–Scholes pricing + Greeks + IV (Newton-Raphson).
 *
 * Used by the option-chain page to populate IV/Delta/Theta/Gamma/Vega
 * columns purely on the client when the backend doesn't ship them with
 * the broker quote.
 *
 * Conventions:
 *   T      time to expiry in YEARS (use `timeToExpiry` to convert from an ISO date)
 *   r      risk-free rate (annualised, decimal — e.g. 0.065 for 6.5%)
 *   q      dividend yield (annualised; 0 for indices in our use)
 *   sigma  volatility (annualised, decimal — e.g. 0.18 for 18%)
 *   delta  per-share (NOT per-contract)
 *   theta  per-DAY (we divide by 365 — most Indian platforms show per-day)
 *   vega   per 1% absolute change in vol (we divide by 100)
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const DEFAULT_RISK_FREE = 0.065;     // ~10y G-Sec yield, good enough for screen Greeks
const DEFAULT_DIVIDEND = 0;          // indices

// Standard normal CDF via erfc — accurate to ~7 decimals.
function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (
    0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))
  );
  return x > 0 ? 1 - p : p;
}

function normPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / SQRT_2PI;
}

export type CallPut = "call" | "put";

export interface Greeks {
  iv: number;        // decimal (0.18 = 18%)
  delta: number;
  gamma: number;
  theta: number;     // per day
  vega: number;      // per 1% vol change
}

/** Days-fraction until expiry. Floors at 1h so options expiring today
 *  still produce finite Greeks. */
export function timeToExpiry(expiryIso: string, nowMs: number = Date.now()): number {
  // Indian expiries settle at ~15:30 IST. Use end-of-day IST (15:30) as
  // the cutoff; that's good enough for screen-time Greeks.
  const expiryEod = new Date(`${expiryIso}T15:30:00+05:30`).getTime();
  const diffMs = expiryEod - nowMs;
  const oneHour = 60 * 60 * 1000;
  return Math.max(diffMs, oneHour) / (365 * 24 * 60 * 60 * 1000);
}

function bsPrice(
  S: number, K: number, T: number, r: number, q: number, sigma: number, cp: CallPut,
): number {
  if (sigma <= 0 || T <= 0) {
    const intrinsic = cp === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return intrinsic;
  }
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (cp === "call") {
    return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

function bsVega(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (sigma <= 0 || T <= 0) return 0;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.exp(-q * T) * normPdf(d1) * Math.sqrt(T);
}

/** Newton–Raphson IV solver. Falls back to a wide bisection if NR
 *  oscillates (deep ITM/OTM with tiny vega). */
function impliedVol(
  price: number, S: number, K: number, T: number, r: number, q: number, cp: CallPut,
): number {
  // Reject obviously broken inputs — don't return a "0% IV" that the
  // caller then renders as a number; let the UI show "—".
  if (!Number.isFinite(price) || price <= 0 || S <= 0 || T <= 0) return 0;

  // Arbitrage-bound check. Below the intrinsic floor → no real IV.
  const lowerBound = cp === "call"
    ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
    : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
  if (price < lowerBound - 1e-4) return 0;

  // Initial guess — Manaster-Koehler 1982 closed form.
  let sigma = Math.sqrt(Math.abs(Math.log(S / K) + r * T) * 2 / T) || 0.3;
  sigma = Math.max(0.01, Math.min(sigma, 3));

  for (let i = 0; i < 50; i++) {
    const p = bsPrice(S, K, T, r, q, sigma, cp);
    const v = bsVega(S, K, T, r, q, sigma);
    if (!Number.isFinite(p) || v < 1e-8) break;
    const diff = p - price;
    if (Math.abs(diff) < 1e-4) return sigma;
    sigma -= diff / v;
    if (sigma <= 0 || sigma > 5) {
      // Reset towards mid-range — Newton has wandered off.
      sigma = 0.3 + 0.05 * i;
    }
  }
  // Bisection fallback.
  let lo = 0.001;
  let hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, q, mid, cp);
    if (Math.abs(p - price) < 1e-4) return mid;
    if (p > price) hi = mid; else lo = mid;
  }
  return 0;
}

export function calcGreeks(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  cp: CallPut,
  opts: { r?: number; q?: number } = {},
): Greeks {
  const r = opts.r ?? DEFAULT_RISK_FREE;
  const q = opts.q ?? DEFAULT_DIVIDEND;

  const sigma = impliedVol(marketPrice, S, K, T, r, q, cp);
  if (sigma <= 0 || T <= 0) {
    return { iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const nd1 = normPdf(d1);
  const ePart_r = Math.exp(-r * T);
  const ePart_q = Math.exp(-q * T);

  const delta = cp === "call" ? ePart_q * Nd1 : ePart_q * (Nd1 - 1);
  const gamma = (ePart_q * nd1) / (S * sigma * sqrtT);
  const vegaPerOne = S * ePart_q * nd1 * sqrtT;   // per 1.0 (100% absolute change)
  const vega = vegaPerOne / 100;                  // per 1% — what traders read
  let theta;
  if (cp === "call") {
    theta = -((S * ePart_q * nd1 * sigma) / (2 * sqrtT))
      - r * K * ePart_r * Nd2
      + q * S * ePart_q * Nd1;
  } else {
    theta = -((S * ePart_q * nd1 * sigma) / (2 * sqrtT))
      + r * K * ePart_r * normCdf(-d2)
      - q * S * ePart_q * normCdf(-d1);
  }
  const thetaPerDay = theta / 365;

  return { iv: sigma, delta, gamma, theta: thetaPerDay, vega };
}
