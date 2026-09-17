"""Connectivity as an engineer means it: through drafting apparatus to real equipment.

A hop-bounded neighbourhood answers the wrong question on an extracted P&ID. The nodes next
to a valve are line connectors and crossings, which exhaust the hop budget before any
equipment is reached; on the OPEN100 main steam sheet the nearest equipment to a control
valve is six hops away, so a four-hop search reported "connected to nothing" while the
canvas showed sixteen components. These tests pin the walk that closes that gap.
"""

from __future__ import annotations

from pathlib import Path

import networkx as nx
import pytest

from pid_intelligence.corpus.graphml import GraphRepository, NodeNotFoundError


@pytest.fixture
def repository() -> GraphRepository:
    return GraphRepository(cache_max_entries=8, max_hops=4, max_nodes=50, max_edges=100)


def _write(tmp_path: Path, graph: nx.Graph, name: str = "sheet.graphml") -> Path:
    path = tmp_path / name
    nx.write_graphml(graph, path)
    return path


def _chain(tmp_path: Path) -> Path:
    """valve1 -- six connectors -- instrument1, with a crossing branch to tank1.

    The instrument sits seven hops from the valve and the tank six: both beyond a four-hop
    neighbourhood, which is exactly the shape that made the old answer wrong.
    """
    graph = nx.Graph()
    graph.add_node("valve1", label="valve")
    previous = "valve1"
    for index in range(6):
        node = f"connector{index}"
        graph.add_node(node, label="connector")
        graph.add_edge(previous, node)
        previous = node
    graph.add_node("instrument1", label="instrumentation")
    graph.add_edge(previous, "instrument1")
    graph.add_node("crossing1", label="crossing")
    # Branch from deep enough that the tank, too, lies beyond four hops.
    graph.add_edge("connector3", "crossing1")
    graph.add_node("tank1", label="tank")
    graph.add_edge("crossing1", "tank1")
    return _write(tmp_path, graph)


def test_reaches_equipment_beyond_the_hop_bound(
    repository: GraphRepository, tmp_path: Path
) -> None:
    path = _chain(tmp_path)

    # The four-hop neighbourhood finds no equipment at all.
    hood = repository.neighbors(path, "valve1", hops=4)
    labels = {record.attributes.get("label") for record in hood.nodes if record.node_id != "valve1"}
    assert labels <= {"connector", "crossing"}

    reach = repository.connected_equipment(path, "valve1")
    assert [(node, hops) for node, _, hops in reach.found] == [("tank1", 6), ("instrument1", 7)]
    assert reach.truncated is False


def test_stops_at_the_first_equipment_on_each_path(
    repository: GraphRepository, tmp_path: Path
) -> None:
    graph = nx.Graph()
    for node, label in [
        ("valve1", "valve"),
        ("connector1", "connector"),
        ("valve2", "valve"),
        ("valve3", "valve"),
    ]:
        graph.add_node(node, label=label)
    graph.add_edges_from([("valve1", "connector1"), ("connector1", "valve2"), ("valve2", "valve3")])
    path = _write(tmp_path, graph)

    # valve3 is joined to valve2, not to valve1: the walk must not pass through equipment.
    reach = repository.connected_equipment(path, "valve1")
    assert [node for node, _, _ in reach.found] == ["valve2"]


def test_reports_an_unrecognised_label_instead_of_walking_past_it(
    repository: GraphRepository, tmp_path: Path
) -> None:
    graph = nx.Graph()
    graph.add_node("valve1", label="valve")
    graph.add_node("mystery", label="heat_exchanger")
    graph.add_node("valve2", label="valve")
    graph.add_edges_from([("valve1", "mystery"), ("mystery", "valve2")])
    path = _write(tmp_path, graph)

    reach = repository.connected_equipment(path, "valve1")
    assert reach.found == [("mystery", "heat_exchanger", 1)]


def test_reports_nothing_for_a_node_joined_only_to_apparatus(
    repository: GraphRepository, tmp_path: Path
) -> None:
    graph = nx.Graph()
    graph.add_node("valve1", label="valve")
    graph.add_node("connector1", label="connector")
    graph.add_edge("valve1", "connector1")
    path = _write(tmp_path, graph)

    reach = repository.connected_equipment(path, "valve1")
    assert reach.found == []
    assert reach.apparatus_walked == 1


def test_walks_both_directions_of_a_directed_graph(
    repository: GraphRepository, tmp_path: Path
) -> None:
    graph = nx.DiGraph()
    for node, label in [
        ("upstream", "instrumentation"),
        ("c1", "connector"),
        ("valve1", "valve"),
        ("c2", "connector"),
        ("downstream", "tank"),
    ]:
        graph.add_node(node, label=label)
    graph.add_edges_from(
        [("upstream", "c1"), ("c1", "valve1"), ("valve1", "c2"), ("c2", "downstream")]
    )
    path = _write(tmp_path, graph)

    reach = repository.connected_equipment(path, "valve1")
    assert sorted(node for node, _, _ in reach.found) == ["downstream", "upstream"]


def test_honours_the_item_limit_and_says_so(repository: GraphRepository, tmp_path: Path) -> None:
    graph = nx.Graph()
    graph.add_node("hub", label="valve")
    graph.add_node("header", label="connector")
    graph.add_edge("hub", "header")
    for index in range(30):
        graph.add_node(f"valve{index}", label="valve")
        graph.add_edge("header", f"valve{index}")
    path = _write(tmp_path, graph)

    reach = repository.connected_equipment(path, "hub", limit=5)
    assert len(reach.found) == 5
    assert reach.truncated is True
    assert reach.truncation_reason is not None


def test_rejects_an_unknown_node(repository: GraphRepository, tmp_path: Path) -> None:
    path = _chain(tmp_path)
    with pytest.raises(NodeNotFoundError):
        repository.connected_equipment(path, "not-a-node")
