"""Failure injection.

Every injected failure must produce a deterministic, externally visible outcome: a stable
error code, a recorded metric, released resources, and no partial result presented as a
finished answer.
"""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import openai
import pytest
from agents.testing import ScriptedModel, assistant_message, function_call

from pid_intelligence.agent.runtime import (
    AdmissionTimeoutError,
    MaxTurnsExceededError,
    PIDRuntime,
    RunDeadlineExceededError,
    SessionPersistenceError,
    UpstreamModelError,
)
from pid_intelligence.memory.registry import SessionRegistry
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

_GRAPH = "area_100/PID-100-REV04.graphml"

RuntimeFactory = Callable[[ScriptedModel], PIDRuntime]


def _request() -> httpx.Request:
    """Build a placeholder upstream request for constructing provider exceptions."""
    return httpx.Request("POST", "https://api.openai.com/v1/responses")


def _status_error(status: int) -> openai.APIStatusError:
    """Build a provider status error carrying the given HTTP status."""
    response = httpx.Response(status_code=status, request=_request())
    return openai.APIStatusError("upstream failure", response=response, body=None)


async def test_rate_limiting_is_classified_and_counted(
    make_runtime: RuntimeFactory,
    metrics: MetricsRegistry,
) -> None:
    response = httpx.Response(status_code=429, request=_request())
    error = openai.RateLimitError("slow down", response=response, body=None)
    runtime = make_runtime(ScriptedModel([error]))

    with pytest.raises(UpstreamModelError) as caught:
        await runtime.run("throttled", "anything")
    assert caught.value.code == "upstream_rate_limited"
    snapshot = metrics.snapshot()
    assert snapshot['openai_status_errors_total{classification="upstream_rate_limited"}'] == 1


async def test_a_server_side_upstream_failure_is_classified_as_unavailable(
    make_runtime: RuntimeFactory,
) -> None:
    runtime = make_runtime(ScriptedModel([_status_error(503)]))
    with pytest.raises(UpstreamModelError) as caught:
        await runtime.run("outage", "anything")
    assert caught.value.code == "upstream_unavailable"


async def test_an_upstream_client_error_is_classified_as_rejected(
    make_runtime: RuntimeFactory,
) -> None:
    runtime = make_runtime(ScriptedModel([_status_error(400)]))
    with pytest.raises(UpstreamModelError) as caught:
        await runtime.run("rejected", "anything")
    assert caught.value.code == "upstream_request_rejected"


async def test_an_unreachable_provider_is_classified_as_unavailable(
    make_runtime: RuntimeFactory,
) -> None:
    error = openai.APIConnectionError(request=_request())
    runtime = make_runtime(ScriptedModel([error]))
    with pytest.raises(UpstreamModelError) as caught:
        await runtime.run("unreachable", "anything")
    assert caught.value.code == "upstream_unavailable"


async def test_a_provider_timeout_is_classified_as_a_timeout(
    make_runtime: RuntimeFactory,
) -> None:
    error = openai.APITimeoutError(request=_request())
    runtime = make_runtime(ScriptedModel([error]))
    with pytest.raises(UpstreamModelError) as caught:
        await runtime.run("slow", "anything")
    assert caught.value.code == "upstream_timeout"


async def test_the_run_deadline_bounds_a_slow_model(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
) -> None:
    class SlowModel(ScriptedModel):
        async def get_response(self, *args: object, **kwargs: object) -> object:
            await asyncio.sleep(5)
            raise AssertionError("the deadline should have fired first")

    runtime = PIDRuntime(
        agent=make_agent(SlowModel([])),
        registry=registry,
        settings=settings.model_copy(update={"run_deadline_s": 0.2}),
        metrics=metrics,
    )
    with pytest.raises(RunDeadlineExceededError, match="exceeded its deadline"):
        await runtime.run("slow-run", "anything")
    assert metrics.snapshot()['agent_runs_total{outcome="run_deadline_exceeded"}'] == 1


