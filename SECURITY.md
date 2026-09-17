# Security policy

## Reporting a vulnerability

Do not open a public issue or pull request for a security defect.

Report privately to the maintainers through the repository's private vulnerability
reporting channel. Include what you did, what happened, what you expected, and — if the
finding involves the corpus — a synthetic artifact that reproduces it rather than a real
engineering document.

Expect acknowledgement within three working days and an assessment of exploitability and
impact within ten. Findings are triaged by exploitability and impact; accepted risk is
documented rather than left implicit.

## Threat model

The service reads an untrusted engineering corpus, sends parts of it to a model provider,
and exposes an HTTP API. The interesting boundaries are:

**Corpus content is untrusted data.** Text inside PDFs, text drawn on images, GraphML
attributes and filenames are evidence, never instruction. A document telling the agent to
ignore its instructions, reveal a key or run a command is reported as a property of that
document and never obeyed. The agent instruction states this explicitly, and
`tests/security/` asserts that embedded instruction text reaches the model only as an
ordinary tool result and never as a system message.

**Filesystem access is funnelled through one resolver.** Every caller-supplied path passes
containment under the corpus root — checked after symlink resolution — plus existence,
regular-file type, extension policy and a size bound read from `stat` before any byte is
read. Absolute paths, drive-qualified paths, UNC paths, NUL bytes and over-long paths are
rejected syntactically before resolution.

Two independent layers enforce this: the resolver inside each tool, and a tool input
guardrail that re-validates any `path` argument before the tool body runs. The redundancy
is deliberate — a tool added later without the resolver still fails closed.

**Tools are read-only and narrow.** The agent has no shell, no network reach, no file
write, no delete, no SQL execution, no environment access and no secret retrieval. There
are nine tools and `tests/security/` asserts the count and scans the tool modules for the
capabilities they must not have.

**Credentials never enter the model plane.** `OPENAI_API_KEY` is never placed in model
context, returned by a tool, logged, or written to session history. A tool output guardrail
suppresses any result containing it, and `Settings.describe` reduces it to a presence flag
for startup logging.

**Session identifiers are opaque keys.** They match a conservative pattern, and are never
filesystem paths and never interpolated into SQL.

**Input crossing the trust boundary is validated before use.** Request bodies are bounded
and abandoned as soon as they exceed the limit; the payload must be a string or a list of
objects; the session identifier must conform.

## What is deliberately not defended

- **Multi-tenant isolation.** Sessions are isolated from one another, but any caller who
  can reach the API can read any session and the whole corpus. Put an authenticating proxy
  in front of it, or run it somewhere only trusted callers can reach.
- **Corpus confidentiality from the model provider.** Artifacts the agent reads are sent to
  the configured provider. Do not point `CORPUS_ROOT` at material that must not leave the
  environment.
- **Denial of service from a trusted caller.** Admission, deadlines, turn bounds and size
  limits bound resource use per request, but there is no per-caller rate limiting.

## Operational requirements

- Run the service with least privilege. It needs read access to `CORPUS_ROOT` and write
  access to the `SQLITE_PATH` directory, and nothing else.
- Keep `CORPUS_ROOT` read-only at the filesystem level as well. The service never writes
  there; enforcing it removes a class of mistake.
- Do not commit `.env`. Production credentials belong in the environment or a secret
  manager.
- Enable dependency and secret scanning on the repository.
- Apply least privilege to CI identities and deployment credentials.

## Logging

Never logged: full document bytes, base64 images, complete corpus documents, prompt
contents, hidden model reasoning, or credential material. What is logged is identifiers,
timings, counts, statuses and sizes. Error bodies returned to clients carry a stable code,
a message and a request identifier — never a stack trace, corpus content or credential
material.

## Supported versions

Pre-1.0: only the latest release receives security fixes.
