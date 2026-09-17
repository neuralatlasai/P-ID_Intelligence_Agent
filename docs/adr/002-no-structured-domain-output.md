# ADR-002 - No structured domain output object

**Status:** Accepted

## Context

An obvious design for an evidence-grounded agent is a JSON answer:

```json
{"answer": "...", "confidence": 0.91, "assets": [], "connections": [], "provenance": []}
```

## Decision

Rejected. Engineering answer structure is expressed as ordinary assistant text with stable
sections: answer, evidence, topology, revisions, conflicts, uncertainty.

## Consequences

The structure lives in the prompt, where it can be changed and evaluated, rather than in a
schema that constrains what the model may say. An engineering answer is frequently irregular
- one claim observed, another inferred, two sources disagreeing about a third - and a fixed
schema either cannot express that or forces the model to flatten it into fields that
misrepresent it.

The confidence field is the clearest case. A schema with a `confidence: float` makes the
model produce a number for every answer, and a number in a field labelled confidence reads
as calibrated. See ADR-011.

The cost is that a consumer parses prose rather than JSON. The headings are stable enough to
segment, and the evidence lines carry corpus-relative paths that can be resolved.

## Reverses if

A consumer demonstrates a need prose cannot serve - and then the right move is a separate,
explicitly versioned extraction endpoint, not a change to the model-plane contract.
