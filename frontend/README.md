# P&ID Intelligence — Web

The browser UI and Node gateway for the [P&ID Intelligence Agent](../README.md) backend.

An engineer asks a question, watches the agent work, and reads an answer that says which
drawings it rests on and how each claim is known. The frontend owns none of that reasoning:
it owns getting the question there, showing the work honestly, and getting out of the way.

## What this is, and what it is not

| Owner | Responsibility |
|---|---|
| Python backend | Conversation truth, model execution, tools, corpus, engineering reasoning, persistence |
| Node gateway | Same-origin transport, backend URL isolation, streaming pass-through, header policy |
| Browser | Session navigation, input, streaming presentation, evidence projection, layout, accessibility |

Three constraints follow, and each is enforced by a test in `tests/contract/`:

- **No domain wire schema.** The request body is an OpenAI Responses input; the response is
  native output items; stream frames are native Responses events. There is no `PIDRequest`,
  no `PIDResponse`, no evidence envelope.
- **One protocol boundary.** Every protocol type is re-exported from the pinned `openai`
  package by `src/lib/responses/native-types.ts`. No other module imports it, and nothing
  hand-declares the protocol — so the compiler and the lockfile are what catch drift.
- **No second backend.** No model call, no API key, no database, no corpus access. The
  gateway forwards bytes and does not interpret them.

## Running it

The backend must be running first.

```bash
# Terminal 1 — the Python backend (from the repository root)
pid-intelligence                       # serves http://127.0.0.1:8000

# Terminal 2 — this application
cd frontend
npm install
cp .env.example .env.local             # then set BACKEND_BASE_URL if it is not the default
npm run dev                            # http://localhost:3000
```

For a production build:

```bash
npm run build
BACKEND_BASE_URL=http://127.0.0.1:8000 npm start
```

`BACKEND_BASE_URL` is server-only. The browser calls same-origin `/api/*` routes, so the
backend's location never reaches the bundle and CORS never enters the picture. A production
build fails if it is unset.

> **Note on `npm run`.** Each script invokes its tool through `node ./node_modules/<tool>`
> rather than the generated `.bin` shim. The shims interpolate their own directory unquoted,
> so any path containing `&` breaks them — and this project lives under
> *P&ID Intelligence Agent*. Calling `node` directly is shell- and platform-independent.

## The screen

```
┌──────────────────────────────────────────────────────────────────────┐
│ P&ID Intelligence                    OpenAI Agents SDK · Backend ready│
├───────────┬──────────────────────────────────────┬───────────────────┤
│ Sessions  │ Session active · <id>                │ EVIDENCE          │
│           ├──────────────────────────────────────┤                   │
│ + New     │ You  What is FCV-2201?               │ Cited sources     │
│ Search    │                                      │ Evidence support  │
│           │ ▣    Activity & tool calls  3 steps  │ Topology          │
│ Today     │      Answer                          │ Asset hierarchy   │
│  …        │      Observed (from drawings)        │ Impacted assets   │
│ Yesterday │      Corroborated (across sources)   │                   │
│  …        │      Inferred (from context)         │                   │
│           │      Conflicting / Unknown           │                   │
│ Help      │      Elapsed 3.2 s                   │                   │
│ Settings  ├──────────────────────────────────────┤                   │
│           │ Ask a follow-up question…         ➤  │                   │
└───────────┴──────────────────────────────────────┴───────────────────┘
```

Which regions are on screen depends on width, and **every region stays reachable at every
width**:

| Width | Sessions | Conversation | Evidence |
|---|---|---|---|
| ≥ 1440px | column | column | column |
| ≥ 1180px | column | column | inline under the answer |
| < 1180px | drawer | column | inline under the answer |

Evidence renders in exactly one place at a time. Rendering it in both the rail and the
inline stack would duplicate every citation in the accessibility tree.

## How an answer is presented

The backend's prompt asks the agent to label each claim — observed, corroborated, inferred,
conflicting, unknown — and to write under stable headings. The frontend recognises that
structure and presents it. It never creates it.

Four rules hold, each covered by a test in `tests/unit/sections.test.ts`:

1. **Nothing is lost.** The answer is split into segments whose concatenation reproduces the
   source exactly, and the renderer walks segments. A heading the parser fails to recognise
   simply renders without the extra styling.
2. **Nothing is invented.** A card appears only when the answer explicitly contains the
   corresponding section. There is no placeholder saying "no topology change" — that would
   be a claim the answer never made.
3. **Recognition is lexical.** Headings are matched by text. No model is called, and no
   engineering relationship is inferred from a naming convention.
4. **Failure is local.** A malformed answer costs a card, never the answer.

### Citations are verified, not guessed

A corpus path can contain a space — `PID2Graph OPEN100/0.graphml` is real — and a regex
permissive enough to span one also swallows the prose before it. So a path found in the
answer is reported only when it stands alone, or when extending it leftwards reproduces a
path the agent demonstrably opened or the backend listed. A fragment that cannot be resolved
is dropped: a truncated path looks real, resolves to nothing, and would send an engineer
looking for a file that does not exist.

Each citation says how it is known — *opened by agent* (taken from persisted tool arguments)
or *cited in answer*. A path cited but never opened is exactly the kind of thing worth
noticing.

