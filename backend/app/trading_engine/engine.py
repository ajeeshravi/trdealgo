"""Centralized trading engine.

Pipeline: signal/intake → idempotency → **risk pre-check** → order routing →
execution → position update → post-trade risk → fan-out (events/notifications).

The engine owns the invariant that *no order is sent to a broker without a
passing risk check*.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal

from app.brokers.base import BrokerBase
from app.brokers.models import Order, OrderRequest
from app.core.logging import get_logger
from app.core.redis import get_redis
from app.risk import kill_switch
from app.risk.engine import RiskEngine, risk_engine
from app.risk.rules import RiskContext, RiskProfile

log = get_logger("trading_engine")


class OrderRejected(Exception):
    def __init__(self, rule: str, reason: str) -> None:
        self.rule = rule
        self.reason = reason
        super().__init__(f"{rule}: {reason}")


@dataclass(slots=True)
class TradingEngine:
    broker: BrokerBase
    account_id: str
    risk: RiskEngine = risk_engine

    async def _build_risk_context(
        self, order: OrderRequest, risk_profile: RiskProfile, ref_price: Decimal | None
    ) -> RiskContext:
        account = await self.broker.get_account()
        positions = await self.broker.get_positions()
        r = get_redis()
        realized = Decimal(await r.get(f"pnl:realized:{self.account_id}") or "0")
        peak = await r.get(f"equity:peak:{self.account_id}")
        halted = set(await r.smembers("market:halted") or [])
        return RiskContext(
            account=account,
            positions=positions,
            risk_profile=risk_profile,
            realized_pnl_today=realized,
            peak_equity=Decimal(peak) if peak else account.equity,
            kill_switch_active=await kill_switch.is_active(self.account_id),
            broker_connected=await self.broker.is_connected(),
            halted_symbols=halted,
            reference_price=ref_price,
        )

    async def _idempotent(self, client_order_id: str | None) -> str | None:
        """Returns the previously-stored broker order id for a replayed request."""
        if not client_order_id:
            return None
        return await get_redis().get(f"idem:order:{client_order_id}")

    async def submit(
        self,
        order: OrderRequest,
        *,
        risk_profile: RiskProfile,
        ref_price: Decimal | None = None,
    ) -> Order:
        """Submit one order through the full pipeline. Raises OrderRejected."""
        # 1. Idempotency — replay returns the original result.
        existing = await self._idempotent(order.client_order_id)
        if existing:
            log.info("order.idempotent_replay", client_order_id=order.client_order_id)
            for o in await self.broker.get_orders(open_only=False):
                if o.id == existing:
                    return o

        # 2. Mandatory risk pre-check.
        ctx = await self._build_risk_context(order, risk_profile, ref_price)
        decision = self.risk.validate(order, ctx)
        if not decision.allowed:
            await self._publish(
                "risk.events",
                {"account_id": self.account_id, "rule": decision.rule,
                 "reason": decision.reason, "symbol": order.symbol},
            )
            raise OrderRejected(decision.rule, decision.reason)

        # 3. Route to broker.
        placed = await self.broker.place_order(order)
        log.info("order.placed", id=placed.id, symbol=order.symbol, status=placed.status)

        # 4. Persist idempotency mapping + fan out.
        if order.client_order_id:
            await get_redis().set(
                f"idem:order:{order.client_order_id}", placed.id, ex=86400
            )
        await self._publish(
            "orders.events",
            {"account_id": self.account_id, "id": placed.id,
             "symbol": placed.symbol, "status": placed.status.value},
        )
        return placed

    async def cancel(self, broker_order_id: str) -> None:
        await self.broker.cancel_order(broker_order_id)
        await self._publish(
            "orders.events",
            {"account_id": self.account_id, "id": broker_order_id, "status": "canceled"},
        )

    async def _publish(self, channel: str, payload: dict) -> None:
        await get_redis().publish(channel, json.dumps(payload, default=str))
