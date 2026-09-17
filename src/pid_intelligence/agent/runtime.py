"""Run orchestration: admission, serialisation, deadlines, cancellation and classification.

The runtime is deliberately thin. It decides *whether* and *when* a run may start, bounds
how long it may take, guarantees that two turns of one conversation cannot interleave, and
classifies failures into stable codes the transport can map to status codes. Everything
inside the run — the agent loop, tool dispatch, model calls, session loading and
persistence, tracing — belongs to the Agents SDK and is not reimplemented here.

Two properties are load-bearing:

* the per-session lock is held for the *whole* run, including the SDK's post-response
  session persistence, so a second turn never observes a half-written history;
* on every exit path, including cancellation, the session lock and the global admission
  slot are released. A cancelled run is never reported as a success.

The local session is the sole authority for conversation continuity, so no run sets
``previous_response_id``, ``auto_previous_response_id`` or ``conversation_id``. Mixing
server-managed continuation with a client-managed session would create two histories and
ambiguous ownership.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Any, Final

import openai
from agents import Agent, RunConfig, Runner, ToolExecutionConfig
from agents.exceptions import (
    AgentsException,
    MaxTurnsExceeded,
    ModelBehaviorError,
    ModelTimeoutError,
    UserError,
)
from agents.items import TResponseInputItem
from agents.stream_events import RawResponsesStreamEvent
from agents.tracing import get_current_trace

from pid_intelligence.memory.registry import SessionEntry, SessionRegistry
from pid_intelligence.observability.hooks import CorrelationContext, RunObservabilityHooks
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

__all__ = [
    "AdmissionTimeoutError",
    "AgentRunError",
    "MaxTurnsExceededError",
    "PIDRuntime",
    "RunDeadlineExceededError",
    "RunOutcome",
    "SessionPersistenceError",
    "UpstreamModelError",
]

_LOGGER = logging.getLogger(__name__)

_WORKFLOW_NAME: Final[str] = "pid-intelligence-run"
_UPSTREAM_SERVER_ERROR_STATUS: Final[int] = 500


class AgentRunError(RuntimeError):
    """Base class for run failures that the transport maps to a status code.

    Attributes:
        code: Stable, machine-readable classification. The transport maps it to an HTTP
            status; clients may branch on it. It is part of the backend's transport
            contract, not a model output schema.
    """

    code = "internal_error"

    def __init__(self, message: str) -> None:
        """Initialise the failure with an operator- and client-safe message."""
        super().__init__(message)


class AdmissionTimeoutError(AgentRunError):
    """The global admission limit was saturated for the whole request budget."""

    code = "admission_limit"


class RunDeadlineExceededError(AgentRunError):
    """The run exceeded its overall deadline."""

    code = "run_deadline_exceeded"


class MaxTurnsExceededError(AgentRunError):
    """The agent loop hit the configured maximum-turn bound.

    The partial work is discarded rather than returned. An incomplete investigation must
    not be presented as a finished engineering answer.
    """

    code = "max_turns_exceeded"


class UpstreamModelError(AgentRunError):
    """The model provider failed, timed out, throttled or was unreachable."""

    def __init__(self, message: str, code: str) -> None:
        """Initialise with a classification distinguishing throttling from outage."""
        super().__init__(message)
        self.code = code


class SessionPersistenceError(AgentRunError):
    """Conversation history could not be persisted.

    History durability is part of correctness, so this fails the request. The service does
    not continue silently with an unpersisted turn.
    """

    code = "session_persistence_failed"


@dataclass(frozen=True, slots=True)
class RunOutcome:
    """The result of one non-streaming run.

    Attributes:
        output: Native OpenAI Responses output items from the final model response. They
            are returned unchanged; no domain envelope is wrapped around them.
        correlation: Identifiers, model-call count and token usage for the run. This is
            observability data, carried beside the payload rather than inside it.
    """

    output: Sequence[Any]
    correlation: CorrelationContext


class PIDRuntime:
    """Executes agent runs under admission, serialisation and deadline policy.

    One instance is constructed at startup and shared by every request. It holds the
    immutable agent definition, the session registry, the metrics registry and the global
    admission semaphore.
    """

    def __init__(
        self,
        *,
        agent: Agent[None],
        registry: SessionRegistry,
        settings: Settings,
        metrics: MetricsRegistry,
    ) -> None:
        """Initialise the runtime.

        Args:
            agent: The immutable agent definition every run starts from.
            registry: Session object cache providing per-session locks.
            settings: Validated configuration supplying every bound.
            metrics: Registry receiving run-level series.
        """
        self._agent = agent
        self._registry = registry
        self._settings = settings
        self._metrics = metrics
        self._admission = asyncio.Semaphore(settings.max_concurrent_runs)

    @property
    def settings(self) -> Settings:
        """Return the validated configuration this runtime enforces."""
        return self._settings

    @property
    def registry(self) -> SessionRegistry:
        """Return the session registry backing this runtime."""
        return self._registry

    async def run(
        self,
        session_id: str,
        input_items: str | list[TResponseInputItem],
        *,
        request_id: str | None = None,
    ) -> RunOutcome:
        """Execute one non-streaming run and return its native output items.

        Args:
            session_id: Validated conversation identifier. It is transport metadata and is
                never injected into the model payload.
            input_items: The user's instruction as an OpenAI Responses-compatible string
                or input-item list. It is passed through unchanged.
            request_id: Backend request identifier for correlation. Generated when absent.

        Returns:
            The final model response's output items together with the run's correlation
            data.

        Raises:
            AdmissionTimeoutError: If no admission slot became available within the
                request budget.
            RunDeadlineExceededError: If the run exceeded its overall deadline.
            MaxTurnsExceededError: If the agent loop hit the maximum-turn bound.
            UpstreamModelError: If the model provider failed, throttled or timed out.
            SessionPersistenceError: If conversation history could not be persisted.
            AgentRunError: For any other classified run failure.
        """
        correlation = CorrelationContext(
            request_id=request_id or _new_request_id(),
            session_id=session_id,
        )
        hooks = RunObservabilityHooks(self._metrics, correlation)
        deadline = asyncio.get_running_loop().time() + self._settings.run_deadline_s

        async with self._admitted(session_id, deadline) as entry:
            with self._metrics.time("agent_run_duration_seconds"):
                try:
                    async with asyncio.timeout_at(deadline):
                        result = await Runner.run(
                            self._agent,
                            input_items,
                            session=entry.session,
                            max_turns=self._settings.max_agent_turns,
                            run_config=self._run_config(),
                            hooks=hooks,
                        )
                except BaseException as exc:
                    self._record_outcome(_classify_outcome(exc))
                    raise self._translate(exc) from exc

            correlation.trace_id = _current_trace_id()
            self._record_outcome("success")
            self._metrics.increment("sqlite_session_writes_total")

            if not result.raw_responses:
                raise AgentRunError(
                    "the run produced no model response; no output items are available"
                )
            _LOGGER.info("run completed: %s", correlation.as_log_fields())
            return RunOutcome(output=result.raw_responses[-1].output, correlation=correlation)

    async def run_streamed(
        self,
        session_id: str,
        input_items: str | list[TResponseInputItem],
        *,
        request_id: str | None = None,
    ) -> AsyncIterator[Any]:
        """Execute one streaming run, yielding native OpenAI Responses stream events.

        Only raw model events are yielded, and their payloads are forwarded verbatim. No
        application token-delta schema is introduced.

        The run is not finished when the last visible token is emitted: the SDK may still
        persist session items and run final lifecycle hooks. The admission slot and the
        session lock are therefore held until the event stream itself completes.

        Args:
            session_id: Validated conversation identifier.
            input_items: The user's instruction as an OpenAI Responses-compatible string
                or input-item list.
            request_id: Backend request identifier for correlation. Generated when absent.

        Yields:
            Native ``TResponseStreamEvent`` payloads in arrival order.

        Raises:
            AdmissionTimeoutError: If no admission slot became available in time.
            RunDeadlineExceededError: If the run exceeded its overall deadline.
            MaxTurnsExceededError: If the agent loop hit the maximum-turn bound.
            UpstreamModelError: If the model provider failed, throttled or timed out.
            SessionPersistenceError: If conversation history could not be persisted.
            AgentRunError: For any other classified run failure.
        """
        correlation = CorrelationContext(
            request_id=request_id or _new_request_id(),
            session_id=session_id,
        )
        hooks = RunObservabilityHooks(self._metrics, correlation)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._settings.run_deadline_s

        async with AsyncExitStack() as stack:
            entry = await stack.enter_async_context(self._admitted(session_id, deadline))
            timer = self._metrics.time("agent_run_duration_seconds")
            stack.enter_context(timer)

            streaming = Runner.run_streamed(
                self._agent,
                input_items,
                session=entry.session,
                max_turns=self._settings.max_agent_turns,
                run_config=self._run_config(),
                hooks=hooks,
            )
            correlation.trace_id = _current_trace_id()
            events = streaming.stream_events().__aiter__()
            completed = False

            try:
                while True:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise TimeoutError
                    try:
                        event = await asyncio.wait_for(events.__anext__(), timeout=remaining)
                    except StopAsyncIteration:
                        break
                    if isinstance(event, RawResponsesStreamEvent):
                        yield event.data
                completed = True
            except BaseException as exc:
                self._record_outcome(_classify_outcome(exc))
                if isinstance(exc, GeneratorExit | asyncio.CancelledError):
                    raise
                raise self._translate(exc) from exc
            finally:
                if not completed:
                    streaming.cancel()

            self._record_outcome("success")
            self._metrics.increment("sqlite_session_writes_total")
            _LOGGER.info("streamed run completed: %s", correlation.as_log_fields())

    @asynccontextmanager
    async def _admitted(self, session_id: str, deadline: float) -> AsyncIterator[SessionEntry]:
        """Acquire the global admission slot and the per-session lock, releasing both.

        Cheap rejection happens here, before any model work begins: a saturated service
        refuses the request rather than queueing it past its own deadline.

        Args:
            session_id: Conversation to serialise on.
            deadline: Monotonic loop time by which the run must have finished.

        Yields:
            The session entry whose lock is held for the body of the block.

        Raises:
            AdmissionTimeoutError: If the admission slot was not obtained before the
                deadline.
        """
        loop = asyncio.get_running_loop()
        budget = deadline - loop.time()
        if budget <= 0:
            raise AdmissionTimeoutError("request budget was exhausted before admission")

        try:
            await asyncio.wait_for(self._admission.acquire(), timeout=budget)
        except TimeoutError as exc:
            self._record_outcome("admission_limit")
            raise AdmissionTimeoutError(
                f"the service is at its concurrency limit of "
                f"{self._settings.max_concurrent_runs} runs; retry shortly"
            ) from exc

        entry: SessionEntry | None = None
        try:
            entry, _ = await self._registry.acquire(session_id)
            yield entry
        finally:
            if entry is not None:
                self._registry.release(entry)
            self._admission.release()

    def _run_config(self) -> RunConfig:
        """Build the per-run SDK configuration.

        ``max_function_tool_concurrency`` bounds how many model-emitted tool calls the
        backend executes at once, which is a different control from
        ``ModelSettings.parallel_tool_calls``: that one bounds what the model may emit.
        """
        return RunConfig(
            workflow_name=_WORKFLOW_NAME,
            tracing_disabled=not self._settings.tracing_enabled,
            trace_include_sensitive_data=False,
            tool_execution=ToolExecutionConfig(
                max_function_tool_concurrency=self._settings.max_function_tool_concurrency,
            ),
        )

    def _record_outcome(self, outcome: str) -> None:
        """Count one run outcome, and the maximum-turn breach separately when it applies."""
        self._metrics.increment("agent_runs_total", outcome=outcome)
        if outcome == "max_turns_exceeded":
            self._metrics.increment("agent_max_turns_exceeded_total")

    def _translate(self, exc: BaseException) -> BaseException:
        """Map a raised exception to a classified runtime failure.

        Cancellation is propagated unchanged so that a cancelled run is never reported as
        a completed one.
        """
        if isinstance(exc, AgentRunError | asyncio.CancelledError | GeneratorExit):
            return exc

        budgeted = self._translate_budget_failure(exc)
        if budgeted is not None:
            return budgeted

        upstream = _classify_openai_error(exc)
        if upstream is not None:
            self._metrics.increment("openai_status_errors_total", classification=upstream.code)
            return upstream

        if _is_session_persistence_failure(exc):
            self._metrics.increment("sqlite_session_errors_total")
            return SessionPersistenceError(
                "conversation history could not be persisted; the turn was not saved"
            )
        if isinstance(exc, ModelBehaviorError | UserError | AgentsException):
            return AgentRunError(f"the agent run failed: {exc}")
        return exc

    def _translate_budget_failure(self, exc: BaseException) -> AgentRunError | None:
        """Map an exhausted time or turn budget to its classified failure.

        Returns:
            The classified failure, or ``None`` when the exception is not a budget
            exhaustion.
        """
        if isinstance(exc, TimeoutError):
            return RunDeadlineExceededError(
                f"the run exceeded its deadline of {self._settings.run_deadline_s:g}s"
            )
        if isinstance(exc, MaxTurnsExceeded):
            return MaxTurnsExceededError(
                f"the agent reached the configured limit of {self._settings.max_agent_turns} "
                "turns before completing the task; the partial result is not returned"
            )
        if isinstance(exc, ModelTimeoutError):
            return UpstreamModelError(
                f"the model call exceeded its timeout of {self._settings.model_call_timeout_s:g}s",
                code="upstream_timeout",
            )
        return None


def _classify_openai_error(exc: BaseException) -> UpstreamModelError | None:
    """Classify a model-provider exception, or return ``None`` when it is not one.

    The classification separates throttling, which the client should retry after a delay,
    from an outage, which it should not retry immediately, from a request the provider
    rejected outright.
    """
    if isinstance(exc, openai.RateLimitError):
        return UpstreamModelError(
            "the model provider is throttling requests; retry after a short delay",
            code="upstream_rate_limited",
        )
    if isinstance(exc, openai.APITimeoutError):
        return UpstreamModelError(
            "the model provider did not respond before the call timeout",
            code="upstream_timeout",
        )
    if isinstance(exc, openai.APIConnectionError):
        return UpstreamModelError(
            "the model provider could not be reached",
            code="upstream_unavailable",
        )
    if isinstance(exc, openai.APIStatusError):
        status = getattr(exc, "status_code", None)
        if isinstance(status, int) and status >= _UPSTREAM_SERVER_ERROR_STATUS:
            return UpstreamModelError(
                f"the model provider returned status {status}",
                code="upstream_unavailable",
            )
        return UpstreamModelError(
            f"the model provider rejected the request with status {status}",
            code="upstream_request_rejected",
        )
    return None


def _is_session_persistence_failure(exc: BaseException) -> bool:
    """Report whether an exception originated in the session store.

    Detection is by exception type rather than by message, so it does not depend on the
    wording of a database driver's error text.
    """
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, sqlite3.Error):
            return True
        current = current.__cause__ or current.__context__
    return False


def _classify_outcome(exc: BaseException) -> str:
    """Map an exception to the bounded outcome label used on the run metric."""
    if isinstance(exc, asyncio.CancelledError | GeneratorExit):
        return "cancelled"
    if isinstance(exc, TimeoutError):
        return "run_deadline_exceeded"
    if isinstance(exc, MaxTurnsExceeded):
        return "max_turns_exceeded"
    if isinstance(exc, AgentRunError):
        return exc.code
    if isinstance(exc, openai.OpenAIError):
        return "upstream_error"
    return "error"


def _current_trace_id() -> str | None:
    """Return the active SDK trace identifier, or ``None`` when tracing is disabled."""
    current = get_current_trace()
    return current.trace_id if current is not None else None


def _new_request_id() -> str:
    """Generate a backend request identifier for correlation."""
    return f"req_{uuid.uuid4().hex}"
