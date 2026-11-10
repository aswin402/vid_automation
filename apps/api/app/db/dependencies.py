from typing import AsyncGenerator
from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import SessionLocal
from app.models.domain import User


DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"
DEFAULT_USER_EMAIL = "creator@vidautomation.local"


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as db:
        yield db


async def get_current_user(
    db: AsyncSession = Depends(get_db),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> User:
    """
    Resolves the authenticated user (or provisions the isolated development identity).
    Supports per-user isolation via X-User-Id / X-User-Email headers for multi-user testing.
    """
    target_id = x_user_id or DEFAULT_USER_ID
    target_email = x_user_email or (
        DEFAULT_USER_EMAIL if target_id == DEFAULT_USER_ID else f"user-{target_id[:8]}@vidautomation.local"
    )

    result = await db.execute(select(User).where(User.id == target_id))
    user = result.scalar_one_or_none()
    if not user:
        user = User(id=target_id, email=target_email, name="Studio Creator")
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user
