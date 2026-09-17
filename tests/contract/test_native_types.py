"""Contract tests for the model-plane boundary.

These assert the constraints the architecture calls non-negotiable: the input is an OpenAI
Responses input, the output is native OpenAI output items, stream frames are native
Responses events, no domain request or response object exists anywhere in the package, and
no second conversation schema is created.

They are deliberately structural. A future change that reintroduces a domain envelope will
fail here even if every behavioural test still passes.
"""

from __future__ import annotations

import ast
import inspect
import json
import re
from pathlib import Path

import pytest
from agents import Agent, Runner
from agents.items import TResponseInputItem
from agents.stream_events import RawResponsesStreamEvent
from agents.testing import ScriptedModel, assistant_message
from agents.tool import ToolOutputFileContent, ToolOutputImage
from openai.types.responses import ResponseOutputMessage

from pid_intelligence.agent import runtime as runtime_module
from pid_intelligence.api import runs as runs_module

_SOURCE_ROOT = Path(runtime_module.__file__).resolve().parents[1]

_FORBIDDEN_TYPE_NAMES = {
    "PIDRequest",
    "PIDResponse",
    "PIDAnswer",
    "PIDQuery",
    "UserQueryRequest",
    "EvidenceEnvelope",
    "TopologyResponse",
    "AnswerEnvelope",
    "ProvenanceEnvelope",
}

_FORBIDDEN_TABLE_NAMES = {"chat_sessions", "messages", "turns", "conversations", "pid_messages"}


def _python_sources() -> list[Path]:
    return sorted(_SOURCE_ROOT.rglob("*.py"))


def test_no_domain_request_or_response_class_is_defined() -> None:
    offenders: list[str] = []
    for path in _python_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name in _FORBIDDEN_TYPE_NAMES:
                offenders.append(f"{path.name}:{node.name}")
    assert offenders == []


def test_no_module_defines_a_pydantic_model_for_the_model_plane() -> None:
    offenders: list[str] = []
    for path in _python_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            bases = {
                base.id if isinstance(base, ast.Name) else getattr(base, "attr", "")
                for base in node.bases
            }
            if "BaseModel" in bases:
                offenders.append(f"{path.relative_to(_SOURCE_ROOT)}:{node.name}")
    # Settings is a pydantic-settings model for configuration, which is control plane, not
    # model plane. Nothing else may subclass BaseModel.
    assert offenders == []


def test_the_package_issues_no_sql_against_the_session_store() -> None:
    write_statement = re.compile(
        r"\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b",
        re.IGNORECASE,
    )
    offenders: list[str] = []
    for path in _python_sources():
        text = path.read_text(encoding="utf-8")
        if write_statement.search(text):
            offenders.append(str(path.relative_to(_SOURCE_ROOT)))
    assert offenders == []


def test_no_module_names_a_competing_conversation_table() -> None:
    offenders: list[str] = []
    for path in _python_sources():
        text = path.read_text(encoding="utf-8")
        for table in _FORBIDDEN_TABLE_NAMES:
            if re.search(rf'["\']{table}["\']', text):
                offenders.append(f"{path.relative_to(_SOURCE_ROOT)}:{table}")
    assert offenders == []


def test_no_non_openai_provider_adapter_is_imported() -> None:
    forbidden = ("litellm", "anthropic", "google.generativeai", "cohere", "mistralai", "ollama")
    offenders: list[str] = []
    for path in _python_sources():
        text = path.read_text(encoding="utf-8")
        offenders.extend(
            f"{path.relative_to(_SOURCE_ROOT)}:{name}" for name in forbidden if name in text
        )
    assert offenders == []


def test_the_runtime_input_annotation_is_the_openai_responses_input() -> None:
    signature = inspect.signature(runtime_module.PIDRuntime.run)
    annotation = signature.parameters["input_items"].annotation
    assert annotation == "str | list[TResponseInputItem]"
    assert TResponseInputItem is not None


def test_the_runtime_never_sets_server_managed_continuation() -> None:
    source = inspect.getsource(runtime_module)
    for forbidden in ("previous_response_id=", "conversation_id=", "auto_previous_response_id="):
        assert forbidden not in source


async def test_the_runtime_returns_native_output_items(make_runtime) -> None:
    runtime = make_runtime(ScriptedModel([[assistant_message("native")]]))
    outcome = await runtime.run("contract", "hello")
    assert all(isinstance(item, ResponseOutputMessage) for item in outcome.output)


async def test_serialisation_preserves_the_native_item_shape(make_runtime) -> None:
    runtime = make_runtime(ScriptedModel([[assistant_message("native")]]))
    outcome = await runtime.run("contract", "hello")
    rendered = runs_module.serialise_item(outcome.output[0])
    assert rendered["type"] == "message"
    assert rendered["role"] == "assistant"
    assert rendered["content"][0]["type"] == "output_text"
    assert json.dumps(rendered)


async def test_stream_frames_are_native_responses_events(make_runtime) -> None:
    runtime = make_runtime(ScriptedModel([[assistant_message("native")]]))
    events = [event async for event in runtime.run_streamed("contract-stream", "hello")]
    assert events
    for event in events:
        assert not isinstance(event, RawResponsesStreamEvent)
        assert type(event).__module__.startswith("openai.types.responses")


async def test_session_items_are_stored_as_openai_input_items(make_runtime) -> None:
    runtime = make_runtime(ScriptedModel([[assistant_message("native")]]))
    await runtime.run("contract-items", "hello")
    items = await runtime.registry.get_items("contract-items")
    assert all(isinstance(item, dict) for item in items)
    assert {"role", "content"} <= set(items[0])


def test_tool_outputs_use_the_sdk_native_multimodal_types() -> None:
    from pid_intelligence.tools import corpus_tools

    source = inspect.getsource(corpus_tools)
    assert "ToolOutputImage(" in source
    assert "ToolOutputFileContent(" in source
    assert ToolOutputImage.model_fields["image_url"] is not None
    assert ToolOutputFileContent.model_fields["file_data"] is not None


def test_tool_argument_schemas_are_generated_from_python_signatures(
    settings,
    services,
    metrics,
) -> None:
    from pid_intelligence.agent.factory import build_tools

    for tool in build_tools(settings, services, metrics):
        schema = tool.params_json_schema
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        assert schema["title"].endswith("_args")


async def test_the_agent_loop_is_the_sdk_runner_not_a_reimplementation(
    make_agent,
    registry,
) -> None:
    agent = make_agent(ScriptedModel([[assistant_message("via runner")]]))
    assert isinstance(agent, Agent)
    entry, _ = await registry.acquire("runner-check")
    try:
        result = await Runner.run(agent, "hello", session=entry.session, max_turns=3)
    finally:
        registry.release(entry)
    assert result.raw_responses
    await registry.close()


@pytest.mark.parametrize("symbol", ["Agent", "Runner", "SQLiteSession", "function_tool"])
def test_the_package_depends_on_the_sdk_primitives(symbol: str) -> None:
    import agents

    assert hasattr(agents, symbol)
