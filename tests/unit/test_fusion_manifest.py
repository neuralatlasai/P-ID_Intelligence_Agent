"""The image-to-simulation identity registry rejects every ambiguous state."""

from copy import deepcopy

import pytest

from pid_intelligence.fusion.manifest import (
    FUSION_DRAWING,
    REVIEWED_DRAWING_SHA256,
    FusionMappingError,
    resolve_fusion_manifest,
)


def _drawing() -> dict[str, object]:
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
    return {
        "source": FUSION_DRAWING,
        "nodes": [
            {
                "id": node_id,
                "kind": kind,
                "x": index + 0.5,
                "y": index + 0.5,
                "width": 1.0,
                "height": 1.0,
                "positioned": True,
            }
            for index, (node_id, kind) in enumerate(identities)
        ],
        "edges": [
            {"source": "tank67", "target": "valve43", "style": "solid"},
            {"source": "valve43", "target": "instrumentation14", "style": "non-solid"},
        ],
    }


def test_manifest_resolves_six_unique_exact_links() -> None:
    payload = resolve_fusion_manifest(_drawing())

    assert payload["validation"] == {
        "status": "verified",
        "recordCount": 12,
        "uniqueAnnotations": 12,
        "uniqueNodes": 12,
        "coordinateSource": "graphml",
        "identityPolicy": "registered-node-and-exact-class",
    }
    records = payload["records"]
    assert isinstance(records, list)
    assert records[0]["annotationId"] == "ANN-001"
    assert records[0]["node"]["id"] == "tank67"
    assert records[0]["node"]["x"] == 0.5
    assert records[0]["neighbours"] == ["valve43"]
    assert records[0]["mappingStatus"] == "verified-node-and-class"
    assert len(records[0]["evidence"]["image"]["sha256"]) == 64
    assert records[0]["evidence"]["image"]["width"] > 0
    assert records[0]["evidence"]["plantIdentity"] == "unverified"
    assert records[0]["drawingIdentity"]["status"] == "unavailable"


def test_transcription_requires_exact_source_image_revision() -> None:
    payload = resolve_fusion_manifest(_drawing(), source_image_digest=REVIEWED_DRAWING_SHA256)
    records = payload["records"]
    assert isinstance(records, list)
    assert records[0]["drawingIdentity"]["tag"] == "RCS-SG-100"
    assert records[0]["drawingIdentity"]["referenceComparison"] == "conflicting"
    changed = resolve_fusion_manifest(_drawing(), source_image_digest="0" * 64)
    assert changed["records"][0]["drawingIdentity"]["status"] == "unavailable"


@pytest.mark.parametrize("fault", ["missing", "class", "position", "duplicate"])
def test_manifest_rejects_partial_or_ambiguous_mapping(fault: str) -> None:
    drawing = deepcopy(_drawing())
    nodes = drawing["nodes"]
    assert isinstance(nodes, list)
    if fault == "missing":
        nodes.pop()
    elif fault == "class":
        nodes[0]["kind"] = "pump"
    elif fault == "position":
        nodes[0]["positioned"] = False
    else:
        nodes[1]["id"] = nodes[0]["id"]

    with pytest.raises(FusionMappingError):
        resolve_fusion_manifest(drawing)
