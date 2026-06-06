"""Market data provider interface + normalized data models.

Providers (Polygon, Alpaca, IBKR, Databento) implement this interface; the rest
of the system consumes normalized :class:`Bar`/:class:`Quote`/:class:`Trade`
regardless of source.
"""
from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal


@dataclass(slots=True)
class Bar:
    symbol: str
    ts: datetime
    timeframe: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    vwap: Decimal | None = None


@dataclass(slots=True)
class Quote:
    symbol: str
    ts: datetime
    bid: Decimal
    ask: Decimal
    bid_size: Decimal = Decimal(0)
    ask_size: Decimal = Decimal(0)


@dataclass(slots=True)
class Trade:
    symbol: str
    ts: datetime
    price: Decimal
    size: Decimal


class MarketDataProvider(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    async def get_bars(
        self, symbol: str, timeframe: str, start: datetime, end: datetime
    ) -> list[Bar]:
        ...

    @abc.abstractmethod
    async def get_latest_quote(self, symbol: str) -> Quote:
        ...

    @abc.abstractmethod
    def stream_quotes(self, symbols: list[str]) -> AsyncIterator[Quote]:
        ...

    def stream_bars(self, symbols: list[str], timeframe: str) -> AsyncIterator[Bar]:
        raise NotImplementedError
