# ADR-010 - One configured model, no router

**Status:** Accepted

## Context

A runtime router could send simple questions to a cheap model and hard ones to an expensive
one.

## Decision

One model identifier, supplied as configuration. `Settings` rejects a comma- or
whitespace-separated value at startup, so a router cannot be introduced by configuration
alone.

## Consequences

Accuracy is established before cost is optimised. A router adds a classification decision
that can be wrong, and it makes every quality measurement ambiguous: a regression could be
the prompt, the tools, or the routing.

The model identifier is control-plane configuration, so changing it is a deployment change
that must pass the regression suite - not application branching logic.

## Reverses if

Baseline accuracy is established, cost becomes a binding constraint, and a candidate
configuration passes the regression suite.
