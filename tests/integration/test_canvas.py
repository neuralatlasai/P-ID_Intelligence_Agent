"""Canvas reads use the real corpus service, independent of model execution."""

from pathlib import Path

import networkx as nx
import pytest
from agents.testing import ScriptedModel

from pid_intelligence.fusion.manifest import FUSION_DRAWING


@pytest.fixture
def canvas_pair(corpus_root: Path) -> None:
    """Create a source pair with known coordinates and directed connectivity."""
    graph = nx.DiGraph()
    graph.add_node("sensor", label="instrumentation", xmin=0, xmax=1, ymin=0, ymax=1)
    graph.add_node("valve", label="valve")
    graph.add_edge("sensor", "valve", edge_label="non-solid")
    nx.write_graphml(graph, corpus_root / "area_100" / "PID-100.graphml")


@pytest.mark.usefixtures("canvas_pair")
async def test_canvas_catalog_and_source(client_for) -> None:
    """Catalog pairing, source geometry and original image survive HTTP transport."""
    async with client_for(ScriptedModel([])) as client:
        listing = await client.get("/v1/canvas/drawings", params={"limit": 1})
        assert listing.status_code == 200
        assert listing.json()["items"][0]["source"] == "area_100/PID-100.graphml"
        source = await client.get("/v1/canvas/graph/area_100/PID-100.graphml")
        assert source.status_code == 200
        data = source.json()
        assert data["directed"] is True
        assert data["unpositioned"] == 1
        # The recorded line style reaches the client; it is the one connectivity attribute
        # beyond the pair itself, and dropping it would hide a signal line among the piping.
        assert data["edges"] == [{"source": "sensor", "target": "valve", "style": "non-solid"}]
        assert data["nodes"][0]["x"] == 0.5
        image = await client.get("/v1/canvas/image/area_100/PID-100.png")
        assert image.status_code == 200
        assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert image.headers["content-type"] == "image/png"
        assert image.headers["cache-control"] == "no-store"


@pytest.mark.usefixtures("canvas_pair")
async def test_canvas_omits_style_when_the_source_records_none(
    client_for, corpus_root: Path
) -> None:
    """An unlabelled edge reports no style rather than a default that was never written."""
    graph = nx.DiGraph()
    graph.add_node("a", label="valve", xmin=0, xmax=1, ymin=0, ymax=1)
    graph.add_node("b", label="valve", xmin=1, xmax=2, ymin=1, ymax=2)
    graph.add_edge("a", "b")
    nx.write_graphml(graph, corpus_root / "area_100" / "PID-100.graphml")
    async with client_for(ScriptedModel([])) as client:
        response = await client.get("/v1/canvas/graph/area_100/PID-100.graphml")
        assert response.json()["edges"] == [{"source": "a", "target": "b"}]


async def test_canvas_rejects_paths_and_pagination(client_for, corpus_root: Path) -> None:
    """Invalid requests cannot disclose a server path or escape the source root."""
    async with client_for(ScriptedModel([])) as client:
        for suffix in [
            "graph/missing.graphml",
            "image/area_100/PID-100-REV04.pdf",
            "image/..%2F..%2Fsecret.png",
            "image/C:%5Csecret.png",
        ]:
            response = await client.get(f"/v1/canvas/{suffix}")
            assert response.status_code == 404
            assert str(corpus_root) not in response.text
        assert (await client.get("/v1/canvas/drawings?limit=101")).status_code == 422
        assert (await client.get("/v1/canvas/drawings?offset=-1")).status_code == 422


@pytest.mark.usefixtures("canvas_pair")
async def test_canvas_marks_invalid_coordinates_unpositioned(client_for, corpus_root: Path) -> None:
    """Invalid coordinates remain searchable; they never become a misleading overlay."""
    graph_path = corpus_root / "area_100" / "PID-100.graphml"
    graph = nx.read_graphml(graph_path)
    graph.nodes["sensor"]["xmax"] = float("inf")
    nx.write_graphml(graph, graph_path)
    async with client_for(ScriptedModel([])) as client:
        response = await client.get("/v1/canvas/graph/area_100/PID-100.graphml")
        assert response.status_code == 200
        assert response.json()["unpositioned"] == 2


@pytest.mark.usefixtures("canvas_pair")
async def test_canvas_rejects_invalid_graph(client_for, corpus_root: Path) -> None:
    """A parser failure has a local, explicit failure state."""
    (corpus_root / "area_100" / "PID-100.graphml").write_text("<invalid", encoding="utf-8")
    async with client_for(ScriptedModel([])) as client:
        response = await client.get("/v1/canvas/graph/area_100/PID-100.graphml")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "unsupported_drawing"


async def test_canvas_fusion_endpoint_verifies_complete_manifest(
    client_for, corpus_root: Path
) -> None:
    """The endpoint derives coordinates from GraphML and returns no partial mapping."""
    graph_path = corpus_root / FUSION_DRAWING
    graph_path.parent.mkdir(parents=True)
    graph = nx.Graph()
    identities = (
        ("tank67", "tank"),
        ("tank70", "tank"),
        ("valve43", "valve"),
        ("valve38", "valve"),
        ("instrumentation14", "instrumentation"),
        ("instrumentation15", "instrumentation"),
        ("instrumentation22", "instrumentation"),
        ("instrumentation25", "instrumentation"),
        ("instrumentation31", "instrumentation"),
        ("instrumentation42", "instrumentation"),
        ("instrumentation60", "instrumentation"),
        ("instrumentation61", "instrumentation"),
    )
    for index, (node_id, kind) in enumerate(identities):
        coordinate = index / 100
        graph.add_node(
            node_id,
            label=kind,
            xmin=coordinate,
            xmax=coordinate + 0.01,
            ymin=coordinate,
            ymax=coordinate + 0.01,
        )
    graph.add_edge("tank67", "valve43", edge_label="solid")
    nx.write_graphml(graph, graph_path)
    graph_path.with_suffix(".png").write_bytes(
        (corpus_root / "area_100" / "PID-100.png").read_bytes()
    )

    async with client_for(ScriptedModel([])) as client:
        response = await client.get(f"/v1/canvas/fusion/{FUSION_DRAWING}")
        assert response.status_code == 200
        payload = response.json()
        assert payload["validation"]["status"] == "verified"
        assert payload["validation"]["recordCount"] == 12
        assert payload["records"][0]["node"]["x"] == 0.005

        graph.nodes["tank67"]["label"] = "pump"
        nx.write_graphml(graph, graph_path)
        rejected = await client.get(f"/v1/canvas/fusion/{FUSION_DRAWING}")
        assert rejected.status_code == 409
        assert rejected.json()["error"]["code"] == "fusion_mapping_unverified"
