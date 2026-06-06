"""Kill switch + emergency controls backed by Redis.

Scope is either ``"global"`` or a specific account id. The trading engine reads
the switch on every order; ops/admin endpoints and continuous monitors flip it.
"""
from __future__ import annotations

from app.core.logging import get_logger
from app.core.redis import get_redis

log = get_logger("risk.kill_switch")

_KEY = "risk:kill_switch"


async def activate(scope: str, reason: str, by: str = "system") -> None:
    r = get_redis()
    await r.hset(_KEY, scope, f"{by}|{reason}")
    log.error("kill_switch.activated", scope=scope, reason=reason, by=by)


async def deactivate(scope: str) -> None:
    await get_redis().hdel(_KEY, scope)
    log.warning("kill_switch.deactivated", scope=scope)


async def is_active(account_id: str) -> bool:
    r = get_redis()
    vals = await r.hmget(_KEY, "global", account_id)
    return any(v is not None for v in vals)


async def status() -> dict[str, str]:
    return await get_redis().hgetall(_KEY)
