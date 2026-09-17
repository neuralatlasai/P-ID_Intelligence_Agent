"""Fail-closed mapping between generated field references and GraphML nodes.

The registry is deliberately small and explicit. A similarity model must never decide
equipment identity: every annotation is registered against one source node and is accepted
only when that node exists, is positioned, and has the expected GraphML class.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from struct import unpack
from typing import Final

FUSION_DRAWING: Final = "PID2Graph OPEN100/0.graphml"
MAPPING_VERSION: Final = "fusion-v2"
PERCENT_MAX: Final = 100
PNG_HEADER_BYTES: Final = 24
MAX_REFERENCE_BYTES: Final = 8_000_000
REVIEWED_DRAWING_SHA256: Final = "2451fbe9b8d0494a822901493cfbf1d2656f0bd7678f0f25bb2266b5e78a7dc9"
# Transcribed from the registered PNG on 2026-09-16. Apply only to those exact bytes.
PRINTED_IDENTITIES: Final = {
    "tank67": ("RCS-SG-100", "STEAM GENERATOR", "conflicting"),
    "tank70": ("MSS-XSS-140", "STEAM SUPERHEATER", "conflicting"),
    "valve43": ("MSV 1404", "MSV 1404", "unverified"),
    "valve38": ("MSCV-XXX", "MSCV-XXX", "unverified"),
    "instrumentation14": ("TCV 1408", "TCV 1408", "conflicting"),
    "instrumentation15": ("PSV 1405", "PSV 1405", "conflicting"),
    "instrumentation22": ("TE 14092A", "TE 14092A", "conflicting"),
    "instrumentation25": ("TCV 1406", "TCV 1406", "conflicting"),
    "instrumentation31": ("TCV 1403", "TCV 1403", "conflicting"),
    "instrumentation42": ("TE 14092B", "TE 14092B", "conflicting"),
    "instrumentation60": ("TE 14093B", "TE 14093B", "conflicting"),
    "instrumentation61": ("TE 14093A", "TE 14093A", "conflicting"),
}


@lru_cache(maxsize=24)
def _image_identity(relative_path: str, size: int, modified_ns: int) -> dict[str, object]:
    """Bound reads and cache by file revision; never equate a digest with plant identity."""
    path = Path(__file__).resolve().parents[3] / "frontend" / "public" / relative_path.lstrip("/")
    if size <= PNG_HEADER_BYTES or size > MAX_REFERENCE_BYTES:
        raise FusionMappingError("Reference image exceeds the supported size bound")
    with path.open("rb") as source:
        data = source.read(size + 1)
    if len(data) != size or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise FusionMappingError("Reference image changed or is not a PNG")
    width, height = unpack(">II", data[16:24])
    return {
        "sha256": sha256(data).hexdigest(),
        "width": width,
        "height": height,
        "bytes": size,
        "assetRevision": str(modified_ns),
    }


class FusionMappingError(ValueError):
    """The complete one-to-one fusion contract could not be verified."""


@dataclass(frozen=True, slots=True)
class AnnotationBox:
    """Percentage-based object box inside one generated reference image."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True, slots=True)
class FusionSpec:
    """Immutable identity assertion reviewed for one reference-image annotation."""

    annotation_id: str
    node_id: str
    expected_kind: str
    title: str
    field_class: str
    generated_image_path: str
    annotation_box: AnnotationBox


