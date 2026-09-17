## What this changes

<!-- The behaviour or interface that changes, and why. One or two sentences. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## Checklist

- [ ] `ruff format --check src tests` passes
- [ ] `ruff check src tests` passes
- [ ] `mypy` passes
- [ ] `pytest` passes
- [ ] Documentation changed in this pull request, not a later one
- [ ] `CHANGELOG.md` updated if the change is externally observable
- [ ] A defect fix carries a regression test, or the pull request says why it cannot

## Non-negotiables

Confirm this change does not:

- [ ] introduce a domain request or response schema on the model plane
- [ ] create a conversation table, or run SQL against the SDK session tables
- [ ] set `previous_response_id`, `auto_previous_response_id` or `conversation_id`
- [ ] add a non-OpenAI provider adapter or a runtime model router
- [ ] read a corpus path without going through `resolve_corpus_path`
- [ ] give a tool write, shell, network, SQL, environment or secret access
- [ ] emit a numeric confidence score

If it does any of these deliberately, update the corresponding record in `docs/adr/` in
this pull request and say what evidence justifies the reversal.

## Impact

- **Public API / compatibility:** <!-- none, additive, or breaking -->
- **Security:** <!-- new trust boundary, new input, new privilege? -->
- **Operations:** <!-- new setting, new metric, new failure mode? -->

## Prompt or model change

If `PID_AGENT_INSTRUCTIONS` or `OPENAI_MODEL` changed:

- [ ] `PROMPT_VERSION` bumped
- [ ] Evaluation reports attached from before and after
