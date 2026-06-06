"""Risk profile + kill switch endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import RiskProfile
from app.risk import kill_switch
from app.schemas.trading import KillSwitchRequest, RiskProfileSchema

router = APIRouter(prefix="/risk", tags=["risk"])


@router.get("/profiles/{account_id}", response_model=RiskProfileSchema)
async def get_profile(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(select(RiskProfile).where(RiskProfile.account_id == account_id))
    ).scalar_one_or_none()
    if row is None:
        return RiskProfileSchema()
    return RiskProfileSchema(
        daily_loss_limit=row.daily_loss_limit,
        max_drawdown_pct=row.max_drawdown_pct,
        max_exposure=row.max_exposure,
        max_position_size=row.max_position_size,
        max_position_pct=row.max_position_pct,
    )


@router.put("/profiles/{account_id}", response_model=RiskProfileSchema)
async def upsert_profile(
    account_id: str,
    body: RiskProfileSchema,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(select(RiskProfile).where(RiskProfile.account_id == account_id))
    ).scalar_one_or_none()
    if row is None:
        row = RiskProfile(account_id=account_id)
        db.add(row)
    row.daily_loss_limit = body.daily_loss_limit
    row.max_drawdown_pct = body.max_drawdown_pct
    row.max_exposure = body.max_exposure
    row.max_position_size = body.max_position_size
    row.max_position_pct = body.max_position_pct
    await db.flush()
    return body


@router.post("/kill-switch")
async def set_kill_switch(
    body: KillSwitchRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
):
    if body.active:
        await kill_switch.activate(body.scope, body.reason or "manual", by=current.id)
    else:
        await kill_switch.deactivate(body.scope)
    return {"scope": body.scope, "active": body.active}


@router.get("/status")
async def status(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    return {"kill_switch": await kill_switch.status()}
