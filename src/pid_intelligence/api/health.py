"""Liveness, readiness and metrics endpoints.

These endpoints are independent of the model plane. Liveness answers whether the process
is running; readiness answers whether it can actually serve a run, which means the corpus
is readable and the session database is writable. Neither calls a model, so a provider
outage never makes the process look dead to an orchestrator.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse, PlainTextResponse

from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.observability.metrics import MetricsRegistry

__all__ = ["ReadinessReport", "build_health_router", "check_readiness"]

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ReadinessReport:
    """Outcome of the readiness probe.

    Attributes:
        ready: Whether every dependency check passed.
        checks: Per-dependency status, keyed by dependency name.
        corpus_files: Number of served artifacts currently discoverable, or ``None`` when
            discovery failed.
    """

    ready: bool
    checks: dict[str, str]
    corpus_files: int | None

    def as_payload(self) -> dict[str, object]:
        """Render the report as the readiness response body."""
        return {
            "status": "ready" if self.ready else "not_ready",
            "checks": self.checks,
            "corpus_files": self.corpus_files,
        }


async def check_readiness(services: CorpusServices, sqlite_path: Path) -> ReadinessReport:
    """Probe the dependencies a run needs before accepting traffic.

    Two things are checked: the corpus root is readable and enumerable, and the session
    database can be opened for writing. Both are proven by doing the work, not by trusting
    a startup-time result, so a permission change or an unmounted volume is detected.

    Args:
        services: Shared corpus services bound to the configured corpus root.
        sqlite_path: Path to the session database.

    Returns:
        A report naming each dependency and its status.

    Side effects:
        Enumerates the corpus and opens the session database. It creates the database file
        if absent, which is the same action the first run would take.
    """
    checks: dict[str, str] = {}
    corpus_files: int | None = None

    try:
        entries = await asyncio.to_thread(services.scanner.entries)
        corpus_files = len(entries)
        checks["corpus"] = "ok" if os.access(services.corpus_root, os.R_OK) else "unreadable"
    except OSError as exc:
        _LOGGER.warning("readiness: corpus scan failed: %s", type(exc).__name__)
        checks["corpus"] = "unreadable"

    try:
        await asyncio.to_thread(_probe_sqlite, sqlite_path)
        checks["session_store"] = "ok"
    except (OSError, sqlite3.Error) as exc:
        _LOGGER.warning("readiness: session store probe failed: %s", type(exc).__name__)
        checks["session_store"] = "unwritable"

    return ReadinessReport(
        ready=all(status == "ok" for status in checks.values()),
        checks=checks,
        corpus_files=corpus_files,
    )


def build_health_router(
    runtime: PIDRuntime,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> APIRouter:
    """Build the liveness, readiness and metrics routes.

    Args:
        runtime: The configured runtime, consulted for the session database path.
        services: Shared corpus services used by the readiness probe.
        metrics: Registry rendered by the metrics endpoint.

    Returns:
        A router exposing ``GET /healthz``, ``GET /readyz`` and ``GET /metrics``.
    """
    router = APIRouter(tags=["operations"])

    @router.get("/healthz", summary="Liveness probe")
    async def healthz() -> JSONResponse:
        """Report that the process is running and able to serve requests.

        This check makes no dependency call, so it stays green during a provider outage
        and an orchestrator does not restart a process that is merely degraded.
        """
        return JSONResponse({"status": "ok"})

    @router.get("/readyz", summary="Readiness probe")
    async def readyz() -> JSONResponse:
        """Report whether the corpus and the session store are usable right now."""
        report = await check_readiness(services, runtime.registry.db_path)
        status = HTTPStatus.OK if report.ready else HTTPStatus.SERVICE_UNAVAILABLE
        return JSONResponse(report.as_payload(), status_code=status)

    @router.get("/metrics", summary="Prometheus metrics exposition")
    async def prometheus_metrics() -> Response:
        """Expose the process's counters, gauges and histograms.

        The exposition carries identifiers from bounded vocabularies only: no session
        identifier, no user text and no corpus content appears in a label.
        """
        return PlainTextResponse(
            metrics.render_prometheus(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    return router


def _probe_sqlite(sqlite_path: Path) -> None:
    """Open the session database and prove it is writable.

    The probe runs a transaction that is immediately rolled back, so it verifies write
    capability without adding a row to any table the SDK owns.
    """
    connection = sqlite3.connect(sqlite_path, timeout=2.0)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.rollback()
    finally:
        connection.close()
