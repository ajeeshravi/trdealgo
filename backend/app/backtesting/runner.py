"""Backtest execution: turn a queued Backtest row into a persisted summary.

``summarize_backtest`` is a pure function (definition + bars → summary dict) so
it can be unit-tested with synthetic bars and no market-data vendor. The async
``run_backtest_for`` wraps it with DB I/O and vendor bar-fetching.
"""
from __future__ import annotations

import math
from datetime import datetime, time
from typing import Any

import pandas as pd

from app.backtesting import metrics
from app.backtesting.engine import BacktestConfig, Backtester
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.trading import Backtest, Strategy
from app.services.market_source import data_engine_for_user
from app.strategies.nocode import NoCodeStrategy

log = get_logger("backtest")


def _json_num(x: float | None) -> float | None:
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return float(x)


def summarize_backtest(
    definition: dict[str, Any],
    capital: float,
    symbol: str,
    bars: pd.DataFrame,
) -> dict:
    """Run a no-code backtest over ``bars`` and return the summary dict.

    Summary keys match what the frontend backtests page reads:
    ``total_pnl``, ``win_rate_pct``, ``sharpe``, ``max_drawdown_pct`` (+ extras).
    """
    initial = float(capital) if capital else 100_000.0
    warmup = min(200, max(20, len(bars) // 3))
    config = BacktestConfig(initial_capital=initial, warmup=warmup)
    strategy = NoCodeStrategy(definition)
    result = Backtester(strategy, config).run(symbol, bars)

    trade_pnls = [t.pnl for t in result.trades if t.pnl is not None]
    m = metrics.compute(result.equity_curve, trade_pnls)
    total_pnl = result.final_equity - initial

    return {
        "total_pnl": _json_num(total_pnl),
        "win_rate_pct": _json_num(m.win_rate * 100),
        "sharpe": _json_num(m.sharpe),
        "max_drawdown_pct": _json_num(m.max_drawdown * 100),
        "num_trades": m.num_trades,
        "total_return_pct": _json_num(m.total_return * 100),
        "profit_factor": _json_num(m.profit_factor),
        "final_equity": _json_num(result.final_equity),
        "initial_capital": _json_num(initial),
        "bars": int(len(bars)),
    }


def _bars_to_df(bars: list) -> pd.DataFrame:
    rows = [
        {
            "ts": b.ts,
            "open": float(b.open),
            "high": float(b.high),
            "low": float(b.low),
            "close": float(b.close),
            "volume": float(b.volume),
        }
        for b in bars
    ]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.set_index("ts").sort_index()


async def run_backtest_for(backtest_id: str) -> str:
    """Execute one queued backtest; persist COMPLETED/FAILED + summary."""
    async with SessionLocal() as db:
        bt = await db.get(Backtest, backtest_id)
        if bt is None:
            return "not_found"
        bt.status = "RUNNING"
        await db.commit()

        try:
            strategy = await db.get(Strategy, bt.strategy_id) if bt.strategy_id else None
            symbols = (strategy.symbols if strategy else None) or []
            if strategy is None or not symbols:
                raise ValueError("strategy has no symbols to backtest")
            symbol = symbols[0]

            engine = await data_engine_for_user(db, strategy.user_id)
            if engine is None:
                raise RuntimeError(
                    "No market-data source — connect an Alpaca account on the Brokers "
                    "page (its keys power backtests too)."
                )

            start = datetime.combine(bt.from_date, time.min)
            end = datetime.combine(bt.to_date, time.max)
            bars = await engine.get_bars(symbol, bt.timeframe, start, end)
            df = _bars_to_df(bars)
            if df.empty or len(df) < 30:
                raise ValueError(f"not enough bars for {symbol} in the requested range")

            capital = float(bt.capital or (strategy.capital if strategy else 0) or 0)
            summary = summarize_backtest(strategy.definition or {}, capital, symbol, df)
            bt.summary = summary
            bt.status = "COMPLETED"
            await db.commit()
            log.info("backtest.completed", backtest_id=backtest_id, symbol=symbol)
            return "completed"
        except Exception as exc:  # noqa: BLE001 - record the failure for the UI
            bt.summary = {"error": str(exc)[:500]}
            bt.status = "FAILED"
            await db.commit()
            log.warning("backtest.failed", backtest_id=backtest_id, error=str(exc))
            return "failed"
