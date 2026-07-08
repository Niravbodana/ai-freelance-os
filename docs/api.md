# AI Freelance OS – API Reference

Base URL: `http://localhost:8000/api/v1`

Interactive docs: `http://localhost:8000/docs` (development only)

## Health

### GET /health
Returns service status.

**Response 200:**
```json
{ "status": "ok", "version": "0.1.0" }
```

## Tasks

### POST /tasks
Create a new task.

**Request:**
```json
{
  "title": "Build landing page",
  "description": "Create a responsive landing page",
  "priority": "high"
}
```

**Response 201:** TaskResponse

### GET /tasks
List all tasks (paginated).

**Query params:** `offset`, `limit`

**Response 200:** `{ "items": [...], "total": N }`

### GET /tasks/{task_id}
Get a task by ID.

### PATCH /tasks/{task_id}
Update a task.

### DELETE /tasks/{task_id}
Delete a task.

## Agents

### POST /agents/dispatch
Dispatch an agent to handle a task.

**Request:**
```json
{
  "task_id": "01ABC...",
  "agent_type": "ceo"
}
```

Available `agent_type` values: `ceo`, `operations_manager`, `worker`, `qa`

**Response 202:** AgentDispatchResponse

## Approvals (Human-in-the-Loop)

### GET /approvals/pending
List all pending approvals requiring human action.

### POST /approvals/{approval_id}/decide
Approve or reject a pending action.

**Request:**
```json
{
  "approved": true,
  "reviewer_note": "Looks good, proceed"
}
```
