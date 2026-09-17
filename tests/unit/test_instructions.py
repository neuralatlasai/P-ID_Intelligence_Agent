"""Behavioural contract for accessible, evidence-grounded assistant answers."""

from pid_intelligence.agent.instructions import PID_AGENT_INSTRUCTIONS, PROMPT_VERSION


def test_prompt_requires_plain_language_component_explanations() -> None:
    assert "# Audience and explanation depth" in PID_AGENT_INSTRUCTIONS
    assert "# Component and detection questions" in PID_AGENT_INSTRUCTIONS
    assert "Plain-language purpose" in PID_AGENT_INSTRUCTIONS
    assert "Pipeline coverage" in PID_AGENT_INSTRUCTIONS


def test_prompt_forbids_invented_session_names_and_vague_component_references() -> None:
    assert "never invent a session name" in PID_AGENT_INSTRUCTIONS
    assert '"that component"' in PID_AGENT_INSTRUCTIONS


def test_prompt_revision_changes_with_the_contract() -> None:
    assert PROMPT_VERSION == "2026-09-16.9"


def test_prompt_routes_connection_questions_through_apparatus() -> None:
    # A hop-bounded search exhausts itself on line connectors; the agent answered "connected
    # to nothing" for a valve the canvas showed joined to sixteen components.
    assert "graph_connected_equipment" in PID_AGENT_INSTRUCTIONS
    assert "Never conclude that a component is connected to nothing" in PID_AGENT_INSTRUCTIONS


def test_prompt_keeps_pixel_positions_out_of_cited_evidence() -> None:
    # The rule is wrapped across a line in the prompt, so match it whitespace-insensitively.
    assert "never by pixel coordinates" in " ".join(PID_AGENT_INSTRUCTIONS.split())


def test_prompt_keeps_generated_and_simulated_context_out_of_observed_evidence() -> None:
    assert "explanatory context, never" in PID_AGENT_INSTRUCTIONS
    assert "Only a corpus artifact actually" in PID_AGENT_INSTRUCTIONS
    assert "Generated visuals and simulated observations" in PID_AGENT_INSTRUCTIONS


def test_prompt_verifies_fusion_annotations_against_graphml() -> None:
    assert "ANN-001 -> tank67" in PID_AGENT_INSTRUCTIONS
    assert "verify the target node" in PID_AGENT_INSTRUCTIONS
    assert "visual resemblance does not verify" in PID_AGENT_INSTRUCTIONS
    assert "check every supplied annotation-to-node pair independently" in PID_AGENT_INSTRUCTIONS
