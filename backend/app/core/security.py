"""Security utilities: JWT, password hashing (extensible)."""
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from jose import JWTError, jwt
from passlib.context import CryptContext

from backend.app.config import settings

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 1 day

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def create_access_token(subject: str | Any, expires_delta: timedelta | None = None) -> str:
    expire = datetime.now(UTC) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload = {"sub": str(subject), "exp": expire}
    return cast(str, jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM))


def decode_token(token: str) -> dict[str, Any]:
    try:
        return cast(dict[str, Any], jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM]))
    except JWTError as exc:
        raise ValueError(f"Invalid token: {exc}") from exc


def hash_password(password: str) -> str:
    return cast(str, pwd_context.hash(password))


def verify_password(plain: str, hashed: str) -> bool:
    return cast(bool, pwd_context.verify(plain, hashed))
