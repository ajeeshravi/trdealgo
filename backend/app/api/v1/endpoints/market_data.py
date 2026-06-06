"""Market data endpoints (bars / quotes)."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends

from app.api.deps import CurrentUser, get_current_user
from app.core.config import settings
from app.market_data.engine import MarketDataEngine
from app.market_data.providers import AlpacaDataProvider, PolygonDataProvider

router = APIRouter(prefix="/market-data", tags=["market-data"])


def _engine() -> MarketDataEngine:
    provider = (
        PolygonDataProvider()
        if settings.POLYGON_API_KEY
        else AlpacaDataProvider()
    )
    return MarketDataEngine(provider)


@router.get("/bars")
async def get_bars(
    symbol: str,
    timeframe: str = "1d",
    start: datetime | None = None,
    end: datetime | None = None,
    current: CurrentUser = Depends(get_current_user),
):
    end = end or datetime.utcnow()
    start = start or (end - timedelta(days=365))
    bars = await _engine().get_bars(symbol, timeframe, start, end)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "bars": [
            {"ts": b.ts.isoformat(), "o": str(b.open), "h": str(b.high),
             "l": str(b.low), "c": str(b.close), "v": str(b.volume)}
            for b in bars
        ],
    }


@router.get("/quote")
async def get_quote(symbol: str, current: CurrentUser = Depends(get_current_user)):
    q = await _engine().latest_quote(symbol)
    return {"symbol": q.symbol, "bid": str(q.bid), "ask": str(q.ask),
            "ts": q.ts.isoformat()}
