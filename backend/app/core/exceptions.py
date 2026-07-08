"""Custom application exceptions."""
from fastapi import HTTPException, status


class AppError(Exception):
    """Base application error."""

    def __init__(self, message: str, code: str = "APP_ERROR") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class NotFoundError(AppError):
    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__(f"{resource} '{resource_id}' not found", "NOT_FOUND")
        self.resource = resource
        self.resource_id = resource_id


class ValidationError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(message, "VALIDATION_ERROR")


class ApprovalRequiredError(AppError):
    def __init__(self, action: str) -> None:
        super().__init__(f"Human approval required for action: {action}", "APPROVAL_REQUIRED")
        self.action = action


class ApprovalTimeoutError(AppError):
    def __init__(self, approval_id: str) -> None:
        super().__init__(f"Approval '{approval_id}' timed out", "APPROVAL_TIMEOUT")


class AgentError(AppError):
    def __init__(self, agent_name: str, message: str) -> None:
        super().__init__(f"Agent '{agent_name}' error: {message}", "AGENT_ERROR")
        self.agent_name = agent_name


def not_found_exception(resource: str, resource_id: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "NOT_FOUND", "resource": resource, "id": resource_id},
    )


def approval_required_exception(action: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_202_ACCEPTED,
        detail={"code": "APPROVAL_REQUIRED", "action": action},
    )
