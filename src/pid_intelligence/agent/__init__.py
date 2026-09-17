"""Agent definition and run orchestration.

The agent is built once from configuration and reused as an immutable definition. The
runtime owns admission, per-session serialisation, deadlines and cancellation around
``Runner``; it does not reimplement the agent loop, the tool dispatcher, session history
handling or tracing, all of which belong to the Agents SDK.
"""

from __future__ import annotations

__all__: list[str] = []
