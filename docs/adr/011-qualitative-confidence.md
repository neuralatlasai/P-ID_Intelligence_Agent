# ADR-011 - Qualitative confidence only

**Status:** Accepted

## Context

The target architecture includes a calibrated confidence score.

## Decision

The agent states certainty qualitatively: high support, partial support, conflicting
evidence, insufficient evidence. It produces no numeric confidence score.

## Consequences

Calibrated means something specific: that among claims assigned 0.9, about 90 per cent are
correct. A number a model emits has no such property, and presenting it in a field called
confidence invites a reader to act on it as though it did - which, for engineering decisions
about pressure relief and control loops, is the kind of error that matters.

Qualitative language forces the reader to the evidence section, which is where the actual
justification is.

`tests/security/test_security.py` asserts the instruction forbids a numeric score, and the
evaluation scorer fails any case whose answer contains one.

## Reverses if

A calibration method is evaluated against a gold set with known outcomes and the resulting
numbers demonstrably match observed correctness. Then the number may be called calibrated,
and the method must be documented alongside it.
