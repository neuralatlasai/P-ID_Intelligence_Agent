# ADR-004 - Basic SQLiteSession, not the advanced variant

**Status:** Accepted

## Context

The SDK offers an advanced SQLite session with additional persistence structures for
conversation branching and per-turn analytics.

## Decision

Use the basic file-backed `SQLiteSession`. The advanced variant is deferred.

## Consequences

Fewer tables, less to reason about, and no persistence structures serving a feature the
product does not have. Branch management and stored analytics are real capabilities with
real storage costs; adopting them before they are needed is paying for optionality that may
never be exercised.

## Reverses if

The product needs conversation branching, per-turn analytics stored in SQLite, or branch
switching. Each of those is a concrete feature request, not a preference.