FUSION_SPECS: Final = (
    FusionSpec(
        "ANN-001",
        "tank67",
        "tank",
        "Primary separation vessel",
        "Vertical process separator",
        "/demo/fusion/asset-tank67-separator.png",
        AnnotationBox(38, 5, 27, 88),
    ),
    FusionSpec(
        "ANN-002",
        "tank70",
        "tank",
        "Utility knock-out drum",
        "Vertical process drum",
        "/demo/fusion/asset-tank70-knockout-drum.png",
        AnnotationBox(38, 5, 28, 88),
    ),
    FusionSpec(
        "ANN-003",
        "valve43",
        "valve",
        "Actuated control valve",
        "Pneumatic globe control valve",
        "/demo/fusion/asset-valve43-control-valve.png",
        AnnotationBox(29, 3, 45, 93),
    ),
    FusionSpec(
        "ANN-004",
        "valve38",
        "valve",
        "Manual isolation valve",
        "Handwheel gate valve",
        "/demo/fusion/asset-valve38-isolation-valve.png",
        AnnotationBox(29, 2, 42, 95),
    ),
    FusionSpec(
        "ANN-005",
        "instrumentation14",
        "instrumentation",
        "Pressure transmitter",
        "Electronic pressure transmitter",
        "/demo/fusion/asset-instrumentation14-pressure-transmitter.png",
        AnnotationBox(35, 9, 38, 76),
    ),
    FusionSpec(
        "ANN-006",
        "instrumentation15",
        "instrumentation",
        "Local pressure indication",
        "Analog pressure gauge",
        "/demo/fusion/asset-instrumentation15-pressure-gauge.png",
        AnnotationBox(39, 5, 28, 51),
    ),
    FusionSpec(
        "ANN-007",
        "instrumentation22",
        "instrumentation",
        "Differential pressure measurement",
        "Differential-pressure transmitter and manifold",
        "/demo/fusion/asset-instrumentation22-differential-pressure-transmitter.png",
        AnnotationBox(29, 4, 41, 76),
    ),
    FusionSpec(
        "ANN-008",
        "instrumentation25",
        "instrumentation",
        "Temperature measurement",
        "Head-mounted temperature transmitter",
        "/demo/fusion/asset-instrumentation25-temperature-transmitter.png",
        AnnotationBox(38, 7, 27, 72),
    ),
    FusionSpec(
        "ANN-009",
        "instrumentation31",
        "instrumentation",
        "Inline flow measurement",
        "Electromagnetic flow meter",
        "/demo/fusion/asset-instrumentation31-magnetic-flowmeter.png",
        AnnotationBox(24, 6, 53, 78),
    ),
    FusionSpec(
        "ANN-010",
        "instrumentation42",
        "instrumentation",
        "Vessel level measurement",
        "Radar level transmitter",
        "/demo/fusion/asset-instrumentation42-radar-level-transmitter.png",
        AnnotationBox(31, 6, 35, 75),
    ),
    FusionSpec(
        "ANN-011",
        "instrumentation60",
        "instrumentation",
        "Rotating-equipment condition monitoring",
        "Bearing vibration transmitter",
        "/demo/fusion/asset-instrumentation60-vibration-transmitter.png",
        AnnotationBox(43, 7, 17, 61),
    ),
    FusionSpec(
        "ANN-012",
        "instrumentation61",
        "instrumentation",
        "Pressure trip monitoring",
        "Weatherproof pressure switch",
        "/demo/fusion/asset-instrumentation61-pressure-switch.png",
        AnnotationBox(36, 12, 30, 65),
    ),
)


def _validate_registry() -> None:
    annotations = {spec.annotation_id for spec in FUSION_SPECS}
    nodes = {spec.node_id for spec in FUSION_SPECS}
    if len(annotations) != len(FUSION_SPECS) or len(nodes) != len(FUSION_SPECS):
        raise RuntimeError("Fusion registry must be one-to-one")
    for spec in FUSION_SPECS:
        box = spec.annotation_box
        if min(box.x, box.y, box.width, box.height) < 0:
            raise RuntimeError(f"Negative annotation box for {spec.annotation_id}")
        if box.x + box.width > PERCENT_MAX or box.y + box.height > PERCENT_MAX:
            raise RuntimeError(f"Out-of-bounds annotation box for {spec.annotation_id}")


_validate_registry()


def _index_topology(
    raw_nodes: list[object], raw_edges: list[object]
) -> tuple[dict[str, dict[str, object]], dict[str, set[str]], dict[str, int]]:
    """Validate and index topology once for constant-time record resolution."""
    node_by_id: dict[str, dict[str, object]] = {}
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict) or not isinstance(raw_node.get("id"), str):
            raise FusionMappingError("Drawing contains an invalid node")
        node_id = raw_node["id"]
        if node_id in node_by_id:
            raise FusionMappingError(f"Duplicate source node: {node_id}")
        node_by_id[node_id] = raw_node

    neighbours: dict[str, set[str]] = {node_id: set() for node_id in node_by_id}
    incident: dict[str, int] = dict.fromkeys(node_by_id, 0)
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, dict):
            raise FusionMappingError("Drawing contains an invalid edge")
        start, end = raw_edge.get("source"), raw_edge.get("target")
        if not isinstance(start, str) or not isinstance(end, str):
            raise FusionMappingError("Drawing edge has an invalid endpoint")
        if start not in node_by_id or end not in node_by_id:
            raise FusionMappingError("Drawing edge references a missing node")
        neighbours[start].add(end)
        neighbours[end].add(start)
        incident[start] += 1
        incident[end] += 1
    return node_by_id, neighbours, incident


