"""Tool-boundary guardrails: path containment and credential suppression."""

from __future__ import annotations

import json

import pytest
from agents import Agent
from agents.tool_context import ToolContext
from agents.tool_guardrails import ToolInputGuardrailData, ToolOutputGuardrailData

from pid_intelligence.guardrails.tool_guards import (
    build_corpus_path_guardrail,
    build_secret_redaction_guardrail,
)
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings


def _tool_context(arguments: dict[str, object], tool_name: str = "load_corpus_artifact"):
    return ToolContext(
        context=None,
        tool_name=tool_name,
        tool_call_id="call-1",
        tool_arguments=json.dumps(arguments),
    )


def _agent() -> Agent[None]:
    return Agent[None](name="probe")


async def _run_input(guardrail, arguments: dict[str, object]):
    return await guardrail.run(
        ToolInputGuardrailData(context=_tool_context(arguments), agent=_agent())
    )


async def _run_output(guardrail, output: object):
    return await guardrail.run(
        ToolOutputGuardrailData(
            context=_tool_context({"path": "area_100/PID-100.png"}),
            agent=_agent(),
            output=output,
        )
    )


async def test_a_contained_path_is_allowed(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    guardrail = build_corpus_path_guardrail(settings, metrics)
    result = await _run_input(guardrail, {"path": "area_100/PID-100.png"})
    assert result.behavior["type"] == "allow"


@pytest.mark.parametrize(
    "path",
    [
        "../../etc/passwd",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "area_100/../../outside.png",
        "area_200/PID-200.JPG",
        "area_100/absent.png",
    ],
)
async def test_an_escaping_or_unserved_path_is_rejected(
    settings: Settings,
    metrics: MetricsRegistry,
    path: str,
) -> None:
    guardrail = build_corpus_path_guardrail(settings, metrics)
    result = await _run_input(guardrail, {"path": path})
    assert result.behavior["type"] == "reject_content"
    assert "corpus" in result.behavior["message"]


async def test_a_rejection_is_counted_as_both_a_call_and_an_error(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    guardrail = build_corpus_path_guardrail(settings, metrics)
    await _run_input(guardrail, {"path": "../escape.png"})
    snapshot = metrics.snapshot()
    assert snapshot['tool_errors_total{tool="load_corpus_artifact"}'] == 1
    assert snapshot['tool_calls_total{tool="load_corpus_artifact"}'] == 1


async def test_a_call_without_a_path_argument_is_allowed(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    guardrail = build_corpus_path_guardrail(settings, metrics)
    result = await _run_input(guardrail, {"name_contains": "REV04"})
    assert result.behavior["type"] == "allow"


async def test_malformed_arguments_are_deferred_to_the_sdk(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    guardrail = build_corpus_path_guardrail(settings, metrics)
    context = ToolContext(
        context=None,
        tool_name="load_corpus_artifact",
        tool_call_id="call-1",
        tool_arguments="{not json",
    )
    result = await guardrail.run(ToolInputGuardrailData(context=context, agent=_agent()))
    assert result.behavior["type"] == "allow"


async def test_output_containing_the_credential_is_suppressed(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    credentialed = settings.model_copy(update={"openai_api_key": "sk-test-abcdef1234567890"})
    guardrail = build_secret_redaction_guardrail(credentialed, metrics)
    result = await _run_output(guardrail, "the key is sk-test-abcdef1234567890")
    assert result.behavior["type"] == "reject_content"
    assert "sk-test-abcdef1234567890" not in result.behavior["message"]


async def test_ordinary_output_is_allowed(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    credentialed = settings.model_copy(update={"openai_api_key": "sk-test-abcdef1234567890"})
    guardrail = build_secret_redaction_guardrail(credentialed, metrics)
    result = await _run_output(guardrail, "P-2101A -> FCV-2201 [line=LN-1001]")
    assert result.behavior["type"] == "allow"


async def test_screening_is_inert_without_a_configured_credential(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    guardrail = build_secret_redaction_guardrail(settings, metrics)
    result = await _run_output(guardrail, "anything at all")
    assert result.behavior["type"] == "allow"


async def test_non_string_output_is_screened_too(
    settings: Settings,
    metrics: MetricsRegistry,
) -> None:
    credentialed = settings.model_copy(update={"openai_api_key": "sk-test-abcdef1234567890"})
    guardrail = build_secret_redaction_guardrail(credentialed, metrics)
    result = await _run_output(guardrail, {"leak": "sk-test-abcdef1234567890"})
    assert result.behavior["type"] == "reject_content"
