"""Fixtures for HTTP-level integration tests."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
import pytest
from agents.testing import ScriptedModel
from fastapi import FastAPI

from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.main import build_app
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

AppFactory = Callable[[ScriptedModel], FastAPI]


@pytest.fixture
def make_app(
    make_runtime: Callable[[ScriptedModel], PIDRuntime],
    settings: Settings,
    metrics: MetricsRegistry,
    services: CorpusServices,
) -> AppFactory:
    """Return a factory building the real application around a scripted model."""

    def _build(model: ScriptedModel) -> FastAPI:
        runtime = make_runtime(model)
        return build_app(
            runtime=runtime,
            settings=settings,
            metrics=metrics,
            services=services,
        )

    return _build


@pytest.fixture
def client_for(make_app: AppFactory):
    """Return an async context manager yielding an HTTP client bound to the app.

    The application's lifespan runs for the duration of the block, so the session sweeper
    starts and the session registry is closed exactly as it would be in production.
    """

    @asynccontextmanager
    async def _client(model: ScriptedModel) -> AsyncIterator[httpx.AsyncClient]:
        app = make_app(model)
        transport = httpx.ASGITransport(app=app)
        async with (
            httpx.AsyncClient(transport=transport, base_url="http://testserver") as http,
            app.router.lifespan_context(app),
        ):
            yield http

    return _client
