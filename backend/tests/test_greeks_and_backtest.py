"""Tests for option greeks, IV utilities, and the backtester."""
import numpy as np
import pandas as pd

from app.backtesting.engine import Backtester, BacktestConfig
from app.backtesting.metrics import compute, monte_carlo
from app.options.greeks import black_scholes, implied_volatility
from app.options.iv import iv_percentile, iv_rank
from app.strategies.builtin import MomentumStrategy


def test_black_scholes_call_put_parity():
    S, K, t, r, sigma = 100, 100, 1.0, 0.05, 0.2
    call = black_scholes(S, K, t, r, sigma, "call").price
    put = black_scholes(S, K, t, r, sigma, "put").price
    # C - P = S - K e^{-rt}
    assert abs((call - put) - (S - K * np.exp(-r * t))) < 1e-6


def test_call_delta_bounds():
    g = black_scholes(100, 100, 0.5, 0.05, 0.25, "call")
    assert 0.0 < g.delta < 1.0
    assert g.gamma > 0


def test_implied_vol_roundtrip():
    true_sigma = 0.30
    price = black_scholes(100, 105, 0.5, 0.03, true_sigma, "call").price
    recovered = implied_volatility(price, 100, 105, 0.5, 0.03, "call")
    assert abs(recovered - true_sigma) < 1e-3


def test_iv_rank_percentile():
    hist = [10, 20, 30, 40, 50]
    assert iv_rank(30, hist) == 50.0
    assert iv_percentile(30, hist) == 40.0


def test_metrics_basic():
    curve = pd.Series(
        [100, 101, 102, 101, 103],
        index=pd.date_range("2024-01-01", periods=5, freq="D"),
    )
    m = compute(curve, [1, -0.5, 2])
    assert m.num_trades == 3
    assert 0 <= m.win_rate <= 1
    assert m.max_drawdown <= 0


def test_monte_carlo_shape():
    out = monte_carlo([1, 2, -1, 3, -2], n_sims=100)
    assert {"p5", "p50", "p95", "max_drawdown_p95"} <= out.keys()


def test_backtester_runs():
    # Trending series so momentum produces at least one trade.
    n = 300
    prices = np.linspace(100, 200, n) + np.random.default_rng(0).normal(0, 1, n)
    df = pd.DataFrame(
        {"open": prices, "high": prices + 1, "low": prices - 1,
         "close": prices, "volume": 1_000_000},
        index=pd.date_range("2023-01-01", periods=n, freq="D"),
    )
    bt = Backtester(MomentumStrategy(), BacktestConfig(warmup=60))
    result = bt.run("TEST", df)
    assert len(result.equity_curve) > 0
    assert result.final_equity > 0