def resolve_fusion_manifest(
    drawing: dict[str, object], *, source_image_digest: str = ""
) -> dict[str, object]:
    """Resolve all registered links in O(V + E), or reject the whole manifest.

    Coordinates and classes are copied from the parsed GraphML payload rather than from
    this registry. The response can therefore prove which live source geometry was used.
    """
    if drawing.get("source") != FUSION_DRAWING:
        raise FusionMappingError("No reviewed fusion mapping exists for this drawing")

    raw_nodes = drawing.get("nodes")
    raw_edges = drawing.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise FusionMappingError("Drawing topology is unavailable")

    node_by_id, neighbours, incident = _index_topology(raw_nodes, raw_edges)

    records: list[dict[str, object]] = []
    for spec in FUSION_SPECS:
        node = node_by_id.get(spec.node_id)
        if node is None:
            raise FusionMappingError(f"Required source node is missing: {spec.node_id}")
        if node.get("kind") != spec.expected_kind:
            raise FusionMappingError(f"Source class mismatch: {spec.node_id}")
        if node.get("positioned") is not True:
            raise FusionMappingError(f"Source node is not positioned: {spec.node_id}")
        image_path = (
            Path(__file__).resolve().parents[3]
            / "frontend"
            / "public"
            / spec.generated_image_path.lstrip("/")
        )
        try:
            image_stat = image_path.stat()
            image_identity = _image_identity(
                spec.generated_image_path, image_stat.st_size, image_stat.st_mtime_ns
            )
        except OSError as error:
            raise FusionMappingError(
                f"Reference image unavailable: {spec.annotation_id}"
            ) from error
        records.append(
            {
                "annotationId": spec.annotation_id,
                "node": node,
                "expectedKind": spec.expected_kind,
                "title": spec.title,
                "fieldClass": spec.field_class,
                "generatedImagePath": spec.generated_image_path,
                "annotationBox": asdict(spec.annotation_box),
                "neighbours": sorted(neighbours[spec.node_id]),
                "incidentEdges": incident[spec.node_id],
                "provenance": "generated",
                "mappingStatus": "verified-node-and-class",
                "evidence": {
                    "image": image_identity,
                    "registration": "curated-reference",
                    "graphClass": "verified",
                    "equipmentSubtype": "unverified",
                    "plantIdentity": "unverified",
                    "imageBox": "manual-unreviewed",
                    "captureTimestamp": "not-available",
                    "reviewer": "not-recorded",
                    "detector": "not-run",
                },
                "drawingIdentity": {
                    "status": "reviewed-transcription"
                    if source_image_digest == REVIEWED_DRAWING_SHA256
                    else "unavailable",
                    "tag": PRINTED_IDENTITIES[spec.node_id][0]
                    if source_image_digest == REVIEWED_DRAWING_SHA256
                    else "not-verified",
                    "description": PRINTED_IDENTITIES[spec.node_id][1]
                    if source_image_digest == REVIEWED_DRAWING_SHA256
                    else "not-verified",
                    "referenceComparison": PRINTED_IDENTITIES[spec.node_id][2]
                    if source_image_digest == REVIEWED_DRAWING_SHA256
                    else "unverified",
                    "sourceImageSha256": source_image_digest,
                    "reviewMethod": "visual-transcription",
                },
            }
        )

    return {
        "mappingVersion": MAPPING_VERSION,
        "source": FUSION_DRAWING,
        "validatedAt": datetime.now(UTC).isoformat(),
        "graphDigest": sha256(
            json.dumps(drawing, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest(),
        "records": records,
        "validation": {
            "status": "verified",
            "recordCount": len(records),
            "uniqueAnnotations": len({record["annotationId"] for record in records}),
            "uniqueNodes": len({spec.node_id for spec in FUSION_SPECS}),
            "coordinateSource": "graphml",
            "identityPolicy": "registered-node-and-exact-class",
        },
    }
