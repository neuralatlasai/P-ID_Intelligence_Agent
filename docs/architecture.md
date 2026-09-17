# Architecture

Written for engineers maintaining or extending this backend.

This description follows the intent of ISO/IEC/IEEE 42010: it names the system boundary,
the planes, who owns which state, how a request flows, and what happens when each part
fails. It describes what the code does, not what a future version might do.

## 1. Boundary

Inside the implementation boundary:

- HTTP admission and transport
- agent construction
- `Runner` invocation
- session selection and session-object lifecycle
- corpus path resolution and recursive discovery
- PDF page rendering and text search
- deterministic GraphML parsing and bounded graph queries
- tool-boundary guardrails
- tracing, metrics and logs
- concurrency, deadlines and cancellation

Outside it:

- the OpenAI API and the model itself
- the user, the browser, any frontend
- engineering authoring systems and any enterprise system not represented in the corpus
- a production distributed database

## 2. Planes

**Control plane** — slowly changing policy, loaded once and immutable thereafter: the
model identifier, model settings, instructions, the enabled tool set, the corpus root,
served extensions, size limits, the run deadline, model and tool timeouts, the turn bound,
concurrency limits, session history policy, tracing state, log level, security policy.

**Data plane** — per-request work: user input items, session history items, corpus path
enumeration, file bytes, graph query results, tool inputs and outputs, response events,
final output items.

The data plane reads control-plane policy. It never writes it. No model output can change
a bound, a path, a model or a tool.

## 3. State ownership

| State | Owner | Lifetime | Persistence | Rule |
|---|---|---|---|---|
| Conversation history | Agents SDK session | Multi-turn | SQLite file | One run at a time per session |
| Corpus files | Filesystem | Long-lived | Filesystem | Read-only to the backend |
| Parsed GraphML | `GraphRepository` cache | Process | Memory | Rebuilt when the file version changes |
| PDF page text | `PdfReader` cache | Process | Memory | Rebuilt when the file version changes |
| Corpus inventory | `CorpusScanner` snapshot | Process | Memory | Time-bounded; disposable |
| Per-session lock | `SessionRegistry` | Process | Memory | One in-flight turn per session |
| Admission semaphore | `PIDRuntime` | Process | Memory | Caps concurrent runs |
| Run context | Agents SDK | One run | Memory | Not shared between sessions |
| Response and request IDs | SDK / provider | Per model call | Optional upstream | Diagnostics only, never conversation authority |
| Metrics | `MetricsRegistry` | Process | Memory | Exported by scrape |
| Traces | SDK tracing | Operational | Trace backend | Debug and verification only |

The system never creates two authoritative stores for the same conversation. That is why
`previous_response_id`, `auto_previous_response_id` and `conversation_id` are never set
while a session is in use, and why `store` defaults to disabled.

## 4. Components

```
main.create_app
  ├── Settings.load_and_validate ......... control plane; fails fast
  ├── MetricsRegistry .................... counters, gauges, histograms
  ├── build_corpus_services .............. scanner + PdfReader + GraphRepository
  ├── build_pid_agent .................... immutable Agent definition
  │     ├── PID_AGENT_INSTRUCTIONS
  │     ├── build_tools .................. 9 read-only tools + 2 guardrails
  │     └── build_model_settings ......... timeout, retry, store, parallel tool calls
  ├── SessionRegistry .................... session objects + per-session locks
  ├── PIDRuntime ......................... admission, deadlines, classification
  └── build_app .......................... FastAPI routers, middleware, lifespan
```

Construction happens in `create_app`. Importing any module performs no I/O, no network
access, no configuration load and no directory creation.

## 5. Request lifecycle

1. Decode a bounded HTTP body, abandoning it as soon as it exceeds the limit.
2. Validate the session identifier against a conservative pattern.
3. Validate that the payload is a string or a list of input-item objects.
4. Acquire a global admission slot, or refuse with 429 — cheap rejection before model work.
5. Resolve the session object from the registry.
6. Acquire the per-session lock.
7. Start the trace and attach correlation identifiers.
8. Enter the overall run deadline.
9. `Runner` loads prior items from the session.
10. The model interprets the instruction.
11. The agent resolves the corpus through `list_corpus_files`.
12. It loads only the artifacts and pages it needs.
13. It performs multimodal and graph reasoning.
14. It cross-checks evidence across sources.
15. It emits the final message.
16. The SDK persists the new items.
17. Usage, request IDs and trace IDs are collected.
18. Native output items are returned, or the native stream finishes.
19. The session lock is released.
20. The admission slot is released.

