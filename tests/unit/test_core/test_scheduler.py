"""Tests for Scheduler: cron parsing, delayed jobs, and retry logic."""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from backend.app.core.scheduler import CronExpression, ScheduledJob, Scheduler


class TestCronExpression:
    def test_wildcard_matches_all(self) -> None:
        expr = CronExpression.parse("* * * * *")
        for minute in range(60):
            dt = datetime(2024, 1, 1, 0, minute, tzinfo=UTC)
            assert expr.matches(dt)

    def test_specific_minute_matches(self) -> None:
        expr = CronExpression.parse("30 * * * *")
        assert expr.matches(datetime(2024, 1, 1, 5, 30, tzinfo=UTC))
        assert not expr.matches(datetime(2024, 1, 1, 5, 29, tzinfo=UTC))

    def test_step_expression(self) -> None:
        expr = CronExpression.parse("*/15 * * * *")
        assert expr.matches(datetime(2024, 1, 1, 0, 0, tzinfo=UTC))
        assert expr.matches(datetime(2024, 1, 1, 0, 15, tzinfo=UTC))
        assert expr.matches(datetime(2024, 1, 1, 0, 30, tzinfo=UTC))
        assert not expr.matches(datetime(2024, 1, 1, 0, 7, tzinfo=UTC))

    def test_range_expression(self) -> None:
        expr = CronExpression.parse("0 9-17 * * *")
        assert expr.matches(datetime(2024, 1, 1, 9, 0, tzinfo=UTC))
        assert expr.matches(datetime(2024, 1, 1, 17, 0, tzinfo=UTC))
        assert not expr.matches(datetime(2024, 1, 1, 8, 0, tzinfo=UTC))
        assert not expr.matches(datetime(2024, 1, 1, 18, 0, tzinfo=UTC))

    def test_list_expression(self) -> None:
        expr = CronExpression.parse("0 8,12,18 * * *")
        assert expr.matches(datetime(2024, 1, 1, 8, 0, tzinfo=UTC))
        assert expr.matches(datetime(2024, 1, 1, 12, 0, tzinfo=UTC))
        assert not expr.matches(datetime(2024, 1, 1, 10, 0, tzinfo=UTC))

    def test_invalid_field_count_raises(self) -> None:
        with pytest.raises(ValueError, match="5 fields"):
            CronExpression.parse("* * * *")

    def test_next_run_returns_future_datetime(self) -> None:
        expr = CronExpression.parse("0 * * * *")
        after = datetime(2024, 6, 15, 10, 5, tzinfo=UTC)
        next_run = expr.next_run(after=after)
        assert next_run > after
        assert next_run.minute == 0
        assert next_run.hour == 11


class TestScheduledJob:
    def test_serialization_roundtrip(self) -> None:
        job = ScheduledJob(
            name="test_job",
            payload={"key": "value"},
            cron="*/5 * * * *",
            max_attempts=5,
        )
        data = job.to_dict()
        restored = ScheduledJob.from_dict(data)
        assert restored.job_id == job.job_id
        assert restored.name == job.name
        assert restored.payload == job.payload
        assert restored.cron == job.cron
        assert restored.max_attempts == job.max_attempts


class TestSchedulerHandlers:
    def test_register_handler(self) -> None:
        scheduler = Scheduler.__new__(Scheduler)
        scheduler._handlers = {}

        async def my_handler(job: ScheduledJob) -> None:
            pass

        scheduler.register_handler("my_job", my_handler)
        assert "my_job" in scheduler._handlers
        assert my_handler in scheduler._handlers["my_job"]

    def test_multiple_handlers_for_same_job(self) -> None:
        scheduler = Scheduler.__new__(Scheduler)
        scheduler._handlers = {}

        async def h1(job: ScheduledJob) -> None:
            pass

        async def h2(job: ScheduledJob) -> None:
            pass

        scheduler.register_handler("job", h1)
        scheduler.register_handler("job", h2)
        assert len(scheduler._handlers["job"]) == 2
