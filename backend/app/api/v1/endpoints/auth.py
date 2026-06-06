"""Authentication endpoints: register, login (+MFA), refresh, me."""
from __future__ import annotations

import secrets

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, get_current_user
from app.core.database import get_db
from app.core.redis import get_redis
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    decrypt_secret,
    hash_password,
    verify_password,
    verify_totp,
)
from app.models.user import MfaSecret, Role, User, UserRole
from app.schemas.auth import (
    LoginRequest,
    MfaVerifyRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])


async def _issue_tokens(user: User) -> TokenResponse:
    roles = [r.name for r in user.roles]
    return TokenResponse(
        access_token=create_access_token(str(user.id), roles),
        refresh_token=create_refresh_token(str(user.id)),
    )


@router.post("/register", response_model=UserOut, status_code=201)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = (
        await db.execute(select(User).where(User.email == body.email))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        full_name=body.full_name,
    )
    db.add(user)
    await db.flush()
    # Default role: trader.
    trader = (await db.execute(select(Role).where(Role.name == "trader"))).scalar_one_or_none()
    if trader:
        db.add(UserRole(user_id=user.id, role_id=trader.id))
    await db.flush()
    await db.refresh(user)
    return UserOut(
        id=str(user.id), email=user.email, full_name=user.full_name,
        roles=[r.name for r in user.roles], mfa_enabled=user.mfa_enabled,
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = (
        await db.execute(select(User).where(User.email == body.email))
    ).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")

    if user.mfa_enabled:
        # Issue a short-lived MFA token; client must complete /auth/mfa/verify.
        mfa_token = secrets.token_urlsafe(24)
        await get_redis().set(f"mfa:pending:{mfa_token}", str(user.id), ex=300)
        return TokenResponse(access_token="", refresh_token="", mfa_required=True)

    return await _issue_tokens(user)


@router.post("/mfa/verify", response_model=TokenResponse)
async def mfa_verify(body: MfaVerifyRequest, db: AsyncSession = Depends(get_db)):
    r = get_redis()
    user_id = await r.get(f"mfa:pending:{body.mfa_token}")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "mfa session expired")
    secret_row = await db.get(MfaSecret, user_id)
    if not secret_row or not verify_totp(decrypt_secret(secret_row.secret_enc), body.code):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid code")
    await r.delete(f"mfa:pending:{body.mfa_token}")
    user = await db.get(User, user_id)
    return await _issue_tokens(user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong token type")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc

    # Rotation: blacklist old jti.
    r = get_redis()
    if await r.get(f"refresh:revoked:{payload.get('jti')}"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token revoked")
    await r.set(f"refresh:revoked:{payload.get('jti')}", "1", ex=60 * 60 * 24 * 30)

    user = await db.get(User, payload["sub"])
    return await _issue_tokens(user)


@router.get("/me", response_model=UserOut)
async def me(current: CurrentUser = Depends(get_current_user)):
    u = current.user
    return UserOut(
        id=str(u.id), email=u.email, full_name=u.full_name,
        roles=current.roles, mfa_enabled=u.mfa_enabled,
    )
