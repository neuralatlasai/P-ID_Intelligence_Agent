"""Run lifecycle hooks and per-request correlation context.

Hooks observe the SDK's agent loop. They record identifiers, timings, token counts and
statuses, and they never alter model input, tool selection or control-plane policy.

Two rules bound what is recorded. Hidden model reasoning is never persisted. Raw corpus
content — document bytes, base64 images, extracted page text, prompt contents — is never
logged. Every log line carries the request, session and trace identifiers needed to join
an operational symptom to a specific run.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from agents import Agent, RunHooks
from agents.items import ModelResponse, TResponseInputItem
from agents.run_context import RunContextWrapper
from agents.tool import Tool

from pid_intelligence.observability.metrics import MetricsRegistry

__all__ = ["CorrelationContext", "RunObservabilityHooks"]

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class CorrelationContext:
    """Identifiers joining one HTTP request to its agent run and upstream model calls.

    Attributes:
        request_id: Backend-assigned identifier for the HTTP request.
        session_id: Conversation the run belongs to.
        trace_id: Agents SDK trace identifier when tracing is active.
        response_ids: Model response identifiers observed during the run, in order.
        request_ids: Upstream transport request identifiers observed during the run.
        model_calls: Number of model calls observed.
        input_tokens: Input tokens reported by the provider across the run.
        output_tokens: Output tokens reported by the provider across the run.
    """

    request_id: str
    session_id: str
    trace_id: str | None = None
    response_ids: list[str] = field(default_factory=list)
    request_ids: list[str] = field(default_factory=list)
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    def as_log_fields(self) -> dict[str, object]:
        """Render the context as a log-safe mapping.

        Returns:
            Identifiers and counts only. No prompt text, no tool arguments, no corpus
            content and no reasoning content is included.
        """
        return {
            "request_id": self.request_id,
            "session_id": self.session_id,
            "trace_id": self.trace_id,
            "model_calls": self.model_calls,
            "last_response_id": self.response_ids[-1] if self.response_ids else None,
            "last_upstream_request_id": self.request_ids[-1] if self.request_ids else None,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
        }


class RunObservabilityHooks(RunHooks[None]):
    """Records model and tool activity for one run.

    One instance serves exactly one run, because it holds that run's in-progress timings.
    The instance is created by the runtime immediately before the run and discarded after.
    """

    def __init__(self, metrics: MetricsRegistry, correlation: CorrelationContext) -> None:
        """Initialise hooks bound to one run's metrics registry and correlation context.

        Args:
            metrics: Registry receiving model-call and tool-call series.
            correlation: Mutable context this run's observed identifiers accumulate into.
        """
        self._metrics = metrics
        self._correlation = correlation
        self._model_call_started: float | None = None
        self._tool_started: dict[str, float] = {}

    @property
    def correlation(self) -> CorrelationContext:
        """Return the correlation context these hooks are accumulating into."""
        return self._correlation

    async def on_agent_start(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
    ) -> None:
        """Record that the agent loop began."""
        del context
        _LOGGER.info(
            "agent run started: agent=%s %s",
            agent.name,
            self._correlation.as_log_fields(),
        )

    async def on_agent_end(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
        output: object,
    ) -> None:
        """Record that the agent loop produced a final output.

        The output itself is deliberately not logged: it is model-authored text that may
        quote corpus content.
        """
        del context, output
        _LOGGER.info(
            "agent run finished: agent=%s %s",
            agent.name,
            self._correlation.as_log_fields(),
        )

    async def on_llm_start(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
        system_prompt: str | None,
        input_items: list[TResponseInputItem],
    ) -> None:
        """Start timing one model call and record its input-item count.

        The system prompt and the input items are counted, never logged. Their contents
        include the user's instruction and any corpus evidence already in context.
        """
        del context, system_prompt
        self._model_call_started = time.perf_counter()
        _LOGGER.debug(
            "model call started: agent=%s input_items=%d %s",
            agent.name,
            len(input_items),
            self._correlation.as_log_fields(),
        )

    async def on_llm_end(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
        response: ModelResponse,
    ) -> None:
        """Record one completed model call's duration, identifiers and token usage."""
        del context, agent
        duration = (
            time.perf_counter() - self._model_call_started
            if self._model_call_started is not None
            else 0.0
        )
        self._model_call_started = None

        self._metrics.increment("openai_model_calls_total")
        self._metrics.observe("openai_model_call_duration_seconds", duration)
        self._correlation.model_calls += 1

        if response.response_id:
            self._correlation.response_ids.append(response.response_id)
        if response.request_id:
            self._correlation.request_ids.append(response.request_id)

        usage = response.usage
        if usage is not None:
            self._metrics.increment("openai_input_tokens_total", float(usage.input_tokens))
            self._metrics.increment("openai_output_tokens_total", float(usage.output_tokens))
            self._correlation.input_tokens += usage.input_tokens
            self._correlation.output_tokens += usage.output_tokens

        _LOGGER.info(
            "model call finished: duration_s=%.3f %s",
            duration,
            self._correlation.as_log_fields(),
        )

    async def on_tool_start(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
        tool: Tool,
    ) -> None:
        """Start timing one tool call.

        Tool arguments are not logged: a path argument is low risk, but the hook must not
        depend on which tool it is observing.
        """
        del context, agent
        self._tool_started[tool.name] = time.perf_counter()

    async def on_tool_end(
        self,
        context: RunContextWrapper[None],
        agent: Agent[None],
        tool: Tool,
        result: object,
    ) -> None:
        """Record one tool call's duration.

        The result is not logged: for the file tools it is base64 document content, and
        for the text tools it is corpus-derived text.
        """
        del context, agent, result
        started = self._tool_started.pop(tool.name, None)
        if started is None:
            return
        _LOGGER.debug(
            "tool call finished: tool=%s duration_s=%.3f %s",
            tool.name,
            time.perf_counter() - started,
            self._correlation.as_log_fields(),
        )
