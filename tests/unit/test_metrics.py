"""Metrics registry semantics and Prometheus exposition."""

from __future__ import annotations

import pytest

from pid_intelligence.observability.metrics import METRIC_NAMES, MetricsRegistry


def test_every_required_metric_name_is_declared() -> None:
    required = {
        "backend_requests_total",
        "backend_requests_inflight",
        "backend_request_duration_seconds",
        "agent_runs_total",
        "agent_run_duration_seconds",
        "agent_max_turns_exceeded_total",
        "openai_model_calls_total",
        "openai_model_call_duration_seconds",
        "openai_model_retries_total",
        "openai_status_errors_total",
        "openai_input_tokens_total",
        "openai_output_tokens_total",
        "tool_calls_total",
        "tool_call_duration_seconds",
        "tool_errors_total",
        "sqlite_session_reads_total",
        "sqlite_session_writes_total",
        "sqlite_session_errors_total",
        "session_items_loaded",
        "session_lock_wait_seconds",
        "corpus_files_scanned",
        "corpus_file_reads_total",
        "corpus_bytes_read_total",
        "graph_query_nodes_returned",
        "graph_query_edges_returned",
    }
    assert required <= set(METRIC_NAMES)


def test_counters_accumulate_per_label_set() -> None:
    registry = MetricsRegistry()
    registry.increment("tool_calls_total", tool="graph_summary")
    registry.increment("tool_calls_total", tool="graph_summary")
    registry.increment("tool_calls_total", tool="render_pdf_page")
    snapshot = registry.snapshot()
    assert snapshot['tool_calls_total{tool="graph_summary"}'] == 2
    assert snapshot['tool_calls_total{tool="render_pdf_page"}'] == 1


def test_a_counter_cannot_decrease() -> None:
    registry = MetricsRegistry()
    with pytest.raises(ValueError, match="cannot decrease"):
        registry.increment("tool_calls_total", -1.0)


def test_inflight_gauge_returns_to_zero_after_a_failure() -> None:
    registry = MetricsRegistry()
    with pytest.raises(RuntimeError), registry.track_inflight("backend_requests_inflight"):
        raise RuntimeError("boom")
    assert registry.snapshot()["backend_requests_inflight"] == 0


def test_durations_are_recorded_even_when_the_block_raises() -> None:
    registry = MetricsRegistry()
    with pytest.raises(RuntimeError), registry.time("agent_run_duration_seconds"):
        raise RuntimeError("boom")
    assert registry.snapshot()["agent_run_duration_seconds_count"] == 1


def test_histogram_buckets_are_cumulative_in_the_exposition() -> None:
    registry = MetricsRegistry()
    for value in (0.001, 0.3, 12.0, 10_000.0):
        registry.observe("tool_call_duration_seconds", value, tool="t")
    lines = registry.render_prometheus().splitlines()
    buckets = [line for line in lines if "_bucket" in line]
    counts = [int(line.rsplit(" ", 1)[1]) for line in buckets]
    assert counts == sorted(counts)
    assert counts[-1] == 4
    assert 'le="+Inf"' in buckets[-1]


def test_histogram_sum_and_count_are_exposed() -> None:
    registry = MetricsRegistry()
    registry.observe("session_lock_wait_seconds", 0.25)
    registry.observe("session_lock_wait_seconds", 0.75)
    rendered = registry.render_prometheus()
    assert "session_lock_wait_seconds_sum 1" in rendered
    assert "session_lock_wait_seconds_count 2" in rendered


def test_exposition_declares_help_and_type_for_each_series() -> None:
    registry = MetricsRegistry()
    registry.increment("agent_runs_total", outcome="success")
    rendered = registry.render_prometheus()
    assert "# HELP agent_runs_total" in rendered
    assert "# TYPE agent_runs_total counter" in rendered


def test_exposition_is_stable_for_unchanged_state() -> None:
    registry = MetricsRegistry()
    registry.increment("agent_runs_total", outcome="success")
    registry.increment("tool_calls_total", tool="graph_summary")
    assert registry.render_prometheus() == registry.render_prometheus()


def test_label_values_are_escaped() -> None:
    registry = MetricsRegistry()
    registry.increment("tool_errors_total", tool='weird"name')
    assert 'tool="weird\\"name"' in registry.render_prometheus()
