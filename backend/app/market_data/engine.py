"""Market data engine: caching, normalization, fan-out to Redis pub/sub.

The engine is the single ingestion point. It caches the latest quote/bar in
Redis (hot path), publishes normalized updates to ``md.quotes.{symbol}``, and
provides a replay capability for backtests/sims.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import datetime

from app.core.logging import get_logger
from app.core.redis import get_redis
from app.market_data.base import Bar, MarketDataProvider, Quote

log = get_logger("market_data.engine")

_QUOTE_TTL = 30  # seconds


class MarketDataEngine:
    def __init__(self, provider: MarketDataProvider) -> None:
        self.provider = provider

    async def latest_quote(self, symbol: str) -> Quote:
        r = get_redis()
        cached = await r.get(f"md:quote:{symbol}")
        if cached:
            d = json.loads(cached)
            return Quote(symbol, datetime.fromisoformat(d["ts"]),
                         bid=d["bid"], ask=d["ask"])
        quote = await self.provider.get_latest_quote(symbol)
        await self._cache_quote(quote)
        return quote

    async def _cache_quote(self, q: Quote) -> None:
        await get_redis().set(
            f"md:quote:{q.symbol}",
            json.dumps({"ts": q.ts.isoformat(), "bid": str(q.bid), "ask": str(q.ask)}),
            ex=_QUOTE_TTL,
        )

    async def get_bars(self, symbol, timeframe, start, end) -> list[Bar]:
        return await self.provider.get_bars(symbol, timeframe, start, end)

    async def run_stream(self, symbols: list[str]) -> None:
        """Background task: stream quotes → cache + publish to Redis."""
        r = get_redis()
        async for q in self.provider.stream_quotes(symbols):
            await self._cache_quote(q)
            await r.publish(
                f"md.quotes.{q.symbol}",
                json.dumps({"symbol": q.symbol, "bid": str(q.bid),
                            "ask": str(q.ask), "ts": q.ts.isoformat()}),
            )

    async def replay(self, bars: list[Bar]) -> AsyncIterator[Bar]:
        """Deterministic replay of historical bars for sim/backtest parity."""
        for bar in sorted(bars, key=lambda b: b.ts):
            yield bar