async def test_the_deadline_releases_the_session_lock(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
) -> None:
    class SlowModel(ScriptedModel):
        async def get_response(self, *args: object, **kwargs: object) -> object:
            await asyncio.sleep(5)
            raise AssertionError("unreachable")

    runtime = PIDRuntime(
        agent=make_agent(SlowModel([])),
        registry=registry,
        settings=settings.model_copy(update={"run_deadline_s": 0.2}),
        metrics=metrics,
    )
    with pytest.raises(RunDeadlineExceededError):
        await runtime.run("locked", "anything")

    entry = await registry.get("locked")
    assert entry.lock.locked() is False
    assert entry.inflight_count == 0


async def test_admission_is_refused_when_capacity_is_saturated(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
) -> None:
    class BlockingModel(ScriptedModel):
        async def get_response(self, *args: object, **kwargs: object) -> object:
            await asyncio.sleep(3)
            raise AssertionError("unreachable")

    saturating = settings.model_copy(update={"max_concurrent_runs": 1, "run_deadline_s": 0.3})
    runtime = PIDRuntime(
        agent=make_agent(BlockingModel([])),
        registry=registry,
        settings=saturating,
        metrics=metrics,
    )
    occupier = asyncio.create_task(runtime.run("occupier", "hold the slot"))
    await asyncio.sleep(0.05)

    with pytest.raises((AdmissionTimeoutError, RunDeadlineExceededError)):
        await runtime.run("refused", "should not be admitted")

    occupier.cancel()
    with pytest.raises((asyncio.CancelledError, RunDeadlineExceededError)):
        await occupier


async def test_cancellation_is_not_reported_as_success(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
) -> None:
    class SlowModel(ScriptedModel):
        async def get_response(self, *args: object, **kwargs: object) -> object:
            await asyncio.sleep(3)
            raise AssertionError("unreachable")

    runtime = PIDRuntime(
        agent=make_agent(SlowModel([])),
        registry=registry,
        settings=settings,
        metrics=metrics,
    )
    task = asyncio.create_task(runtime.run("cancelled", "anything"))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    snapshot = metrics.snapshot()
    assert 'agent_runs_total{outcome="success"}' not in snapshot
    assert snapshot['agent_runs_total{outcome="cancelled"}'] == 1

    entry = await registry.get("cancelled")
    assert entry.lock.locked() is False


async def test_a_session_persistence_failure_fails_the_request(
    settings: Settings,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
) -> None:
    class FailingSession:
        session_id = "broken"

        async def get_items(self, limit: int | None = None) -> list[dict[str, object]]:
            return []

        async def add_items(self, items: list[dict[str, object]]) -> None:
            raise sqlite3.OperationalError("attempt to write a readonly database")

        async def pop_item(self) -> None:
            return None

        async def clear_session(self) -> None:
            return None

    registry = SessionRegistry(
        db_path=settings.sqlite_path,
        max_entries=4,
        idle_s=60.0,
        metrics=metrics,
        session_factory=lambda _id: FailingSession(),
    )
    runtime = PIDRuntime(
        agent=make_agent(ScriptedModel([[assistant_message("done")]])),
        registry=registry,
        settings=settings,
        metrics=metrics,
    )
    with pytest.raises(SessionPersistenceError, match="not saved"):
        await runtime.run("broken", "anything")
    assert metrics.snapshot()["sqlite_session_errors_total"] >= 1
    await registry.close()


