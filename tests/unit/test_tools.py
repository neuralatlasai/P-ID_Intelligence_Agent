"""Tool behaviour: native output types, bounds, read-only guarantees and error text."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from agents.run_context import RunContextWrapper
from agents.tool import FunctionTool, Tool, ToolOutputFileContent, ToolOutputImage
from agents.tool_context import ToolContext

from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings
from pid_intelligence.tools.corpus_tools import build_corpus_tools, tool_error_message
from pid_intelligence.tools.graph_tools import build_graph_tools

ToolInvoker = Callable[[str, dict[str, Any]], Awaitable[Any]]

_GRAPH_REV04 = "area_100/PID-100-REV04.graphml"
_PDF = "area_100/PID-100-REV04.pdf"
_PNG = "area_100/PID-100.png"


@pytest.fixture
def tools(
    settings: Settings,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> dict[str, Tool]:
    built = [
        *build_corpus_tools(settings, services, metrics),
        *build_graph_tools(settings, services, metrics),
    ]
    return {tool.name: tool for tool in built}


@pytest.fixture
def invoke(tools: dict[str, Tool]) -> ToolInvoker:
    """Return a helper that invokes one tool with JSON arguments, as the SDK would."""

    async def _invoke(name: str, arguments: dict[str, Any]) -> Any:
        tool = tools[name]
        assert isinstance(tool, FunctionTool)
        context = ToolContext(
            context=None,
            tool_name=name,
            tool_call_id=f"call-{name}",
            tool_arguments=json.dumps(arguments),
        )
        return await tool.on_invoke_tool(context, json.dumps(arguments))

    return _invoke


def test_the_tool_set_is_exactly_the_eleven_read_only_tools(tools: dict[str, Tool]) -> None:
    assert set(tools) == {
        "list_corpus_files",
        "load_corpus_artifact",
        "render_drawing_region",
        "render_pdf_page",
        "search_pdf_text",
        "graph_summary",
        "graph_find_nodes",
        "graph_connected_equipment",
        "graph_neighbors",
        "graph_shortest_path",
        "graph_edge_lookup",
    }


def test_no_tool_exposes_a_write_shell_or_network_capability(tools: dict[str, Tool]) -> None:
    forbidden = ("write", "delete", "shell", "exec", "http", "fetch", "sql", "env")
    assert not [name for name in tools if any(word in name.lower() for word in forbidden)]


async def test_listing_is_recursive_and_excludes_unserved_types(invoke: ToolInvoker) -> None:
    listing = await invoke("list_corpus_files", {})
    assert _GRAPH_REV04 in listing
    assert "area_200/parallel.graphml" in listing
    assert "PID-200.JPG" not in listing


async def test_listing_can_be_filtered_by_name_and_type(invoke: ToolInvoker) -> None:
    listing = await invoke("list_corpus_files", {"name_contains": "REV04", "file_type": "pdf"})
    assert _PDF in listing
    assert _GRAPH_REV04 not in listing


async def test_listing_rejects_an_unknown_type(invoke: ToolInvoker) -> None:
    assert "unknown file_type" in await invoke("list_corpus_files", {"file_type": "dwg"})


async def test_listing_pages_and_states_truncation(invoke: ToolInvoker) -> None:
    first = await invoke("list_corpus_files", {"limit": 1, "offset": 0})
    assert "TRUNCATED" in first
    second = await invoke("list_corpus_files", {"limit": 1, "offset": 1})
    assert first.splitlines()[1] != second.splitlines()[1]


async def test_png_is_returned_as_a_native_image(invoke: ToolInvoker) -> None:
    result = await invoke("load_corpus_artifact", {"path": _PNG})
    assert isinstance(result, ToolOutputImage)
    assert result.detail == "high"
    assert result.image_url is not None
    assert result.image_url.startswith("data:image/png;base64,")


async def test_pdf_is_returned_as_native_file_content(invoke: ToolInvoker) -> None:
    result = await invoke("load_corpus_artifact", {"path": _PDF})
    assert isinstance(result, ToolOutputFileContent)
    assert result.filename == "PID-100-REV04.pdf"
    assert result.file_data is not None
    assert result.file_data.startswith("data:application/pdf;base64,")


async def test_graphml_is_returned_as_native_file_content(invoke: ToolInvoker) -> None:
    result = await invoke("load_corpus_artifact", {"path": _GRAPH_REV04})
    assert isinstance(result, ToolOutputFileContent)
    assert result.filename == "PID-100-REV04.graphml"


async def test_loaded_image_bytes_match_the_source_file(
    invoke: ToolInvoker,
    corpus_root: Path,
) -> None:
    result = await invoke("load_corpus_artifact", {"path": _PNG})
    assert isinstance(result, ToolOutputImage)
    assert result.image_url is not None
    encoded = result.image_url.split(",", 1)[1]
    assert base64.b64decode(encoded) == (corpus_root / "area_100" / "PID-100.png").read_bytes()


async def test_path_traversal_is_refused_with_a_model_visible_message(
    invoke: ToolInvoker,
) -> None:
    assert "escapes the corpus root" in await invoke(
        "load_corpus_artifact", {"path": "../../etc/passwd"}
    )


async def test_unserved_extension_is_refused(invoke: ToolInvoker) -> None:
    assert "unsupported corpus type" in await invoke(
        "load_corpus_artifact", {"path": "area_200/PID-200.JPG"}
    )


async def test_missing_file_is_refused(invoke: ToolInvoker) -> None:
    assert "not found" in await invoke("load_corpus_artifact", {"path": "area_100/gone.png"})


async def test_oversized_file_is_refused_before_loading(
    settings: Settings,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> None:
    tight = settings.model_copy(update={"max_corpus_file_bytes": 10})
    tool = next(
        item
        for item in build_corpus_tools(tight, services, metrics)
        if item.name == "load_corpus_artifact"
    )
    assert isinstance(tool, FunctionTool)
    context = ToolContext(
        context=None,
        tool_name="load_corpus_artifact",
        tool_call_id="call-1",
        tool_arguments=json.dumps({"path": _PDF}),
    )
    result = await tool.on_invoke_tool(context, json.dumps({"path": _PDF}))
    assert "above the configured limit" in result


async def test_rendered_pdf_page_is_a_native_image(invoke: ToolInvoker) -> None:
    result = await invoke("render_pdf_page", {"path": _PDF, "page_number": 1})
    assert isinstance(result, ToolOutputImage)
    assert result.image_url is not None
    assert result.image_url.startswith("data:image/png;base64,")


async def test_rendering_a_non_pdf_is_refused(invoke: ToolInvoker) -> None:
    assert "operates on .pdf artifacts" in await invoke(
        "render_pdf_page", {"path": _PNG, "page_number": 1}
    )


async def test_rendering_an_out_of_range_page_is_refused(invoke: ToolInvoker) -> None:
    assert "out of range" in await invoke("render_pdf_page", {"path": _PDF, "page_number": 99})


async def test_pdf_search_reports_pages_and_excerpts(invoke: ToolInvoker) -> None:
    result = await invoke("search_pdf_text", {"path": _PDF, "query": "Supersedes"})
    assert "page 1" in result
    assert "Supersedes" in result


async def test_pdf_search_absence_is_stated_without_implying_absence_from_the_drawing(
    invoke: ToolInvoker,
) -> None:
    result = await invoke("search_pdf_text", {"path": _PDF, "query": "ZZ-NOT-PRESENT"})
    assert "No page" in result
    assert "render pages to check" in result


async def test_graph_summary_reports_directedness(invoke: ToolInvoker) -> None:
    assert "directed graph" in await invoke("graph_summary", {"path": _GRAPH_REV04})


async def test_graph_tools_refuse_a_non_graphml_artifact(invoke: ToolInvoker) -> None:
    assert "operate on .graphml artifacts" in await invoke("graph_summary", {"path": _PDF})


async def test_graph_neighbors_renders_direction(invoke: ToolInvoker) -> None:
    result = await invoke("graph_neighbors", {"path": _GRAPH_REV04, "node": "FCV-2201"})
    assert "P-2101A -> FCV-2201" in result
    assert "hop 1" in result


async def test_graph_shortest_path_reports_the_route(invoke: ToolInvoker) -> None:
    result = await invoke(
        "graph_shortest_path",
        {"path": _GRAPH_REV04, "source": "P-2101A", "target": "TK-2301"},
    )
    assert "P-2101A -> FCV-2201 -> TK-2301" in result


async def test_graph_shortest_path_absence_mentions_direction(invoke: ToolInvoker) -> None:
    result = await invoke(
        "graph_shortest_path",
        {"path": _GRAPH_REV04, "source": "TK-2301", "target": "P-2101A"},
    )
    assert "No path" in result
    assert "respecting edge direction" in result


async def test_graph_edge_lookup_requires_an_endpoint(invoke: ToolInvoker) -> None:
    assert "at least one of source or target" in await invoke(
        "graph_edge_lookup", {"path": _GRAPH_REV04}
    )


async def test_graph_edge_lookup_reports_parallel_edges_separately(
    invoke: ToolInvoker,
) -> None:
    result = await invoke(
        "graph_edge_lookup",
        {"path": "area_200/parallel.graphml", "source": "HDR-01", "target": "HDR-02"},
    )
    assert "2 edge(s) match" in result
    assert "LN-2001" in result
    assert "LN-2002" in result


async def test_malformed_graphml_is_reported_as_a_tool_error(invoke: ToolInvoker) -> None:
    assert "cannot parse" in await invoke("graph_summary", {"path": "broken.graphml"})


async def test_tools_never_modify_the_corpus(
    invoke: ToolInvoker,
    corpus_root: Path,
) -> None:
    def fingerprint() -> dict[str, str]:
        return {
            str(path.relative_to(corpus_root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(corpus_root.rglob("*"))
            if path.is_file()
        }

    before = fingerprint()
    await invoke("list_corpus_files", {})
    await invoke("load_corpus_artifact", {"path": _PDF})
    await invoke("load_corpus_artifact", {"path": _PNG})
    await invoke("render_pdf_page", {"path": _PDF, "page_number": 2})
    await invoke("search_pdf_text", {"path": _PDF, "query": "REVISION"})
    await invoke("graph_summary", {"path": _GRAPH_REV04})
    await invoke("graph_neighbors", {"path": _GRAPH_REV04, "node": "P-2101A"})
    assert fingerprint() == before


async def test_tool_metrics_record_calls_and_errors(
    invoke: ToolInvoker,
    metrics: MetricsRegistry,
) -> None:
    await invoke("graph_summary", {"path": _GRAPH_REV04})
    await invoke("graph_summary", {"path": "broken.graphml"})
    snapshot = metrics.snapshot()
    assert snapshot['tool_calls_total{tool="graph_summary"}'] == 2
    assert snapshot['tool_errors_total{tool="graph_summary"}'] == 1


def test_unexpected_failures_are_reduced_to_their_exception_class() -> None:
    context: RunContextWrapper[None] = RunContextWrapper(context=None)
    message = tool_error_message(context, KeyError("a secret internal detail"))
    assert "unexpected KeyError" in message
    assert "secret internal detail" not in message


def test_expected_failures_are_reported_verbatim() -> None:
    context: RunContextWrapper[None] = RunContextWrapper(context=None)
    assert tool_error_message(context, ValueError("page 9 is out of range")) == (
        "Tool error: page 9 is out of range"
    )
