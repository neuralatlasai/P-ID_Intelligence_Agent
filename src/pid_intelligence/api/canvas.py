"""Read-only drawing transport sharing the agent's bounded corpus services.

These endpoints expose source artifacts and a geometric view of GraphML. They do
not run a model, infer plant identities, or change the native agent wire protocol.
All filesystem/parsing work runs in the worker pool, outside the event loop.
"""

from __future__ import annotations

import asyncio
import math
import struct
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, Response

from pid_intelligence.corpus.graphml import GraphMlParseError
from pid_intelligence.corpus.paths import CorpusPathError, resolve_corpus_path
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.fusion import FusionMappingError, resolve_fusion_manifest
from pid_intelligence.settings import Settings

MAX_NODES = 2000
MAX_EDGES = 4000
MAX_PIXELS = 24_000_000
MAX_PATH_CHARS = 1024
PNG_HEADER_BYTES = 24
PNG_SUFFIX = frozenset({".png"})
GRAPH_SUFFIX = frozenset({".graphml"})


def _resolve(
    services: CorpusServices, settings: Settings, path: str, suffixes: frozenset[str]
) -> Path:
    return resolve_corpus_path(
        path,
        corpus_root=services.corpus_root,
        max_bytes=settings.max_corpus_file_bytes,
        allowed_suffixes=suffixes,
    )


def _image_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as file:
        header = file.read(PNG_HEADER_BYTES)
    if len(header) != PNG_HEADER_BYTES or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Unsupported PNG header")
    width, height = struct.unpack(">II", header[16:24])
    if not width or not height or width * height > MAX_PIXELS:
        raise ValueError("Drawing exceeds the canvas pixel budget")
    return width, height


def _geometry(attributes: dict[str, object], width: int, height: int) -> dict[str, object]:
    try:
        xmin, xmax, ymin, ymax = (
            float(str(attributes[key])) for key in ("xmin", "xmax", "ymin", "ymax")
        )
    except (KeyError, ValueError, TypeError):
        return {"x": 0, "y": 0, "width": 0, "height": 0, "positioned": False}
    positioned = (
        all(math.isfinite(value) for value in (xmin, xmax, ymin, ymax))
        and 0 <= xmin <= xmax <= width
        and 0 <= ymin <= ymax <= height
    )
    if not positioned:
        return {"x": 0, "y": 0, "width": 0, "height": 0, "positioned": False}
    return {
        "x": (xmin + xmax) / 2,
        "y": (ymin + ymax) / 2,
        "width": xmax - xmin,
        "height": ymax - ymin,
        "positioned": True,
    }


def _drawing(services: CorpusServices, settings: Settings, relative: str) -> dict[str, object]:
    graph_path = _resolve(services, settings, relative, GRAPH_SUFFIX)
    # Matching stems establish a file pair only; they never establish an asset identity.
    image_relative = str(PurePosixPath(relative).with_suffix(".png"))
    image_path = _resolve(services, settings, image_relative, PNG_SUFFIX)
    width, height = _image_size(image_path)
    graph = services.graphs.load(graph_path)
    if graph.number_of_nodes() > MAX_NODES or graph.number_of_edges() > MAX_EDGES:
        raise ValueError("Graph exceeds the canvas object budget")
    nodes = [
        {
            "id": str(identifier),
            "kind": str(attributes.get("label", "unclassified")),
            **_geometry(attributes, width, height),
        }
        for identifier, attributes in graph.nodes(data=True)
    ]
    return {
        "source": relative,
        "imagePath": image_relative,
        "width": width,
        "height": height,
        "directed": graph.is_directed(),
        "nodes": nodes,
        # The edge label records how the line is drawn -- solid or non-solid. That is the
        # only connectivity attribute the source carries beyond the pair itself, and it is
        # what lets a reader tell a piping run from a signal line, so it is passed through
        # verbatim rather than being interpreted here.
        "edges": [
            {"source": str(start), "target": str(end), "style": str(attributes["edge_label"])}
            if isinstance(attributes.get("edge_label"), str)
            else {"source": str(start), "target": str(end)}
            for start, end, attributes in graph.edges(data=True)
        ],
        "unpositioned": sum(not node["positioned"] for node in nodes),
    }


