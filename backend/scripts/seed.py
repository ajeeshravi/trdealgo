"""Idempotent seed: create the three RBAC roles and an optional admin user.

Usage:
    python -m scripts.seed
    ADMIN_EMAIL=a@b.com ADMIN_PASSWORD=secret python -m scripts.seed
"""
from __future__ import annotations

import asyncio
import os

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models.user import Role, User, UserRole

ROLES = [(1, "admin"), (2, "trader"), (3, "viewer")]


async def main() -> None:
    async with SessionLocal() as db:
        for rid, name in ROLES:
            exists = (
                await db.execute(select(Role).where(Role.id == rid))
            ).scalar_one_or_none()
            if not exists:
                db.add(Role(id=rid, name=name))
        await db.flush()

        email = os.getenv("ADMIN_EMAIL")
        password = os.getenv("ADMIN_PASSWORD")
        if email and password:
            existing = (
                await db.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if not existing:
                user = User(email=email, password_hash=hash_password(password), full_name="Admin")
                db.add(user)
                await db.flush()
                db.add(UserRole(user_id=user.id, role_id=1))
                print(f"created admin: {email}")
        await db.commit()
    print("seed complete")


if __name__ == "__main__":
    asyncio.run(main())
