"""Event-driven backtesting engine.

Replays historical bars, invokes a strategy per bar, simulates fills with simple
slippage/commission, and produces an equity curve + trade list + metrics. The
same :class:`StrategyBase` plugins used live run here unchanged. Supports
walk-forward and Monte Carlo via :mod:`app.backtesting.metrics`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

import pandas as pd

from app.strategies.base import SignalAction, StrategyBase, StrategyContext


@dataclass(slots=True)
class BacktestTrade:
    symbol: str
    side: str
    qty: float
    entry_ts: datetime
    entry_price: float
    exit_ts: datetime | None = None
    exit_price: float | None = None
    pnl: float | None = None


@dataclass(slots=True)
class BacktestResult:
    equity_curve: pd.Series
    trades: list[BacktestTrade]
    final_equity: float


@dataclass(slots=True)
class BacktestConfig:
    initial_capital: float = 100_000.0
    commission_per_share: float = 0.005
    slippage_bps: float = 1.0  # 1 basis point
    warmup: int = 200


@dataclass(slots=True)
class Backtester:
    strategy: StrategyBase
    config: BacktestConfig = field(default_factory=BacktestConfig)

    def run(self, symbol: str, bars: pd.DataFrame) -> BacktestResult:
        """bars: DataFrame indexed by ts with open/high/low/close/volume."""
        cash = Decimal(str(self.config.initial_capital))
        position_qty = Decimal(0)
        entry_price = Decimal(0)
        trades: list[BacktestTrade] = []
        equity_points: list[tuple[datetime, float]] = []
        slip = Decimal(str(self.config.slippage_bps)) / Decimal(10000)
        comm = Decimal(str(self.config.commission_per_share))

        self.strategy.on_start()
        for i in range(self.config.warmup, len(bars)):
            window = bars.iloc[: i + 1]
            ts = window.index[-1]
            price = Decimal(str(window["close"].iloc[-1]))
            equity = cash + position_qty * price

            ctx = StrategyContext(
                symbol=symbol, bars=window, position_qty=position_qty, equity=equity
            )
            sig = self.strategy.generate(ctx)

            if sig.action is SignalAction.ENTER_LONG and position_qty == 0:
                fill = price * (1 + slip)
                qty = self.strategy.sizing.size(equity, fill)
                if qty > 0 and qty * fill <= cash:
                    cash -= qty * fill + qty * comm
                    position_qty, entry_price = qty, fill
                    trades.append(BacktestTrade(symbol, "long", float(qty), ts, float(fill)))
            elif sig.action is SignalAction.EXIT and position_qty > 0:
                fill = price * (1 - slip)
                cash += position_qty * fill - position_qty * comm
                pnl = float((fill - entry_price) * position_qty)
                t = trades[-1]
                t.exit_ts, t.exit_price, t.pnl = ts, float(fill), pnl
                position_qty, entry_price = Decimal(0), Decimal(0)

            equity_points.append((ts, float(cash + position_qty * price)))

        self.strategy.on_stop()
        curve = pd.Series(
            [e for _, e in equity_points],
            index=pd.DatetimeIndex([t for t, _ in equity_points]),
        )
        return BacktestResult(curve, trades, float(curve.iloc[-1]) if len(curve) else self.config.initial_capital)


def walk_forward(
    strategy_factory, symbol: str, bars: pd.DataFrame,
    train: int = 252, test: int = 63,
) -> list[BacktestResult]:
    """Rolling out-of-sample evaluation. ``strategy_factory`` returns a fresh
    strategy (optionally re-optimized on the train window)."""
    results: list[BacktestResult] = []
    start = 0
    while start + train + test <= len(bars):
        test_slice = bars.iloc[start: start + train + test]
        bt = Backtester(strategy_factory(bars.iloc[start: start + train]))
        bt.config.warmup = min(bt.config.warmup, train - 1)
        results.append(bt.run(symbol, test_slice))
        start += test
    return results
