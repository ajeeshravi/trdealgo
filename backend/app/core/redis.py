"""Shared async Redis client used for cache, pub/sub, streams, idempotency."""
from __future__ import annotations

import redis.asyncio as redis

from app.core.config import settings

# Single connection pool shared process-wide.
pool = redis.ConnectionPool.from_url(settings.REDIS_URL, decode_responses=True)


def get_redis() -> redis.Redis:
    return redis.Redis(connection_pool=pool)


async def close_redis() -> None:
    await pool.aclose()
