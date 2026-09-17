"""Path containment and secret-leak guardrails applied at the tool boundary.

Two guardrails run around every function tool:

* an input guardrail that re-validates any ``path`` argument against the corpus resolver
  before the tool body executes, so a rejected path never reaches a filesystem call;
* an output guardrail that refuses any tool result containing the configured API key.

Both reject content rather than raising, so the agent sees a normal tool error, can pick a
different artifact, and the run continues under its existing deadline. A guardrail
rejection is recorded in metrics so repeated escape attempts are visible operationally.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Final

from agents.tool_guardrails import (
    ToolGuardrailFunctionOutput,
    ToolInputGuardrail,
    ToolInputGuardrailData,
    ToolOutputGuardrail,
    ToolOutputGuardrailData,
    tool_input_guardrail,
    tool_output_guardrail,
)

from pid_intelligence.corpus.paths import CorpusPathError, resolve_corpus_path
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

__all__ = [
    "PATH_ARGUMENT_NAMES",
    "build_corpus_path_guardrail",
    "build_secret_redaction_guardrail",
]

_LOGGER = logging.getLogger(__name__)

PATH_ARGUMENT_NAMES: Final[frozenset[str]] = frozenset({"path"})
"""Tool argument names carrying a corpus-relative path.

Any tool that accepts a path names the argument ``path``. Keeping the set explicit means
adding a differently named path argument is a deliberate, reviewable act rather than a
silent bypass of this guardrail.
"""

_MIN_SECRET_LENGTH: Final[int] = 8


def build_corpus_path_guardrail(
    settings: Settings,
    metrics: MetricsRegistry,
) -> ToolInputGuardrail[Any]:
    """Build the guardrail that enforces corpus containment on tool arguments.

    The guardrail resolves the same way the tools do — containment, existence, regular
    file, served extension, size bound — and rejects the call when resolution fails. It is
    redundant with the tools by design.

    Args:
        settings: Validated configuration supplying the corpus root and size bound.
        metrics: Registry receiving guardrail rejection counts.

    Returns:
        A tool input guardrail to attach to every function tool.
    """

    @tool_input_guardrail(name="corpus_path_containment")
    def _guard(data: ToolInputGuardrailData) -> ToolGuardrailFunctionOutput:
        """Reject a tool call whose path argument does not resolve inside the corpus."""
        context = data.context
        arguments = _decode_arguments(context.tool_arguments)
        if arguments is None:
            return ToolGuardrailFunctionOutput.allow()

        for name in PATH_ARGUMENT_NAMES:
            value = arguments.get(name)
            if not isinstance(value, str):
                continue
            try:
                resolve_corpus_path(
                    value,
                    corpus_root=settings.corpus_root,
                    max_bytes=settings.max_corpus_file_bytes,
                )
            except CorpusPathError as exc:
                # A rejected call is still a call the model made. Counting it on both
                # series keeps the per-tool error rate meaningful: without the call
                # count, a guardrail rejection would show as an error with no call.
                metrics.increment("tool_calls_total", tool=str(context.tool_name))
                metrics.increment("tool_errors_total", tool=str(context.tool_name))
                _LOGGER.info(
                    "path guardrail rejected a tool call: tool=%s reason=%s",
                    context.tool_name,
                    type(exc).__name__,
                )
                return ToolGuardrailFunctionOutput.reject_content(
                    message=(
                        f"Tool error: {exc}. Only artifacts inside the configured corpus can "
                        "be read. List the corpus and use a path exactly as listed."
                    ),
                    output_info={"guardrail": "corpus_path_containment"},
                )
        return ToolGuardrailFunctionOutput.allow()

    return _guard


def build_secret_redaction_guardrail(
    settings: Settings,
    metrics: MetricsRegistry,
) -> ToolOutputGuardrail[Any]:
    """Build the guardrail that keeps credential material out of model context.

    The API key must never enter model context, be returned by a tool, be logged or be
    written into session history. The tools never read it, so this guardrail should never
    fire; it exists so that a future change which does leak it fails closed and is counted.

    When no API key is configured the guardrail still runs and allows every output, which
    keeps the tool pipeline identical between credentialed and scripted-model runs.

    Args:
        settings: Validated configuration supplying the credential to screen for.
        metrics: Registry receiving guardrail rejection counts.

    Returns:
        A tool output guardrail to attach to every function tool.
    """
    secret = settings.openai_api_key or ""
    screen = len(secret) >= _MIN_SECRET_LENGTH

    @tool_output_guardrail(name="secret_redaction")
    def _guard(data: ToolOutputGuardrailData) -> ToolGuardrailFunctionOutput:
        """Reject a tool result that contains configured credential material."""
        if not screen:
            return ToolGuardrailFunctionOutput.allow()
        rendered = _render_output(data.output)
        if secret in rendered:
            metrics.increment("tool_errors_total", tool=str(data.context.tool_name))
            # The call itself was already counted by the tool body, which ran to
            # completion; only the result is suppressed.
            _LOGGER.error(
                "secret guardrail suppressed a tool result: tool=%s",
                data.context.tool_name,
            )
            return ToolGuardrailFunctionOutput.reject_content(
                message=(
                    "Tool error: the result was suppressed because it contained credential "
                    "material. Credentials are not part of the engineering corpus."
                ),
                output_info={"guardrail": "secret_redaction"},
            )
        return ToolGuardrailFunctionOutput.allow()

    return _guard


def _decode_arguments(raw: str | None) -> dict[str, Any] | None:
    """Decode a tool's JSON argument payload, returning ``None`` when it is not an object.

    Malformed arguments are not this guardrail's concern: the SDK's own argument
    validation rejects them with a clearer message, so the guardrail defers.
    """
    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _render_output(output: object) -> str:
    """Render a tool result as text for screening, without raising on exotic types."""
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output, default=str)
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return str(output)
