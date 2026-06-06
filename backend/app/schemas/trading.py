"""Trading & risk Pydantic schemas."""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, Field

from app.brokers.models import (
    AssetClass,
    OrderSide,
    OrderType,
    TimeInForce,
)


class ProtectiveLeg(BaseModel):
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None


class PlaceOrderRequest(BaseModel):
    account_id: str
    symbol: str
    asset_class: AssetClass = AssetClass.STOCK
    side: OrderSide
    qty: Decimal = Field(gt=0)
    order_type: OrderType = OrderType.MARKET
    tif: TimeInForce = TimeInForce.DAY
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    trail_percent: Decimal | None = None
    take_profit: ProtectiveLeg | None = None
    stop_loss: ProtectiveLeg | None = None
    strategy_instance_id: str | None = None


class OrderOut(BaseModel):
    id: str
    symbol: str
    side: str
    order_type: str
    qty: Decimal
    filled_qty: Decimal
    status: str
    avg_fill_price: Decimal | None = None


class RiskProfileSchema(BaseModel):
    daily_loss_limit: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    max_exposure: Decimal | None = None
    max_position_size: Decimal | None = None
    max_position_pct: Decimal | None = None


class KillSwitchRequest(BaseModel):
    scope: str = "global"  # "global" or an account id
    active: bool
    reason: str = ""
