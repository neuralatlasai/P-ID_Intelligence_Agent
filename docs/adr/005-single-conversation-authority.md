# ADR-005 - The local session is the sole conversation authority

**Status:** Accepted

## Context

The Responses API can maintain conversation state server-side via `previous_response_id`,
`auto_previous_response_id` or `conversation_id`. The SDK also supports a client-managed
session. Both mechanisms can be passed to `Runner` at once.

## Decision

While a session is in use, none of the server-managed continuation parameters is set.
`ModelSettings.store` defaults to disabled for the same reason.

## Consequences

One store holds the conversation. Mixing the two would produce two histories that can
diverge - after a retry, a timeout, or a partial failure - with no principled way to decide
which is correct.

`tests/contract/test_native_types.py` scans the runtime source for those parameter names, so
reintroducing one fails the build rather than quietly creating a second history.

## Reverses if

Server-managed state replaces the local session entirely. Not alongside it.
