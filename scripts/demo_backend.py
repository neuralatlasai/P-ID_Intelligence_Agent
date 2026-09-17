"""Run the real backend with a scripted model, for frontend verification.

This starts the actual application — real tools, real corpus, real session persistence —
and substitutes only the model, so the frontend is exercised against genuine backend
behaviour without a billed provider call.
"""

from __future__ import annotations

import sys
from typing import Any

import uvicorn
from agents.testing import ScriptedModel, assistant_message, function_call

from pid_intelligence.agent.factory import build_pid_agent
from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import build_corpus_services
from pid_intelligence.main import build_app
from pid_intelligence.memory.registry import SessionRegistry
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

ANSWER = """Answer
FCV-2201 is a control valve used to regulate flow to the heat exchanger E-2201 in the \
cooling water system. It is part of a flow control loop and modulates based on the \
downstream temperature.

Observed (from drawings and documents)
- FCV-2201 is located on line CW-2201-6 — PID2Graph OPEN100/0.graphml
- Connected downstream to E-2201 — 462-Piping-and-Instrumentation-Diagrams.pdf page 3
- Positioned upstream of TI-2210 — PID2Graph OPEN100/0.graphml

Corroborated (across sources)
- Tagged as a flow control valve (globe type) — PID2Graph OPEN100/1.graphml
- Control loop FC-2201 references TIC-2210 — 462-Piping-and-Instrumentation-Diagrams.pdf page 5

Inferred (from context)
- Modulates to maintain target outlet temperature at E-2201
- Likely fails closed based on the cause-and-effect table

Conflicting / Unknown
- Position feedback signal is not clearly shown in revision A
- Alarm configuration was not found in the available documents

Topology / connectivity
P-2101A -> FCV-2201 -> E-2201

Asset hierarchy
- Cooling water unit
  - E-2201 heat exchanger
    - FCV-2201 control valve

Impacted assets
- E-2201 — downstream heat exchanger
- P-2101A — upstream pump
- TI-2210 — temperature indicator

Uncertainty
Evidence support is partial: the valve's fail position is inferred from the \
cause-and-effect table rather than observed on a drawing.
"""

SHORT_ANSWER = """Answer
Six instruments are connected to E-2201 in the current topology file.

Observed (from drawings and documents)
- Instrument set resolved from PID2Graph OPEN100/0.graphml
"""


class ConversationDrivenModel(ScriptedModel):
    """A deterministic model that derives each step from the conversation so far.

    A fixed script is a queue, and a queue is shared. With several sessions running at once
    each one pops whichever step happens to be at the head, so a session can receive another
    conversation's tool call — or an answer with no tool calls at all. That makes an
    end-to-end suite flaky for reasons that have nothing to do with the code under test.

    Deciding from the input instead makes every call a pure function of that session's own
    history: two tool calls, then the answer, however many sessions run in parallel.
    """

    def __init__(self) -> None:
        """Start empty; every call supplies its own step."""
        super().__init__([])

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        """Serve the step this conversation is due."""
        return await self._for_call(args, kwargs).get_response(*args, **kwargs)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        """Stream the step this conversation is due."""
        return self._for_call(args, kwargs).stream_response(*args, **kwargs)

    def _for_call(self, args: tuple[Any, ...], kwargs: dict[str, Any]) -> ScriptedModel:
        """Build a single-step model for one call, chosen by the input it was given."""
        model_input = kwargs.get("input", args[1] if len(args) > 1 else None)
        return ScriptedModel([self._step_for(model_input)])

    @staticmethod
    def _step_for(model_input: Any) -> Any:
        """Choose the step: two tool calls, then the answer.

        The number of tool results already in the input says how far this conversation has
        got. Counting them is what makes the choice independent of every other session.
        """
        completed_tools = 0
        if isinstance(model_input, list):
            completed_tools = sum(
                1
                for item in model_input
                if isinstance(item, dict) and item.get("type") == "function_call_output"
            )

        if completed_tools == 0:
            return [
                function_call(
                    "list_corpus_files",
                    {"file_type": "graphml", "limit": 3},
                    call_id="demo-list",
                )
            ]
        if completed_tools == 1:
            return [
                function_call(
                    "graph_summary",
                    {"path": "PID2Graph OPEN100/0.graphml"},
                    call_id="demo-summary",
                )
            ]
        # A follow-up turn carries the previous turn's tool results too, so an even count
        # marks the long answer and an odd one the short answer. Both are realistic, and
        # alternating them exercises the projection against more than one shape.
        return [assistant_message(ANSWER if completed_tools % 2 == 0 else SHORT_ANSWER)]


def main() -> int:
    """Start the service on the configured port."""
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    settings = Settings.load_and_validate(
        CORPUS_ROOT="data",
        SQLITE_PATH="var/demo-frontend.sqlite3",
        ENABLE_TRACING=False,
        OPENAI_API_KEY=None,
    )
    metrics = MetricsRegistry()
    services = build_corpus_services(settings)
    agent = build_pid_agent(settings, services, metrics).clone(model=ConversationDrivenModel())
    registry = SessionRegistry(
        db_path=settings.sqlite_path, max_entries=64, idle_s=3600.0, metrics=metrics
    )
    runtime = PIDRuntime(agent=agent, registry=registry, settings=settings, metrics=metrics)
    app = build_app(runtime=runtime, settings=settings, metrics=metrics, services=services)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
