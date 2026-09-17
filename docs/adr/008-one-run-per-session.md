# ADR-008 - One in-flight run per session

**Status:** Accepted

## Context

Two concurrent turns against one session can each load the same pre-turn history and then
append competing turns.

## Decision

Serialise runs per session with an in-process `asyncio.Lock`, held for the whole run
including the post-response persistence the SDK performs. Different sessions may run
concurrently, subject to a global admission semaphore.

## Consequences

This is a semantic correctness mechanism, not a database lock. SQLite already serialises
writes; what it cannot prevent is an interleaving that produces a history representing
neither conversation.

Because the lock is process-local, the deployment baseline is one worker. That constraint is
stated in the README, in `docs/operations.md` and in the module docstring, because running
two workers breaks the guarantee silently rather than loudly.

Clients issuing concurrent turns on one session see them queue. `session_lock_wait_seconds`
makes that visible.

## Reverses if

Distributed same-session ownership is introduced. Then the lock moves rather than
disappears.
