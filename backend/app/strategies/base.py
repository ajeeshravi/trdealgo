"""Plugin-based strategy framework.

A strategy is a self-contained unit with entry rules, exit rules, risk
parameters, and position-sizing rules. Strategies emit :class:`Signal` objects;
they never touch brokers directly — the trading engine consumes signals, applies
risk checks, and routes orders. This keeps strategies portable and broker-agnostic.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any

import pandas as pd

from app.brokers.models import AssetClass, OrderSide, OrderType


class SignalAction(str, Enum):
    ENTER_LONG = "enter_long"
    ENTER_SHORT = "enter_short"
    EXIT = "exit"
    HOLD = "hold"


@dataclass(slots=True)
class Signal:
    symbol: str
    action: SignalAction
    strength: float = 1.0  # 0..1, used for confidence-scaled sizing
    order_type: OrderType = OrderType.MARKET
    limit_price: Decimal | None = None
    asset_class: AssetClass = AssetClass.STOCK
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def side(self) -> OrderSide | None:
        if self.action is SignalAction.ENTER_LONG:
            return OrderSide.BUY
        if self.action is SignalAction.ENTER_SHORT:
            return OrderSide.SELL
        return None


@dataclass(slots=True)
class PositionSizing:
    """Position-sizing rules. Exactly one mode is applied."""

    mode: str = "fixed_fraction"  # fixed_fraction | fixed_qty | risk_per_trade | volatility
    fraction: Decimal = Decimal("0.1")     # of equity
    fixed_qty: Decimal | None = None
    risk_per_trade: Decimal = Decimal("0.01")  # fraction of equity risked to stop
    max_qty: Decimal | None = None

    def size(
        self, equity: Decimal, price: Decimal, stop_distance: Decimal | None = None
    ) -> Decimal:
        if self.mode == "fixed_qty" and self.fixed_qty:
            qty = self.fixed_qty
        elif self.mode == "risk_per_trade" and stop_distance and stop_distance > 0:
            risk_dollars = equity * self.risk_per_trade
            qty = (risk_dollars / stop_distance).quantize(Decimal("1"))
        else:  # fixed_fraction
            qty = ((equity * self.fraction) / price).quantize(Decimal("1"))
        if self.max_qty is not None:
            qty = min(qty, self.max_qty)
        return max(qty, Decimal(0))


@dataclass(slots=True)
class RiskParameters:
    stop_loss_pct: Decimal | None = None
    take_profit_pct: Decimal | None = None
    trailing_stop_pct: Decimal | None = None
    max_concurrent_positions: int = 5


@dataclass(slots=True)
class StrategyContext:
    """Everything a strategy needs to make a decision for one symbol."""

    symbol: str
    bars: pd.DataFrame  # columns: open, high, low, close, volume (indexed by ts)
    position_qty: Decimal = Decimal(0)
    equity: Decimal = Decimal(0)
    extras: dict[str, Any] = field(default_factory=dict)


class StrategyBase(abc.ABC):
    """Contract for every strategy plugin.

    Subclasses declare ``key`` (unique id) and ``param_schema`` (JSON schema for
    the dashboard) and implement :meth:`generate`.
    """

    key: str = "base"
    display_name: str = "Base Strategy"
    asset_classes: tuple[AssetClass, ...] = (AssetClass.STOCK, AssetClass.ETF)
    param_schema: dict[str, Any] = {}

    def __init__(
        self,
        params: dict[str, Any] | None = None,
        *,
        sizing: PositionSizing | None = None,
        risk: RiskParameters | None = None,
    ) -> None:
        self.params = params or {}
        self.sizing = sizing or PositionSizing()
        self.risk = risk or RiskParameters()

    @abc.abstractmethod
    def generate(self, ctx: StrategyContext) -> Signal:
        """Return a single Signal for the given context (entry/exit/hold)."""

    # Convenience hooks strategies can override.
    def on_start(self) -> None:  # noqa: D401 - lifecycle hook
        ...

    def on_stop(self) -> None:
        ...
