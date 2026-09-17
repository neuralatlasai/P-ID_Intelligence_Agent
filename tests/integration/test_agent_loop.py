"""Agent-loop orchestration under a scripted model.

These tests assert the *shape* of the workflow — which tools are called, in what order,
and how many model calls the loop takes — without any provider call. An unexpected extra
model call fails the test, because a bounded workflow that silently grows is a defect.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from agents.testing import ScriptedModel, assistant_message, function_call

from pid_intelligence.agent.runtime import MaxTurnsExceededError, PIDRuntime

_GRAPH_REV03 = "area_100/PID-100-REV03.graphml"
_GRAPH_REV04 = "area_100/PID-100-REV04.graphml"
_PDF = "area_100/PID-100-REV04.pdf"
_PNG = "area_100/PID-100.png"

RuntimeFactory = Callable[[ScriptedModel], PIDRuntime]


def _tool_outputs(model: ScriptedModel) -> list[Any]:
    """Return every function-call output the model was shown, in order."""
    outputs: list[Any] = []
    seen: set[str] = set()
    for call in model.calls:
        for item in call.input:
            if isinstance(item, dict) and item.get("type") == "function_call_output":
                call_id = str(item.get("call_id"))
                if call_id not in seen:
                    seen.add(call_id)
                    outputs.append(item.get("output"))
    return outputs


def _rendered(output: Any) -> str:
    return output if isinstance(output, str) else json.dumps(output)


def _emitted_calls(model: ScriptedModel) -> list[str]:
    """Return the tool names the model emitted, in order, without duplicates."""
    names: list[str] = []
    seen: set[str] = set()
    for call in model.calls:
        for item in call.input:
            if isinstance(item, dict) and item.get("type") == "function_call":
                call_id = str(item.get("call_id"))
                if call_id not in seen:
                    seen.add(call_id)
                    names.append(str(item.get("name")))
    return names


async def test_single_drawing_workflow_is_bounded(make_runtime: RuntimeFactory) -> None:
    model = ScriptedModel(
        [
            [function_call("list_corpus_files", {"file_type": "png"}, call_id="c1")],
            [function_call("load_corpus_artifact", {"path": _PNG}, call_id="c2")],
            [assistant_message("Answer\nEvidence: area_100/PID-100.png")],
        ]
    )
    runtime = make_runtime(model)
    outcome = await runtime.run("drawing", "What equipment is on this drawing?")

    assert _emitted_calls(model) == ["list_corpus_files", "load_corpus_artifact"]
    model.assert_complete()
    assert len(outcome.output) == 1
    assert outcome.correlation.model_calls == 3


async def test_topology_workflow_uses_deterministic_graph_tools(
    make_runtime: RuntimeFactory,
) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH_REV04}, call_id="c1")],
            [
                function_call(
                    "graph_find_nodes",
                    {"path": _GRAPH_REV04, "query": "FCV-2201"},
                    call_id="c2",
                )
            ],
            [
                function_call(
                    "graph_neighbors",
                    {"path": _GRAPH_REV04, "node": "FCV-2201", "hops": 1},
                    call_id="c3",
                )
            ],
            [function_call("load_corpus_artifact", {"path": _PNG}, call_id="c4")],
            [assistant_message("Answer\nTopology: P-2101A -> FCV-2201 -> TK-2301")],
        ]
    )
    runtime = make_runtime(model)
    await runtime.run("topology", "What is connected to FCV-2201?")

    assert _emitted_calls(model) == [
        "graph_summary",
        "graph_find_nodes",
        "graph_neighbors",
        "load_corpus_artifact",
    ]
    rendered = " ".join(_rendered(output) for output in _tool_outputs(model))
    assert "directed graph" in rendered
    assert "P-2101A -> FCV-2201" in rendered
    model.assert_complete()


async def test_cross_revision_workflow_reads_both_revisions(
    make_runtime: RuntimeFactory,
) -> None:
    model = ScriptedModel(
        [
            [function_call("list_corpus_files", {"name_contains": "REV"}, call_id="c1")],
            [
                function_call(
                    "graph_neighbors",
                    {"path": _GRAPH_REV03, "node": "P-2101A", "hops": 1},
                    call_id="c2",
                )
            ],
            [
                function_call(
                    "graph_neighbors",
                    {"path": _GRAPH_REV04, "node": "P-2101A", "hops": 1},
                    call_id="c3",
                )
            ],
            [
                function_call(
                    "search_pdf_text",
                    {"path": _PDF, "query": "Supersedes"},
                    call_id="c4",
                )
            ],
            [assistant_message("Answer\nRevisions: REV04 adds PSV-2401.")],
        ]
    )
    runtime = make_runtime(model)
    await runtime.run("revisions", "What changed between REV03 and REV04?")

    rendered = [_rendered(output) for output in _tool_outputs(model)]
    assert any("PSV-2401" in text for text in rendered)
    assert not any("PSV-2401" in text for text in rendered[1:2])
    assert any("Supersedes" in text for text in rendered)
    model.assert_complete()


async def test_a_failed_tool_call_does_not_abort_the_run(
    make_runtime: RuntimeFactory,
) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": "broken.graphml"}, call_id="c1")],
            [function_call("load_corpus_artifact", {"path": _PNG}, call_id="c2")],
            [assistant_message("Structured topology unavailable; used the drawing instead.")],
        ]
    )
    runtime = make_runtime(model)
    outcome = await runtime.run("degraded", "What is on PID-100?")

    assert any("cannot parse" in _rendered(output) for output in _tool_outputs(model))
    assert len(outcome.output) == 1


async def test_exceeding_the_turn_bound_fails_rather_than_returning_partial_work(
    make_runtime: RuntimeFactory,
    settings: Any,
) -> None:
    steps = [
        [function_call("graph_summary", {"path": _GRAPH_REV04}, call_id=f"c{index}")]
        for index in range(settings.max_agent_turns + 3)
    ]
    runtime = make_runtime(ScriptedModel(steps))
    with pytest.raises(MaxTurnsExceededError, match="partial result is not returned"):
        await runtime.run("looping", "Keep going forever.")


async def test_the_run_records_outcome_and_tool_metrics(
    make_runtime: RuntimeFactory,
    metrics: Any,
) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH_REV04}, call_id="c1")],
            [assistant_message("done")],
        ]
    )
    runtime = make_runtime(model)
    await runtime.run("metrics", "Summarise the topology file.")

    snapshot = metrics.snapshot()
    assert snapshot['agent_runs_total{outcome="success"}'] == 1
    assert snapshot['tool_calls_total{tool="graph_summary"}'] == 1
    assert snapshot["openai_model_calls_total"] == 2
    assert snapshot["agent_run_duration_seconds_count"] == 1


async def test_streaming_yields_native_events_and_persists_history(
    make_runtime: RuntimeFactory,
) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH_REV04}, call_id="c1")],
            [assistant_message("streamed answer")],
        ]
    )
    runtime = make_runtime(model)

    events = [event async for event in runtime.run_streamed("stream", "Summarise.")]
    assert events
    assert all(hasattr(event, "type") for event in events)

    items = await runtime.registry.get_items("stream")
    assert len(items) >= 2


async def test_two_sessions_do_not_share_history(make_runtime: RuntimeFactory) -> None:
    model = ScriptedModel([[assistant_message("noted")] for _ in range(4)])
    runtime = make_runtime(model)

    await runtime.run("alpha", "FCV-2201 is the target.")
    await runtime.run("beta", "P-2101A is the target.")

    alpha = repr(await runtime.registry.get_items("alpha"))
    beta = repr(await runtime.registry.get_items("beta"))
    assert "FCV-2201" in alpha and "P-2101A" not in alpha
    assert "P-2101A" in beta and "FCV-2201" not in beta
