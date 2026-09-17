# ADR-009 - The corpus is filesystem-owned state

**Status:** Accepted

## Context

A corpus of a few thousand engineering artifacts invites a metadata database or a vector
index.

## Decision

The filesystem is authoritative. No corpus metadata database. Process-local caches - parsed
graphs, extracted page text, a scan snapshot - are derived and disposable, keyed by file
size and modification time so a changed file invalidates its own entry.

## Consequences

There is no index to build, no index to keep in step with the filesystem, and no class of
bug where the index disagrees with reality. Losing every cache costs latency and nothing
else, which is why `tests/unit/test_cache.py` asserts invalidation rather than hit rates.

Discovery of the full sample corpus takes roughly ten milliseconds warm, so the snapshot
cache is a convenience rather than a necessity.

## Reverses if

Measured corpus size and query behaviour prove the recursive local tools inadequate. Corpus
size alone is not the trigger - a large corpus the agent navigates well with filters needs
no index.
