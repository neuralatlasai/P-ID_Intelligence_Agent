# Changelog

Notable, externally observable changes. The format follows Keep a Changelog; the project
follows semantic versioning.

Before 1.0 the HTTP surface, the error codes and the settings names may change in a minor
release. Every such change is recorded here.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-15

First implementation of the backend described in `project.md`.

### Added

**HTTP surface**

- `POST /v1/sessions/{session_id}/responses` — run one turn, return native OpenAI output
  items.
- `POST /v1/sessions/{session_id}/responses/stream` — stream native Responses events as SSE,
  terminated by a `done` frame, or an `error` frame when a run fails after streaming began.
- `GET /v1/sessions/{session_id}/items` — read persisted conversation items.
- `DELETE /v1/sessions/{session_id}` — clear a session through the SDK session interface.
- `GET /healthz`, `GET /readyz`, `GET /metrics`.
- Stable transport error codes mapped to conventional statuses; see `docs/api.md`.

**Agent**

- One coordinating agent on the OpenAI Agents SDK, one configured model, no runtime router.
- Instructions enforcing evidence discipline, the untrusted-corpus boundary, conflict
  surfacing, evidence-based staleness reasoning and qualitative-only confidence. Prompt
  version `2026-09-15.1`.
- Nine read-only tools: `list_corpus_files`, `load_corpus_artifact`, `render_pdf_page`,
  `search_pdf_text`, `graph_summary`, `graph_find_nodes`, `graph_neighbors`,
  `graph_shortest_path`, `graph_edge_lookup`.
- Tool-boundary guardrails: corpus path containment on input, credential suppression on
  output.

**Corpus**

- Recursive discovery of `.png`, `.pdf` and `.graphml` under a configured root; every other
  extension ignored deterministically.
- Single path resolver enforcing containment after symlink resolution, existence,
  regular-file type, extension policy and a size bound checked before any read.
- PDF page rendering and literal, case-insensitive page text search with one-based page
  numbers.
- Deterministic GraphML parsing preserving directedness, parallel-edge identity and every
  node and edge attribute, with bounded summary, node-search, neighbourhood, shortest-path
  and edge-lookup queries. Truncated results say so.
- Process-local caches for parsed graphs, page text and the scan snapshot, keyed by file
  version.

**Sessions**

- File-backed SDK `SQLiteSession`. No application conversation tables and no SQL against
  the SDK tables.
- Session-object registry with per-session run locks, LRU and idle eviction. Eviction never
  deletes history.
- Conservative session identifier validation.

**Runtime**

- Global admission semaphore, per-session serialisation, overall run deadline, model-call
  timeout, tool timeout, maximum-turn bound and bounded model retries.
- Failure classification into stable codes. Cancellation releases the session lock and the
  admission slot and is never recorded as success.
- Session persistence failure fails the request rather than continuing silently.

**Observability**

- Twenty-five metrics covering requests, runs, model calls, tools, sessions and corpus
  access, exposed as a Prometheus text exposition with bounded label cardinality.
- Run lifecycle hooks recording identifiers, timings and token usage. No prompt content,
  corpus content or model reasoning is logged.
- Request, session and trace identifiers on every log line.

**Quality**

- 316 tests across unit, integration, contract, security, performance and evaluation
  suites. The default gate reaches no network and calls no model.
- A curated twelve-case gold set with an evidence-grounded scorer, plus tests for the scorer
  itself. The billed evaluation is opt-in and reports rather than gates.
- `ruff format`, `ruff check`, `mypy --strict`, `pytest` and a package build, all run in CI
  from a clean environment.

**Documentation**

- `README.md`, `docs/architecture.md`, `docs/api.md`, `docs/operations.md` and twelve
  architecture decision records, each naming the evidence that would reverse it.

### Known limitations

- One worker only. The per-session lock is process-local, so a multi-worker deployment
  would break turn ordering; it needs distributed same-session ownership first.
- No authentication or per-caller rate limiting. Run behind an authenticating proxy.
- No acceptance thresholds on evaluation metrics. These are to be approved from observed
  baseline data rather than invented before measurement.

[Unreleased]: https://github.com/neuralatlasai/pid-intelligence/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/neuralatlasai/pid-intelligence/releases/tag/v0.1.0
