# Contributing

Written for anyone changing this repository.

`standards.md` is the engineering baseline and takes precedence over anything here.
`project.md` is the implementation plan this backend was built against.

## Setup

```bash
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev,server]"
```

## The gate

Run all four before opening a pull request. CI runs the same commands from a clean
environment.

```bash
ruff format --check src tests
ruff check src tests
mypy
pytest
```

`pytest` excludes the `performance` and `real_model` markers. Nothing in the gate reaches
the network or calls a model: model behaviour comes from the SDK scripted model, so agent
workflow shape is asserted without a billed call.

## Non-negotiables

These are enforced by `tests/contract/` and by `tests/security/`. A change that breaks one
fails the build, and that is deliberate — each protects a property that is expensive to
recover once lost.

- **No domain request or response schema.** Input is `str | list[TResponseInputItem]`;
  output is native output items; stream frames are native Responses events.
- **No second conversation store.** No SQL against the SDK tables, no competing table
  names, no ORM layer over them.
- **No server-managed continuation alongside the local session.** `previous_response_id`,
  `auto_previous_response_id` and `conversation_id` stay unset.
- **No non-OpenAI provider adapter.**
- **All corpus access through the resolver.** No tool calls `Path(user_string).read_bytes()`.
- **Tools stay read-only.** No shell, no network, no write, no delete, no SQL, no
  environment access, no secret retrieval.
- **No numeric confidence score.**

If you believe one of these should change, change the corresponding ADR in `docs/adr/`
first. Each record names the evidence that would reverse it; bring that evidence.

## Adding a tool

1. Build it in `tools/corpus_tools.py` or `tools/graph_tools.py` as a closure over
   `settings`, `services` and `metrics`. Settings are passed explicitly rather than read
   from a module global.
2. Resolve any caller-supplied path through `resolve_corpus_path`. Name the argument `path`
   so the containment guardrail sees it; if you must name it otherwise, add the name to
   `PATH_ARGUMENT_NAMES` in the same change and say why.
3. Run blocking work through `asyncio.to_thread`.
4. Wrap the body in `instrument_tool(metrics, "<tool_name>")`.
5. Bound the result, and state the truncation in the returned text when a bound bites.
6. Write the docstring for the model, not for a developer. It becomes the tool description
   and the argument schema, and it is the main lever on whether the agent uses the tool
   well. Say when to use it, when not to, and what a negative result does *not* prove.
7. Add unit tests for the tool and, if it changes workflow shape, a scripted agent-loop
   test.

## Adding a setting

Every operational bound is configuration. Add the field to `Settings` with an environment
alias and a validated range, document it in `.env.example` with its default and the reason
for that default, and add a rejection test to `tests/unit/test_settings.py`.

Defaults choose the safer behaviour.

## Tests

- Name a test for the behaviour or invariant it asserts, not for the function it calls.
- Tests must be deterministic and independent of execution order. Control clocks,
  randomness, the filesystem and the environment.
- Every defect fix carries a regression test unless the failure cannot be reproduced
  deterministically — and then say so in the pull request.
- A flaky test is a defect. Fix it or delete it; do not retry it.

Which suite:

| Directory | For |
|---|---|
| `tests/unit/` | One module in isolation |
| `tests/integration/` | Components together: sessions, HTTP, agent loop, failure injection |
| `tests/contract/` | The model-plane boundary and the structural non-negotiables |
| `tests/security/` | Containment, least privilege, injection, secret handling |
| `tests/performance/` | Load characterisation. Measures and prints; asserts structure only |
| `tests/evals/` | The gold set and its scorer |

## Changing the prompt

The prompt is a quality-critical artifact. Bump `PROMPT_VERSION` in
`agent/instructions.py` so an evaluation result can be attributed to the exact text that
produced it, and run the billed evaluation before and after:

```bash
export OPENAI_API_KEY=... PID_EVAL_CORPUS=/path/to/corpus
PID_EVAL_REPORT=./before.json pytest -m real_model    # on the current prompt
PID_EVAL_REPORT=./after.json  pytest -m real_model    # on yours
```

Attach both reports to the pull request.

## Documentation

Documentation changes in the same pull request as the behaviour it describes. A docstring
states behaviour — contract, side effects, raised exceptions, operational constraints — not
a restatement of the signature.

## Commits and review

- One purpose per commit. Do not mix generated or unrelated changes into a functional one.
- Changes reach the default branch through a pull request with passing required checks.
- Review evaluates correctness, interface compatibility, security, tests, documentation and
  operational impact.

## Security

Do not report a vulnerability in a public issue or pull request. Follow `SECURITY.md`.
