# HTTP contract

Written for client developers, including whoever builds the frontend this backend is meant
to support.

The governing rule: **the model payload does not change shape as it crosses this
boundary.** The request body is an OpenAI Responses input. The response body is the native
output-item list. Stream frames are native Responses stream events. Path parameters,
headers and status codes belong to the transport and are not part of the model payload.

There is no `PIDRequest`, no `PIDResponse`, no evidence envelope. `tests/contract/` fails
the build if one appears.

## Endpoints

### `POST /v1/sessions/{session_id}/responses`

Run one turn and return the final model response's output items.

**Path parameter.** `session_id` selects the conversation. It must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — 1 to 128 characters, starting with a letter or
digit. It is an opaque key: never a filesystem path, never interpolated into SQL, and never
injected into the model payload as a field.

**Body.** Either a JSON string, or a JSON array of OpenAI Responses input-item objects.

```json
"What is connected to FCV-2201?"
```

```json
[{"role": "user", "content": "What is connected to FCV-2201?"}]
```

Send only the new input. Prior turns are loaded from the session automatically.

**Response.** `200` with a JSON array of native output items.

```json
[
  {
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "status": "completed",
    "content": [{"type": "output_text", "text": "Answer\n...", "annotations": []}]
  }
]
```

**Headers.** `x-request-id` echoes a supplied identifier or carries a generated one.
`x-trace-id` is present when tracing is active.

### `POST /v1/sessions/{session_id}/responses/stream`

Same input contract; the response is Server-Sent Events.

```
event: event
data: {"type":"response.output_text.delta","delta":"Answer",...}

event: event
data: {"type":"response.completed",...}

event: done
data: {"request_id":"req_..."}
```

Each `event: event` frame carries one native Responses stream event, forwarded unchanged.
There is no application token-delta schema.

The stream is not finished when the last visible token arrives. The SDK may still persist
session items and run final lifecycle hooks; the server holds the run open until the
underlying event stream completes, then emits `done`.

If the run fails *after* streaming has begun, the HTTP status has already been sent, so the
failure arrives as a terminal frame carrying the status it would have had:

```
event: error
data: {"status":504,"error":{"code":"run_deadline_exceeded","message":"...","request_id":"req_..."}}
```

A request rejected *before* streaming begins returns an ordinary JSON error response with
the mapped status.

### `GET /v1/sessions/{session_id}/items`

Return the session's persisted conversation items as a JSON array of native input items,
unchanged. An unknown session returns `200` with `[]`: a session with no history is
indistinguishable from one not yet used.

### `DELETE /v1/sessions/{session_id}`

Clear the session's history through the SDK session interface. `204` on success. A failure
to clear is reported rather than assumed — reporting success when history remains would
mislead the caller.

### `GET /healthz`

`200 {"status": "ok"}`. Calls no dependency, so a provider outage does not make the process
look dead to an orchestrator.

### `GET /readyz`

Proves the corpus is enumerable and the session database is writable, by doing both.

```json
{"status": "ready", "checks": {"corpus": "ok", "session_store": "ok"}, "corpus_files": 1049}
```

`200` when ready, `503` when not.

### `GET /metrics`

Prometheus text exposition. See `docs/operations.md`.

## Errors

Every error body is the same minimal shape:

```json
{"error": {"code": "admission_limit", "message": "...", "request_id": "req_..."}}
```

`code` is stable and machine-readable; branch on it rather than parsing `message`. The body
never contains corpus content, prompt text, model reasoning, a stack trace or credential
material. An unclassified internal exception is reported generically for exactly that
reason.

| Code | Status | Meaning | Client action |
|---|---|---|---|
| `invalid_body` | 400 | Body absent, blank, or not valid JSON | Fix the request |
| `invalid_session_id` | 400 | Identifier outside the accepted pattern | Use a conforming identifier |
| `not_found` | 404 | A specifically requested resource does not exist | Do not retry |
| `body_too_large` | 413 | Body above `MAX_REQUEST_BODY_BYTES` | Send less |
| `incompatible_input_items` | 422 | Payload is neither a string nor a list of objects | Send a Responses input |
| `admission_limit` | 429 | Service at its concurrency limit for the whole budget | Retry after a short delay |
| `upstream_rate_limited` | 429 | Provider is throttling | Back off, then retry |
| `run_deadline_exceeded` | 504 | Run exceeded `RUN_DEADLINE_S` | Retry, or simplify the question |
| `max_turns_exceeded` | 504 | Agent loop hit `MAX_AGENT_TURNS`; partial work discarded | Narrow the question |
| `upstream_timeout` | 504 | Provider did not respond in time | Retry |
| `upstream_unavailable` | 503 | Provider unreachable or returned 5xx | Retry with backoff |
| `upstream_request_rejected` | 502 | Provider rejected the request | Do not retry unchanged |
| `session_persistence_failed` | 500 | History could not be persisted; the turn was not saved | Investigate the service |
| `internal_error` | 500 | Unexpected failure | Report with the `request_id` |

`max_turns_exceeded` deliberately returns no partial answer. An incomplete investigation
presented as a finished engineering conclusion is worse than an error.

## Concurrency behaviour a client should expect

Requests to **different** sessions run concurrently, up to `MAX_CONCURRENT_RUNS`. Beyond
that, admission is refused with `429` rather than queued past the request's own deadline.

Requests to the **same** session queue behind one another. This is by design: it is what
makes multi-turn history ordering meaningful. A client issuing two turns at once will see
the second take longer, not fail.

## Answer shape

The assistant text is ordinary prose under stable headings, chosen so a frontend can render
sections without a second schema:

- **Answer** — the direct response.
- **Evidence** — corpus-relative paths, plus page, node, edge or tag as applicable.
- **Topology / connectivity** — including whether the graph was directed.
- **Revisions / changes** — differences between documents, staleness evidence.
- **Conflicts** — what each source says, and that they disagree.
- **Uncertainty** — what is missing and what would resolve it.

Claims are labelled observed, corroborated, inferred, conflicting or unknown. Certainty is
qualitative. There is no numeric confidence score, and a client should not synthesise one:
a number a model produces is not calibrated merely because a model produced it.
