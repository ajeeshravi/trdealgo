"""Live market endpoints used by the dashboard and feed.

`snapshot` is the dashboard's one-call price source: for each symbol it tries
to resolve a last price + previous close + the day's OHLC. It is sourced from
the configured market-data vendor (Polygon if a key is set, else Alpaca). When
no vendor credentials are configured every row degrades to nulls with
``source: "none"`` so the UI renders a calm "—" instead of throwing.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user, require_roles
from app.core.config import settings
from app.core.logging import get_logger
from app.market_data.engine import MarketDataEngine
from app.market_data.providers import AlpacaDataProvider, PolygonDataProvider

router = APIRouter(prefix="/market", tags=["market"])
log = get_logger("market")


def _engine() -> MarketDataEngine:
    provider = (
        PolygonDataProvider() if settings.POLYGON_API_KEY else AlpacaDataProvider()
    )
    return MarketDataEngine(provider)


def _vendor_configured() -> bool:
    return bool(settings.POLYGON_API_KEY or settings.ALPACA_API_KEY)


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
):
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    if not syms:
        return {}
    if not _vendor_configured():
        # No data vendor — return empty rows so the UI shows "—" calmly.
        return {s: dict(_EMPTY_ROW) for s in syms}
    engine = _engine()
    rows = await asyncio.gather(*(_snapshot_one(engine, s) for s in syms))
    return dict(zip(syms, rows, strict=False))


@router.get("/ltp")
async def ltp(symbols: str, current: CurrentUser = Depends(get_current_user)):
    snap = await snapshot(symbols, current)  # type: ignore[arg-type]
    return {sym: row["ltp"] for sym, row in snap.items()}


@router.get("/feed-status")
async def feed_status(current: CurrentUser = Depends(get_current_user)):
    return {
        "connected": _vendor_configured(),
        "vendor": "polygon"
        if settings.POLYGON_API_KEY
        else ("alpaca" if settings.ALPACA_API_KEY else None),
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
