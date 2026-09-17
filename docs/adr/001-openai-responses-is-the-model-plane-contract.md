# ADR-001 - OpenAI Responses types are the model-plane contract

**Status:** Accepted

## Context

The backend sits between an HTTP client and the OpenAI Responses API. The tempting move is
to define an application request and response model in the middle, on the grounds that it
decouples the client from the provider.

## Decision

Model-plane input is `str | list[TResponseInputItem]`. Model-plane output is the native
output-item list. Streaming forwards native `TResponseStreamEvent` payloads obtained from
`RawResponsesStreamEvent.data`.

The backend may add path parameters, headers, status codes and transport-level controls,
because those belong to the transport boundary rather than the model payload.

## Consequences

The client sees exactly what the provider produced - annotations, item identifiers,
reasoning items, tool-call items and everything else - without the backend deciding which
fields matter. A frontend can render progress and results without the core being redesigned.

The cost is that the client is coupled to the Responses format. That is an honest coupling:
the alternative is a translation layer that must be extended every time the provider adds a
field, and that silently drops anything it has not been taught about.

`tests/contract/test_native_types.py` fails the build if a domain envelope appears.

## Reverses if

A second model provider becomes a requirement. Then a translation layer is justified,
because there is a genuine second shape to translate between - not before.