### Confidence is categorical

Evidence support reads *Supported*, *Partial*, *Conflicting*, *Insufficient* or
*Not assessed*, and every one of them says a calibrated score is unavailable. There is no
numeric confidence and will not be until the backend produces a value calibrated against
known outcomes. A number a model emits is not calibrated because a model emitted it, and
"0.94" in a card labelled Confidence invites an engineer to act on a precision that does not
exist.

### Activity, not reasoning

The activity panel shows a tool's name and its state. Nothing else. Reasoning deltas,
reasoning summaries and tool arguments are recognised in `src/lib/responses/projector.ts`
specifically so they can be *excluded* — the exclusion is a stated decision rather than an
accident of which cases the switch happens to handle.

## Behaviour worth knowing

**A streamed POST is never retried automatically.** By the time the browser notices a broken
connection, the request may already have reached the backend and persisted the turn.
Replaying it would duplicate the conversation. Retry is always an explicit action, and the
question text is preserved so it can be retried or copied.

**Completion is not the last visible token.** After the stream ends the backend may still be
persisting the turn. The run stays in *Finalizing* until history has been re-read, and the
transcript then shows what was actually saved rather than what the browser assembled.

**Stop cancels the run, not just the view.** The abort propagates through the gateway to the
backend, which releases the run's session lock and admission slot.

**The session list is local.** The backend publishes no session list, so the sidebar shows
sessions opened in this browser and says so. A list that silently omitted work done
elsewhere, while looking complete, would be worse than no list.

## Architecture

```
src/
├── app/
│   ├── api/                    Node gateway — the only path to the backend
│   │   ├── health/
│   │   └── sessions/[sessionId]/{responses,responses/stream,items}
│   ├── s/[sessionId]/          the session route
│   └── layout.tsx, page.tsx, globals.css
├── proxy.ts                    refuses a malformed session address with a real 404
├── components/
│   ├── shell/                  header, runtime status, session banner, app shell
│   ├── session/                sessions sidebar
│   ├── conversation/           transcript, turns, activity, answer, composer
│   ├── evidence/               the five evidence cards and the rail
│   └── ui/                     button, card, badge, dialog, disclosure, icons
├── hooks/                      streaming run, session history, health, scroll, viewport
├── lib/
│   ├── backend/                gateway, header policy, error vocabulary
│   ├── responses/              protocol boundary, SSE, projectors, section extraction
│   ├── session/                identifiers, local shortcuts
│   ├── security/               URL safety
│   └── telemetry/              turn timing
└── styles/                     tokens, layout, typography
```

## Testing

```bash
npm run gate          # format, lint, types, unit + integration + contract + security, build
npm run test          # 345 tests, no network, no model
npm run test:e2e      # 81 tests across three viewports, against a real backend
```

The default suite reaches no network and calls no model: the streaming path is exercised
against mocked gateway responses, including deltas split one byte at a time.

The E2E suite needs a backend. `tests/e2e/README.md` explains how to run one with a scripted
model, so the flows are deterministic and cost nothing.

| Suite | Proves |
|---|---|
| `tests/unit/` | SSE parsing at pathological chunk boundaries, the run state machine, section extraction, URL safety, error classification |
| `tests/integration/` | Streaming end to end, the answer surface, the evidence cards, the composer, the activity panel |
| `tests/contract/` | No domain schema, one protocol import, no second backend, backend URL server-only |
| `tests/security/` | Model output renders inert, unsafe URLs are refused, hostile session identifiers are rejected |
| `tests/e2e/` | The real workflow, keyboard-only operation, axe checks, 200% zoom, reduced motion |

## Accessibility

WCAG 2.2 AA is a release gate, not an aspiration. Every axe check runs at all three
viewports on every state — empty, answered, activity expanded, dialog open — and the
keyboard flows are exercised explicitly rather than assumed.

Specifics worth stating:

- Every text colour meets 4.5:1 against every surface it is used on; the values are computed
  and recorded in `src/styles/tokens.css`.
- Status is icon plus text plus colour, never colour alone.
- The answer is not a live region. Announcing every token would make the page unusable with
  a screen reader; completion is announced once.
- Dialogs trap focus and return it to whatever opened them.
- Nothing animates under `prefers-reduced-motion`.

## Security

- Model output is untrusted. Markdown renders with raw HTML disabled; `dangerouslySetInnerHTML`
  appears nowhere and a test enforces that. Link and image URLs pass a scheme allowlist, so a
  `javascript:` href becomes plain text.
- A corpus path is never turned into a URL. The backend serves no corpus files, so any link
  built from a path would resolve against the current route and point at nothing.
- Session identifiers are validated in the proxy, in the page and in the gateway, against the
  same pattern the backend uses.
- The gateway allowlists routes and headers in both directions. There is no generic URL proxy,
  and credentials are never forwarded upstream.
- A strict CSP is set in `next.config.ts`. `'unsafe-eval'` is granted only in development.

## Further reading

- `plan(20260915-145645).md` — the implementation plan this was built against.
- `../docs/api.md` — the backend contract the gateway forwards to.
- `../docs/architecture.md` — backend boundaries and state ownership.
