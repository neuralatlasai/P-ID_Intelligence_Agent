"""HTTP transport.

The transport is thin by design and owns nothing the model plane owns. It decodes a
bounded request body, validates the session identifier, hands native OpenAI Responses
input items to the runtime, and serialises native output items or native stream events
back out.

There is no application request model and no application response model. Path parameters,
headers and status codes belong to the transport boundary; the model payload does not
change shape as it crosses it.
"""

from __future__ import annotations

__all__: list[str] = []
