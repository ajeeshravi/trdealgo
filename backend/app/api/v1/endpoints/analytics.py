"""Trading analytics: P&L series, fill ratio, latency."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import BrokerAccount, Order

router = APIRouter(prefix="/analytics", tags=["analytics"])
ROLES_ALL = ("admin", "trader", "viewer")


@router.get("/pnl")
async def pnl(
    days: int = 30,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    # Realised daily P&L requires the fills/positions rollup pipeline, which is
    # not wired up yet. Return a zero series spanning the window so the chart
    # renders an empty baseline rather than 404-ing.
    today = date.today()
    series = [
        {"date": (today - timedelta(days=i)).isoformat(), "pnl": 0.0}
        for i in range(max(days, 1) - 1, -1, -1)
    ]
    return {"total_pnl": 0.0, "days": series}


@router.get("/fill-ratio")
async def fill_ratio(
    days: int = 30,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    account_ids = (
        await db.execute(
            select(BrokerAccount.id).where(BrokerAccount.user_id == current.user.id)
        )
    ).scalars().all()
    if not account_ids:
        return {"fill_ratio_pct": 0.0}
    total = (
        await db.execute(
            select(func.count()).select_from(Order).where(Order.account_id.in_(account_ids))
        )
    ).scalar_one()
    filled = (
        await db.execute(
            select(func.count())
            .select_from(Order)
            .where(Order.account_id.in_(account_ids), Order.status == "filled")
        )
    ).scalar_one()
    pct = (filled / total * 100.0) if total else 0.0
    return {"fill_ratio_pct": round(pct, 2)}


@router.get("/latency")
async def latency(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    # Order-placement latency is captured by the live engine's metrics, not yet
    # surfaced here. Report 0 until that telemetry is wired in.
    return {"p95_ms": 0}
