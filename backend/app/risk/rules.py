"""Pre-trade risk rules (chain of responsibility).

Each rule inspects a proposed order against the current account context and
returns a :class:`RiskDecision`. The engine stops at the first hard ``reject``.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum

from app.brokers.models import Account, OrderRequest, OrderSide, Position


class Verdict(str, Enum):
    ALLOW = "allow"
    WARN = "warn"
    REJECT = "reject"


@dataclass(slots=True)
class RiskContext:
    account: Account
    positions: list[Position]
    risk_profile: RiskProfile
    realized_pnl_today: Decimal = Decimal(0)
    peak_equity: Decimal | None = None
    kill_switch_active: bool = False
    broker_connected: bool = True
    halted_symbols: set[str] = field(default_factory=set)
    reference_price: Decimal | None = None  # last/quote for the order symbol


@dataclass(slots=True)
class RiskProfile:
    daily_loss_limit: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    max_exposure: Decimal | None = None
    max_position_size: Decimal | None = None
    max_position_pct: Decimal | None = None


@dataclass(slots=True)
class RiskDecision:
    verdict: Verdict
    rule: str
    reason: str = ""

    @property
    def allowed(self) -> bool:
        return self.verdict is not Verdict.REJECT


class RiskRule(abc.ABC):
    name: str = "rule"

    @abc.abstractmethod
    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        ...

    def _ok(self) -> RiskDecision:
        return RiskDecision(Verdict.ALLOW, self.name)

    def _reject(self, reason: str) -> RiskDecision:
        return RiskDecision(Verdict.REJECT, self.name, reason)


def _order_notional(order: OrderRequest, ctx: RiskContext) -> Decimal:
    price = order.limit_price or ctx.reference_price or Decimal(0)
    return abs(order.qty) * price


class KillSwitchRule(RiskRule):
    name = "kill_switch"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        if ctx.kill_switch_active:
            return self._reject("kill switch active: new orders blocked")
        return self._ok()


class BrokerConnectedRule(RiskRule):
    name = "broker_connected"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        if not ctx.broker_connected:
            return self._reject("broker disconnected: order routing frozen")
        return self._ok()


class MarketHaltRule(RiskRule):
    name = "market_halt"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        if order.symbol in ctx.halted_symbols:
            return self._reject(f"{order.symbol} is halted")
        return self._ok()


class OrderSanityRule(RiskRule):
    name = "order_sanity"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        if order.qty <= 0:
            return self._reject("quantity must be positive")
        if order.order_type.value in ("limit", "stop_limit") and not order.limit_price:
            return self._reject("limit order missing limit price")
        return self._ok()


class DailyLossLimitRule(RiskRule):
    name = "daily_loss_limit"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        limit = ctx.risk_profile.daily_loss_limit
        if limit is not None and ctx.realized_pnl_today <= -abs(limit):
            return self._reject(
                f"daily loss limit hit ({ctx.realized_pnl_today} <= -{limit})"
            )
        return self._ok()


class MaxDrawdownRule(RiskRule):
    name = "max_drawdown"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        pct = ctx.risk_profile.max_drawdown_pct
        if pct is not None and ctx.peak_equity and ctx.peak_equity > 0:
            dd = (ctx.peak_equity - ctx.account.equity) / ctx.peak_equity
            if dd >= pct:
                return self._reject(f"max drawdown breached ({dd:.2%} >= {pct:.2%})")
        return self._ok()


class MaxPositionSizeRule(RiskRule):
    name = "max_position_size"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        notional = _order_notional(order, ctx)
        prof = ctx.risk_profile
        if prof.max_position_size is not None and notional > prof.max_position_size:
            return self._reject(
                f"position size {notional} exceeds max {prof.max_position_size}"
            )
        if prof.max_position_pct is not None and ctx.account.equity > 0:
            pct = notional / ctx.account.equity
            if pct > prof.max_position_pct:
                return self._reject(
                    f"position {pct:.2%} of equity exceeds max {prof.max_position_pct:.2%}"
                )
        return self._ok()


class MaxExposureRule(RiskRule):
    name = "max_exposure"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        prof = ctx.risk_profile
        if prof.max_exposure is None:
            return self._ok()
        gross = sum(
            (abs(p.qty) * (p.market_price or p.avg_price) for p in ctx.positions),
            Decimal(0),
        )
        if order.side is OrderSide.BUY:
            gross += _order_notional(order, ctx)
        if gross > prof.max_exposure:
            return self._reject(f"gross exposure {gross} exceeds max {prof.max_exposure}")
        return self._ok()


class BuyingPowerRule(RiskRule):
    name = "buying_power"

    def evaluate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        if order.side is OrderSide.BUY:
            notional = _order_notional(order, ctx)
            if notional > ctx.account.buying_power:
                return self._reject(
                    f"insufficient buying power ({notional} > {ctx.account.buying_power})"
                )
        return self._ok()


# Order matters: hard global gates first, then financial limits.
DEFAULT_RULES: list[RiskRule] = [
    KillSwitchRule(),
    BrokerConnectedRule(),
    MarketHaltRule(),
    OrderSanityRule(),
    DailyLossLimitRule(),
    MaxDrawdownRule(),
    BuyingPowerRule(),
    MaxPositionSizeRule(),
    MaxExposureRule(),
]
