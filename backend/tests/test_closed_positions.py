"""Closed-position reconstruction from filled orders."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.api.v1.endpoints.positions import closed_positions_from_orders
from app.brokers.models import OrderSide, OrderStatus


@dataclass
class FakeOrder:
    symbol: str
    side: OrderSide
    filled_qty: Decimal
    avg_fill_price: Decimal | None
    status: OrderStatus = OrderStatus.FILLED
    qty: Decimal = Decimal(0)


def test_fully_closed_roundtrip_realizes_pnl():
    orders = [
        FakeOrder("AAPL", OrderSide.BUY, Decimal(10), Decimal(100)),
        FakeOrder("AAPL", OrderSide.SELL, Decimal(10), Decimal(110)),
    ]
    closed = closed_positions_from_orders(orders)
    assert len(closed) == 1
    assert closed[0]["symbol"] == "AAPL"
    assert closed[0]["avg_price"] == 100.0
    assert closed[0]["realized_pnl"] == 100.0  # (110-100)*10


def test_partial_close_is_not_reported():
    orders = [
        FakeOrder("MSFT", OrderSide.BUY, Decimal(10), Decimal(200)),
        FakeOrder("MSFT", OrderSide.SELL, Decimal(4), Decimal(210)),
    ]
    assert closed_positions_from_orders(orders) == []


def test_non_filled_orders_ignored():
    orders = [
        FakeOrder("TSLA", OrderSide.BUY, Decimal(5), Decimal(250), status=OrderStatus.CANCELED),
        FakeOrder("TSLA", OrderSide.SELL, Decimal(5), Decimal(260), status=OrderStatus.CANCELED),
    ]
    assert closed_positions_from_orders(orders) == []