def _catalog(services: CorpusServices, offset: int, limit: int) -> dict[str, object]:
    entries = services.scanner.entries()
    images = {entry.relative_path for entry in entries if entry.suffix == ".png"}
    # O(F) pairing after the scanner's cached deterministic sort; no pairwise search.
    pairs = [
        {
            "source": entry.relative_path,
            "imagePath": str(PurePosixPath(entry.relative_path).with_suffix(".png")),
        }
        for entry in entries
        if entry.suffix == ".graphml"
        and str(PurePosixPath(entry.relative_path).with_suffix(".png")) in images
    ]
    return {
        "items": pairs[offset : offset + limit],
        "total": len(pairs),
        "offset": offset,
        "limit": limit,
    }


def _failure(error: Exception) -> JSONResponse:
    # Path-resolution messages may contain local paths; expose only stable public copy.
    if isinstance(error, CorpusPathError | OSError):
        return JSONResponse(
            {
                "error": {
                    "code": "source_unavailable",
                    "message": "The requested corpus source is unavailable.",
                }
            },
            status_code=404,
        )
    return JSONResponse(
        {
            "error": {
                "code": "unsupported_drawing",
                "message": "The source cannot be displayed within the canvas limits.",
            }
        },
        status_code=422,
    )


def _fusion_failure(_error: FusionMappingError) -> JSONResponse:
    """Expose a stable fail-closed state without leaking topology internals."""
    return JSONResponse(
        {
            "error": {
                "code": "fusion_mapping_unverified",
                "message": "The complete field-to-simulation mapping could not be verified.",
            }
        },
        status_code=409,
    )


def build_canvas_router(services: CorpusServices, settings: Settings) -> APIRouter:
    """Mount bounded source reads; configured backend access policy remains authoritative."""
    router = APIRouter(prefix="/v1/canvas", tags=["canvas"])
    workers = asyncio.Semaphore(4)

    @router.get("/drawings")
    async def catalog(
        offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
    ) -> JSONResponse:
        async with workers:
            payload = await asyncio.to_thread(_catalog, services, offset, limit)
        return JSONResponse(payload, headers={"cache-control": "no-store"})

    @router.get("/graph/{path:path}")
    async def graph(path: str) -> JSONResponse:
        if len(path) > MAX_PATH_CHARS:
            return _failure(ValueError("Path exceeds limit"))
        try:
            async with workers:
                payload = await asyncio.to_thread(_drawing, services, settings, path)
        except (CorpusPathError, OSError, GraphMlParseError, ValueError) as error:
            return _failure(error)
        return JSONResponse(payload, headers={"cache-control": "no-store"})

    @router.get("/fusion/{path:path}")
    async def fusion(path: str) -> JSONResponse:
        if len(path) > MAX_PATH_CHARS:
            return _failure(ValueError("Path exceeds limit"))
        try:

            def resolve() -> dict[str, object]:

                drawing = _drawing(services, settings, path)
                source_image = _resolve(
                    services, settings, path.removesuffix(".graphml") + ".png", PNG_SUFFIX
                )
                with source_image.open("rb") as source:
                    image_bytes = source.read(settings.max_corpus_file_bytes + 1)
                if len(image_bytes) > settings.max_corpus_file_bytes:
                    raise FusionMappingError("Drawing image exceeds size bound")
                return resolve_fusion_manifest(
                    drawing, source_image_digest=sha256(image_bytes).hexdigest()
                )

            async with workers:
                payload = await asyncio.to_thread(resolve)
        except FusionMappingError as error:
            return _fusion_failure(error)
        except (CorpusPathError, OSError, GraphMlParseError, ValueError) as error:
            return _failure(error)
        return JSONResponse(payload, headers={"cache-control": "no-store"})

    @router.get("/image/{path:path}")
    async def image(path: str) -> Response:
        if len(path) > MAX_PATH_CHARS:
            return _failure(ValueError("Path exceeds limit"))

        def read() -> bytes:
            resolved = _resolve(services, settings, path, PNG_SUFFIX)
            _image_size(resolved)
            with resolved.open("rb") as file:
                data = file.read(settings.max_corpus_file_bytes + 1)
            if len(data) > settings.max_corpus_file_bytes:
                raise ValueError("Source grew beyond its bound")
            return data

        try:
            async with workers:
                data = await asyncio.to_thread(read)
        except (CorpusPathError, OSError, ValueError) as error:
            return _failure(error)
        return Response(
            data,
            media_type="image/png",
            headers={"cache-control": "no-store", "x-content-type-options": "nosniff"},
        )

    return router
