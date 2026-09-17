# Architecture decision records

Each record states a decision, why it was taken, and — most usefully — what evidence would
reverse it. A decision with no stated reversal condition is a prejudice, not an
architecture.

| ADR | Decision | Reverses if |
|---|---|---|
| [001](001-openai-responses-is-the-model-plane-contract.md) | OpenAI Responses types are the model-plane contract | A second model provider becomes a requirement |
| [002](002-no-structured-domain-output.md) | No structured domain output object | A consumer proves prose cannot serve it |
| [003](003-sdk-owned-session-schema.md) | The SDK owns the conversation schema | Never, while the SDK owns sessions |
| [004](004-basic-sqlite-session.md) | Basic `SQLiteSession`, not the advanced variant | Branching or per-turn SQL analytics is needed |
| [005](005-single-conversation-authority.md) | Local session is the sole conversation authority | Server-managed state replaces the local session entirely |
| [006](006-one-coordinating-agent.md) | One coordinating agent | An ablation shows multi-agent quality gains exceeding the costs |
| [007](007-native-multimodal-tool-outputs.md) | SDK-native multimodal tool outputs | The SDK stops converting them to native content |
| [008](008-one-run-per-session.md) | One in-flight run per session | Distributed session ownership arrives |
| [009](009-corpus-is-filesystem-owned.md) | The corpus is filesystem-owned state | Measured query behaviour proves local tools inadequate |
| [010](010-single-configured-model.md) | One configured model, no router | Baseline accuracy is established and cost becomes binding |
| [011](011-qualitative-confidence.md) | Qualitative confidence only | A calibration method is evaluated against known outcomes |
| [012](012-line-length-and-tooling.md) | 100-character lines, ruff and mypy strict | The team adopts a different formatter profile |