Steps 19 and 20 run on every exit path, including cancellation.

## 6. Concurrency

Two independent controls:

- **Global admission** caps how many runs execute at once, process-wide.
- **Per-session serialisation** guarantees that two turns of one conversation cannot
  interleave.

```
session-A run ─┐
session-B run ─┼─ may execute concurrently, subject to admission
session-C run ─┘

session-A turn-2 waits for session-A turn-1
```

The per-session lock is a *semantic* correctness mechanism, not a database lock. Even
though SQLite serialises writes, two concurrent runs could each read the same pre-turn
history and then append competing turns in an order representing neither user's
conversation. The lock is held for the whole run, including the SDK's post-response
persistence, so a second turn never observes a half-written history.

The lock is process-local. That is why the deployment baseline is one worker.

## 7. Failure domains

| Domain | Failure | Behaviour |
|---|---|---|
| Configuration | Missing corpus, unwritable database, non-positive bound, multi-model value | Startup fails with an actionable message |
| Transport | Oversized, malformed or non-conforming body; bad session id | 4xx with a stable code, no model work |
| Admission | Capacity saturated for the whole budget | 429, no model work |
| Deadline | Run exceeds its budget | 504, lock and slot released, run cancelled |
| Turn bound | Agent loop exhausts its turns | 504 with `max_turns_exceeded`; partial work discarded |
| Provider | Throttling, outage, timeout, rejection | Classified into 429 / 503 / 504 / 502; retries bounded |
| Session store | Write failure | 500 with `session_persistence_failed`; never a silent continue |
| Corpus | Missing, oversized, corrupt or escaping path | Model-visible tool error; the run continues with other evidence |
| Graph | Malformed GraphML | Tool error; the agent must report structured topology unavailable |
| Client | Disconnect | Run cancelled, resources released, never recorded as success |

Cancellation is never translated into success. `agent_runs_total{outcome="cancelled"}`
exists precisely so that a cancelled run is visible as such.

## 8. Security model

The trust boundary runs between the corpus and the control plane. Corpus content —
including text inside PDFs and attributes inside GraphML — is untrusted data. The
instructions state this explicitly and require embedded directives to be reported rather
than obeyed; `tests/security/` asserts that an embedded instruction reaches the model only
as an ordinary tool result and never as a system message.

Filesystem access is funnelled through one resolver. Two layers enforce it: the resolver
itself inside each tool, and a tool input guardrail that re-validates any `path` argument
before the tool body runs. The redundancy is deliberate — a future tool added without the
resolver still fails closed.

The agent has no shell, no network reach, no write, no delete, no SQL execution, no
environment access and no secret retrieval. The credential is never placed in model
context, never returned by a tool, never logged and never written to session history; a
tool output guardrail suppresses any result containing it.

## 9. Observability

Every backend log line carries the request, session and trace identifiers. Where available
the upstream transport request ID and model response ID are recorded too.

Never logged: full document bytes, base64 images, complete corpus documents, prompt
contents, or hidden model reasoning. What is logged is identifiers, timings, counts,
statuses and sizes.

Metric labels are drawn from bounded vocabularies — route template, tool name, file type,
outcome class — so exposition cardinality is a property of the code rather than of the
workload. Session identifiers never appear in a label.

## 10. Scale-out seam

SQLite is a demo persistence choice, not a ceiling. The agent, the tools, the corpus layer
and the model payload depend only on the SDK `Session` contract, so replacing the session
implementation — SQLAlchemy over PostgreSQL, Redis, or another supported backend — is a
wiring change in `SessionRegistry._create_session` and nothing else.

A multi-worker deployment needs one further thing this baseline does not provide:
distributed same-session ownership. Without it the per-session ordering guarantee does not
hold across processes.

## 11. What would change this design

Each of these is currently rejected, and each has a stated condition that would reverse it.
The reasoning is recorded in `docs/adr/`.

- **More than one agent** — only if an ablation shows a quality gain exceeding the added
  latency, token cost, state complexity and failure surface.
- **History compaction** — only if measurement shows context pressure *and* evaluation
  shows no unacceptable regression in tag recall, asset identity, revision references,
  cross-turn constraints, prior corrections and established file scope.
- **A vector database** — only if measured corpus size and query behaviour prove the
  recursive local tools inadequate.
- **A numeric confidence score** — only after calibration against a gold set with known
  outcomes and a documented method.
- **A cheaper model** — only after baseline accuracy is established and the regression
  suite passes with the replacement.
