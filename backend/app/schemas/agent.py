"""Agent schemas."""
from datetime import datetime

from pydantic import BaseModel

from backend.app.models.agent_run import AgentRunStatus


class AgentRunResponse(BaseModel):
    id: str
    task_id: str
    agent_type: str
    agent_name: str
    status: AgentRunStatus
    input_data: str | None
    output_data: str | None
    error_message: str | None
    tokens_used: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AgentDispatchRequest(BaseModel):
    task_id: str
    agent_type: str = "worker"


class AgentDispatchResponse(BaseModel):
    run_id: str
    task_id: str
    agent_type: str
    status: AgentRunStatus
