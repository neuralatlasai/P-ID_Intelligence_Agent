"""Ask the running service a question, non-streaming and streaming.

Run the service first, then:

    python examples/ask.py "What is connected to FCV-2201?"
    python examples/ask.py --stream "Compare the two revisions of PID-100."

The point of this example is what it does *not* contain: no request model, no response
model, no envelope. The body is an OpenAI Responses input and the reply is the native
output-item list, so the client speaks the provider's format directly.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterator
from typing import Any

import httpx

DEFAULT_BASE_URL = os.environ.get("PID_BASE_URL", "http://127.0.0.1:8000")
DEFAULT_SESSION = os.environ.get("PID_SESSION", "example")

HTTP_OK = 200


def ask(client: httpx.Client, session_id: str, question: str) -> list[dict[str, Any]]:
    """Run one turn and return the native output items.

    Prior turns of this session are loaded by the service automatically, so only the new
    input is sent.
    """
    response = client.post(f"/v1/sessions/{session_id}/responses", content=json.dumps(question))
    if response.status_code != HTTP_OK:
        error = response.json().get("error", {})
        raise SystemExit(
            f"request failed: {response.status_code} {error.get('code')} "
            f"{error.get('message')} (request_id={error.get('request_id')})"
        )
    return list(response.json())


def stream(client: httpx.Client, session_id: str, question: str) -> Iterator[dict[str, Any]]:
    """Run one turn and yield native Responses stream events.

    The stream ends with a ``done`` frame. A failure after streaming has begun arrives as an
    ``error`` frame, because the HTTP status was already sent.
    """
    with client.stream(
        "POST",
        f"/v1/sessions/{session_id}/responses/stream",
        content=json.dumps(question),
    ) as response:
        if response.status_code != HTTP_OK:
            response.read()
            raise SystemExit(f"request failed: {response.status_code} {response.text}")

        event_name = ""
        for line in response.iter_lines():
            if line.startswith("event: "):
                event_name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                payload = json.loads(line.removeprefix("data: "))
                if event_name == "error":
                    raise SystemExit(f"run failed: {payload}")
                if event_name == "done":
                    return
                yield payload


def answer_text(items: list[dict[str, Any]]) -> str:
    """Extract the assistant text from native output items."""
    chunks: list[str] = []
    for item in items:
        for part in item.get("content", []) or []:
            if part.get("type") == "output_text":
                chunks.append(part.get("text", ""))
    return "\n".join(chunks)


def main() -> int:
    """Parse arguments, send the question and print the answer."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question", help="the engineering question to ask")
    parser.add_argument("--session", default=DEFAULT_SESSION, help="conversation identifier")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="service base URL")
    parser.add_argument("--stream", action="store_true", help="stream the response")
    args = parser.parse_args()

    with httpx.Client(base_url=args.base_url, timeout=httpx.Timeout(600.0)) as client:
        if not args.stream:
            print(answer_text(ask(client, args.session, args.question)))
            return 0

        for event in stream(client, args.session, args.question):
            if event.get("type") == "response.output_text.delta":
                sys.stdout.write(event.get("delta", ""))
                sys.stdout.flush()
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
