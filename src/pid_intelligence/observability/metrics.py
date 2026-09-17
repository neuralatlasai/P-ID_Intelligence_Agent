"""In-process metrics registry with a Prometheus text exposition.

The service records the counters, gauges and histograms the architecture requires without
taking a dependency on a metrics client library. The registry is a plain, thread-safe
in-memory structure: it is exported by scrape and is lost on restart, which is the correct
lifetime for demo-scale operational data.

No metric label carries user text, corpus content, tag values or session identifiers.
Labels are drawn from bounded vocabularies — tool name, file type, outcome class — so the
cardinality of the exposition is a property of the code rather than of the workload.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Final

__all__ = [
    "METRIC_NAMES",
    "MetricsRegistry",
    "Timer",
]

_DEFAULT_BUCKETS: Final[tuple[float, ...]] = (
    0.005,
    0.025,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
    120.0,
    300.0,
)

METRIC_NAMES: Final[tuple[str, ...]] = (
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
)
"""Every metric the service exposes. Asserted by tests so the set cannot silently shrink."""

_HELP: Final[Mapping[str, str]] = {
    "backend_requests_total": "HTTP requests completed, by route and status class.",
    "backend_requests_inflight": "HTTP requests currently being served.",
    "backend_request_duration_seconds": "End-to-end HTTP request duration.",
    "agent_runs_total": "Agent runs completed, by outcome.",
    "agent_run_duration_seconds": "Agent run duration from admission to final item.",
    "agent_max_turns_exceeded_total": "Runs that hit the configured maximum-turn bound.",
    "openai_model_calls_total": "Model calls observed through run lifecycle hooks.",
    "openai_model_call_duration_seconds": "Duration of one model call.",
    "openai_model_retries_total": "Model call attempts beyond the first for one logical call.",
    "openai_status_errors_total": "Upstream model failures, by classification.",
    "openai_input_tokens_total": "Input tokens reported by the model provider.",
    "openai_output_tokens_total": "Output tokens reported by the model provider.",
    "tool_calls_total": "Local function-tool invocations, by tool.",
    "tool_call_duration_seconds": "Local function-tool duration, by tool.",
    "tool_errors_total": "Local function-tool failures, by tool.",
    "sqlite_session_reads_total": "Session history reads through the SDK session interface.",
    "sqlite_session_writes_total": "Session history writes through the SDK session interface.",
    "sqlite_session_errors_total": "Session persistence failures.",
    "session_items_loaded": "Conversation items loaded for one run.",
    "session_lock_wait_seconds": "Time a run waited for its per-session lock.",
    "corpus_files_scanned": "Artifacts returned by one recursive corpus scan.",
    "corpus_file_reads_total": "Corpus artifact reads, by file type.",
    "corpus_bytes_read_total": "Corpus bytes read from disk.",
    "graph_query_nodes_returned": "Nodes returned by one graph query.",
    "graph_query_edges_returned": "Edges returned by one graph query.",
}

_Labels = tuple[tuple[str, str], ...]


@dataclass(slots=True)
class _Histogram:
    """Cumulative bucket counts, sum and observation count for one label set."""

    buckets: tuple[float, ...]
    counts: list[int] = field(default_factory=list)
    total: float = 0.0
    observations: int = 0

    def __post_init__(self) -> None:
        """Size the bucket counter list to match the configured boundaries."""
        if not self.counts:
            self.counts = [0] * len(self.buckets)

    def observe(self, value: float) -> None:
        """Record one observation into the first bucket that bounds it.

        Counts are stored per bucket rather than cumulatively; the exposition accumulates
        them when rendering, which is where the Prometheus format requires it.
        """
        self.total += value
        self.observations += 1
        for index, boundary in enumerate(self.buckets):
            if value <= boundary:
                self.counts[index] += 1
                return


class Timer:
    """Monotonic stopwatch used to time a block and report its elapsed seconds."""

    __slots__ = ("_elapsed", "_started")

    def __init__(self) -> None:
        """Start the stopwatch."""
        self._started = time.perf_counter()
        self._elapsed: float | None = None

    def stop(self) -> float:
        """Stop the stopwatch, returning elapsed seconds. Repeated calls are idempotent."""
        if self._elapsed is None:
            self._elapsed = time.perf_counter() - self._started
        return self._elapsed

    @property
    def elapsed(self) -> float:
        """Return elapsed seconds, stopping the stopwatch on first access if running."""
        return self.stop()


class MetricsRegistry:
    """Thread-safe registry of counters, gauges and histograms.

    Instances are explicitly owned and passed to collaborators. The module holds no
    global registry, so two services in one process do not share counters and tests
    observe only their own instance.
    """

    def __init__(self, *, buckets: Sequence[float] = _DEFAULT_BUCKETS) -> None:
        """Initialise an empty registry.

        Args:
            buckets: Ascending histogram boundaries in seconds, applied to every
                histogram in this registry.
        """
        self._buckets = tuple(sorted(buckets))
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, _Labels], float] = {}
        self._gauges: dict[tuple[str, _Labels], float] = {}
        self._histograms: dict[tuple[str, _Labels], _Histogram] = {}

    def increment(self, name: str, value: float = 1.0, **labels: str) -> None:
        """Add to a monotonic counter.

        Args:
            name: Metric name, which should appear in :data:`METRIC_NAMES`.
            value: Non-negative amount to add.
            **labels: Bounded-vocabulary label values.

        Raises:
            ValueError: If ``value`` is negative, which would break counter semantics.
        """
        if value < 0:
            raise ValueError(f"counter {name} cannot decrease")
        key = (name, _normalise(labels))
        with self._lock:
            self._counters[key] = self._counters.get(key, 0.0) + value

    def set_gauge(self, name: str, value: float, **labels: str) -> None:
        """Set a gauge to an absolute value."""
        key = (name, _normalise(labels))
        with self._lock:
            self._gauges[key] = value

    def adjust_gauge(self, name: str, delta: float, **labels: str) -> None:
        """Add a signed delta to a gauge, creating it at zero when absent."""
        key = (name, _normalise(labels))
        with self._lock:
            self._gauges[key] = self._gauges.get(key, 0.0) + delta

    def observe(self, name: str, value: float, **labels: str) -> None:
        """Record one histogram observation."""
        key = (name, _normalise(labels))
        with self._lock:
            histogram = self._histograms.get(key)
            if histogram is None:
                histogram = _Histogram(buckets=self._buckets)
                self._histograms[key] = histogram
            histogram.observe(value)

    @contextmanager
    def track_inflight(self, name: str, **labels: str) -> Iterator[None]:
        """Increment a gauge for the duration of a block and decrement on every exit path."""
        self.adjust_gauge(name, 1.0, **labels)
        try:
            yield
        finally:
            self.adjust_gauge(name, -1.0, **labels)

    @contextmanager
    def time(self, name: str, **labels: str) -> Iterator[Timer]:
        """Time a block and record its duration, including when the block raises."""
        timer = Timer()
        try:
            yield timer
        finally:
            self.observe(name, timer.stop(), **labels)

    def snapshot(self) -> dict[str, float]:
        """Return a flat mapping of every current value, for assertions and diagnostics.

        Returns:
            Keys are rendered as ``name{label="value"}`` for labelled series and as
            ``name`` otherwise. Histograms contribute ``_sum`` and ``_count`` series.
        """
        with self._lock:
            flat: dict[str, float] = {}
            for (name, labels), value in self._counters.items():
                flat[_render_key(name, labels)] = value
            for (name, labels), value in self._gauges.items():
                flat[_render_key(name, labels)] = value
            for (name, labels), histogram in self._histograms.items():
                flat[_render_key(f"{name}_sum", labels)] = histogram.total
                flat[_render_key(f"{name}_count", labels)] = float(histogram.observations)
            return flat

    def render_prometheus(self) -> str:
        """Render the registry in the Prometheus text exposition format.

        Returns:
            A newline-terminated exposition. Series are emitted in sorted order so a
            scrape of unchanged state is byte-identical.
        """
        with self._lock:
            counters = dict(self._counters)
            gauges = dict(self._gauges)
            histograms = dict(self._histograms)

        lines: list[str] = []
        for name in sorted({key[0] for key in counters}):
            lines.extend(_render_simple(name, "counter", counters))
        for name in sorted({key[0] for key in gauges}):
            lines.extend(_render_simple(name, "gauge", gauges))
        for name in sorted({key[0] for key in histograms}):
            lines.extend(_render_histogram(name, histograms, self._buckets))
        return "\n".join(lines) + "\n"


def _normalise(labels: Mapping[str, str]) -> _Labels:
    """Normalise a label mapping into a hashable, deterministically ordered key."""
    return tuple(sorted((str(key), str(value)) for key, value in labels.items()))


def _render_key(name: str, labels: _Labels) -> str:
    """Render a metric name and label set as a single snapshot key."""
    if not labels:
        return name
    rendered = ",".join(f'{key}="{value}"' for key, value in labels)
    return f"{name}{{{rendered}}}"


def _render_labels(labels: _Labels, extra: tuple[tuple[str, str], ...] = ()) -> str:
    """Render a label set in Prometheus syntax, escaping backslashes and quotes."""
    combined = tuple(labels) + extra
    if not combined:
        return ""
    rendered = ",".join(f'{key}="{_escape(value)}"' for key, value in combined)
    return f"{{{rendered}}}"


def _escape(value: str) -> str:
    """Escape a label value for the Prometheus text format."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _render_simple(
    name: str,
    metric_type: str,
    values: Mapping[tuple[str, _Labels], float],
) -> list[str]:
    """Render every series of one counter or gauge, with its HELP and TYPE headers."""
    lines = [
        f"# HELP {name} {_HELP.get(name, 'No description registered.')}",
        f"# TYPE {name} {metric_type}",
    ]
    for (series_name, labels), value in sorted(values.items(), key=lambda item: item[0]):
        if series_name != name:
            continue
        lines.append(f"{name}{_render_labels(labels)} {_format(value)}")
    return lines


def _render_histogram(
    name: str,
    values: Mapping[tuple[str, _Labels], _Histogram],
    buckets: tuple[float, ...],
) -> list[str]:
    """Render every series of one histogram, including the mandatory ``+Inf`` bucket."""
    lines = [
        f"# HELP {name} {_HELP.get(name, 'No description registered.')}",
        f"# TYPE {name} histogram",
    ]
    for (series_name, labels), histogram in sorted(values.items(), key=lambda item: item[0]):
        if series_name != name:
            continue
        cumulative = 0
        for boundary, count in zip(buckets, histogram.counts, strict=True):
            cumulative += count
            bucket_labels = _render_labels(labels, (("le", _format(boundary)),))
            lines.append(f"{name}_bucket{bucket_labels} {cumulative}")
        inf_labels = _render_labels(labels, (("le", "+Inf"),))
        lines.append(f"{name}_bucket{inf_labels} {histogram.observations}")
        lines.append(f"{name}_sum{_render_labels(labels)} {_format(histogram.total)}")
        lines.append(f"{name}_count{_render_labels(labels)} {histogram.observations}")
    return lines


def _format(value: float) -> str:
    """Render a float without a trailing ``.0`` for integral values."""
    if value == int(value):
        return str(int(value))
    return repr(value)
