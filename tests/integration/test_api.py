"""HTTP transport behaviour: endpoints, status mapping, streaming and probes."""

from __future__ import annotations

import json

import pytest
from agents.testing import ScriptedModel, assistant_message, function_call

_GRAPH = "area_100/PID-100-REV04.graphml"


def _replies(count: int = 6) -> ScriptedModel:
    return ScriptedModel([[assistant_message("acknowledged")] for _ in range(count)])


async def test_liveness_does_not_depend_on_any_dependency(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readiness_reports_the_corpus_and_the_session_store(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.get("/readyz")
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "ready"
    assert body["checks"] == {"corpus": "ok", "session_store": "ok"}
    assert body["corpus_files"] >= 5


async def test_metrics_are_exposed_in_the_prometheus_text_format(client_for) -> None:
    async with client_for(_replies()) as client:
        await client.post("/v1/sessions/probe/responses", content=json.dumps("hello"))
        response = await client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "# TYPE backend_requests_total counter" in response.text


async def test_a_string_body_is_accepted(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.post(
            "/v1/sessions/s1/responses", content=json.dumps("What is on PID-100?")
        )
    assert response.status_code == 200
    assert isinstance(response.json(), list)


async def test_an_input_item_array_is_accepted(client_for) -> None:
    body = [{"role": "user", "content": "What is on PID-100?"}]
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s1/responses", content=json.dumps(body))
    assert response.status_code == 200


async def test_the_response_body_is_a_list_of_native_output_items(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s1/responses", content=json.dumps("hi"))
    items = response.json()
    assert [item["type"] for item in items] == ["message"]
    assert items[0]["role"] == "assistant"
    assert items[0]["content"][0]["type"] == "output_text"


async def test_the_response_carries_the_request_identifier(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.post(
            "/v1/sessions/s1/responses",
            content=json.dumps("hi"),
            headers={"x-request-id": "req-supplied-123"},
        )
    assert response.headers["x-request-id"] == "req-supplied-123"


async def test_history_accumulates_across_turns(client_for) -> None:
    async with client_for(_replies()) as client:
        await client.post("/v1/sessions/s1/responses", content=json.dumps("first"))
        await client.post("/v1/sessions/s1/responses", content=json.dumps("second"))
        response = await client.get("/v1/sessions/s1/items")
    items = response.json()
    assert response.status_code == 200
    assert len(items) == 4


async def test_an_unknown_session_has_no_items_rather_than_a_not_found(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.get("/v1/sessions/never-used/items")
    assert response.status_code == 200
    assert response.json() == []


async def test_deleting_a_session_clears_its_history(client_for) -> None:
    async with client_for(_replies()) as client:
        await client.post("/v1/sessions/s1/responses", content=json.dumps("first"))
        deleted = await client.delete("/v1/sessions/s1")
        remaining = await client.get("/v1/sessions/s1/items")
    assert deleted.status_code == 204
    assert remaining.json() == []


async def test_deleting_one_session_leaves_another_intact(client_for) -> None:
    async with client_for(_replies()) as client:
        await client.post("/v1/sessions/alpha/responses", content=json.dumps("alpha turn"))
        await client.post("/v1/sessions/beta/responses", content=json.dumps("beta turn"))
        await client.delete("/v1/sessions/alpha")
        beta = await client.get("/v1/sessions/beta/items")
    assert beta.json()


@pytest.mark.parametrize(
    ("body", "expected_status", "expected_code"),
    [
        ("", 400, "invalid_body"),
        ("not json at all", 400, "invalid_body"),
        (json.dumps(""), 400, "invalid_body"),
        (json.dumps([]), 400, "invalid_body"),
        (json.dumps(42), 422, "incompatible_input_items"),
        (json.dumps([1, 2, 3]), 422, "incompatible_input_items"),
        (json.dumps({"question": "x"}), 422, "incompatible_input_items"),
    ],
)
async def test_unacceptable_bodies_are_classified(
    client_for,
    body: str,
    expected_status: int,
    expected_code: str,
) -> None:
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s1/responses", content=body)
    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code


async def test_an_oversized_body_is_rejected(client_for, settings) -> None:
    body = json.dumps("x" * (settings.max_request_body_bytes + 1024))
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s1/responses", content=body)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "body_too_large"


@pytest.mark.parametrize("session_id", ["with%20space", "a" * 200, "quote%27id"])
async def test_an_unacceptable_session_identifier_is_rejected(
    client_for,
    session_id: str,
) -> None:
    async with client_for(_replies()) as client:
        response = await client.post(
            f"/v1/sessions/{session_id}/responses", content=json.dumps("hi")
        )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_session_id"


async def test_an_error_body_is_minimal_and_carries_the_request_id(client_for) -> None:
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s1/responses", content="oops")
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "request_id"}


async def test_streaming_emits_native_events_then_a_done_frame(client_for) -> None:
    model = ScriptedModel(
        [
            [function_call("graph_summary", {"path": _GRAPH}, call_id="c1")],
            [assistant_message("streamed")],
        ]
    )
    frames: list[tuple[str, dict]] = []
    async with (
        client_for(model) as client,
        client.stream(
            "POST", "/v1/sessions/s2/responses/stream", content=json.dumps("stream this")
        ) as response,
    ):
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        event_name = ""
        async for line in response.aiter_lines():
            if line.startswith("event: "):
                event_name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                frames.append((event_name, json.loads(line.removeprefix("data: "))))

    assert frames[-1][0] == "done"
    payloads = [payload for name, payload in frames if name == "event"]
    assert payloads
    assert all("type" in payload for payload in payloads)
    assert any(payload["type"].startswith("response.") for payload in payloads)


async def test_streaming_persists_history_for_the_session(client_for) -> None:
    async with client_for(_replies()) as client:
        async with client.stream(
            "POST", "/v1/sessions/s3/responses/stream", content=json.dumps("stream this")
        ) as response:
            async for _ in response.aiter_lines():
                pass
        items = await client.get("/v1/sessions/s3/items")
    assert len(items.json()) >= 2


async def test_streaming_rejects_an_invalid_body_before_the_stream_begins(
    client_for,
) -> None:
    async with client_for(_replies()) as client:
        response = await client.post("/v1/sessions/s2/responses/stream", content="bad")
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")


async def test_request_metrics_label_by_route_template_not_session_id(client_for) -> None:
    async with client_for(_replies()) as client:
        await client.post("/v1/sessions/aaa/responses", content=json.dumps("x"))
        await client.post("/v1/sessions/bbb/responses", content=json.dumps("x"))
        rendered = (await client.get("/metrics")).text
    assert 'route="/v1/sessions/{session_id}/responses"' in rendered
    assert "aaa" not in rendered
    assert "bbb" not in rendered


async def test_the_openapi_document_declares_no_domain_request_or_response_model(
    client_for,
) -> None:
    async with client_for(_replies()) as client:
        document = (await client.get("/openapi.json")).json()
    schema_names = set(document.get("components", {}).get("schemas", {}))
    forbidden = {"PIDRequest", "PIDResponse", "PIDAnswer", "UserQueryRequest", "TopologyResponse"}
    assert not (schema_names & forbidden)
