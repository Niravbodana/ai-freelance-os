"""RBAC, Secrets Manager abstraction, and Audit Log.

RBAC
----
Role-based access control using a simple permission map.
Built-in roles: admin, operator, viewer, agent.
Permissions follow the pattern: ``resource:action``.

Usage::
    rbac = get_rbac()
    rbac.check("admin", "tasks:delete")    # → True
    rbac.check("viewer", "tasks:delete")   # → False

    # Decorator (FastAPI dependency)
    @app.get("/admin")
    async def admin_route(user: CurrentUser = Depends(get_current_user)):
        require_permission(user.role, "system:admin")

Secrets Manager
---------------
Abstract interface so the application never imports a specific vault SDK.
Implementations: environment variables (default), HashiCorp Vault (future),
AWS Secrets Manager (future).

Usage::
    secrets = get_secrets_manager()
    api_key = await secrets.get("OPENAI_API_KEY")

Audit Log
---------
Immutable structured log of security-relevant actions.
Written to the database and also emitted as structured log lines.

Usage::
    audit = get_audit_log(db=session)
    await audit.record(actor="user:abc", action="approval.granted",
                       resource="approval:123", outcome="success")
"""
from __future__ import annotations

import abc
import os
from enum import StrEnum
from typing import TYPE_CHECKING, Any

import ulid
from sqlalchemy import Enum as SAEnum
from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.logging import get_logger
from backend.app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# RBAC
# ─────────────────────────────────────────────────────────────────────────────


class Role(StrEnum):
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"
    AGENT = "agent"


# Permission map: role → frozenset of allowed permissions
_PERMISSIONS: dict[str, frozenset[str]] = {
    Role.ADMIN: frozenset(
        {
            "tasks:create",
            "tasks:read",
            "tasks:update",
            "tasks:delete",
            "agents:read",
            "agents:manage",
            "approvals:read",
            "approvals:decide",
            "system:admin",
            "secrets:read",
            "audit:read",
            "plugins:manage",
        }
    ),
    Role.OPERATOR: frozenset(
        {
            "tasks:create",
            "tasks:read",
            "tasks:update",
            "agents:read",
            "approvals:read",
            "approvals:decide",
            "plugins:manage",
        }
    ),
    Role.VIEWER: frozenset(
        {
            "tasks:read",
            "agents:read",
            "approvals:read",
            "audit:read",
        }
    ),
    Role.AGENT: frozenset(
        {
            "tasks:read",
            "tasks:update",
            "agents:read",
        }
    ),
}


class PermissionDeniedError(Exception):
    """Raised when an actor lacks a required permission."""

    def __init__(self, role: str, permission: str) -> None:
        super().__init__(f"Role '{role}' does not have permission '{permission}'")
        self.role = role
        self.permission = permission


class RBACEngine:
    """Evaluates role-based permissions."""

    def __init__(self, permissions: dict[str, frozenset[str]] | None = None) -> None:
        self._permissions = dict(permissions or _PERMISSIONS)

    def check(self, role: str, permission: str) -> bool:
        """Return True if *role* has *permission*."""
        allowed = self._permissions.get(role, frozenset())
        return permission in allowed

    def require(self, role: str, permission: str) -> None:
        """Raise :class:`PermissionDeniedError` if check fails."""
        if not self.check(role, permission):
            raise PermissionDeniedError(role, permission)

    def grant(self, role: str, permission: str) -> None:
        """Dynamically add a permission to a role."""
        existing = self._permissions.get(role, frozenset())
        self._permissions[role] = existing | {permission}

    def revoke(self, role: str, permission: str) -> None:
        """Dynamically remove a permission from a role."""
        existing = self._permissions.get(role, frozenset())
        self._permissions[role] = existing - {permission}

    def permissions_for(self, role: str) -> frozenset[str]:
        return self._permissions.get(role, frozenset())


_rbac: RBACEngine | None = None


def get_rbac() -> RBACEngine:
    global _rbac
    if _rbac is None:
        _rbac = RBACEngine()
    return _rbac


