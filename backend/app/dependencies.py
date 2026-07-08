"""FastAPI dependency injection."""
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import Settings, get_settings
from backend.app.db.session import AsyncSessionLocal


async def get_db() -> AsyncIterator[AsyncSession]:
    """Yield a database session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def get_config(settings: Annotated[Settings, Depends(get_settings)]) -> Settings:
    return settings
