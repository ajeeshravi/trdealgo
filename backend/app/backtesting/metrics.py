"""Performance metrics for backtests and live analytics."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(slots=True)
class PerformanceMetrics:
    total_return: float
    cagr: float
    sharpe: float
    sortino: float
    max_drawdown: float
    win_rate: float
    profit_factor: float
    num_trades: int


def _annualization_factor(index: pd.DatetimeIndex) -> float:
    if len(index) < 2:
        return 252.0
    avg_sec = (index[-1] - index[0]).total_seconds() / max(len(index) - 1, 1)
    if avg_sec <= 0:
        return 252.0
    per_year = (365 * 24 * 3600) / avg_sec
    return min(per_year, 252.0)


def compute(equity_curve: pd.Series, trade_pnls: list[float]) -> PerformanceMetrics:
    """equity_curve indexed by timestamp; trade_pnls = realized P&L per closed trade."""
    eq = equity_curve.dropna()
    if len(eq) < 2:
        return PerformanceMetrics(0, 0, 0, 0, 0, 0, 0, len(trade_pnls))

    returns = eq.pct_change().dropna()
    ann = _annualization_factor(eq.index)
    total_return = float(eq.iloc[-1] / eq.iloc[0] - 1)
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    cagr = float((eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1)

    std = returns.std()
    sharpe = float(returns.mean() / std * np.sqrt(ann)) if std > 0 else 0.0
    downside = returns[returns < 0].std()
    sortino = float(returns.mean() / downside * np.sqrt(ann)) if downside > 0 else 0.0

    running_max = eq.cummax()
    drawdown = (eq - running_max) / running_max
    max_dd = float(drawdown.min())

    wins = [p for p in trade_pnls if p > 0]
    losses = [p for p in trade_pnls if p < 0]
    win_rate = len(wins) / len(trade_pnls) if trade_pnls else 0.0
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = float(gross_win / gross_loss) if gross_loss > 0 else float("inf") if gross_win else 0.0

    return PerformanceMetrics(
        total_return=total_return, cagr=cagr, sharpe=sharpe, sortino=sortino,
        max_drawdown=max_dd, win_rate=win_rate, profit_factor=profit_factor,
        num_trades=len(trade_pnls),
    )


def monte_carlo(trade_pnls: list[float], n_sims: int = 1000, seed: int = 42) -> dict:
    """Bootstrap trade order to estimate the distribution of terminal P&L / drawdown."""
    if not trade_pnls:
        return {"p5": 0.0, "p50": 0.0, "p95": 0.0, "max_drawdown_p95": 0.0}
    rng = np.random.default_rng(seed)
    arr = np.array(trade_pnls)
    terminals, drawdowns = [], []
    for _ in range(n_sims):
        shuffled = rng.permutation(arr)
        curve = np.cumsum(shuffled)
        terminals.append(curve[-1])
        peak = np.maximum.accumulate(curve)
        drawdowns.append(float(np.min(curve - peak)))
    return {
        "p5": float(np.percentile(terminals, 5)),
        "p50": float(np.percentile(terminals, 50)),
        "p95": float(np.percentile(terminals, 95)),
        "max_drawdown_p95": float(np.percentile(drawdowns, 5)),
    }
