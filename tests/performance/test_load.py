"""Load characterisation.

These tests measure rather than assert quality thresholds: the architecture requires that
acceptance thresholds be approved from observed baseline data, not invented before
measurement. They therefore assert only structural expectations — same-session turns queue,
different sessions do not, and deterministic operations stay within an order of magnitude
of their intended cost — and print the distribution for the record.

They are excluded from the default gate by the ``performance`` marker. Run them with
``pytest -m performance``.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from collections.abc import Callable

import pytest
from agents.testing import ScriptedModel, assistant_message, function_call

from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.observability.metrics import MetricsRegistry

pytestmark = pytest.mark.performance

_GRAPH = "area_100/PID-100-REV04.graphml"

RuntimeFactory = Callable[[ScriptedModel], PIDRuntime]


def _percentiles(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    return {
        "p50": statistics.median(ordered),
        "p95": ordered[max(int(len(ordered) * 0.95) - 1, 0)],
        "p99": ordered[max(int(len(ordered) * 0.99) - 1, 0)],
    }


async def test_independent_sessions_scale_without_serialising(
    make_runtime: RuntimeFactory,
    metrics: MetricsRegistry,
) -> None:
    session_count = 24
    model = ScriptedModel([[assistant_message("ok")] for _ in range(session_count * 2)])
    runtime = make_runtime(model)

    started = time.perf_counter()
    await asyncio.gather(
        *(runtime.run(f"load-{index}", "measure me") for index in range(session_count))
    )
    elapsed = time.perf_counter() - started

    snapshot = metrics.snapshot()
    durations = snapshot["agent_run_duration_seconds_sum"]
    print(
        f"\nsessions={session_count} wall_clock={elapsed:.3f}s "
        f"run_time_total={durations:.3f}s "
        f"lock_wait_total={snapshot.get('session_lock_wait_seconds_sum', 0.0):.4f}s"
    )
    assert snapshot['agent_runs_total{outcome="success"}'] == session_count


async def test_same_session_turns_queue_by_design(
    make_runtime: RuntimeFactory,
    metrics: MetricsRegistry,
) -> None:
    turns = 8
    model = ScriptedModel([[assistant_message("ok")] for _ in range(turns * 2)])
    runtime = make_runtime(model)

    await asyncio.gather(*(runtime.run("single", "measure me") for _ in range(turns)))
    snapshot = metrics.snapshot()
    print(
        f"\nqueued_turns={turns} lock_wait_total={snapshot['session_lock_wait_seconds_sum']:.4f}s"
    )
    assert snapshot["session_lock_wait_seconds_count"] >= turns
    items = await runtime.registry.get_items("single")
    assert len(items) == turns * 2


async def test_graph_query_latency_distribution(services: CorpusServices, corpus_root) -> None:
    path = corpus_root / _GRAPH
    samples: list[float] = []
    for _ in range(200):
        started = time.perf_counter()
        services.graphs.neighbors(path, "P-2101A", hops=2)
        samples.append(time.perf_counter() - started)

    distribution = _percentiles(samples)
    print(f"\ngraph_neighbors latency seconds: {distribution}")
    assert distribution["p99"] < 0.5


async def test_corpus_scan_latency_distribution(services: CorpusServices) -> None:
    samples: list[float] = []
    for _ in range(50):
        started = time.perf_counter()
        services.scanner.entries(force_rescan=True)
        samples.append(time.perf_counter() - started)

    distribution = _percentiles(samples)
    print(f"\ncorpus scan latency seconds: {distribution}")
    assert distribution["p99"] < 2.0


async def test_tool_call_distribution_is_recorded_per_run(
    make_runtime: RuntimeFactory,
    metrics: MetricsRegistry,
) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH}, call_id="c1")],
            [
                function_call(
                    "graph_neighbors",
                    {"path": _GRAPH, "node": "P-2101A", "hops": 1},
                    call_id="c2",
                )
            ],
            [assistant_message("done")],
        ]
    )
    runtime = make_runtime(model)
    await runtime.run("tooling", "measure tool calls")

    snapshot = metrics.snapshot()
    tool_calls = sum(
        value for key, value in snapshot.items() if key.startswith("tool_calls_total{")
    )
    print(
        f"\nmodel_calls={snapshot['openai_model_calls_total']} "
        f"tool_calls={tool_calls} "
        f"run_seconds={snapshot['agent_run_duration_seconds_sum']:.4f}"
    )
    assert tool_calls == 2
    assert snapshot["openai_model_calls_total"] == 3
