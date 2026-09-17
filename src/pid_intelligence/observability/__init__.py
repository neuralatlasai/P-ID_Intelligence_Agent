"""Operational visibility: metrics, lifecycle hooks and correlation context.

Nothing in this subpackage influences the agent loop. Hooks observe and record; they
never alter model input, tool selection or control-plane policy.

Two rules govern everything recorded here: hidden model reasoning is never persisted, and
raw corpus content is never logged. What is recorded is identifiers, timings, counts,
statuses and sizes.
"""

from __future__ import annotations

__all__: list[str] = []
