"""Live/paper strategy engine.

A periodic tick evaluates each active StrategyRun's no-code definition against
recent bars and, in **paper** mode, simulates fills + records logs + updates
run P&L. The signal logic is shared with the backtester (``NoCodeStrategy``) so
a strategy behaves identically in backtest, paper and (future) live.

``evaluate_paper_tick`` is pure (definition + position + bars → decision) so it
can be unit-tested with synthetic bars and no market-data vendor.

Live (real-broker) order routing is intentionally NOT enabled here: a non-paper
run logs its signals but does not place real orders until a broker session +
live feed are wired in. This keeps the engine safe to run without a broker.
"""
from __future__ import annotations

from datetime import UTC
from decimal import Decimal
from typing import Any

import pandas as pd

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.market_data.engine import MarketDataEngine
from app.market_data.providers import AlpacaDataProvider, PolygonDataProvider
from app.strategies.base import SignalAction, StrategyContext
from app.strategies.nocode import NoCodeStrategy

log = get_logger("strategy_engine")

ACTIVE_STATUSES = ("LIVE", "PAPER")


def evaluate_paper_tick(
    definition: dict[str, Any],
    position: dict[str, Any] | None,
    symbol: str,
    bars: pd.DataFrame,
    capital: float,
) -> dict[str, Any]:
    """Evaluate the latest bar and update a single paper position.

    Returns ``{"position", "logs", "realized_delta", "last_price"}`` where
    ``position`` is ``{"qty", "avg_price"}`` or ``None`` (flat).
    """
    logs: list[dict] = []
    realized_delta = 0.0
    if bars is None or len(bars) == 0:
        return {"position": position, "logs": logs, "realized_delta": 0.0, "last_price": None}

    last_price = float(bars["close"].iloc[-1])
    qty = float(position["qty"]) if position else 0.0
    avg_price = float(position["avg_price"]) if position else 0.0

    strategy = NoCodeStrategy(definition)
    ctx = StrategyContext(
        symbol=symbol,
        bars=bars,
        position_qty=Decimal(str(qty)),
        equity=Decimal(str(capital)),
    )
    sig = strategy.generate(ctx)

    if sig.action is SignalAction.ENTER_LONG and qty == 0:
        size = strategy.sizing.size(Decimal(str(capital)), Decimal(str(last_price)))
        new_qty = float(size)
        if new_qty > 0:
            position = {"qty": new_qty, "avg_price": last_price}
            logs.append({"kind": "signal", "level": "info", "internal_symbol": symbol,
                         "message": f"ENTER_LONG {symbol} @ {last_price:.2f}", "meta": {}})
            logs.append({"kind": "order", "level": "info", "internal_symbol": symbol,
                         "message": f"paper BUY {new_qty:g} {symbol} @ {last_price:.2f}",
                         "meta": {"side": "BUY", "qty": new_qty, "price": last_price}})
    elif sig.action is SignalAction.EXIT and qty > 0:
        realized_delta = (last_price - avg_price) * qty
        logs.append({"kind": "signal", "level": "info", "internal_symbol": symbol,
                     "message": f"EXIT {symbol} @ {last_price:.2f}", "meta": {}})
        logs.append({"kind": "order", "level": "info", "internal_symbol": symbol,
                     "message": f"paper SELL {qty:g} {symbol} @ {last_price:.2f} "
                                f"(realized {realized_delta:+.2f})",
                     "meta": {"side": "SELL", "qty": qty, "price": last_price,
                              "realized": realized_delta}})
        position = None

    return {"position": position, "logs": logs, "realized_delta": realized_delta,
            "last_price": last_price}


def _engine() -> MarketDataEngine:
    provider = PolygonDataProvider() if settings.POLYGON_API_KEY else AlpacaDataProvider()
    return MarketDataEngine(provider)


def _vendor_configured() -> bool:
    return bool(settings.POLYGON_API_KEY or settings.ALPACA_API_KEY)


def _bars_to_df(bars: list) -> pd.DataFrame:
    rows = [
        {"ts": b.ts, "open": float(b.open), "high": float(b.high), "low": float(b.low),
         "close": float(b.close), "volume": float(b.volume)}
        for b in bars
    ]
    df = pd.DataFrame(rows)
    return df.set_index("ts").sort_index() if not df.empty else df


async def tick_all() -> str:
    """One engine cycle over every active run. Returns a short status string."""
    from datetime import datetime, timedelta

    from sqlalchemy import select

    from app.models.trading import Strategy, StrategyLog, StrategyRun

    if not _vendor_configured():
        log.info("strategy_engine.skip", reason="no market-data vendor configured")
        return "no_vendor"

    async with SessionLocal() as db:
        runs = (
            await db.execute(
                select(StrategyRun).where(StrategyRun.status.in_(ACTIVE_STATUSES))
            )
        ).scalars().all()
        if not runs:
            return "no_active_runs"

        engine = _engine()
        ticked = 0
        for run in runs:
            strategy = await db.get(Strategy, run.strategy_id)
            if strategy is None or not strategy.symbols:
                continue
            capital = float(strategy.capital or 0) or 100_000.0
            state = dict(run.state or {})
            positions = dict(state.get("positions") or {})

            if not run.is_paper:
                # Live routing requires a connected broker session + live feed,
                # which isn't enabled yet — record the gap once per tick and skip.
                db.add(StrategyLog(
                    strategy_id=strategy.id, run_id=str(run.id), kind="run", level="warn",
                    message="Live order routing is not enabled — connect a broker or use a "
                            "paper run. Signals are not being placed as real orders.",
                ))
                continue

            end = datetime.now(UTC)
            start = end - timedelta(days=30)
            realized_delta_total = 0.0
            unrealized = 0.0
            for symbol in strategy.symbols:
                try:
                    bars = await engine.get_bars(symbol, "1d", start, end)
                except Exception as exc:  # noqa: BLE001
                    db.add(StrategyLog(
                        strategy_id=strategy.id, run_id=str(run.id), kind="run", level="error",
                        internal_symbol=symbol, message=f"bar fetch failed: {exc}"))
                    continue
                df = _bars_to_df(bars)
                if df.empty:
                    continue
                result = evaluate_paper_tick(
                    strategy.definition or {}, positions.get(symbol), symbol, df, capital)
                positions[symbol] = result["position"] if result["position"] else None
                if positions[symbol] is None:
                    positions.pop(symbol, None)
                realized_delta_total += result["realized_delta"]
                for entry in result["logs"]:
                    db.add(StrategyLog(strategy_id=strategy.id, run_id=str(run.id), **entry))
                # mark-to-market open position
                pos = positions.get(symbol)
                if pos and result["last_price"] is not None:
                    unrealized += (result["last_price"] - pos["avg_price"]) * pos["qty"]

            state["positions"] = positions
            run.state = state
            run.realized_pnl = (run.realized_pnl or Decimal(0)) + Decimal(str(realized_delta_total))
            run.pnl = run.realized_pnl + Decimal(str(unrealized))
            ticked += 1

        await db.commit()
        return f"ticked={ticked}"
