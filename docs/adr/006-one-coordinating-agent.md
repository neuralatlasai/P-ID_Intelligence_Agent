# ADR-006 - One coordinating agent

**Status:** Accepted

## Context

The target architecture describes nine logical stages: query parsing, corpus resolution,
drawing retrieval, diagram reasoning, topology extraction, connectivity reconstruction,
cross-document reasoning, validation and answer synthesis. It is tempting to build nine
agents.

## Decision

One coordinating agent with deterministic tools. The stages are execution phases inside one
loop, guided by the instructions, not agent instances.

## Consequences

Each additional agent adds a model call, a handoff, more state, more latency, more tokens
and more ways to fail - and the stages here are not independent. Corpus resolution informs
retrieval, retrieval informs topology, topology informs cross-checking. Splitting them means
passing context between agents that a single loop already holds.

The seven phases in the prompt give the discipline the diagram intends without the
machinery.

## Reverses if

An ablation demonstrates that a specific split improves the target quality metrics by more
than the added latency, token cost, state complexity and failure surface. The evaluation
harness exists to run exactly that comparison.
