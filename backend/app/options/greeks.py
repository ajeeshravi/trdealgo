"""Black-Scholes pricing and option Greeks."""
from __future__ import annotations

import math
from dataclasses import dataclass

from scipy.stats import norm


@dataclass(slots=True)
class Greeks:
    price: float
    delta: float
    gamma: float
    theta: float
    vega: float
    rho: float


def _d1_d2(S: float, K: float, t: float, r: float, sigma: float, q: float = 0.0):
    if t <= 0 or sigma <= 0:
        return float("nan"), float("nan")
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma**2) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    return d1, d2


def black_scholes(
    S: float, K: float, t: float, r: float, sigma: float,
    right: str = "call", q: float = 0.0,
) -> Greeks:
    """Greeks for a European option. ``t`` in years, ``r``/``q``/``sigma`` annualized."""
    d1, d2 = _d1_d2(S, K, t, r, sigma, q)
    if math.isnan(d1):
        intrinsic = max(0.0, (S - K) if right == "call" else (K - S))
        return Greeks(intrinsic, 0.0, 0.0, 0.0, 0.0, 0.0)

    disc_r = math.exp(-r * t)
    disc_q = math.exp(-q * t)
    pdf = norm.pdf(d1)
    if right == "call":
        price = S * disc_q * norm.cdf(d1) - K * disc_r * norm.cdf(d2)
        delta = disc_q * norm.cdf(d1)
        theta = (
            -S * disc_q * pdf * sigma / (2 * math.sqrt(t))
            - r * K * disc_r * norm.cdf(d2)
            + q * S * disc_q * norm.cdf(d1)
        )
        rho = K * t * disc_r * norm.cdf(d2)
    else:
        price = K * disc_r * norm.cdf(-d2) - S * disc_q * norm.cdf(-d1)
        delta = -disc_q * norm.cdf(-d1)
        theta = (
            -S * disc_q * pdf * sigma / (2 * math.sqrt(t))
            + r * K * disc_r * norm.cdf(-d2)
            - q * S * disc_q * norm.cdf(-d1)
        )
        rho = -K * t * disc_r * norm.cdf(-d2)

    gamma = disc_q * pdf / (S * sigma * math.sqrt(t))
    vega = S * disc_q * pdf * math.sqrt(t)
    return Greeks(price, delta, gamma, theta / 365.0, vega / 100.0, rho / 100.0)


def implied_volatility(
    market_price: float, S: float, K: float, t: float, r: float,
    right: str = "call", q: float = 0.0,
) -> float:
    """Newton-Raphson IV solver with bisection fallback."""
    sigma = 0.25
    for _ in range(100):
        g = black_scholes(S, K, t, r, sigma, right, q)
        diff = g.price - market_price
        vega = g.vega * 100.0
        if abs(diff) < 1e-5:
            return sigma
        if vega < 1e-8:
            break
        sigma = max(1e-4, sigma - diff / vega)
    # Bisection fallback
    lo, hi = 1e-4, 5.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if black_scholes(S, K, t, r, mid, right, q).price > market_price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2
