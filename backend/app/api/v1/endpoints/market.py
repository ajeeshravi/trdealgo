"""Live market endpoints used by the dashboard and feed.

`snapshot` is the dashboard's one-call price source: for each symbol it tries
to resolve a last price + previous close + the day's OHLC. Market data is
sourced from the user's connected Alpaca account (credentials entered in the
frontend), with an optional env vendor fallback. When no data source is
available every row degrades to nulls with ``source: "none"`` so the UI renders
a calm "—" instead of throwing.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, get_current_user, require_roles
from app.core.database import get_db
from app.core.logging import get_logger
from app.market_data.engine import MarketDataEngine
from app.services.market_source import data_engine_for_user

router = APIRouter(prefix="/market", tags=["market"])
log = get_logger("market")


_EMPTY_ROW = {
    "ltp": None,
    "prev_close": None,
    "open": None,
    "high": None,
    "low": None,
    "source": "none",
}


async def _snapshot_one(engine: MarketDataEngine, symbol: str) -> dict:
    """Resolve one symbol's snapshot from recent daily bars.

    Latest bar → ltp (close) + open/high/low; the bar before it → prev_close.
    Any failure (no vendor key, unknown symbol, network) yields an empty row.
    """
    try:
        end = datetime.utcnow()
        start = end - timedelta(days=10)
        bars = await engine.get_bars(symbol, "1d", start, end)
        if not bars:
            return dict(_EMPTY_ROW)
        last = bars[-1]
        prev = bars[-2] if len(bars) >= 2 else None
        return {
            "ltp": float(last.close),
            "prev_close": float(prev.close) if prev else None,
            "open": float(last.open),
            "high": float(last.high),
            "low": float(last.low),
            "source": "eod",
        }
    except Exception as exc:  # noqa: BLE001 - degrade gracefully per symbol
        log.debug("snapshot.symbol_failed", symbol=symbol, error=str(exc))
        return dict(_EMPTY_ROW)


@router.get("/snapshot")
async def snapshot(
    symbols: str,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    if not syms:
        return {}
    engine = await data_engine_for_user(db, current.user.id)
    if engine is None:
        # No data source — return empty rows so the UI shows "—" calmly.
        return {s: dict(_EMPTY_ROW) for s in syms}
    rows = await asyncio.gather(*(_snapshot_one(engine, s) for s in syms))
    return dict(zip(syms, rows, strict=False))


@router.get("/ltp")
async def ltp(
    symbols: str,
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    snap = await snapshot(symbols, current, db)
    return {sym: row["ltp"] for sym, row in snap.items()}


@router.get("/feed-status")
async def feed_status(
    current: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    engine = await data_engine_for_user(db, current.user.id)
    return {
        "connected": engine is not None,
        "vendor": "alpaca" if engine is not None else None,
        "subscribed": [],
    }


class SubscribeRequest(BaseModel):
    symbols: list[str] = []


@router.post("/subscribe")
async def subscribe(
    body: SubscribeRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    # Subscription is managed by the live streaming worker; acknowledge here.
    return {"ok": True, "symbols": body.symbols}


@router.post("/unsubscribe")
async def unsubscribe(
    body: SubscribeRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    return {"ok": True, "symbols": body.symbols}
