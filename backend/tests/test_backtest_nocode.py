"""No-code evaluator + backtest runner over synthetic bars (no vendor needed)."""
from __future__ import annotations

import math

import pandas as pd

from app.backtesting.runner import summarize_backtest
from app.strategies.indicators import sma
from app.strategies.nocode import _eval_group


def _oscillating_bars(n: int = 400) -> pd.DataFrame:
    """A clean oscillating close series so MAs cross several times."""
    idx = pd.date_range("2024-01-01", periods=n, freq="D")
    closes = [100 + 15 * math.sin(2 * math.pi * i / 120) for i in range(n)]
    return pd.DataFrame(
        {
            "open": closes,
            "high": [c + 1 for c in closes],
            "low": [c - 1 for c in closes],
            "close": closes,
            "volume": [1_000_000] * n,
        },
        index=idx,
    )


EMA_CROSS_DEF = {
    "instrument_class": "EQUITY",
    "side": "LONG",
    "params": {"sizing": {"mode": "fixed_fraction", "fraction": 0.5}},
    "entry": {"all": [{"type": "ema_cross", "fast": 5, "slow": 20, "direction": "up"}]},
    "exit": {"all": [{"type": "ema_cross", "fast": 5, "slow": 20, "direction": "down"}]},
}


def test_summary_has_expected_shape_and_trades():
    bars = _oscillating_bars()
    summary = summarize_backtest(EMA_CROSS_DEF, capital=100_000, symbol="SPY", bars=bars)

    # Frontend-required keys are present.
    for key in ("total_pnl", "win_rate_pct", "sharpe", "max_drawdown_pct"):
        assert key in summary

    # The oscillating series must produce at least one completed trade.
    assert summary["num_trades"] >= 1
    assert summary["bars"] == len(bars)
    # JSON-safe: no NaN/inf leak through.
    for v in summary.values():
        assert v is None or isinstance(v, int | float)


def test_compare_condition_evaluates():
    bars = _oscillating_bars(60)
    # close vs its own SMA(10): at least one of >/< must hold on the last bar.
    last_close = float(bars["close"].iloc[-1])
    last_sma = float(sma(bars["close"], 10).iloc[-1])
    gt = _eval_group(
        bars,
        {"all": [{"type": "compare",
                  "left": {"indicator": "close"},
                  "op": ">",
                  "right": {"indicator": "sma", "params": {"period": 10}}}]},
    )
    assert gt == (last_close > last_sma)


def test_unknown_condition_never_triggers():
    bars = _oscillating_bars(60)
    assert _eval_group(bars, {"all": [{"type": "totally_unknown"}]}) is False


def test_empty_entry_group_does_not_enter():
    bars = _oscillating_bars(120)
    summary = summarize_backtest(
        {"entry": {}, "exit": {}}, capital=50_000, symbol="QQQ", bars=bars
    )
    assert summary["num_trades"] == 0
    assert summary["total_pnl"] == 0.0
