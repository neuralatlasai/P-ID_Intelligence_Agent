# Operations

Written for whoever runs this service.

## Deployment baseline

```
1 Python process
1 Uvicorn worker
1 file-backed SQLite database
1 local read-only corpus directory
outbound access to the OpenAI API
```

**One worker is a correctness requirement, not a performance choice.** The per-session lock
that prevents two turns of one conversation from interleaving is process-local. A second
worker would let two turns of the same session run at once and append history in an order
representing neither user's conversation. Scale by making the single process's admission
limit larger, or by adding distributed same-session ownership — not by adding workers.

```bash
pid-intelligence
# equivalently
uvicorn pid_intelligence.main:create_app --factory --host 0.0.0.0 --port 8000 --workers 1
```

There is no module-level `app`: importing the package must not load configuration or touch
the filesystem, so point the server at the factory.

## Startup

Each step gates the next; a failure at any of them exits with an actionable message rather
than starting a half-working service.

1. Validate settings. Every bound must be positive; `OPENAI_MODEL` must name exactly one
   model.
2. Resolve `CORPUS_ROOT` to an absolute path and prove it exists, is a directory and is
   readable.
3. Create the `SQLITE_PATH` parent directory if absent and prove it is writable.
4. Build the corpus services.
5. Construct the immutable agent.
6. Construct the session registry and the admission semaphore.
7. Configure the SDK credential and tracing state.
8. Serve.

Exit codes: `0` clean shutdown, `2` invalid configuration, `3` the optional server extra is
not installed.

## Shutdown

Admission stops, the session sweeper is cancelled, in-flight runs finish or are cancelled,
cached session objects are closed, and metrics and logs flush. Closing a session object
releases a file handle; conversation history in the database is untouched.

## Probes

| Probe | Use for | Fails when |
|---|---|---|
| `GET /healthz` | Liveness | The process is not serving |
| `GET /readyz` | Readiness | The corpus is unreadable, or the session store is unwritable |

`/healthz` deliberately calls no dependency: a provider outage degrades the service but
does not justify restarting the process, and a liveness probe that fails on a dependency
outage causes exactly that.

`/readyz` proves its claims by doing the work — it enumerates the corpus and opens the
database in a transaction it immediately rolls back — so a permission change or an
unmounted volume is detected rather than assumed away.

## Metrics

`GET /metrics` returns a Prometheus text exposition. Labels come from bounded vocabularies
only; session identifiers never appear in one.

**Traffic and latency**
`backend_requests_total{route,status}`, `backend_requests_inflight`,
`backend_request_duration_seconds{route}`

**Agent runs**
`agent_runs_total{outcome}`, `agent_run_duration_seconds`,
`agent_max_turns_exceeded_total`

`outcome` is one of `success`, `cancelled`, `run_deadline_exceeded`, `max_turns_exceeded`,
`admission_limit`, `upstream_*`, `session_persistence_failed`, `error`.

**Model**
`openai_model_calls_total`, `openai_model_call_duration_seconds`,
`openai_model_retries_total`, `openai_status_errors_total{classification}`,
`openai_input_tokens_total`, `openai_output_tokens_total`

**Tools**
`tool_calls_total{tool}`, `tool_call_duration_seconds{tool}`, `tool_errors_total{tool}`

**Sessions**
`sqlite_session_reads_total`, `sqlite_session_writes_total`, `sqlite_session_errors_total`,
`session_items_loaded`, `session_lock_wait_seconds`

**Corpus**
`corpus_files_scanned`, `corpus_file_reads_total{type}`, `corpus_bytes_read_total`,
`graph_query_nodes_returned`, `graph_query_edges_returned`

The registry is in-memory and is lost on restart. That is the correct lifetime for
demo-scale operational data; scrape it if you need history.

## What to watch

| Signal | Reading |
|---|---|
| `session_lock_wait_seconds` rising | Clients are issuing concurrent turns on one session. Expected to queue; investigate only if the client believes they are parallel. |
| `agent_runs_total{outcome="admission_limit"}` non-zero | `MAX_CONCURRENT_RUNS` is the binding constraint. |
| `agent_max_turns_exceeded_total` rising | Questions are too broad, the corpus listing is too large to navigate, or a tool is unhelpful enough that the agent loops. Read a trace. |
| `sqlite_session_errors_total` non-zero | Session durability is compromised. Treat as an incident: history is part of correctness. |
| `tool_errors_total{tool=...}` concentrated on one tool | A corpus problem — corrupt PDFs, malformed GraphML — or a bad path pattern the model keeps producing. |
| `openai_status_errors_total{classification="upstream_rate_limited"}` | Reduce `MAX_CONCURRENT_RUNS` or raise the provider quota. |

## Correlation

Every backend log line carries `request_id`, `session_id` and `trace_id`. Model call lines
add the upstream transport request ID and the response ID when the provider supplies them.

To investigate one request: take `x-request-id` from the response (or the `request_id` in
an error body), grep the logs for it, then open the trace by its `trace_id`.

Never logged: full document bytes, base64 images, complete corpus documents, prompt
contents, hidden model reasoning, or credential material.

## Tuning order

Do not optimise before you have baseline accuracy and traces. Then, in this order:

1. Eliminate irrelevant file reads — usually a prompt or listing-filter problem.
2. Render only the required PDF pages instead of loading whole documents.
3. Let the parsed-GraphML cache do its work (`GRAPH_CACHE_MAX_ENTRIES`).
4. Let the PDF page-text cache do its work (`PDF_CACHE_MAX_ENTRIES`).
5. Allow independent read-only tool calls to run in parallel.
6. Tune `MAX_FUNCTION_TOOL_CONCURRENCY`.
7. Tune session-history retrieval (`SESSION_HISTORY_LIMIT`).
8. Evaluate prompt caching and context management.
9. Only then evaluate a cheaper model, and only against the regression suite.

Do not add a vector database because the corpus *could* grow. Add retrieval infrastructure
when measured corpus size and query behaviour prove the recursive local tools inadequate.

## Long sessions

The baseline stores every turn and retrieves the full history. When measurement — not
intuition — shows context pressure, evaluate in this order:

1. `SESSION_HISTORY_LIMIT`, which retrieves only recent items while the database still
   holds every item.
2. A deterministic history filter, if filtering must be predictable.
3. Compaction around the underlying session.

Compaction is not enabled because it exists. Enable it only if evaluation shows no
unacceptable regression in tag recall, asset identity consistency, revision references,
cross-turn constraints, prior user corrections, and previously established file scope.

## Changing the model

The model ID is control-plane configuration, not application branching. Changing it is a
deployment change and must pass the same regression suite before it becomes the default:

```bash
export OPENAI_API_KEY=...
export PID_EVAL_CORPUS=/path/to/curated/corpus
export PID_EVAL_REPORT=./eval-candidate.json
OPENAI_MODEL=<candidate> pytest -m real_model
```

Compare the report against the incumbent's on episode success, tag and evidence recall,
unsupported-claim rate, latency and token usage. There is no runtime router: one model
serves every request.

## Release

Freeze, record and ship together: the model ID, the prompt version
(`agent.instructions.PROMPT_VERSION`), the tool implementation version, the dependency
lock, the corpus snapshot identifier, and the evaluation report. Release only when every
gate passes.

## Scale-out

To move off SQLite, change `SessionRegistry._create_session` to construct another SDK
`Session` implementation. Nothing else moves: not the agent instructions, not the tools,
not the corpus layer, not the model payload, not the reasoning flow.

To run more than one worker you additionally need distributed same-session ownership or a
different state model. That work is outside this baseline, and running multiple workers
without it silently breaks turn ordering.
