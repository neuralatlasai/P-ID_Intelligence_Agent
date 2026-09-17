"""Construction of the immutable P&ID Intelligence Agent definition.

The agent is built once at startup from validated configuration and reused for every run.
Nothing in the data plane mutates it: the model identifier, the instructions, the tool set
and the model settings are control-plane policy.

One coordinating agent is the baseline topology. The logical stages of the architecture —
corpus resolution, drawing retrieval, topology reconstruction, cross-document reasoning,
validation — are execution phases inside one agent loop, guided by the instructions, not
separate agent instances. Additional agents are added only if an ablation demonstrates a
quality gain that outweighs the added latency, token cost, state and failure surface.
"""

from __future__ import annotations

from agents import Agent, ModelSettings
from agents.tool import FunctionTool, Tool

from pid_intelligence.agent.instructions import PID_AGENT_INSTRUCTIONS
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.guardrails.tool_guards import (
    build_corpus_path_guardrail,
    build_secret_redaction_guardrail,
)
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings
from pid_intelligence.tools.corpus_tools import build_corpus_tools
from pid_intelligence.tools.graph_tools import build_graph_tools

__all__ = ["AGENT_NAME", "build_model_settings", "build_pid_agent", "build_tools"]

AGENT_NAME = "P&ID Intelligence Agent"
"""Display name carried into traces and lifecycle hooks."""


def build_tools(
    settings: Settings,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> list[Tool]:
    """Build the agent's complete tool set with guardrails attached.

    The set is deliberately small and read-only: corpus inventory, native multimodal file
    loading, PDF page rendering and text search, and five deterministic graph operations.
    There is no shell tool, no write-capable tool and no general network tool.

    Args:
        settings: Validated configuration supplying every tool bound.
        services: Shared scanner, PDF reader and graph repository for this process.
        metrics: Registry receiving per-tool call, duration and error counts.

    Returns:
        Tools in a stable order, each carrying the path-containment input guardrail and
        the secret-redaction output guardrail.
    """
    tools: list[FunctionTool] = [
        *build_corpus_tools(settings, services, metrics),
        *build_graph_tools(settings, services, metrics),
    ]
    input_guardrail = build_corpus_path_guardrail(settings, metrics)
    output_guardrail = build_secret_redaction_guardrail(settings, metrics)

    for tool in tools:
        tool.tool_input_guardrails = [*(tool.tool_input_guardrails or []), input_guardrail]
        tool.tool_output_guardrails = [*(tool.tool_output_guardrails or []), output_guardrail]
    return list(tools)


def build_model_settings(settings: Settings) -> ModelSettings:
    """Build the model-call policy shared by every run.

    ``store`` defaults to disabled because the local SQLite session is the authoritative
    conversation history; making continuity depend on upstream response retention as well
    would create a second owner of the same state. Enabling it is a deliberate
    control-plane decision, never a per-response one.

    Args:
        settings: Validated configuration supplying the timeout, retry policy and
            storage preference.

    Returns:
        Model settings with a bounded per-call timeout, a bounded retry policy, parallel
        tool calls permitted, and raw usage preserved for observability.
    """
    return ModelSettings(
        timeout=settings.model_call_timeout_s,
        store=settings.store_model_responses,
        parallel_tool_calls=True,
        preserve_raw_usage=True,
        retry=settings.model_retry_settings(),
    )


def build_pid_agent(
    settings: Settings,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> Agent[None]:
    """Build the single coordinating agent used by every run.

    Args:
        settings: Validated configuration supplying the one model identifier and every
            model-call bound.
        services: Shared corpus services the tools read through.
        metrics: Registry the tools record into.

    Returns:
        An agent definition to be treated as immutable for the life of the process.
    """
    return Agent[None](
        name=AGENT_NAME,
        model=settings.openai_model,
        instructions=PID_AGENT_INSTRUCTIONS,
        tools=build_tools(settings, services, metrics),
        model_settings=build_model_settings(settings),
    )
