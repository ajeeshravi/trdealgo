"""Concrete market data providers: Alpaca and Polygon (REST + WS)."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import datetime
from decimal import Decimal

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.market_data.base import Bar, MarketDataProvider, Quote

log = get_logger("market_data")

_TF_ALPACA = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour", "1d": "1Day"}


class AlpacaDataProvider(MarketDataProvider):
    name = "alpaca"

    def __init__(self, api_key: str | None = None, api_secret: str | None = None) -> None:
        self._headers = {
            "APCA-API-KEY-ID": api_key or settings.ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": api_secret or settings.ALPACA_API_SECRET,
        }

    async def get_bars(self, symbol, timeframe, start, end) -> list[Bar]:
        async with httpx.AsyncClient(
            base_url=settings.ALPACA_DATA_URL, headers=self._headers, timeout=15.0
        ) as c:
            r = await c.get(
                f"/v2/stocks/{symbol}/bars",
                params={
                    "timeframe": _TF_ALPACA.get(timeframe, "1Day"),
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "limit": 10000,
                    "feed": settings.ALPACA_DATA_FEED,
                },
            )
            r.raise_for_status()
            return [
                Bar(
                    symbol=symbol,
                    ts=datetime.fromisoformat(b["t"].replace("Z", "+00:00")),
                    timeframe=timeframe,
                    open=Decimal(str(b["o"])),
                    high=Decimal(str(b["h"])),
                    low=Decimal(str(b["l"])),
                    close=Decimal(str(b["c"])),
                    volume=Decimal(str(b["v"])),
                    vwap=Decimal(str(b.get("vw", 0))),
                )
                for b in r.json().get("bars", [])
            ]

    async def get_latest_quote(self, symbol) -> Quote:
        async with httpx.AsyncClient(
            base_url=settings.ALPACA_DATA_URL, headers=self._headers, timeout=10.0
        ) as c:
            r = await c.get(
                f"/v2/stocks/{symbol}/quotes/latest",
                params={"feed": settings.ALPACA_DATA_FEED},
            )
            r.raise_for_status()
            q = r.json()["quote"]
            return Quote(
                symbol=symbol,
                ts=datetime.fromisoformat(q["t"].replace("Z", "+00:00")),
                bid=Decimal(str(q["bp"])),
                ask=Decimal(str(q["ap"])),
                bid_size=Decimal(str(q["bs"])),
                ask_size=Decimal(str(q["as"])),
            )

    async def stream_quotes(self, symbols) -> AsyncIterator[Quote]:
        import websockets

        url = "wss://stream.data.alpaca.markets/v2/iex"
        async for ws in websockets.connect(url):
            try:
                await ws.send(json.dumps({
                    "action": "auth",
                    "key": self._headers["APCA-API-KEY-ID"],
                    "secret": self._headers["APCA-API-SECRET-KEY"],
                }))
                await ws.send(json.dumps({"action": "subscribe", "quotes": symbols}))
                async for raw in ws:
                    for m in json.loads(raw):
                        if m.get("T") == "q":
                            yield Quote(
                                symbol=m["S"],
                                ts=datetime.fromisoformat(m["t"].replace("Z", "+00:00")),
                                bid=Decimal(str(m["bp"])),
                                ask=Decimal(str(m["ap"])),
                            )
            except Exception as exc:  # noqa: BLE001 - reconnect via outer loop
                log.warning("alpaca.data.reconnect", error=str(exc))
                continue


class PolygonDataProvider(MarketDataProvider):
    name = "polygon"

    def __init__(self, api_key: str | None = None) -> None:
        self._key = api_key or settings.POLYGON_API_KEY

    async def get_bars(self, symbol, timeframe, start, end) -> list[Bar]:
        mult, span = {"1m": (1, "minute"), "5m": (5, "minute"), "1h": (1, "hour"),
                      "1d": (1, "day")}.get(timeframe, (1, "day"))
        url = (f"https://api.polygon.io/v2/aggs/ticker/{symbol}/range/"
               f"{mult}/{span}/{start:%Y-%m-%d}/{end:%Y-%m-%d}")
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(url, params={"apiKey": self._key, "limit": 50000})
            r.raise_for_status()
            return [
                Bar(
                    symbol=symbol,
                    ts=datetime.utcfromtimestamp(b["t"] / 1000),
                    timeframe=timeframe,
                    open=Decimal(str(b["o"])), high=Decimal(str(b["h"])),
                    low=Decimal(str(b["l"])), close=Decimal(str(b["c"])),
                    volume=Decimal(str(b["v"])), vwap=Decimal(str(b.get("vw", 0))),
                )
                for b in r.json().get("results", [])
            ]

    async def get_latest_quote(self, symbol) -> Quote:
        url = f"https://api.polygon.io/v2/last/nbbo/{symbol}"
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(url, params={"apiKey": self._key})
            r.raise_for_status()
            res = r.json()["results"]
            return Quote(symbol=symbol, ts=datetime.utcnow(),
                         bid=Decimal(str(res["P"])), ask=Decimal(str(res["p"])))

    async def stream_quotes(self, symbols) -> AsyncIterator[Quote]:  # pragma: no cover
        raise NotImplementedError("polygon ws streaming omitted in scaffold")
