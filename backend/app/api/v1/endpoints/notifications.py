"""In-app notifications: feed, read-state, preferences, and channel config."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.platform import Notification, NotificationPreference

router = APIRouter(prefix="/notifications", tags=["notifications"])

ROLES_ALL = ("admin", "trader", "viewer")

# Channels the preferences panel knows how to render.
_DEFAULT_CHANNEL = {
    "enabled": False,
    "target": "",
    "categories": [],
    "severity_min": "INFO",
}


def _default_preferences() -> dict:
    return {
        "channels": {
            "in_app": {**_DEFAULT_CHANNEL, "enabled": True},
            "email": dict(_DEFAULT_CHANNEL),
            "telegram": dict(_DEFAULT_CHANNEL),
            "webhook": dict(_DEFAULT_CHANNEL),
        },
        "strategies_muted": [],
        "brokers_muted": [],
        "silent_mode": {"enabled": False, "start": "22:00", "end": "07:00", "tz": "America/New_York"},
        "rate_limit": {"per_minute": 20, "per_hour": 200},
        "sound": {"critical": True, "error": True, "warning": False, "info": False},
        "browser_push": False,
        "desktop_push": False,
        "auto_expiry_days": 30,
    }


def _serialize(n: Notification) -> dict:
    return {
        "id": str(n.id),
        "type": n.type,
        "severity": n.severity,
        "category": n.category,
        "event": n.event,
        "title": n.title,
        "message": n.message,
        "read": n.read,
        "action_status": n.action_status,
        "strategy_id": n.strategy_id,
        "strategy_name": n.strategy_name,
        "broker_account_id": n.broker_account_id,
        "broker_name": n.broker_name,
        "account_label": n.account_label,
        "symbol": n.symbol,
        "order_id": n.order_id,
        "trade_id": n.trade_id,
        "meta": n.meta or {},
        "created_at": n.created_at.isoformat() if n.created_at else None,
        "expires_at": n.expires_at.isoformat() if n.expires_at else None,
    }


# ---------------------------------------------------------------------------
# Feed
# ---------------------------------------------------------------------------
@router.get("")
async def list_notifications(
    limit: int = 25,
    offset: int = 0,
    unread_only: bool = False,
    severity: str | None = None,
    category: str | None = None,
    strategy_id: str | None = None,
    broker_account_id: str | None = None,
    symbol: str | None = None,
    search: str | None = None,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    base = select(Notification).where(Notification.user_id == current.user.id)
    if unread_only:
        base = base.where(Notification.read.is_(False))
    if severity:
        base = base.where(Notification.severity == severity)
    if category:
        base = base.where(Notification.category == category)
    if strategy_id:
        base = base.where(Notification.strategy_id == strategy_id)
    if broker_account_id:
        base = base.where(Notification.broker_account_id == broker_account_id)
    if symbol:
        base = base.where(Notification.symbol == symbol)
    if search:
        like = f"%{search}%"
        base = base.where(Notification.message.ilike(like) | Notification.title.ilike(like))

    total = (
        await db.execute(select(func.count()).select_from(base.subquery()))
    ).scalar_one()
    unread = (
        await db.execute(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == current.user.id, Notification.read.is_(False))
        )
    ).scalar_one()
    rows = (
        await db.execute(
            base.order_by(Notification.created_at.desc()).limit(min(limit, 200)).offset(offset)
        )
    ).scalars().all()
    return {
        "items": [_serialize(n) for n in rows],
        "total": total,
        "unread": unread,
        "limit": limit,
        "offset": offset,
    }


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    n = await db.get(Notification, notification_id)
    if n is None or n.user_id != current.user.id:
        raise HTTPException(404, "notification not found")
    n.read = True
    await db.flush()
    return {"ok": True}


@router.post("/read-all")
async def mark_all_read(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        update(Notification)
        .where(Notification.user_id == current.user.id, Notification.read.is_(False))
        .values(read=True)
    )
    return {"ok": True}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: str,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    n = await db.get(Notification, notification_id)
    if n is None or n.user_id != current.user.id:
        raise HTTPException(404, "notification not found")
    await db.delete(n)
    await db.flush()
    return {"ok": True}


@router.delete("")
async def delete_all(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(sa_delete(Notification).where(Notification.user_id == current.user.id))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------
async def _get_prefs(db: AsyncSession, user_id) -> NotificationPreference:
    pref = await db.get(NotificationPreference, user_id)
    if pref is None:
        pref = NotificationPreference(user_id=user_id, data=_default_preferences())
        db.add(pref)
        await db.flush()
    return pref


@router.get("/preferences")
async def get_preferences(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    pref = await _get_prefs(db, current.user.id)
    return pref.data or _default_preferences()


@router.put("/preferences")
async def update_preferences(
    body: dict,
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    pref = await _get_prefs(db, current.user.id)
    merged = {**(pref.data or _default_preferences()), **(body or {})}
    pref.data = merged
    await db.flush()
    return merged


@router.post("/preferences/reset")
async def reset_preferences(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    pref = await _get_prefs(db, current.user.id)
    pref.data = _default_preferences()
    await db.flush()
    return pref.data


# ---------------------------------------------------------------------------
# Channels. Delivery integrations (SMTP / Telegram) are not configured in this
# build, so verify/test/discover report a clear "not configured" result rather
# than failing — the settings panel renders the state cleanly.
# ---------------------------------------------------------------------------
@router.get("/channels/status")
async def channels_status(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    return {
        "in_app": {"configured": True, "detail": "Always on."},
        "email": {"configured": False, "detail": "SMTP not configured."},
        "telegram": {"configured": False, "detail": "Bot token not configured."},
        "webhook": {"configured": False, "detail": "No webhook URL set."},
    }


@router.get("/channels/email/providers")
async def email_providers(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    return {
        "providers": [
            {"key": "gmail", "label": "Gmail", "host": "smtp.gmail.com", "port": 587,
             "use_tls": True, "hint": "Use an App Password.",
             "app_password_url": "https://myaccount.google.com/apppasswords"},
            {"key": "outlook", "label": "Outlook / Microsoft 365", "host": "smtp.office365.com",
             "port": 587, "use_tls": True, "hint": "", "app_password_url": None},
            {"key": "custom", "label": "Custom SMTP", "host": "", "port": 587,
             "use_tls": True, "hint": "Enter your provider's SMTP settings.",
             "app_password_url": None},
        ]
    }


@router.post("/channels/email/verify")
async def verify_email(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    return {"ok": False, "error": "Email delivery is not configured in this build.", "server": None}


@router.post("/channels/telegram/discover")
async def telegram_discover(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    return {"ok": False, "error": "Telegram delivery is not configured in this build.", "chats": []}


@router.post("/channels/test")
async def test_channel(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
):
    return {"ok": False, "error": "Outbound channels are not configured in this build."}
