"""Broker-agnostic domain models.

Strategies and the trading engine operate exclusively on these types. Each
broker adapter is responsible for translating to/from its native payloads
(anti-corruption layer), so swapping brokers never touches trading logic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum


class AssetClass(str, Enum):
    STOCK = "stock"
    ETF = "etf"
    FUTURE = "future"
    OPTION = "option"


class OrderSide(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"
    TRAILING_STOP = "trailing_stop"
    BRACKET = "bracket"
    OCO = "oco"


class TimeInForce(str, Enum):
    DAY = "day"
    GTC = "gtc"
    IOC = "ioc"
    FOK = "fok"


class OrderStatus(str, Enum):
    NEW = "new"
    PENDING = "pending"
    ACCEPTED = "accepted"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass(slots=True)
class OptionLeg:
    """A single leg of a multi-leg options/spread order."""

    symbol: str  # OCC symbol, e.g. AAPL250117C00190000
    side: OrderSide
    ratio: int = 1
    strike: Decimal | None = None
    expiry: str | None = None  # YYYY-MM-DD
    right: str | None = None   # "call" | "put"


@dataclass(slots=True)
class OrderRequest:
    """Normalized order request handed to a broker adapter."""

    symbol: str
    asset_class: AssetClass
    side: OrderSide
    qty: Decimal
    order_type: OrderType = OrderType.MARKET
    tif: TimeInForce = TimeInForce.DAY
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    trail_percent: Decimal | None = None
    # Bracket protective legs
    take_profit_price: Decimal | None = None
    stop_loss_price: Decimal | None = None
    # Multi-leg options
    legs: list[OptionLeg] = field(default_factory=list)
    client_order_id: str | None = None
    extended_hours: bool = False


@dataclass(slots=True)
class Order:
    """Order as reported by the broker."""

    id: str               # broker order id
    client_order_id: str | None
    symbol: str
    side: OrderSide
    order_type: OrderType
    qty: Decimal
    filled_qty: Decimal
    status: OrderStatus
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    avg_fill_price: Decimal | None = None
    submitted_at: datetime | None = None
    raw: dict | None = None


@dataclass(slots=True)
class Execution:
    order_id: str
    exec_id: str
    qty: Decimal
    price: Decimal
    fee: Decimal
    ts: datetime


@dataclass(slots=True)
class Position:
    symbol: str
    asset_class: AssetClass
    qty: Decimal
    avg_price: Decimal
    market_price: Decimal | None = None
    unrealized_pnl: Decimal | None = None
    realized_pnl: Decimal = Decimal(0)


@dataclass(slots=True)
class Margin:
    initial: Decimal | None = None
    maintenance: Decimal | None = None
    excess_liquidity: Decimal | None = None
    buying_power: Decimal | None = None


@dataclass(slots=True)
class Account:
    account_id: str
    cash: Decimal
    equity: Decimal
    buying_power: Decimal
    margin: Margin = field(default_factory=Margin)
    currency: str = "USD"
    pattern_day_trader: bool = False
    raw: dict | None = None
