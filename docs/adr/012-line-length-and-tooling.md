# ADR-012 - 100-character lines, ruff and mypy strict

**Status:** Accepted

## Context

`standards.md` requires machine-enforced formatting that remains PEP 8 compatible unless a
documented project rule overrides it, and requires that a conflict between applicable rules
be documented with the selected rule, its authority and the reason.

## Decision

- **Line length 100.** PEP 8 recommends 79 and the Google Python Style Guide 80. This
  project selects 100.
- **Formatter and linter:** ruff, configured in `pyproject.toml`.
- **Type checker:** mypy in strict mode over `src/pid_intelligence`.

## Reason for the line-length selection

PEP 8 explicitly permits a team to agree a longer limit, so this is a choice within PEP 8
rather than a departure from it. The code here carries long identifiers by design -
`max_function_tool_concurrency`, `build_secret_redaction_guardrail`, `ToolOutputFileContent`
- and 79 columns would force a wrap into most signatures and most f-strings, which harms
readability rather than helping it. 100 leaves those on one line and still fits two files
side by side on an ordinary display.

The rule is machine-enforced, so it does not depend on individual preference.

## Suppressions

Suppressions are minimal, localised and justified inline. The ones present are:

- `# noqa: BLE001` at four sites: two transport boundaries, one background-task boundary and
  one shutdown boundary. Section 8 of `standards.md` permits broad capture at process and
  service boundaries; each site preserves diagnostic context and each carries a comment
  saying why.
- `# noqa: PLC0415` on the delayed `uvicorn` import, which exists so the package is
  importable and testable without the optional server extra.
- Per-file ignores for tests, each listed with a reason in `pyproject.toml`.

## Reverses if

The team adopts a different formatter profile. The rule matters less than that it is
machine-enforced and written down.