# ─────────────────────────────────────────────────────────────────────────────
# Secrets Manager
# ─────────────────────────────────────────────────────────────────────────────


class SecretsManager(abc.ABC):
    """Abstract interface for secret retrieval."""

    @abc.abstractmethod
    async def get(self, key: str) -> str | None:
        """Retrieve a secret by *key*. Returns None if not found."""
        ...

    @abc.abstractmethod
    async def set(self, key: str, value: str) -> None:
        """Store or update a secret."""
        ...

    @abc.abstractmethod
    async def delete(self, key: str) -> None:
        """Remove a secret."""
        ...


class EnvSecretsManager(SecretsManager):
    """Reads secrets from environment variables (default implementation)."""

    async def get(self, key: str) -> str | None:
        return os.environ.get(key)

    async def set(self, key: str, value: str) -> None:
        os.environ[key] = value

    async def delete(self, key: str) -> None:
        os.environ.pop(key, None)


class InMemorySecretsManager(SecretsManager):
    """In-memory secrets store (useful for tests)."""

    def __init__(self, initial: dict[str, str] | None = None) -> None:
        self._store: dict[str, str] = dict(initial or {})

    async def get(self, key: str) -> str | None:
        return self._store.get(key)

    async def set(self, key: str, value: str) -> None:
        self._store[key] = value

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)


_secrets: SecretsManager | None = None


def get_secrets_manager() -> SecretsManager:
    global _secrets
    if _secrets is None:
        _secrets = EnvSecretsManager()
    return _secrets


def set_secrets_manager(manager: SecretsManager) -> None:
    """Replace the default secrets manager (e.g. to plug in Vault)."""
    global _secrets
    _secrets = manager


# ─────────────────────────────────────────────────────────────────────────────
# Audit Log
# ─────────────────────────────────────────────────────────────────────────────


class AuditOutcome(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"


class AuditLogEntry(TimestampMixin, Base):
    """Immutable audit log record."""

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(26), primary_key=True)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    resource: Mapped[str | None] = mapped_column(String(255), nullable=True)
    outcome: Mapped[AuditOutcome] = mapped_column(
        SAEnum(AuditOutcome), default=AuditOutcome.SUCCESS, nullable=False
    )
    detail_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class AuditLog:
    """Records security-relevant events to the database and structured log."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def record(
        self,
        actor: str,
        action: str,
        *,
        resource: str | None = None,
        outcome: AuditOutcome = AuditOutcome.SUCCESS,
        detail: dict[str, Any] | None = None,
        ip_address: str | None = None,
        trace_id: str | None = None,
    ) -> AuditLogEntry:
        """Write an audit entry to the database."""
        import json

        # Pull trace_id from context if not supplied
        if trace_id is None:
            from backend.app.core.tracing import get_trace_id
            trace_id = get_trace_id()

        entry = AuditLogEntry(
            id=str(ulid.new()),
            actor=actor,
            action=action,
            resource=resource,
            outcome=outcome,
            detail_json=json.dumps(detail) if detail else None,
            ip_address=ip_address,
            trace_id=trace_id,
        )
        self._db.add(entry)
        await self._db.flush()

        logger.info(
            "audit",
            actor=actor,
            action=action,
            resource=resource,
            outcome=outcome,
            trace_id=trace_id,
        )
        return entry

    async def record_approval(
        self,
        actor: str,
        approval_id: str,
        approved: bool,
        note: str | None = None,
    ) -> AuditLogEntry:
        """Convenience method to record an approval decision."""
        return await self.record(
            actor=actor,
            action="approval.decided",
            resource=f"approval:{approval_id}",
            outcome=AuditOutcome.SUCCESS if approved else AuditOutcome.FAILURE,
            detail={"approved": approved, "note": note},
        )


def get_audit_log(db: AsyncSession) -> AuditLog:
    """Factory: create an :class:`AuditLog` for the given session."""
    return AuditLog(db=db)
