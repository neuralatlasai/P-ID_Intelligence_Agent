"""Transport error policy.

HTTP errors are backend transport errors. They are not a model output schema and not a
domain error taxonomy: the payload is a stable, minimal object carrying a machine-readable
code, a human-readable message and the request identifier needed to find the run in logs
and traces.

No error body contains corpus content, prompt text, model reasoning, stack traces or
credential material.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

from fastapi.responses import JSONResponse

from pid_intelligence.agent.runtime import AgentRunError
from pid_intelligence.corpus.paths import CorpusPathError
from pid_intelligence.memory.registry import InvalidSessionIdError

__all__ = [
    "STATUS_BY_CODE",
    "BodyTooLargeError",
    "InvalidBodyError",
    "InvalidInputItemsError",
    "TransportError",
    "error_payload",
    "error_response",
    "status_for",
]

STATUS_BY_CODE: Final[dict[str, int]] = {
    "invalid_body": HTTPStatus.BAD_REQUEST,
    "invalid_session_id": HTTPStatus.BAD_REQUEST,
    "not_found": HTTPStatus.NOT_FOUND,
    "run_deadline_exceeded": HTTPStatus.GATEWAY_TIMEOUT,
    "max_turns_exceeded": HTTPStatus.GATEWAY_TIMEOUT,
    "body_too_large": HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
    "incompatible_input_items": HTTPStatus.UNPROCESSABLE_ENTITY,
    "admission_limit": HTTPStatus.TOO_MANY_REQUESTS,
    "upstream_rate_limited": HTTPStatus.TOO_MANY_REQUESTS,
    "upstream_timeout": HTTPStatus.GATEWAY_TIMEOUT,
    "upstream_unavailable": HTTPStatus.SERVICE_UNAVAILABLE,
    "upstream_request_rejected": HTTPStatus.BAD_GATEWAY,
    "session_persistence_failed": HTTPStatus.INTERNAL_SERVER_ERROR,
    "internal_error": HTTPStatus.INTERNAL_SERVER_ERROR,
}
"""Mapping from stable error code to HTTP status.

Codes are part of the transport contract: a client may branch on the code rather than
parse the message. Statuses follow conventional semantics — the service refusing work is
429, a budget exhausted is 504, an upstream outage is 503, and only genuinely unexpected
failures are 500.
"""


class TransportError(Exception):
    """A request failed before or outside the agent run.

    Attributes:
        code: Stable classification, resolved to a status through :data:`STATUS_BY_CODE`.
    """

    code = "internal_error"

    def __init__(self, message: str) -> None:
        """Initialise the error with a client-safe message."""
        super().__init__(message)


class BodyTooLargeError(TransportError):
    """The request body exceeded the configured limit."""

    code = "body_too_large"


class InvalidBodyError(TransportError):
    """The request body is absent, blank, or not valid JSON."""

    code = "invalid_body"


class InvalidInputItemsError(TransportError):
    """The body was decodable but is not an acceptable OpenAI Responses input.

    Raised when the payload is neither a string nor a list of input-item objects, or when
    an item is not an object at all.
    """

    code = "incompatible_input_items"


def status_for(error: Exception) -> int:
    """Resolve an exception to its HTTP status.

    Args:
        error: A transport error, a classified runtime failure, a rejected session
            identifier, a rejected corpus path, or any other exception.

    Returns:
        The mapped status, defaulting to 500 for an unclassified exception.
    """
    if isinstance(error, InvalidSessionIdError):
        return HTTPStatus.BAD_REQUEST
    if isinstance(error, CorpusPathError):
        return HTTPStatus.BAD_REQUEST
    if isinstance(error, TransportError | AgentRunError):
        return STATUS_BY_CODE.get(error.code, HTTPStatus.INTERNAL_SERVER_ERROR)
    return HTTPStatus.INTERNAL_SERVER_ERROR


def error_payload(error: Exception, *, request_id: str) -> dict[str, object]:
    """Build the minimal error body.

    Args:
        error: The failure being reported.
        request_id: Backend request identifier, so an operator can find the run.

    Returns:
        A mapping with ``error.code``, ``error.message`` and ``error.request_id``. An
        unclassified exception is reported generically, because its message is not a
        controlled surface.
    """
    if isinstance(error, InvalidSessionIdError):
        code, message = "invalid_session_id", str(error)
    elif isinstance(error, CorpusPathError):
        code, message = "invalid_body", str(error)
    elif isinstance(error, TransportError | AgentRunError):
        code, message = error.code, str(error)
    else:
        code = "internal_error"
        message = "the request failed because of an unexpected internal error"

    return {"error": {"code": code, "message": message, "request_id": request_id}}


def error_response(error: Exception, *, request_id: str) -> JSONResponse:
    """Build the complete HTTP error response for a failure.

    Args:
        error: The failure being reported.
        request_id: Backend request identifier, echoed in the body and in the
            ``x-request-id`` header.

    Returns:
        A JSON response carrying the mapped status and the minimal error body.
    """
    return JSONResponse(
        status_code=status_for(error),
        content=error_payload(error, request_id=request_id),
        headers={"x-request-id": request_id},
    )
