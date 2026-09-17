"""Export one explicitly selected, local drawing as a static frontend demonstration.

This build-time fixture is not a corpus API. Graph edges retain their undirected
semantics; bounding boxes retain the source image coordinate system. O(V + E).
"""

import json
import shutil
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "PID2Graph OPEN100"
TARGET = ROOT / "frontend" / "public" / "demo"
NS = {"g": "http://graphml.graphdrawing.org/xmlns"}
MAX_SOURCE_BYTES = 4_000_000
MAX_NODES = 2000
MAX_EDGES = 4000


def main() -> None:
    """Validate the bounded fixture before publishing any generated assets."""
    source = SOURCE / "0.graphml"
    with source.open("rb") as graph_file:
        raw = graph_file.read(MAX_SOURCE_BYTES + 1)
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("Fixture exceeds the 4 MB export limit")
    # This explicit local UTF-8 fixture cannot contain DTDs or entity declarations.
    if b"\x00" in raw or b"<!doctype" in raw.lower() or b"<!entity" in raw.lower():
        raise ValueError("XML declarations are not supported in the fixture")
    tree = ET.fromstring(raw.decode("utf-8"))  # noqa: S314 -- bounded UTF-8; DTD/entities rejected above
    keys = {key.attrib["id"]: key.attrib["attr.name"] for key in tree.findall("g:key", NS)}
    with (SOURCE / "0.png").open("rb") as image:
        header = image.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Expected a PNG fixture")
    width, height = struct.unpack(">II", header[16:24])
    nodes = []
    for node in tree.findall("g:graph/g:node", NS):
        data = {keys[item.attrib["key"]]: item.text for item in node.findall("g:data", NS)}
        x1, x2, y1, y2 = (float(data[k]) for k in ("xmin", "xmax", "ymin", "ymax"))
        if not (0 <= x1 <= x2 <= width and 0 <= y1 <= y2 <= height):
            raise ValueError(f"Invalid bounding box: {node.attrib['id']}")
        nodes.append(
            {
                "id": node.attrib["id"],
                "kind": data["label"],
                "x": (x1 + x2) / 2,
                "y": (y1 + y2) / 2,
                "width": x2 - x1,
                "height": y2 - y1,
            }
        )
    ids = {node["id"] for node in nodes}
    edges = []
    for edge in tree.findall("g:graph/g:edge", NS):
        start, end = edge.attrib["source"], edge.attrib["target"]
        if start not in ids or end not in ids:
            raise ValueError("Dangling fixture edge")
        edges.append({"source": start, "target": end})
    if len(nodes) > MAX_NODES or len(edges) > MAX_EDGES:
        raise ValueError("Fixture exceeds the rendering budget")
    payload = {
        "width": width,
        "height": height,
        "nodes": nodes,
        "edges": edges,
        "source": "PID2Graph OPEN100/0.graphml",
        "directed": False,
    }
    TARGET.mkdir(parents=True, exist_ok=True)
    (TARGET / "main-steam.json").write_text(json.dumps(payload), encoding="utf-8")
    shutil.copyfile(SOURCE / "0.png", TARGET / "main-steam.png")
    shutil.copyfile(source, TARGET / "main-steam.graphml")
    print(f"Exported {len(nodes)} nodes and {len(edges)} undirected edges")


if __name__ == "__main__":
    main()
