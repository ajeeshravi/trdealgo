"""Authentication & cryptography helpers: password hashing, JWT, TOTP, envelope
encryption for broker credentials."""
from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pyotp
from cryptography.fernet import Fernet
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


# ----- Passwords -----
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


# ----- JWT -----
def _encode(payload: dict[str, Any], ttl: timedelta, token_type: str) -> str:
    now = datetime.now(UTC)
    body = {**payload, "iat": now, "exp": now + ttl, "type": token_type}
    return jwt.encode(body, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def create_access_token(sub: str, roles: list[str]) -> str:
    return _encode(
        {"sub": sub, "roles": roles},
        timedelta(minutes=settings.ACCESS_TOKEN_TTL_MIN),
        "access",
    )


def create_refresh_token(sub: str, jti: str | None = None) -> str:
    return _encode(
        {"sub": sub, "jti": jti or secrets.token_urlsafe(16)},
        timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
        "refresh",
    )


def decode_token(token: str) -> dict[str, Any]:
    """Raises jwt.PyJWTError on invalid/expired token."""
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG])


# ----- MFA (TOTP) -----
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.APP_NAME)


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code, valid_window=1)


# ----- API keys -----
def generate_api_key() -> tuple[str, str, str]:
    """Returns (full_key, prefix, sha256_hash). Store only prefix+hash."""
    raw = secrets.token_urlsafe(32)
    prefix = raw[:8]
    return raw, prefix, hashlib.sha256(raw.encode()).hexdigest()


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ----- Envelope encryption for broker credentials -----
def _fernet() -> Fernet:
    key = settings.CREDENTIALS_ENC_KEY
    if not key:
        # Dev fallback: derive a stable key from JWT_SECRET. In prod use a
        # KMS-issued data key passed via CREDENTIALS_ENC_KEY.
        key = base64.urlsafe_b64encode(
            hashlib.sha256(settings.JWT_SECRET.encode()).digest()
        ).decode()
    return Fernet(key)


def encrypt_secret(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_secret(token: bytes) -> str:
    return _fernet().decrypt(token).decode()
