# Running the end-to-end suite

These tests drive a real browser against a real Node gateway and a real Python backend.
That is the point: streaming, session persistence across a reload, and layout at three
viewports cannot be verified any other way.

## What you need running

A backend on a port the gateway can reach. Two options.

### Against a scripted model (recommended)

The backend runs its real tools, real corpus and real session persistence, and substitutes
only the model. The flows are deterministic and nothing is billed.

```python
# scripts/demo_backend.py, run from the repository root
from agents.testing import ScriptedModel, assistant_message, function_call

from pid_intelligence.agent.factory import build_pid_agent
from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import build_corpus_services
from pid_intelligence.main import build_app
from pid_intelligence.memory.registry import SessionRegistry
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

settings = Settings.load_and_validate(CORPUS_ROOT="data", SQLITE_PATH="var/e2e.sqlite3")
metrics = MetricsRegistry()
services = build_corpus_services(settings)
agent = build_pid_agent(settings, services, metrics).clone(model=ScriptedModel(steps))
# ... build the registry, runtime and app, then serve with uvicorn.
```

The suite's assertions do not depend on the answer's wording. They check that an answer
arrives, that it is reconciled with persisted history, that citations carry provenance, and
that no numeric confidence appears — all of which hold for any answer the agent writes.

### Against a live model

```bash
OPENAI_API_KEY=... pid-intelligence
```

This works and is worth doing before a release, but it is slower, billed, and the answers
vary. Prefer the scripted backend for routine runs.

## Running

```bash
# Once, to fetch the browser.
npm run test:e2e:install

# All three viewports.
BACKEND_BASE_URL=http://127.0.0.1:8000 npm run test:e2e

# One viewport, or one test.
BACKEND_BASE_URL=http://127.0.0.1:8000 \
  node ./node_modules/@playwright/test/cli.js test --project=mobile
```

The config starts the frontend itself unless `E2E_BASE_URL` is set. Build first — it runs
`next start`, not the dev server, so what is tested is what would ship:

```bash
npm run build
```

## Viewports

| Project | Width | Exercises |
|---|---|---|
| `desktop-wide` | 1600px | Sessions, conversation and evidence all in their own columns |
| `desktop-narrow` | 1280px | Sessions column, evidence inline beneath the answer |
| `mobile` | Pixel 7 | Sessions as a drawer, everything stacked |

Running all three is not redundant. The drawer's stacking order, the inline evidence stack
and the touch targets only exist below a breakpoint, and a bug in any of them is invisible
at desktop width.

## When something fails

Playwright keeps a trace for every failure:

```bash
npx playwright show-trace test-results/<test-name>/trace.zip
```

The trace carries a DOM snapshot per step, the network log and the console, which is
usually faster than re-running with a headed browser.

## Accessibility failures

`accessibility.spec.ts` reports **every** axe violation in a run rather than stopping at the
first, so one run tells the whole story. A `color-contrast` violation names the offending
class; the fix belongs in `src/styles/tokens.css`, where the computed ratios are recorded
next to each value — change the token, not the component.
