"""GraphML parsing fidelity and bounded topology queries."""

from __future__ import annotations

from pathlib import Path

import networkx as nx
import pytest

from pid_intelligence.corpus.graphml import (
    GraphMlParseError,
    GraphRepository,
    NodeNotFoundError,
)


@pytest.fixture
def repository() -> GraphRepository:
    return GraphRepository(cache_max_entries=8, max_hops=4, max_nodes=50, max_edges=100)


@pytest.fixture
def rev04(corpus_root: Path) -> Path:
    return corpus_root / "area_100" / "PID-100-REV04.graphml"


def test_directed_graph_is_not_coerced_to_undirected(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    assert repository.summary(rev04).directed is True


def test_undirected_graph_stays_undirected(
    repository: GraphRepository,
    corpus_root: Path,
) -> None:
    summary = repository.summary(corpus_root / "area_200" / "parallel.graphml")
    assert summary.directed is False


def test_parallel_edge_identity_is_preserved(
    repository: GraphRepository,
    corpus_root: Path,
) -> None:
    path = corpus_root / "area_200" / "parallel.graphml"
    assert repository.summary(path).multigraph is True
    edges, total = repository.edge_lookup(path, source="HDR-01", target="HDR-02")
    assert total == 2
    assert {edge.attributes["line"] for edge in edges} == {"LN-2001", "LN-2002"}
    assert len({edge.key for edge in edges}) == 2


def test_node_and_edge_attributes_are_preserved(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    summary = repository.summary(rev04)
    assert "label" in summary.node_attribute_keys
    assert "loop" in summary.node_attribute_keys
    assert set(summary.edge_attribute_keys) == {"line", "size"}


def test_summary_reports_counts_and_label_distribution(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    summary = repository.summary(rev04)
    assert summary.node_count == 4
    assert summary.edge_count == 3
    assert dict(summary.label_histogram)["pump"] == 1


def test_find_nodes_matches_identifier_substring(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.find_nodes(rev04, "FCV")
    assert [node.node_id for node in result.nodes] == ["FCV-2201"]


def test_find_nodes_matches_attribute_values(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.find_nodes(rev04, "relief_valve")
    assert [node.node_id for node in result.nodes] == ["PSV-2401"]


def test_find_nodes_is_case_insensitive(repository: GraphRepository, rev04: Path) -> None:
    assert repository.find_nodes(rev04, "fcv-2201").total_matched == 1


def test_find_nodes_reports_truncation(repository: GraphRepository, rev04: Path) -> None:
    result = repository.find_nodes(rev04, "-", limit=1)
    assert result.truncated is True
    assert result.total_matched > len(result.nodes)


def test_find_nodes_rejects_a_blank_query(repository: GraphRepository, rev04: Path) -> None:
    with pytest.raises(ValueError, match="must not be blank"):
        repository.find_nodes(rev04, "  ")


def test_neighbors_reaches_upstream_and_downstream_in_a_directed_graph(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.neighbors(rev04, "FCV-2201", hops=1)
    reached = {node.node_id for node in result.nodes}
    assert reached == {"FCV-2201", "P-2101A", "TK-2301"}


def test_neighbors_preserves_edge_direction_in_the_result(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.neighbors(rev04, "FCV-2201", hops=1)
    rendered = {edge.render() for edge in result.edges}
    assert any("P-2101A -> FCV-2201" in line for line in rendered)
    assert not any("FCV-2201 -> P-2101A" in line for line in rendered)


def test_neighbors_records_hop_distance(repository: GraphRepository, rev04: Path) -> None:
    result = repository.neighbors(rev04, "TK-2301", hops=2)
    assert result.distances["TK-2301"] == 0
    assert result.distances["FCV-2201"] == 1
    assert result.distances["P-2101A"] == 2


def test_neighbors_clamps_hops_to_the_configured_bound(rev04: Path) -> None:
    bounded = GraphRepository(cache_max_entries=4, max_hops=1, max_nodes=50, max_edges=100)
    assert bounded.neighbors(rev04, "TK-2301", hops=99).hops == 1


def test_neighbors_reports_truncation_when_the_node_budget_is_reached(rev04: Path) -> None:
    tiny = GraphRepository(cache_max_entries=4, max_hops=4, max_nodes=2, max_edges=100)
    result = tiny.neighbors(rev04, "P-2101A", hops=3)
    assert result.truncated is True
    assert "node budget" in (result.truncation_reason or "")


def test_neighbors_reports_truncation_when_the_edge_budget_is_reached(rev04: Path) -> None:
    tiny = GraphRepository(cache_max_entries=4, max_hops=4, max_nodes=50, max_edges=1)
    result = tiny.neighbors(rev04, "P-2101A", hops=3)
    assert result.truncated is True


def test_neighbors_rejects_a_zero_hop_request(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    with pytest.raises(ValueError, match="at least 1"):
        repository.neighbors(rev04, "P-2101A", hops=0)


def test_missing_node_produces_a_deterministic_error(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    with pytest.raises(NodeNotFoundError, match="not present"):
        repository.neighbors(rev04, "NO-SUCH-TAG")


def test_node_lookup_tolerates_differing_case(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    assert repository.neighbors(rev04, "fcv-2201").origin == "FCV-2201"


def test_shortest_path_returns_the_traversed_edges(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.shortest_path(rev04, "P-2101A", "TK-2301")
    assert result.found is True
    assert result.nodes == ("P-2101A", "FCV-2201", "TK-2301")
    assert [edge.attributes["line"] for edge in result.edges] == ["LN-1001", "LN-1002"]


def test_shortest_path_respects_direction(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    result = repository.shortest_path(rev04, "TK-2301", "P-2101A")
    assert result.found is False
    assert result.respects_direction is True


def test_shortest_path_honours_the_cutoff(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    assert repository.shortest_path(rev04, "P-2101A", "TK-2301", cutoff=1).found is False


def test_edge_lookup_requires_at_least_one_endpoint(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    with pytest.raises(ValueError, match="at least one"):
        repository.edge_lookup(rev04)


def test_edge_lookup_returns_incident_edges_for_one_endpoint(
    repository: GraphRepository,
    rev04: Path,
) -> None:
    _, total = repository.edge_lookup(rev04, source="P-2101A")
    assert total == 2


def test_malformed_graphml_fails_visibly(
    repository: GraphRepository,
    corpus_root: Path,
) -> None:
    with pytest.raises(GraphMlParseError, match="cannot parse"):
        repository.summary(corpus_root / "broken.graphml")


def test_parsed_graph_is_cached_per_file_version(
    repository: GraphRepository,
    tmp_path: Path,
) -> None:
    path = tmp_path / "cached.graphml"
    first = nx.DiGraph()
    first.add_edge("A", "B")
    nx.write_graphml(first, path)
    assert repository.summary(path).edge_count == 1

    second = nx.DiGraph()
    second.add_edge("A", "B")
    second.add_edge("B", "C")
    nx.write_graphml(second, path)
    assert repository.summary(path).edge_count == 2


def test_long_attribute_values_are_truncated_with_a_marker(
    repository: GraphRepository,
    tmp_path: Path,
) -> None:
    path = tmp_path / "verbose.graphml"
    graph = nx.DiGraph()
    graph.add_node("N1", note="x" * 500)
    nx.write_graphml(graph, path)
    node = repository.find_nodes(path, "N1").nodes[0]
    assert node.attributes["note"].endswith("...(truncated)")
