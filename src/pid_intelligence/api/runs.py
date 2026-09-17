"""Session and run endpoints.

The request body is an OpenAI Responses input: either a string or a list of input items.
There is no application request model wrapped around it. The response body is the native
output-item list from the final model response, or a Server-Sent Events stream of native
Responses stream events. There is no application response model either.

The session identifier is a path parameter. It is transport metadata used to select the
conversation; it is never injected into the model payload as an extra field.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from pid_intelligence.agent.runtime import AgentRunError, PIDRuntime
from pid_intelligence.api.errors import (
    BodyTooLargeError,
    InvalidBodyError,
    InvalidInputItemsError,
    TransportError,
    error_payload,
    error_response,
    status_for,
)
from pid_intelligence.memory.registry import InvalidSessionIdError, validate_session_id

__all__ = ["SSE_MEDIA_TYPE", "build_runs_router", "read_input_items", "serialise_item"]

_LOGGER = logging.getLogger(__name__)

SSE_MEDIA_TYPE = "text/event-stream"
"""Media type of the streaming endpoint."""

_REQUEST_ID_HEADER = "x-request-id"
_MAX_SUPPLIED_REQUEST_ID_CHARS = 128


def build_runs_router(runtime: PIDRuntime) -> APIRouter:
    """Build the session and run routes.

    Args:
        runtime: The configured runtime executing admitted runs.

    Returns:
        A router exposing the response, streaming, items and delete endpoints under
        ``/v1/sessions``.
    """
    router = APIRouter(prefix="/v1/sessions", tags=["runs"])
    max_body_bytes = runtime.settings.max_request_body_bytes

    @router.post("/{session_id}/responses", summary="Run the agent and return output items")
    async def create_response(session_id: str, request: Request) -> Response:
        """Execute one turn and return the final model response's native output items.

        The body is a string or a list of OpenAI Responses input items. Prior turns of
        this session are loaded automatically by the SDK from the session store; the
        client sends only the new input.

        Args:
            session_id: Conversation identifier from the request path.
            request: The incoming request, read as a bounded raw body.

        Returns:
            A JSON array of native output items on success, or the minimal transport
            error body with the mapped status.
        """
        request_id = _request_id(request)
        try:
            validate_session_id(session_id)
            input_items = await read_input_items(request, max_body_bytes)
            outcome = await runtime.run(session_id, input_items, request_id=request_id)
        except (TransportError, AgentRunError, InvalidSessionIdError) as exc:
            _log_failure(request_id, session_id, exc)
            return error_response(exc, request_id=request_id)

        headers = {_REQUEST_ID_HEADER: request_id}
        if outcome.correlation.trace_id:
            headers["x-trace-id"] = outcome.correlation.trace_id
        return JSONResponse(
            content=[serialise_item(item) for item in outcome.output],
            headers=headers,
        )

    @router.post(
        "/{session_id}/responses/stream",
        summary="Run the agent and stream native Responses events",
    )
    async def stream_response(session_id: str, request: Request) -> Response:
        """Execute one turn and stream native OpenAI Responses events as SSE.

        Each ``data:`` frame is one native Responses stream event, forwarded unchanged. No
        application token-delta schema is introduced. The stream ends with a ``done``
        event; if the run fails after streaming has begun, an ``error`` event carrying the
        same body as a non-streaming failure is emitted before the stream closes, because
        the HTTP status has already been sent.

        Args:
            session_id: Conversation identifier from the request path.
            request: The incoming request, read as a bounded raw body.

        Returns:
            An event stream on success, or the minimal transport error body when the
            request is rejected before streaming begins.
        """
        request_id = _request_id(request)
        try:
            validate_session_id(session_id)
            input_items = await read_input_items(request, max_body_bytes)
        except (TransportError, InvalidSessionIdError) as exc:
            _log_failure(request_id, session_id, exc)
            return error_response(exc, request_id=request_id)

        return StreamingResponse(
            _sse_frames(runtime, session_id, input_items, request_id),
            media_type=SSE_MEDIA_TYPE,
            headers={
                _REQUEST_ID_HEADER: request_id,
                "cache-control": "no-store",
                "x-accel-buffering": "no",
            },
        )

    @router.get("/{session_id}/items", summary="Read persisted conversation items")
    async def list_items(session_id: str, request: Request) -> Response:
        """Return the session's persisted conversation items.

        The items are the SDK's own stored input items, returned unchanged. An unknown
        session yields an empty array rather than a 404: a session with no history is
        indistinguishable from one that has not been used yet.

        Args:
            session_id: Conversation identifier from the request path.
            request: The incoming request, used for correlation only.

        Returns:
            A JSON array of native input items.
        """
        request_id = _request_id(request)
        try:
            validate_session_id(session_id)
            items = await runtime.registry.get_items(session_id)
        except InvalidSessionIdError as exc:
            return error_response(exc, request_id=request_id)
        except Exception as exc:  # noqa: BLE001 - transport boundary: every failure
            # must become a status code rather than a dropped connection.
            _log_failure(request_id, session_id, exc)
            return error_response(exc, request_id=request_id)
        return JSONResponse(
            content=[serialise_item(item) for item in items],
            headers={_REQUEST_ID_HEADER: request_id},
        )

    @router.delete("/{session_id}", summary="Clear a session's conversation history")
    async def delete_session(session_id: str, request: Request) -> Response:
        """Clear a session's history through the SDK session interface.

        The application issues no SQL against the SDK's tables. A failure to clear is
        reported rather than assumed, because silently reporting success would leave the
        caller believing history was removed when it was not.

        Args:
            session_id: Conversation identifier from the request path.
            request: The incoming request, used for correlation only.

        Returns:
            An empty 204 response on success, or the minimal transport error body.
        """
        request_id = _request_id(request)
        try:
            validate_session_id(session_id)
            await runtime.registry.delete(session_id)
        except InvalidSessionIdError as exc:
            return error_response(exc, request_id=request_id)
        except Exception as exc:  # noqa: BLE001 - transport boundary: every failure
            # must become a status code rather than a dropped connection.
            _log_failure(request_id, session_id, exc)
            return error_response(exc, request_id=request_id)
        return Response(status_code=204, headers={_REQUEST_ID_HEADER: request_id})

    return router


async def read_input_items(request: Request, max_bytes: int) -> str | list[Any]:
    """Read and validate the OpenAI Responses input from a bounded request body.

    The body is consumed in chunks and abandoned as soon as it exceeds the limit, so an
    oversized upload is rejected without being buffered in full.

    Args:
        request: The incoming request.
        max_bytes: Inclusive upper bound on the body size.

    Returns:
        The decoded input: a string, or a list of input-item objects. Items are not
        re-modelled; they are handed to the SDK as decoded.

    Raises:
        BodyTooLargeError: If the body exceeds ``max_bytes``.
        InvalidBodyError: If the body is empty or is not valid JSON.
        InvalidInputItemsError: If the payload is neither a string nor a list of objects.
    """
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > max_bytes:
            raise BodyTooLargeError(f"request body exceeds the limit of {max_bytes} bytes")
        chunks.append(chunk)

    raw = b"".join(chunks)
    if not raw.strip():
        raise InvalidBodyError(
            "request body must be a JSON string or a JSON array of OpenAI input items"
        )

    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, ValueError) as exc:
        raise InvalidBodyError(f"request body is not valid JSON: {exc}") from exc

    if isinstance(decoded, str):
        if not decoded.strip():
            raise InvalidBodyError("request body string must not be blank")
        return decoded
    if isinstance(decoded, list):
        if not decoded:
            raise InvalidBodyError("request body array must contain at least one input item")
        for index, item in enumerate(decoded):
            if not isinstance(item, dict):
                raise InvalidInputItemsError(
                    f"input item at index {index} is {type(item).__name__}; each item must "
                    "be an OpenAI Responses input-item object"
                )
        return decoded
    raise InvalidInputItemsError(
        f"request body is {type(decoded).__name__}; it must be a JSON string or a JSON "
        "array of OpenAI Responses input items"
    )


def serialise_item(item: object) -> Any:
    """Render one native item as JSON-compatible data without changing its shape.

    Items arrive either as OpenAI SDK models or as plain mappings, depending on whether
    they came from a model response or from the session store. Both are emitted as the
    same JSON objects the OpenAI types define; no field is added, removed or renamed.

    Args:
        item: A native input or output item.

    Returns:
        JSON-compatible data mirroring the item.
    """
    dump = getattr(item, "model_dump", None)
    if callable(dump):
        return dump(mode="json", exclude_none=True)
    return item


async def _sse_frames(
    runtime: PIDRuntime,
    session_id: str,
    input_items: str | list[Any],
    request_id: str,
) -> AsyncIterator[bytes]:
    """Yield SSE frames for one streaming run.

    The generator holds the run open until the SDK's event stream completes, so session
    persistence and final lifecycle hooks finish before the response ends.
    """
    try:
        async for event in runtime.run_streamed(session_id, input_items, request_id=request_id):
            yield _frame("event", serialise_item(event))
        yield _frame("done", {"request_id": request_id})
    except (TransportError, AgentRunError, InvalidSessionIdError) as exc:
        _log_failure(request_id, session_id, exc)
        yield _frame(
            "error",
            {
                "status": status_for(exc),
                **error_payload(exc, request_id=request_id),
            },
        )
    except Exception as exc:  # transport boundary; must close the stream
        _LOGGER.exception(
            "unexpected streaming failure: request_id=%s session_id=%s", request_id, session_id
        )
        yield _frame(
            "error",
            {"status": 500, **error_payload(exc, request_id=request_id)},
        )


def _frame(event_name: str, payload: object) -> bytes:
    """Encode one Server-Sent Events frame."""
    body = json.dumps(payload, default=str, separators=(",", ":"))
    return f"event: {event_name}\ndata: {body}\n\n".encode()


def _request_id(request: Request) -> str:
    """Return the caller's request identifier, or generate one.

    A caller-supplied identifier is accepted only when it is short and printable, so an
    untrusted header cannot inject control characters into log lines.
    """
    supplied = request.headers.get(_REQUEST_ID_HEADER, "")
    if supplied and len(supplied) <= _MAX_SUPPLIED_REQUEST_ID_CHARS and supplied.isprintable():
        return supplied
    return f"req_{uuid.uuid4().hex}"


def _log_failure(request_id: str, session_id: str, error: Exception) -> None:
    """Log a failed request by identifier and error class, without the payload."""
    _LOGGER.warning(
        "request failed: request_id=%s session_id=%s error=%s status=%d",
        request_id,
        session_id,
        type(error).__name__,
        status_for(error),
    )
