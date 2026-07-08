"""Tests for RBAC, Secrets Manager, and Audit Log."""
from __future__ import annotations

import pytest

from backend.app.core.rbac import (
    AuditLog,
    AuditOutcome,
    EnvSecretsManager,
    InMemorySecretsManager,
    PermissionDeniedError,
    RBACEngine,
    Role,
    get_rbac,
    get_secrets_manager,
    set_secrets_manager,
)


class TestRBACEngine:
    def test_admin_has_all_permissions(self) -> None:
        rbac = RBACEngine()
        assert rbac.check(Role.ADMIN, "system:admin")
        assert rbac.check(Role.ADMIN, "tasks:delete")
        assert rbac.check(Role.ADMIN, "secrets:read")

    def test_viewer_has_read_only(self) -> None:
        rbac = RBACEngine()
        assert rbac.check(Role.VIEWER, "tasks:read")
        assert not rbac.check(Role.VIEWER, "tasks:delete")
        assert not rbac.check(Role.VIEWER, "system:admin")

    def test_operator_can_create_tasks(self) -> None:
        rbac = RBACEngine()
        assert rbac.check(Role.OPERATOR, "tasks:create")
        assert not rbac.check(Role.OPERATOR, "tasks:delete")

    def test_require_raises_on_denied(self) -> None:
        rbac = RBACEngine()
        with pytest.raises(PermissionDeniedError) as exc_info:
            rbac.require(Role.VIEWER, "tasks:delete")
        assert exc_info.value.role == Role.VIEWER
        assert exc_info.value.permission == "tasks:delete"

    def test_require_passes_on_allowed(self) -> None:
        rbac = RBACEngine()
        rbac.require(Role.ADMIN, "system:admin")  # should not raise

    def test_grant_adds_permission(self) -> None:
        rbac = RBACEngine()
        rbac.grant(Role.VIEWER, "tasks:create")
        assert rbac.check(Role.VIEWER, "tasks:create")

    def test_revoke_removes_permission(self) -> None:
        rbac = RBACEngine()
        rbac.revoke(Role.ADMIN, "system:admin")
        assert not rbac.check(Role.ADMIN, "system:admin")

    def test_unknown_role_returns_false(self) -> None:
        rbac = RBACEngine()
        assert not rbac.check("nonexistent_role", "tasks:read")

    def test_permissions_for_returns_frozenset(self) -> None:
        rbac = RBACEngine()
        perms = rbac.permissions_for(Role.OPERATOR)
        assert isinstance(perms, frozenset)
        assert len(perms) > 0


class TestGetRbac:
    def test_singleton_returns_same_instance(self) -> None:
        a = get_rbac()
        b = get_rbac()
        assert a is b


class TestInMemorySecretsManager:
    async def test_set_and_get(self) -> None:
        mgr = InMemorySecretsManager()
        await mgr.set("MY_KEY", "secret_value")
        value = await mgr.get("MY_KEY")
        assert value == "secret_value"

    async def test_missing_key_returns_none(self) -> None:
        mgr = InMemorySecretsManager()
        assert await mgr.get("NONEXISTENT") is None

    async def test_delete_removes_key(self) -> None:
        mgr = InMemorySecretsManager()
        await mgr.set("KEY", "value")
        await mgr.delete("KEY")
        assert await mgr.get("KEY") is None

    async def test_initial_values(self) -> None:
        mgr = InMemorySecretsManager({"A": "1", "B": "2"})
        assert await mgr.get("A") == "1"


class TestEnvSecretsManager:
    async def test_get_existing_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TEST_SECRET", "env_value")
        mgr = EnvSecretsManager()
        assert await mgr.get("TEST_SECRET") == "env_value"

    async def test_get_missing_returns_none(self) -> None:
        mgr = EnvSecretsManager()
        assert await mgr.get("__SURELY_NOT_SET__") is None

    async def test_set_updates_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mgr = EnvSecretsManager()
        await mgr.set("MY_TEST_VAR", "hello")
        assert await mgr.get("MY_TEST_VAR") == "hello"


class TestSetSecretsManager:
    def test_set_replaces_singleton(self) -> None:
        original = get_secrets_manager()
        custom = InMemorySecretsManager()
        set_secrets_manager(custom)
        assert get_secrets_manager() is custom
        # Restore
        set_secrets_manager(original)


class TestAuditLog:
    async def test_record_creates_entry(self, db_session) -> None:
        audit = AuditLog(db=db_session)
        entry = await audit.record(
            actor="user:123",
            action="task.created",
            resource="task:abc",
        )
        assert entry.actor == "user:123"
        assert entry.action == "task.created"
        assert entry.outcome == AuditOutcome.SUCCESS

    async def test_record_failure_outcome(self, db_session) -> None:
        audit = AuditLog(db=db_session)
        entry = await audit.record(
            actor="system",
            action="login.failed",
            outcome=AuditOutcome.FAILURE,
        )
        assert entry.outcome == AuditOutcome.FAILURE

    async def test_record_approval(self, db_session) -> None:
        audit = AuditLog(db=db_session)
        entry = await audit.record_approval(
            actor="reviewer:bob",
            approval_id="appr-123",
            approved=True,
            note="LGTM",
        )
        assert entry.action == "approval.decided"
        assert entry.outcome == AuditOutcome.SUCCESS
        assert "appr-123" in entry.resource

    async def test_record_approval_rejected(self, db_session) -> None:
        audit = AuditLog(db=db_session)
        entry = await audit.record_approval(
            actor="reviewer:alice",
            approval_id="appr-456",
            approved=False,
        )
        assert entry.outcome == AuditOutcome.FAILURE
