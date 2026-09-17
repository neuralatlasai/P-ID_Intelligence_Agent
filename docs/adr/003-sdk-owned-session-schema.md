# ADR-003 - The SDK owns the conversation schema

**Status:** Accepted

## Context

The Agents SDK session implementation creates and manages its own tables and stores
serialised input items in them.

## Decision

Use that schema. The application creates no `chat_sessions`, `messages`, `turns` or
equivalent table, and issues no SQL against the SDK tables. Every mutation goes through the
session interface (`get_items`, `add_items`, `pop_item`, `clear_session`) or through
`Runner` with `session=...`.

## Consequences

There is exactly one authoritative store for a conversation. A second table, or an ORM layer
over the SDK tables, would create two owners of the same state and a migration burden every
time the SDK storage changes.

`Runner` owns persistence for normal turns, so the application does not call `add_items`
itself during a run - doing so would duplicate items.

`tests/contract/test_native_types.py` scans the source for write SQL and for competing table
names; `tests/integration/test_sessions.py` asserts the database contains the SDK tables and
none of the forbidden ones.

## Reverses if

Nothing, while the SDK owns sessions. If it ever stops, this record is replaced rather than
amended.
