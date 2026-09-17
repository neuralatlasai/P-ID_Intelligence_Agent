"""Session persistence, isolation, serialisation and lifecycle.

These tests exercise the real SDK SQLite session against a temporary database file. They
prove the properties multi-turn correctness depends on: history survives a process
restart, sessions do not leak into one another, two turns of one session cannot interleave,
evicting a cached object does not delete history, and a persistence failure is visible.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest
from agents import Agent, Runner
from agents.testing import ScriptedModel, assistant_message

from pid_intelligence.memory.registry import (
    InvalidSessionIdError,
    SessionRegistry,
    validate_session_id,
)
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

_USER_A = [{"role": "user", "content": "FCV-2201 is the target."}]
_USER_B = [{"role": "user", "content": "P-2101A is the target."}]


def _registry(settings: Settings, metrics: MetricsRegistry, **overrides: object) -> SessionRegistry:
    options: dict[str, object] = {
        "db_path": settings.sqlite_path,
        "max_entries": 8,
        "idle_s": 60.0,
        "metrics": metrics,
    }
    options.update(overrides)
    return SessionRegistry(**options)  # type: ignore[arg-type]


def _agent(*replies: str) -> Agent[None]:
    model = ScriptedModel([[assistant_message(reply)] for reply in replies])
    return Agent[None](name="session-probe", model=model)


async def test_the_first_turn_is_persisted(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    entry, _ = await registry.acquire("alpha")
    try:
        await Runner.run(_agent("noted"), "first turn", session=entry.session, max_turns=3)
    finally:
        registry.release(entry)

    items = await registry.get_items("alpha")
    assert len(items) >= 2
    await registry.close()


async def test_the_second_turn_sees_the_first(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    agent = _agent("noted", "recalled")

    for text in ("FCV-2201 is the target.", "What is connected to it?"):
        entry, _ = await registry.acquire("alpha")
        try:
            await Runner.run(agent, text, session=entry.session, max_turns=3)
        finally:
            registry.release(entry)

    model = agent.model
    assert isinstance(model, ScriptedModel)
    second_call_input = repr(model.calls[-1].input)
    assert "FCV-2201 is the target." in second_call_input
    await registry.close()


async def test_history_survives_a_process_restart(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    first = _registry(settings, metrics)
    entry, _ = await first.acquire("alpha")
    try:
        await entry.session.add_items(_USER_A)
    finally:
        first.release(entry)
    await first.close()

    second = _registry(settings, metrics)
    restored = await second.get_items("alpha")
    assert restored[0]["content"] == "FCV-2201 is the target."
    await second.close()


async def test_sessions_are_isolated(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    for session_id, items in (("alpha", _USER_A), ("beta", _USER_B)):
        entry, _ = await registry.acquire(session_id)
        try:
            await entry.session.add_items(items)
        finally:
            registry.release(entry)

    alpha = repr(await registry.get_items("alpha"))
    beta = repr(await registry.get_items("beta"))
    assert "FCV-2201" in alpha and "P-2101A" not in alpha
    assert "P-2101A" in beta and "FCV-2201" not in beta
    await registry.close()


async def test_same_session_turns_serialise(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    observed: list[str] = []

    async def turn(label: str) -> None:
        entry, _ = await registry.acquire("alpha")
        try:
            observed.append(f"enter-{label}")
            await asyncio.sleep(0.02)
            observed.append(f"exit-{label}")
        finally:
            registry.release(entry)

    await asyncio.gather(turn("one"), turn("two"))
    assert observed in (
        ["enter-one", "exit-one", "enter-two", "exit-two"],
        ["enter-two", "exit-two", "enter-one", "exit-one"],
    )
    await registry.close()


async def test_different_sessions_run_concurrently(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    observed: list[str] = []

    async def turn(session_id: str) -> None:
        entry, _ = await registry.acquire(session_id)
        try:
            observed.append(f"enter-{session_id}")
            await asyncio.sleep(0.02)
            observed.append(f"exit-{session_id}")
        finally:
            registry.release(entry)

    await asyncio.gather(turn("alpha"), turn("beta"))
    assert observed[:2] == ["enter-alpha", "enter-beta"]
    await registry.close()


async def test_lock_wait_is_recorded(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    first, _ = await registry.acquire("alpha")
    waiter = asyncio.create_task(registry.acquire("alpha"))
    await asyncio.sleep(0.02)
    registry.release(first)
    second, waited = await waiter
    registry.release(second)
    assert waited > 0
    assert metrics.snapshot()["session_lock_wait_seconds_count"] >= 2
    await registry.close()


async def test_clearing_a_session_removes_its_history(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    entry, _ = await registry.acquire("alpha")
    try:
        await entry.session.add_items(_USER_A)
    finally:
        registry.release(entry)

    await registry.delete("alpha")
    assert await registry.get_items("alpha") == []
    await registry.close()


async def test_clearing_one_session_leaves_others_intact(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    for session_id, items in (("alpha", _USER_A), ("beta", _USER_B)):
        entry, _ = await registry.acquire(session_id)
        try:
            await entry.session.add_items(items)
        finally:
            registry.release(entry)

    await registry.delete("alpha")
    assert await registry.get_items("beta")
    await registry.close()


async def test_eviction_closes_the_object_without_deleting_history(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics, max_entries=1, idle_s=0.0)
    entry, _ = await registry.acquire("alpha")
    try:
        await entry.session.add_items(_USER_A)
    finally:
        registry.release(entry)

    evicted = await registry.prune()
    assert evicted >= 1
    assert "alpha" not in registry.cached_session_ids()
    assert await registry.get_items("alpha")
    await registry.close()


async def test_an_in_flight_session_is_never_evicted(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics, max_entries=1, idle_s=0.0)
    entry, _ = await registry.acquire("alpha")
    try:
        await registry.prune()
        assert "alpha" in registry.cached_session_ids()
    finally:
        registry.release(entry)
    await registry.close()


async def test_capacity_eviction_keeps_the_cache_bounded(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics, max_entries=2, idle_s=1000.0)
    for index in range(5):
        entry, _ = await registry.acquire(f"s{index}")
        registry.release(entry)
    assert len(registry.cached_session_ids()) <= 2
    await registry.close()


async def test_a_persistence_failure_is_raised_rather_than_swallowed(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    class FailingSession:
        session_id = "alpha"

        async def get_items(self, limit: int | None = None) -> list[dict[str, object]]:
            raise sqlite3.OperationalError("attempt to write a readonly database")

        async def add_items(self, items: list[dict[str, object]]) -> None:
            raise sqlite3.OperationalError("attempt to write a readonly database")

        async def pop_item(self) -> None:
            return None

        async def clear_session(self) -> None:
            raise sqlite3.OperationalError("attempt to write a readonly database")

    registry = _registry(settings, metrics, session_factory=lambda _id: FailingSession())
    with pytest.raises(sqlite3.OperationalError):
        await registry.get_items("alpha")
    assert metrics.snapshot()["sqlite_session_errors_total"] >= 1
    await registry.close()


async def test_a_closed_registry_refuses_new_sessions(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    registry = _registry(settings, metrics)
    await registry.close()
    with pytest.raises(RuntimeError, match="closed"):
        await registry.get("alpha")


@pytest.mark.parametrize(
    "session_id",
    ["", " ", "../escape", "a/b", "a\\b", "a b", "x" * 129, "-leading", "quote'id"],
)
def test_unsafe_session_identifiers_are_rejected(session_id: str) -> None:
    with pytest.raises(InvalidSessionIdError):
        validate_session_id(session_id)


@pytest.mark.parametrize("session_id", ["a", "session-1", "user.42_demo", "A1" * 60])
def test_conservative_session_identifiers_are_accepted(session_id: str) -> None:
    assert validate_session_id(session_id) == session_id


def test_no_application_conversation_table_is_created(
    settings: Settings,
    metrics: MetricsRegistry,
    tmp_path: Path,
) -> None:
    async def exercise() -> None:
        registry = _registry(settings, metrics)
        entry, _ = await registry.acquire("alpha")
        try:
            await entry.session.add_items(_USER_A)
        finally:
            registry.release(entry)
        await registry.close()

    asyncio.run(exercise())

    connection = sqlite3.connect(settings.sqlite_path)
    try:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    finally:
        connection.close()

    forbidden = {"chat_sessions", "messages", "turns", "conversations", "pid_messages"}
    assert not (tables & forbidden)
    assert "agent_sessions" in tables
    assert "agent_messages" in tables
