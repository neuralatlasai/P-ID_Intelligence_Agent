"""Session object lifecycle over the Agents SDK session contract.

Conversation history is owned by the SDK session implementation and stored in the schema
that implementation creates. This package owns only the lifetime of the session *objects*
and the per-session serialisation that keeps turn ordering meaningful.

No module here creates a conversation table, writes SQL, or holds a second copy of
conversation state. Every history mutation goes through the SDK session interface or
through ``Runner`` with ``session=...``.
"""

from __future__ import annotations

from pid_intelligence.memory.registry import (
    InvalidSessionIdError,
    SessionEntry,
    SessionRegistry,
    validate_session_id,
)

__all__ = [
    "InvalidSessionIdError",
    "SessionEntry",
    "SessionRegistry",
    "validate_session_id",
]
