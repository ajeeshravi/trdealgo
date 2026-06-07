"""Paper-mode strategy-engine tick over synthetic bars (no vendor needed)."""
from __future__ import annotations

import pandas as pd

from app.services.strategy_engine import evaluate_paper_tick

# Entry always true (close > 0), exit never (close < 0).
ALWAYS_ENTER = {
    "entry": {"all": [{"type": "compare", "left": {"indicator": "close"}, "op": ">", "right": {"value": 0}}]},
    "exit": {"all": [{"type": "compare", "left": {"indicator": "close"}, "op": "<", "right": {"value": 0}}]},
}
# Exit always true (close > 0).
ALWAYS_EXIT = {
    "entry": {"all": [{"type": "compare", "left": {"indicator": "close"}, "op": "<", "right": {"value": 0}}]},
    "exit": {"all": [{"type": "compare", "left": {"indicator": "close"}, "op": ">", "right": {"value": 0}}]},
}


def _flat_bars(price: float = 100.0, n: int = 60) -> pd.DataFrame:
    idx = pd.date_range("2024-01-01", periods=n, freq="D")
    return pd.DataFrame(
        {"open": price, "high": price + 1, "low": price - 1, "close": price, "volume": 1_000_000},
        index=idx,
    )


def test_paper_entry_opens_position_and_logs_order():
    bars = _flat_bars(100.0)
    out = evaluate_paper_tick(ALWAYS_ENTER, None, "SPY", bars, capital=100_000)
    assert out["position"] is not None
    # fixed_fraction 0.1 of 100k at $100 → 100 shares
    assert out["position"]["qty"] == 100
    assert out["position"]["avg_price"] == 100.0
    assert any(log["kind"] == "order" and log["meta"].get("side") == "BUY" for log in out["logs"])
    assert out["realized_delta"] == 0.0


def test_paper_exit_realizes_pnl_and_flattens():
    bars = _flat_bars(110.0)
    out = evaluate_paper_tick(
        ALWAYS_EXIT, {"qty": 10, "avg_price": 100.0}, "SPY", bars, capital=100_000
    )
    assert out["position"] is None
    # (110 - 100) * 10 = 100
    assert out["realized_delta"] == 100.0
    assert any(log["kind"] == "order" and log["meta"].get("side") == "SELL" for log in out["logs"])


def test_no_signal_holds_flat():
    bars = _flat_bars(100.0)
    out = evaluate_paper_tick(ALWAYS_EXIT, None, "SPY", bars, capital=100_000)
    # entry is false (close < 0), so we stay flat with no orders.
    assert out["position"] is None
    assert out["logs"] == []
