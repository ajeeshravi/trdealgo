"""Backtest queueing and result listing."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import Backtest

router = APIRouter(prefix="/backtests", tags=["backtests"])


class CreateBacktestRequest(BaseModel):
    strategy_id: str
    from_date: date
    to_date: date
    timeframe: str = "5m"
    capital: float = 0
    name: str


def _serialize(b: Backtest) -> dict:
    return {
        "id": str(b.id),
        "name": b.name,
        "strategy_id": b.strategy_id,
        "from_date": b.from_date.isoformat() if b.from_date else None,
        "to_date": b.to_date.isoformat() if b.to_date else None,
        "timeframe": b.timeframe,
        "capital": float(b.capital or 0),
        "status": b.status,
        "summary": b.summary,
    }


@router.get("")
async def list_backtests(
    strategy: str | None = None,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Backtest).where(Backtest.user_id == current.user.id)
    if strategy:
        stmt = stmt.where(Backtest.strategy_id == strategy)
    stmt = stmt.order_by(Backtest.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return [_serialize(b) for b in rows]


@router.post("", status_code=201)
async def create_backtest(
    body: CreateBacktestRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    bt = Backtest(
        user_id=current.user.id,
        strategy_id=body.strategy_id,
        name=body.name,
        from_date=body.from_date,
        to_date=body.to_date,
        timeframe=body.timeframe,
        capital=Decimal(str(body.capital or 0)),
        status="QUEUED",
    )
    db.add(bt)
    await db.flush()
    return _serialize(bt)
