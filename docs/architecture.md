# AI Freelance OS – Architecture

## Overview

AI Freelance OS is a production-grade multi-agent system built with Python (FastAPI) that orchestrates AI agents to assist with freelance work coordination. The system requires **human approval for all important actions**.

## Directory Structure

```
ai-freelance-os/
├── backend/          # FastAPI application
│   └── app/
│       ├── api/      # REST endpoints
│       ├── core/     # Logging, exceptions, security
│       ├── db/       # Database session & base
│       ├── models/   # SQLAlchemy ORM models
│       ├── schemas/  # Pydantic request/response schemas
│       └── services/ # Business logic
├── agents/           # Multi-agent system
│   ├── base_agent.py
│   ├── ceo_agent.py
│   ├── operations_manager_agent.py
│   ├── worker_agent.py
│   ├── qa_agent.py
│   └── registry.py
├── database/         # Alembic migrations & init SQL
├── prompts/          # LLM system prompts per agent
├── tests/            # Unit and integration tests
├── docs/             # Documentation
└── frontend/         # Future UI
```

## Agent Hierarchy

```
Human Operator
      │
      ▼
  CEO Agent          ← Strategic decisions, goal decomposition
      │
      ▼
Operations Manager  ← Task coordination, worker assignment
      │
      ▼
 Worker Agent(s)    ← Task execution
      │
      ▼
   QA Agent         ← Quality validation, approval requests
      │
      ▼
Human Approval      ← Required for important actions
```

## Memory System

| Layer       | Storage   | Use Case                    | TTL         |
|-------------|-----------|----------------------------|-------------|
| Short-term  | Redis     | Active task context         | 1 hour      |
| Long-term   | PostgreSQL| Task results, learned facts | Permanent   |

## Human-in-the-Loop

The system creates `Approval` records when:
- CEO detects a strategic decision requires human review
- QA agent marks output below quality threshold
- Any irreversible action is about to be taken

Approvals are surfaced via `GET /api/v1/approvals/pending` and resolved via `POST /api/v1/approvals/{id}/decide`.

## WhatsApp Integration (Future)

Environment variables `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are pre-configured. A future webhook handler at `/api/v1/webhooks/whatsapp` will relay approval requests and task updates via WhatsApp Business API.

## Design Principles

- **SOLID**: Each agent and service has a single responsibility
- **Type hints**: Full mypy strict mode compliance
- **Structured logging**: JSON logs via structlog
- **Configuration**: All settings via environment variables
- **Testability**: Dependency injection throughout; in-memory SQLite for tests