async def test_max_turns_produces_a_distinct_failure_and_metric(
    make_runtime: RuntimeFactory,
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    steps = [
        [function_call("graph_summary", {"path": _GRAPH}, call_id=f"c{index}")]
        for index in range(settings.max_agent_turns + 2)
    ]
    runtime = make_runtime(ScriptedModel(steps))
    with pytest.raises(MaxTurnsExceededError):
        await runtime.run("looping", "never stop")

    snapshot = metrics.snapshot()
    assert snapshot["agent_max_turns_exceeded_total"] == 1
    assert snapshot['agent_runs_total{outcome="max_turns_exceeded"}'] == 1


async def test_a_file_deleted_between_listing_and_loading_is_reported(
    make_runtime: RuntimeFactory,
    corpus_root: Path,
) -> None:
    doomed = corpus_root / "transient.png"
    doomed.write_bytes(b"\x89PNG\r\n\x1a\n")

    model = ScriptedModel(
        [
            [function_call("list_corpus_files", {"file_type": "png"}, call_id="c1")],
            [function_call("load_corpus_artifact", {"path": "transient.png"}, call_id="c2")],
            [assistant_message("The listed drawing was no longer present.")],
        ]
    )
    runtime = make_runtime(model)

    original = model.get_response

    async def delete_then_respond(*args: object, **kwargs: object) -> object:
        if doomed.exists() and len(model.calls) >= 1:
            doomed.unlink()
        return await original(*args, **kwargs)

    model.get_response = delete_then_respond  # type: ignore[method-assign]
    await runtime.run("transient", "Load the drawing you just listed.")

    outputs = [
        item.get("output")
        for call in model.calls
        for item in call.input
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    assert any("not found" in str(output) for output in outputs)


async def test_a_corrupt_pdf_is_reported_without_claiming_inspection(
    make_runtime: RuntimeFactory,
    corpus_root: Path,
) -> None:
    corrupt = corpus_root / "corrupt.pdf"
    corrupt.write_bytes(b"%PDF-1.7\nnot actually a pdf")

    model = ScriptedModel(
        [
            [
                function_call(
                    "search_pdf_text",
                    {"path": "corrupt.pdf", "query": "REV"},
                    call_id="c1",
                )
            ],
            [assistant_message("The document could not be read.")],
        ]
    )
    runtime = make_runtime(model)
    await runtime.run("corrupt", "Search the document.")

    outputs = [
        str(item.get("output"))
        for call in model.calls
        for item in call.input
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    assert any("Tool error" in output for output in outputs)


async def test_a_tool_timeout_becomes_a_model_visible_error(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    make_agent: Callable[[ScriptedModel], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pid_intelligence.corpus.graphml as graphml_module

    original = graphml_module.GraphRepository.summary

    def slow_summary(self: Any, path: Path) -> Any:
        import time

        time.sleep(1.0)
        return original(self, path)

    monkeypatch.setattr(graphml_module.GraphRepository, "summary", slow_summary)

    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH}, call_id="c1")],
            [assistant_message("The topology tool timed out.")],
        ]
    )
    from pid_intelligence.agent.factory import build_pid_agent
    from pid_intelligence.corpus.services import build_corpus_services

    tight = settings.model_copy(update={"tool_timeout_s": 0.05})
    agent = build_pid_agent(tight, build_corpus_services(tight), metrics).clone(model=model)
    runtime = PIDRuntime(agent=agent, registry=registry, settings=tight, metrics=metrics)

    await runtime.run("tool-timeout", "Summarise the topology file.")
    outputs = [
        str(item.get("output"))
        for call in model.calls
        for item in call.input
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    assert any("time" in output.lower() for output in outputs)


async def test_an_empty_corpus_yields_an_explicit_no_evidence_listing(
    settings: Settings,
    registry: SessionRegistry,
    metrics: MetricsRegistry,
    tmp_path: Path,
) -> None:
    from pid_intelligence.agent.factory import build_pid_agent
    from pid_intelligence.corpus.services import build_corpus_services

    empty = tmp_path / "empty-corpus"
    empty.mkdir()
    empty_settings = settings.model_copy(update={"corpus_root": empty})

    model = ScriptedModel(
        [
            [function_call("list_corpus_files", {}, call_id="c1")],
            [assistant_message("The corpus contains no artifacts, so no answer is supported.")],
        ]
    )
    agent = build_pid_agent(empty_settings, build_corpus_services(empty_settings), metrics).clone(
        model=model
    )
    runtime = PIDRuntime(agent=agent, registry=registry, settings=empty_settings, metrics=metrics)
    await runtime.run("empty", "What is in the corpus?")

    outputs = [
        str(item.get("output"))
        for call in model.calls
        for item in call.input
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    assert any("No corpus files" in output for output in outputs)
