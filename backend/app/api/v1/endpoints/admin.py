"""Admin: user management and platform settings.

User and scheduler-settings management are fully implemented. The symbol-master
sync, exchange-holiday and institutional-ingest endpoints belong to data
pipelines that are India-specific / not yet built for US markets, so they return
empty/queued responses for now — the admin page renders without 404-ing.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.platform import AppSetting
from app.models.user import Role, User, UserRole

router = APIRouter(prefix="/admin", tags=["admin"])
ADMIN = ("admin",)

_SETTINGS_KEY = "scheduler"
_DEFAULT_SETTINGS = {
    "broker_auto_login_enabled": False,
    "broker_auto_login_time": "09:00",
    "broker_auto_logout_enabled": False,
    "broker_auto_logout_time": "16:00",
    "eod_ingest_enabled": False,
    "eod_ingest_time": "18:00",
    "updated_at": None,
}


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
@router.get("/users")
async def list_users(
    current: CurrentUser = Depends(require_roles(*ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    users = (await db.execute(select(User))).scalars().all()
    # role per user (first assigned, default viewer)
    role_rows = (
        await db.execute(select(UserRole.user_id, Role.name).join(Role, Role.id == UserRole.role_id))
    ).all()
    roles_by_user: dict = {}
    for uid, name in role_rows:
        roles_by_user.setdefault(uid, name)
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "role": roles_by_user.get(u.id, "viewer"),
            "is_active": u.is_active,
        }
        for u in users
    ]


@router.post("/users/{user_id}/disable")
async def disable_user(
    user_id: str,
    current: CurrentUser = Depends(require_roles(*ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "user not found")
    u.is_active = False
    await db.flush()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
async def _get_settings(db: AsyncSession) -> AppSetting:
    s = await db.get(AppSetting, _SETTINGS_KEY)
    if s is None:
        s = AppSetting(key=_SETTINGS_KEY, value=dict(_DEFAULT_SETTINGS))
        db.add(s)
        await db.flush()
    return s


@router.get("/settings")
async def get_settings(
    current: CurrentUser = Depends(require_roles(*ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_settings(db)
    return {**_DEFAULT_SETTINGS, **(s.value or {})}


@router.patch("/settings")
async def update_settings(
    body: dict,
    current: CurrentUser = Depends(require_roles(*ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_settings(db)
    merged = {**_DEFAULT_SETTINGS, **(s.value or {}), **(body or {})}
    s.value = merged
    await db.flush()
    return merged


# ---------------------------------------------------------------------------
# Data-pipeline endpoints (stubs until the US data pipelines are built)
# ---------------------------------------------------------------------------
@router.get("/symbol-master/health")
async def symbol_master_health(current: CurrentUser = Depends(require_roles(*ADMIN))):
    return {"total": 0, "active": 0, "mappings_per_broker": {}, "last_sync_per_broker": {}}


@router.get("/symbol-master/sync-runs")
async def symbol_master_sync_runs(
    limit: int = 20, current: CurrentUser = Depends(require_roles(*ADMIN))
):
    return []


@router.post("/symbol-master/sync/{broker}")
async def symbol_master_sync(
    broker: str, inline: bool = False, current: CurrentUser = Depends(require_roles(*ADMIN))
):
    return {"queued": False, "upserts": 0, "skipped": 0}


@router.get("/notification-settings")
async def notification_settings(current: CurrentUser = Depends(require_roles(*ADMIN))):
    return []


@router.patch("/notification-settings/{event_key}")
async def update_notification_setting(
    event_key: str, body: dict, current: CurrentUser = Depends(require_roles(*ADMIN))
):
    return {"ok": True}


@router.get("/holidays")
async def list_holidays(
    exchange: str = "US", year: int | None = None,
    current: CurrentUser = Depends(require_roles(*ADMIN)),
):
    return []


@router.post("/holidays")
async def add_holiday(
    body: dict, exchange: str = "US", current: CurrentUser = Depends(require_roles(*ADMIN))
):
    return {"ok": True}


@router.delete("/holidays/{holiday_date}")
async def delete_holiday(
    holiday_date: str, exchange: str = "US",
    current: CurrentUser = Depends(require_roles(*ADMIN)),
):
    return {"ok": True}
