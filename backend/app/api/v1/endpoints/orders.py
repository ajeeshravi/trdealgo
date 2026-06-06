"""Order endpoints. Every placement runs through the Risk Engine via the
TradingEngine — there is no path to a broker that skips risk checks."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.brokers.models import OrderRequest
from app.core.database import get_db
from app.models.trading import RiskProfile
from app.risk.rules import RiskProfile as RiskProfileDC
from app.schemas.trading import OrderOut, PlaceOrderRequest
from app.services.broker_manager import broker_manager
from app.trading_engine.engine import OrderRejected, TradingEngine

router = APIRouter(prefix="/orders", tags=["orders"])


def _to_order_request(body: PlaceOrderRequest, client_order_id: str) -> OrderRequest:
    return OrderRequest(
        symbol=body.symbol,
        asset_class=body.asset_class,
        side=body.side,
        qty=body.qty,
        order_type=body.order_type,
        tif=body.tif,
        limit_price=body.limit_price,
        stop_price=body.stop_price,
        trail_percent=body.trail_percent,
        take_profit_price=body.take_profit.limit_price if body.take_profit else None,
        stop_loss_price=body.stop_loss.stop_price if body.stop_loss else None,
        client_order_id=client_order_id,
    )


async def _load_risk_profile(db: AsyncSession, account_id: str) -> RiskProfileDC:
    from sqlalchemy import select

    row = (
        await db.execute(select(RiskProfile).where(RiskProfile.account_id == account_id))
    ).scalar_one_or_none()
    if row is None:
        return RiskProfileDC()
    return RiskProfileDC(
        daily_loss_limit=row.daily_loss_limit,
        max_drawdown_pct=row.max_drawdown_pct,
        max_exposure=row.max_exposure,
        max_position_size=row.max_position_size,
        max_position_pct=row.max_position_pct,
    )


@router.post("", response_model=OrderOut, status_code=201)
async def place_order(
    body: PlaceOrderRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    broker = await broker_manager.get(db, body.account_id)
    engine = TradingEngine(broker=broker, account_id=body.account_id)
    risk_profile = await _load_risk_profile(db, body.account_id)
    client_order_id = idempotency_key or str(uuid.uuid4())
    req = _to_order_request(body, client_order_id)

    try:
        placed = await engine.submit(req, risk_profile=risk_profile)
    except OrderRejected as exc:
        # 422: risk engine refused the order.
        raise HTTPException(422, detail={"rule": exc.rule, "reason": exc.reason}) from exc

    return OrderOut(
        id=placed.id, symbol=placed.symbol, side=placed.side.value,
        order_type=placed.order_type.value, qty=placed.qty,
        filled_qty=placed.filled_qty, status=placed.status.value,
        avg_fill_price=placed.avg_fill_price,
    )


@router.get("", response_model=list[OrderOut])
async def list_orders(
    account_id: str,
    open_only: bool = True,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    broker = await broker_manager.get(db, account_id)
    orders = await broker.get_orders(open_only=open_only)
    return [
        OrderOut(
            id=o.id, symbol=o.symbol, side=o.side.value, order_type=o.order_type.value,
            qty=o.qty, filled_qty=o.filled_qty, status=o.status.value,
            avg_fill_price=o.avg_fill_price,
        )
        for o in orders
    ]


@router.delete("/{broker_order_id}", status_code=204)
async def cancel_order(
    broker_order_id: str,
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    broker = await broker_manager.get(db, account_id)
    engine = TradingEngine(broker=broker, account_id=account_id)
    await engine.cancel(broker_order_id)
