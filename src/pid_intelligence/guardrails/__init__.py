"""Tool-boundary guardrails.

Guardrails are a second, independent check at the tool boundary. The tools already
resolve every path and already refuse to return secret material; the guardrails here
reject the same classes of call before the tool body runs, and inspect tool output before
it reaches model context.

Defence in depth is the point: a future tool added without the resolver, or an accidental
change to an existing one, still fails closed.
"""

from __future__ import annotations

from pid_intelligence.guardrails.tool_guards import (
    build_corpus_path_guardrail,
    build_secret_redaction_guardrail,
)

__all__ = ["build_corpus_path_guardrail", "build_secret_redaction_guardrail"]
