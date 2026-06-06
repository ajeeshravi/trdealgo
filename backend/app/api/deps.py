"""Shared FastAPI dependencies: auth, RBAC, DB session."""
from __future__ import annotations

from collections.abc import Callable

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token, hash_api_key
from app.models.user import ApiKey, User

bearer = HTTPBearer(auto_error=False)


class CurrentUser:
    def __init__(self, user: User, roles: list[str]) -> None:
        self.user = user
        self.roles = roles
        self.id = str(user.id)


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    x_api_key: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    # API-key auth path
    if x_api_key:
        prefix = x_api_key[:8]
        row = (
            await db.execute(
                select(ApiKey).where(
                    ApiKey.prefix == prefix, ApiKey.hash == hash_api_key(x_api_key)
                )
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid api key")
        user = await db.get(User, row.user_id)
        return CurrentUser(user, [r.name for r in user.roles])

    # JWT path
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing credentials")
    try:
        payload = decode_token(creds.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong token type")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc

    user = await db.get(User, payload["sub"])
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "inactive user")
    return CurrentUser(user, payload.get("roles", []))


def require_roles(*roles: str) -> Callable:
    """RBAC dependency factory: require any of the given roles."""

    async def checker(current: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not set(roles) & set(current.roles):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "insufficient role")
        return current

    return checker
