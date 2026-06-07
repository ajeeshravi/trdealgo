"""Price-trigger management (entry / SL / target arming)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import Trigger

router = APIRouter(prefix="/triggers", tags=["triggers"])

LIVE_STATES = ["PENDING", "ARMED"]
HISTORY_STATES = ["TRIGGERED", "FILLED", "CANCELLED", "FAILED"]


def _num(v) -> float | None:
    return float(v) if v is not None else None


def _serialize(t: Trigger) -> dict:
    return {
        "id": str(t.id),
        "user_id": str(t.user_id),
        "broker_account_id": t.broker_account_id,
        "strategy_run_id": t.strategy_run_id,
        "parent_id": t.parent_id,
        "role": t.role,
        "internal_symbol": t.internal_symbol,
        "side": t.side,
        "qty": _num(t.qty) or 0,
        "direction": t.direction,
        "trigger_price": _num(t.trigger_price) or 0,
        "limit_price": _num(t.limit_price),
        "limit_timeout_sec": t.limit_timeout_sec,
        "product": t.product,
        "is_paper": t.is_paper,
        "state": t.state,
        "triggered_at": t.triggered_at.isoformat() if t.triggered_at else None,
        "triggered_ltp": _num(t.triggered_ltp),
        "order_id": t.order_id,
        "extras": t.extras or {},
        "note": t.note,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


@router.get("")
async def list_triggers(
    limit: int = 300,
    state: str | None = None,
    internal_symbol: str | None = None,
    include_history: bool = False,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Trigger).where(Trigger.user_id == current.user.id)
    if state:
        stmt = stmt.where(Trigger.state == state)
    elif not include_history:
        stmt = stmt.where(Trigger.state.in_(LIVE_STATES))
    if internal_symbol:
        stmt = stmt.where(Trigger.internal_symbol == internal_symbol)
    stmt = stmt.order_by(Trigger.created_at.desc()).limit(min(limit, 2000))
    rows = (await db.execute(stmt)).scalars().all()
    return [_serialize(t) for t in rows]


@router.delete("/{trigger_id}")
async def cancel_trigger(
    trigger_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    t = await db.get(Trigger, trigger_id)
    if t is None or t.user_id != current.user.id:
        raise HTTPException(404, "trigger not found")
    if t.state in LIVE_STATES:
        t.state = "CANCELLED"
        await db.flush()
        return {"cancelled_count": 1, "state": t.state}
    # Already terminal — nothing to cancel.
    return {"cancelled_count": 0, "state": t.state}


@router.post("/cancel-all")
async def cancel_all(
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(Trigger).where(
                Trigger.user_id == current.user.id,
                Trigger.state.in_(LIVE_STATES),
            )
        )
    ).scalars().all()
    for t in rows:
        t.state = "CANCELLED"
    await db.flush()
    return {"cancelled_count": len(rows)}
