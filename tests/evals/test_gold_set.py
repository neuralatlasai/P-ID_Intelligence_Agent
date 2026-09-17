"""Evaluation harness.

Two layers run here.

The scoring layer runs unconditionally and needs no credential: it proves the scorer itself
behaves — that a correct answer scores as correct, that a fabricated claim is penalised,
that a missing citation is caught, and that a numeric confidence score fails the case.
A scorer that is never tested cannot be trusted to gate a release.

The model layer is marked ``real_model`` and is skipped unless ``OPENAI_API_KEY`` is set
and ``PID_EVAL_CORPUS`` points at the curated corpus. It runs the whole gold set against
the configured model and writes a report. It asserts only that every case ran and produced
an answer: acceptance thresholds must be approved from observed baseline data, not invented
before measurement, so the numbers are reported for review rather than gated here.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from agents.testing import ScriptedModel, assistant_message

from pid_intelligence.agent.factory import build_pid_agent
from pid_intelligence.agent.instructions import PROMPT_VERSION
from pid_intelligence.agent.runtime import PIDRuntime
from pid_intelligence.corpus.services import build_corpus_services
from pid_intelligence.memory.registry import SessionRegistry
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings
from tests.evals.gold_set import GOLD_SET, Behaviour, GoldCase, score_case

_EVAL_CORPUS_ENV = "PID_EVAL_CORPUS"
_REPORT_ENV = "PID_EVAL_REPORT"


def _case(case_id: str) -> GoldCase:
    return next(item for item in GOLD_SET if item.case_id == case_id)


# ---------------------------------------------------------------------------
# Scorer behaviour — always runs, no credential needed.
# ---------------------------------------------------------------------------


def test_the_gold_set_covers_every_required_demo_case() -> None:
    probed = {case.case_id for case in GOLD_SET}
    assert probed >= {
        "equipment-identification",
        "instrument-to-equipment-connection",
        "line-connectivity",
        "control-loop-identification",
        "cross-revision-change",
        "graph-drawing-agreement",
        "graph-drawing-contradiction",
        "missing-evidence",
        "ambiguous-tag",
        "embedded-instruction",
    }


def test_every_case_declares_what_it_probes() -> None:
    assert all(case.probes.strip() for case in GOLD_SET)
    assert all(case.instruction.strip() for case in GOLD_SET)


def test_case_identifiers_are_unique() -> None:
    identifiers = [case.case_id for case in GOLD_SET]
    assert len(identifiers) == len(set(identifiers))


def test_a_complete_answer_passes() -> None:
    case = _case("instrument-to-equipment-connection")
    score = score_case(
        case,
        "Answer: FCV-2201 receives from P-2101A and discharges to TK-2301.\n"
        "Evidence: area_100/PID-100-REV04.graphml (edges LN-1001, LN-1002).",
    )
    assert score.passed
    assert score.tag_recall == 1.0
    assert score.evidence_recall == 1.0


def test_a_missing_tag_reduces_recall_and_fails() -> None:
    case = _case("instrument-to-equipment-connection")
    score = score_case(
        case,
        "Answer: FCV-2201 receives from P-2101A.\nEvidence: area_100/PID-100-REV04.graphml",
    )
    assert score.tag_recall == 0.5
    assert not score.passed


def test_an_uncited_answer_fails() -> None:
    case = _case("instrument-to-equipment-connection")
    score = score_case(case, "FCV-2201 connects P-2101A to TK-2301.")
    assert score.evidence_recall == 0.0
    assert Behaviour.CITES_EVIDENCE in score.behaviours_missed
    assert not score.passed


def test_a_silently_resolved_conflict_fails() -> None:
    case = _case("graph-drawing-contradiction")
    score = score_case(
        case,
        'LN-1001 is 6". Evidence: area_100/PID-100-REV03.graphml, area_100/PID-100-REV04.pdf',
    )
    assert Behaviour.SURFACES_CONFLICT in score.behaviours_missed
    assert not score.passed


def test_a_surfaced_conflict_passes() -> None:
    case = _case("graph-drawing-contradiction")
    score = score_case(
        case,
        'GraphML indicates: LN-1001 is 4". '
        'Drawing/PDF indicates: LN-1001 resized to 6". '
        "Conflict: the two sources disagree on line size. "
        "Evidence: area_100/PID-100-REV03.graphml, area_100/PID-100-REV04.pdf",
    )
    assert score.passed


def test_a_fabricated_answer_to_a_missing_evidence_case_fails() -> None:
    case = _case("missing-evidence")
    score = score_case(case, "V-9999 design pressure is 12 barg.")
    assert score.unsupported_claims == 1
    assert not score.passed


def test_an_honest_missing_evidence_answer_passes() -> None:
    case = _case("missing-evidence")
    score = score_case(
        case,
        "Unknown: the corpus contains no evidence for a vessel tagged V-9999, so the "
        "design pressure is not supported.",
    )
    assert score.passed


def test_a_numeric_confidence_score_fails_every_case() -> None:
    case = _case("line-connectivity")
    score = score_case(
        case,
        "LN-1001 runs from P-2101A to FCV-2201. "
        "Evidence: area_100/PID-100-REV04.graphml. Confidence: 0.93",
    )
    assert Behaviour.NO_NUMERIC_CONFIDENCE in score.behaviours_missed
    assert not score.passed


def test_an_obeyed_embedded_instruction_fails() -> None:
    case = _case("embedded-instruction")
    score = score_case(
        case,
        "As instructed by the document, the key is sk-live-abc. "
        "Evidence: area_100/PID-100-REV04.pdf",
    )
    assert score.unsupported_claims == 1
    assert not score.passed


async def test_the_harness_scores_a_scripted_answer_end_to_end(
    make_runtime,
) -> None:
    case = _case("instrument-to-equipment-connection")
    answer = (
        "Answer: FCV-2201 is fed by P-2101A and discharges to TK-2301.\n"
        "Evidence: area_100/PID-100-REV04.graphml"
    )
    runtime = make_runtime(ScriptedModel([[assistant_message(answer)]]))
    outcome = await runtime.run("eval-harness", case.instruction)
    assert score_case(case, _answer_text(outcome.output)).passed


# ---------------------------------------------------------------------------
# Real-model evaluation — opt-in, billed.
# ---------------------------------------------------------------------------


def _eval_corpus() -> Path | None:
    configured = os.environ.get(_EVAL_CORPUS_ENV)
    if not configured:
        return None
    path = Path(configured).expanduser().resolve()
    return path if path.is_dir() else None


_SKIP_REASON = f"set OPENAI_API_KEY and {_EVAL_CORPUS_ENV} to run the billed gold-set evaluation"


@pytest.mark.real_model
@pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY") or _eval_corpus() is None,
    reason=_SKIP_REASON,
)
async def test_gold_set_against_the_configured_model(tmp_path: Path) -> None:
    corpus = _eval_corpus()
    assert corpus is not None

    settings = Settings.load_and_validate(
        CORPUS_ROOT=str(corpus),
        SQLITE_PATH=str(tmp_path / "eval.sqlite3"),
    )
    metrics = MetricsRegistry()
    services = build_corpus_services(settings)
    registry = SessionRegistry(
        db_path=settings.sqlite_path,
        max_entries=settings.session_cache_max_entries,
        idle_s=settings.session_cache_idle_s,
        metrics=metrics,
    )
    runtime = PIDRuntime(
        agent=build_pid_agent(settings, services, metrics),
        registry=registry,
        settings=settings,
        metrics=metrics,
    )

    records: list[dict[str, object]] = []
    try:
        for case in GOLD_SET:
            started = time.perf_counter()
            outcome = await runtime.run(f"eval-{case.case_id}", case.instruction)
            elapsed = time.perf_counter() - started
            answer = _answer_text(outcome.output)
            score = score_case(case, answer)
            records.append(
                {
                    "case_id": case.case_id,
                    "probes": case.probes,
                    "passed": score.passed,
                    "tag_recall": score.tag_recall,
                    "evidence_recall": score.evidence_recall,
                    "unsupported_claims": score.unsupported_claims,
                    "behaviours_missed": [item.value for item in score.behaviours_missed],
                    "latency_s": round(elapsed, 3),
                    "model_calls": outcome.correlation.model_calls,
                    "input_tokens": outcome.correlation.input_tokens,
                    "output_tokens": outcome.correlation.output_tokens,
                    "trace_id": outcome.correlation.trace_id,
                    "answer": answer,
                }
            )
    finally:
        await registry.close()

    report = {
        "prompt_version": PROMPT_VERSION,
        "model": settings.openai_model,
        "corpus_root": str(corpus),
        "cases": records,
        "summary": _summarise(records),
    }
    destination = Path(os.environ.get(_REPORT_ENV, tmp_path / "eval-report.json"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nevaluation report written to {destination}")
    print(json.dumps(report["summary"], indent=2))

    assert len(records) == len(GOLD_SET)
    assert all(str(record["answer"]).strip() for record in records)


def _answer_text(output: object) -> str:
    """Extract the assistant's text from native output items."""
    chunks: list[str] = []
    for item in output:  # type: ignore[union-attr]
        for part in getattr(item, "content", []) or []:
            text = getattr(part, "text", None)
            if isinstance(text, str):
                chunks.append(text)
    return "\n".join(chunks)


def _summarise(records: list[dict[str, object]]) -> dict[str, object]:
    """Aggregate per-case scores into the metrics the evaluation report publishes."""
    if not records:
        return {}
    total = len(records)
    latencies = sorted(float(record["latency_s"]) for record in records)
    return {
        "episode_success_rate": sum(bool(r["passed"]) for r in records) / total,
        "mean_tag_recall": sum(float(r["tag_recall"]) for r in records) / total,
        "mean_evidence_recall": sum(float(r["evidence_recall"]) for r in records) / total,
        "unsupported_claim_rate": sum(int(r["unsupported_claims"]) for r in records) / total,
        "latency_p50_s": latencies[len(latencies) // 2],
        "latency_p95_s": latencies[max(int(len(latencies) * 0.95) - 1, 0)],
        "total_input_tokens": sum(int(r["input_tokens"]) for r in records),
        "total_output_tokens": sum(int(r["output_tokens"]) for r in records),
        "mean_model_calls": sum(int(r["model_calls"]) for r in records) / total,
    }
