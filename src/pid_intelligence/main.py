"""Application assembly, startup, shutdown and the console entry point.

Importing this module has no effect beyond defining names: it opens no database, reads no
configuration, starts no server and creates no directory. Construction happens in
:func:`create_app`, which is the factory an ASGI server is pointed at.

Startup order is fixed and each step is a gate on the next: validate settings, resolve the
corpus root, prepare the session database location, build the corpus services, construct
the immutable agent, construct the session registry, construct the admission semaphore,
configure tracing and logging, then serve.

The deployment baseline is one process with one worker. The per-session lock that keeps
turn ordering correct is process-local, so a second worker would break that guarantee
without a distributed ownership mechanism that is out of scope for this baseline.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from agents import set_default_openai_key, set_tracing_disabled
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from pid_intelligence import __version__
from pid_intelligence.agent.factory import build_pid_agent
from pid_intelligence.agent.instructions import PROMPT_VERSION
from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.api.canvas import build_canvas_router
from pid_intelligence.api.errors import error_response
from pid_intelligence.api.health import build_health_router
from pid_intelligence.api.runs import build_runs_router
from pid_intelligence.corpus.services import CorpusServices, build_corpus_services
from pid_intelligence.memory.registry import SessionRegistry
from pid_intelligence.observability.metrics import MetricsRegistry, Timer
from pid_intelligence.settings import ConfigurationError, Settings

__all__ = ["build_app", "configure_logging", "create_app", "main"]

_LOGGER = logging.getLogger("pid_intelligence")

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging(level: str) -> None:
    """Configure logging for the application process.

    This is called by the application entry point, never at import time: a library that
    configures global logging on import takes a decision that belongs to whoever runs the
    process.

    Args:
        level: A logging level name already validated by the settings loader.
    """
    logging.basicConfig(level=getattr(logging, level), format=_LOG_FORMAT, force=True)


def build_app(
    *,
    runtime: PIDRuntime,
    settings: Settings,
    metrics: MetricsRegistry,
    services: CorpusServices,
) -> FastAPI:
    """Assemble the ASGI application around an already-constructed runtime.

    Taking the runtime as an argument keeps the transport replaceable and lets tests drive
    the same application with a scripted model and a temporary corpus.

    Args:
        runtime: The configured runtime executing admitted runs.
        settings: Validated configuration, used for metadata and the eviction interval.
        metrics: Registry exposed by the metrics endpoint and updated by middleware.
        services: Shared corpus services used by the readiness probe.

    Returns:
        A FastAPI application with the operations and run routers mounted, a request
        metrics middleware installed, and a lifespan that prunes and closes the session
        registry.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """Run the periodic session-cache sweep for the lifetime of the application.

        On shutdown the sweep is cancelled and every cached session object is closed.
        Closing an object releases a file handle; it never deletes conversation history.
        """
        del app
        sweeper = asyncio.create_task(
            _sweep_sessions(runtime.registry, settings.session_cache_sweep_interval_s),
            name="pid-session-sweeper",
        )
        _LOGGER.info(
            "service ready: version=%s prompt_version=%s model=%s corpus_root=%s",
            __version__,
            PROMPT_VERSION,
            settings.openai_model,
            settings.corpus_root,
        )
        try:
            yield
        finally:
            sweeper.cancel()
            with suppress(asyncio.CancelledError):
                await sweeper
            await runtime.registry.close()
            _LOGGER.info("service stopped")

    app = FastAPI(
        title="P&ID Intelligence Agent",
        version=__version__,
        summary="Engineering reasoning over a local P&ID corpus, on the OpenAI Agents SDK.",
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def record_request_metrics(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        """Count, time and track every HTTP request.

        The route template is resolved after the request has been routed and is used as
        the metric label in place of the concrete path, so session identifiers never enter
        metric cardinality. Timing is recorded against that label rather than started with
        it, because the template is not yet known when the middleware begins.
        """
        timer = Timer()
        with metrics.track_inflight("backend_requests_inflight"):
            try:
                response = await call_next(request)
            finally:
                route = _route_template(request)
                metrics.observe("backend_request_duration_seconds", timer.stop(), route=route)
        metrics.increment(
            "backend_requests_total",
            route=route,
            status=f"{response.status_code // 100}xx",
        )
        return response

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        """Convert an unhandled exception into the minimal transport error body.

        This is a process boundary: the exception is logged with its traceback for
        operators and reported to the client generically, because an unhandled
        exception's message is not a controlled surface.
        """
        request_id = request.headers.get("x-request-id", "unknown")
        _LOGGER.exception("unhandled request failure: path=%s", request.url.path)
        return error_response(exc, request_id=request_id)

    app.include_router(build_health_router(runtime, services, metrics))
    app.include_router(build_runs_router(runtime))
    app.include_router(build_canvas_router(services, settings))
    return app


def create_app(**overrides: object) -> FastAPI:
    """Load configuration, construct every component and return the application.

    This is the ASGI factory. Point a server at it with ``--factory``; do not import a
    module-level application object, because constructing one at import time would make
    importing the package perform configuration and filesystem work.

    Args:
        **overrides: Settings overrides taking precedence over the environment, used by
            tests and by embedding processes.

    Returns:
        A fully wired application.

    Raises:
        ConfigurationError: If the configuration is invalid, the corpus root is missing,
            or the session database location is not writable.

    Side effects:
        Configures process logging, creates the session database's parent directory, and
        sets the SDK's default API key and tracing state.
    """
    settings = Settings.load_and_validate(**overrides)
    configure_logging(settings.log_level)

    if settings.openai_api_key:
        set_default_openai_key(settings.openai_api_key, use_for_tracing=settings.enable_tracing)
    set_tracing_disabled(not settings.tracing_enabled)
    if settings.enable_tracing and not settings.tracing_enabled:
        _LOGGER.warning(
            "tracing was requested but no API key is configured; traces cannot be exported"
        )

    metrics = MetricsRegistry()
    services = build_corpus_services(settings)
    agent = build_pid_agent(settings, services, metrics)
    registry = SessionRegistry(
        db_path=settings.sqlite_path,
        max_entries=settings.session_cache_max_entries,
        idle_s=settings.session_cache_idle_s,
        history_limit=settings.session_history_limit,
        metrics=metrics,
    )
    runtime = PIDRuntime(
        agent=agent,
        registry=registry,
        settings=settings,
        metrics=metrics,
    )
    _LOGGER.info("configuration loaded: %s", settings.describe())
    return build_app(runtime=runtime, settings=settings, metrics=metrics, services=services)


def main() -> int:
    """Run the service with a single Uvicorn worker.

    One worker is deliberate: the per-session lock that serialises turns is process-local,
    so a second worker would allow two turns of one conversation to interleave.

    Returns:
        ``0`` on clean shutdown, ``2`` when configuration is invalid, and ``3`` when the
        optional server dependency is not installed.
    """
    try:
        settings = Settings.load_and_validate()
    except ConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)  # noqa: T201 - CLI diagnostic
        return 2

    try:
        # Delayed import: the ASGI server is an optional extra, so the package must be
        # importable and testable without it. Importing at module scope would make the
        # whole package depend on a dependency only the console entry point needs.
        import uvicorn  # noqa: PLC0415
    except ImportError:
        print(  # noqa: T201 - CLI diagnostic
            "uvicorn is not installed; install the 'server' extra: "
            "pip install 'pid-intelligence[server]'",
            file=sys.stderr,
        )
        return 3

    uvicorn.run(
        "pid_intelligence.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level=settings.log_level.lower(),
    )
    return 0


async def _sweep_sessions(registry: SessionRegistry, interval_s: float) -> None:
    """Evict idle session objects on a fixed interval until cancelled.

    A sweep failure is logged and the loop continues: eviction is an optimisation, and
    stopping it must not take the service down.
    """
    while True:
        await asyncio.sleep(interval_s)
        try:
            evicted = await registry.prune()
        except Exception as exc:  # noqa: BLE001 - background task boundary: a failed
            # sweep is an optimisation loss and must not take the service down.
            _LOGGER.warning("session sweep failed: %s", type(exc).__name__)
            continue
        if evicted:
            _LOGGER.debug("session sweep evicted %d idle session object(s)", evicted)


def _route_template(request: Request) -> str:
    """Return the matched route template, or a bounded fallback.

    Using the template rather than the concrete path keeps session identifiers out of
    metric labels, which would otherwise grow cardinality without bound.
    """
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path:
        return path
    return "unmatched"
