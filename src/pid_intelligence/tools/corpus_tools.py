"""Corpus discovery and native multimodal file tools.

The tools built here turn filesystem artifacts into the Agents SDK's native tool output
types, which the SDK converts into OpenAI Responses ``input_image`` and ``input_file``
content. No application-level document or image object is introduced anywhere in the path.

Every tool resolves caller-supplied paths through the corpus resolver before touching the
filesystem, so path containment, extension policy and size policy hold for all of them.
Blocking filesystem and rendering work runs in a worker thread so one slow artifact cannot
stall the event loop or other concurrent runs.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Final

from agents import function_tool
from agents.run_context import RunContextWrapper
from agents.tool import FunctionTool, ToolOutputFileContent, ToolOutputImage

from pid_intelligence.corpus.graphml import GraphMlError
from pid_intelligence.corpus.images import DrawingRegionError, render_whole_drawing
from pid_intelligence.corpus.images import render_drawing_region as render_region
from pid_intelligence.corpus.paths import CorpusPathError, resolve_corpus_path
from pid_intelligence.corpus.pdf import PdfError
from pid_intelligence.corpus.scan import CorpusEntry, format_inventory
from pid_intelligence.corpus.services import CorpusServices
from pid_intelligence.observability.metrics import MetricsRegistry
from pid_intelligence.settings import Settings

__all__ = [
    "ToolExecutionError",
    "build_corpus_tools",
    "instrument_tool",
    "tool_error_message",
]

_LOGGER = logging.getLogger(__name__)

_MEDIA_TYPES: Final[dict[str, str]] = {".pdf": "application/pdf", ".graphml": "application/xml"}
_SERVED_TYPES: Final[frozenset[str]] = frozenset({"png", "pdf", "graphml"})


class ToolExecutionError(RuntimeError):
    """A tool could not complete for a reason the model should see and act on.

    The message names the artifact and the cause. It never contains file content, and it
    never contains credential material.
    """


def tool_error_message(_context: RunContextWrapper[object], error: Exception) -> str:
    """Render a tool failure as a model-visible message.

    Deterministic, expected failures — a missing file, a rejected path, an unreadable
    PDF, a malformed graph, an absent node — are reported verbatim so the agent can choose
    a different artifact or state that evidence is unavailable. Anything unexpected is
    reduced to its exception class, because an unexpected exception's message is not a
    controlled surface and may quote input.

    Args:
        _context: Run context supplied by the SDK. Unused: the message depends only on
            the error.
        error: The exception raised by the tool body.

    Returns:
        A single-line message for the model.
    """
    expected = (
        ToolExecutionError,
        CorpusPathError,
        PdfError,
        GraphMlError,
        DrawingRegionError,
        ValueError,
    )
    if isinstance(error, expected):
        return f"Tool error: {error}"
    _LOGGER.warning("unexpected tool failure: %s", type(error).__name__)
    return (
        f"Tool error: the operation failed with an unexpected {type(error).__name__}. "
        "Try a different artifact, or state that this evidence could not be read."
    )


@contextmanager
def instrument_tool(metrics: MetricsRegistry, tool_name: str) -> Iterator[None]:
    """Count and time one tool invocation, recording failures without swallowing them.

    The exception propagates unchanged so the SDK's failure handler renders the
    model-visible message; this wrapper only ensures the call, its duration and any
    failure are recorded.

    Args:
        metrics: Registry receiving the call, duration and error series.
        tool_name: Bounded-vocabulary label identifying the tool.

    Yields:
        ``None``. The caller runs the tool body inside the block.
    """
    metrics.increment("tool_calls_total", tool=tool_name)
    with metrics.time("tool_call_duration_seconds", tool=tool_name):
        try:
            yield
        except Exception:
            metrics.increment("tool_errors_total", tool=tool_name)
            raise


def _image_result(payload: bytes, metrics: MetricsRegistry, *, kind: str) -> ToolOutputImage:
    """Account for the bytes read and return them as a high-detail image.

    Every path that puts a raster into model context goes through here, so the read and
    byte counters cannot drift apart as tools are added.
    """
    metrics.increment("corpus_file_reads_total", type=kind)
    metrics.increment("corpus_bytes_read_total", float(len(payload)))
    encoded = base64.b64encode(payload).decode("ascii")
    return ToolOutputImage(image_url=f"data:image/png;base64,{encoded}", detail="high")


def build_corpus_tools(
    settings: Settings,
    services: CorpusServices,
    metrics: MetricsRegistry,
) -> list[FunctionTool]:
    """Build the corpus discovery and multimodal file tools.

    Args:
        settings: Validated configuration supplying every bound the tools enforce.
        services: Shared scanner, PDF reader and graph repository for this process.
        metrics: Registry receiving per-tool call, duration and error counts.

    Returns:
        The tool objects to register on the agent, in a stable order.
    """
    corpus_root = services.corpus_root
    timeout = settings.tool_timeout_s

    def _resolve(path: str) -> Path:
        """Resolve one caller-supplied path under the corpus root, or raise."""
        return resolve_corpus_path(
            path,
            corpus_root=corpus_root,
            max_bytes=settings.max_corpus_file_bytes,
        )

    @function_tool(timeout=timeout, failure_error_function=tool_error_message)
    async def list_corpus_files(
        name_contains: str | None = None,
        file_type: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> str:
        """List engineering artifacts available in the corpus.

        Use this first for any corpus-level question, to find out which drawings,
        topology files and documents exist before deciding what to read. The listing is
        recursive and covers every subfolder.

        Results are paged. When the listing says it is truncated, either narrow the
        filters or request the stated offset; never assume the first page is the whole
        corpus.

        Args:
            name_contains: Case-insensitive substring filter on the artifact path, for
                example an area name, a drawing number or a tag fragment.
            file_type: Restrict to one type: "png", "pdf" or "graphml".
            limit: Maximum artifacts to list on this page.
            offset: Zero-based index of the first artifact to list, for paging.

        Returns:
            One artifact per line as "path | type | N bytes | mtime=<iso8601>", preceded
            by the covered range and followed by an explicit truncation notice when the
            page does not cover every match. Modification time is operational metadata
            that may guide inspection order; it is never evidence of engineering revision
            status.
        """
        with instrument_tool(metrics, "list_corpus_files"):
            entries = await asyncio.to_thread(services.scanner.entries)
            metrics.observe("corpus_files_scanned", float(len(entries)))

            matched = _filter_entries(entries, name_contains, file_type)
            page_size = _bounded(limit, settings.max_corpus_list_entries)
            start = max(offset, 0)
            page = matched[start : start + page_size]
            return format_inventory(page, total_matched=len(matched), offset=start)

    @function_tool(timeout=timeout, failure_error_function=tool_error_message)
    async def load_corpus_artifact(path: str) -> ToolOutputImage | ToolOutputFileContent:
        """Load a corpus artifact into context so it can be read directly.

        A PNG is supplied as a high-detail image, downscaled if it is larger than the model
        will resolve. A PDF is supplied as a file, which makes
        every page available at once and suits revision tables, specifications and
        multi-page documents whose relevant page is not yet known. A GraphML file is
        supplied as a file for inspection, but topology questions should be answered with
        the deterministic graph tools rather than by reading the markup.

        For a large PDF whose relevant page is already known, prefer render_pdf_page: it
        gives higher visual fidelity on the page that matters and costs far less context.

        Args:
            path: Corpus-relative path exactly as listed by list_corpus_files.

        Returns:
            The artifact as native image or file content.

        Raises:
            Reports a tool error, without loading anything, when the path escapes the
            corpus, does not exist, is not a served type, or exceeds the configured size
            limit. The size check happens before any byte is read.
        """
        with instrument_tool(metrics, "load_corpus_artifact"):
            resolved = await asyncio.to_thread(_resolve, path)
            suffix = resolved.suffix.lower()
            if suffix == ".png":
                # Bounded rather than read verbatim: the raster is re-sent with the
                # conversation on every later model call, so its size is paid once per
                # remaining turn. See CONTEXT_MAX_EDGE.
                rendered = await asyncio.to_thread(
                    render_whole_drawing,
                    resolved,
                    max_bytes=settings.max_corpus_file_bytes,
                )
                return _image_result(rendered, metrics, kind="png")

            payload = await asyncio.to_thread(resolved.read_bytes)
            metrics.increment("corpus_file_reads_total", type=suffix.removeprefix("."))
            metrics.increment("corpus_bytes_read_total", float(len(payload)))
            encoded = base64.b64encode(payload).decode("ascii")
            media_type = _MEDIA_TYPES[suffix]
            return ToolOutputFileContent(
                file_data=f"data:{media_type};base64,{encoded}",
                filename=resolved.name,
            )

    @function_tool(timeout=timeout, failure_error_function=tool_error_message)
    async def render_pdf_page(path: str, page_number: int) -> ToolOutputImage:
        """Render one PDF page as a high-detail image.

        Use this when P&ID symbols, instrument bubbles or line labels are too small to
        read reliably from the whole document, or when search_pdf_text has already
        identified which page matters.

        Args:
            path: Corpus-relative path to a PDF, exactly as listed by list_corpus_files.
            page_number: One-based page number, as printed on the document.

        Returns:
            The rendered page as a high-detail image.

        Raises:
            Reports a tool error when the page number is outside the document's range,
            when the document is encrypted or unreadable, or when the rendered image
            exceeds the configured size limit.
        """
        with instrument_tool(metrics, "render_pdf_page"):
            resolved = await asyncio.to_thread(_resolve, path)
            _require_suffix(resolved, ".pdf", "render_pdf_page")
            rendered = await asyncio.to_thread(
                services.pdf_reader.render_page_png,
                resolved,
                page_number,
                dpi=settings.pdf_render_dpi,
                max_bytes=settings.max_corpus_file_bytes,
            )
            return _image_result(rendered, metrics, kind="pdf")

    @function_tool(timeout=timeout, failure_error_function=tool_error_message)
    async def render_drawing_region(
        path: str,
        x: int,
        y: int,
        width: int,
        height: int,
    ) -> ToolOutputImage:
        """Magnify one rectangle of a raster drawing so small text becomes readable.

        A whole P&ID sheet loaded at once is downsampled far below the resolution an
        instrument bubble needs: the tag inside a ten-pixel circle becomes unreadable, and
        the correct outcome is then to decline to read it. Use this to lean in instead.
        When you need the tags across a whole sheet, sweep it in a grid of overlapping
        tiles of roughly 700x600 source pixels -- twelve tiles cover a 2600x1700 sheet --
        and read each magnified tile as it arrives.

        Coordinates are in the source image's own pixels with the origin at its top-left
        corner -- the same space the drawing's GraphML records node positions in, so a node
        bounding box can be turned directly into a region request.

        Args:
            path: Corpus-relative path to a PNG, exactly as listed by list_corpus_files.
            x: Left edge of the region, in source pixels.
            y: Top edge of the region, in source pixels.
            width: Region width in source pixels. Prefer 600-800.
            height: Region height in source pixels. Prefer 500-700.

        Returns:
            The magnified region as a high-detail image.

        Raises:
            Reports a tool error when the path escapes the corpus, is not a PNG, when the
            region lies outside the sheet, or when the magnified region exceeds the
            configured size limit.
        """
        with instrument_tool(metrics, "render_drawing_region"):
            resolved = await asyncio.to_thread(_resolve, path)
            _require_suffix(resolved, ".png", "render_drawing_region")
            rendered, _region = await asyncio.to_thread(
                render_region,
                resolved,
                x=x,
                y=y,
                width=width,
                height=height,
                scale=settings.drawing_region_scale,
                max_bytes=settings.max_corpus_file_bytes,
            )
            return _image_result(rendered, metrics, kind="png")

    @function_tool(timeout=timeout, failure_error_function=tool_error_message)
    async def search_pdf_text(path: str, query: str) -> str:
        """Find which pages of a PDF mention a term, without loading the document.

        Use this to locate revision tables, tag references, specification clauses or
        change notes before deciding which pages to render. It is a cheap retrieval step.

        The text layer of an engineering drawing is often incomplete or absent, so no
        matches does not prove the term is absent from the drawing, and a match is not by
        itself evidence of connectivity. Confirm findings visually.

        Args:
            path: Corpus-relative path to a PDF, exactly as listed by list_corpus_files.
            query: Literal text to find. Matching is case-insensitive and is not a regular
                expression, so tags containing "-" or "." match literally.

        Returns:
            One line per matching page as "page <n> | <k> match(es) | <excerpt>", or a
            statement that no page matched. Excerpts are short by design.
        """
        with instrument_tool(metrics, "search_pdf_text"):
            resolved = await asyncio.to_thread(_resolve, path)
            _require_suffix(resolved, ".pdf", "search_pdf_text")
            hits = await asyncio.to_thread(
                services.pdf_reader.search_text,
                resolved,
                query,
                max_hits=settings.max_pdf_text_hits,
            )
            metrics.increment("corpus_file_reads_total", type="pdf")

            if not hits:
                return (
                    f"No page of {path} contains '{query}' in its extractable text layer. "
                    "The drawing may still show the term graphically; render pages to check."
                )
            lines = [
                f"page {hit.page_number} | {hit.match_count} match(es) | {hit.excerpt}"
                for hit in hits
            ]
            if len(hits) >= settings.max_pdf_text_hits:
                lines.append(
                    f"TRUNCATED: the hit limit of {settings.max_pdf_text_hits} pages was "
                    "reached; further pages may also match."
                )
            return "\n".join([f"{len(hits)} page(s) of {path} mention '{query}':", *lines])

    return [
        list_corpus_files,
        load_corpus_artifact,
        render_drawing_region,
        render_pdf_page,
        search_pdf_text,
    ]


def _filter_entries(
    entries: list[CorpusEntry],
    name_contains: str | None,
    file_type: str | None,
) -> list[CorpusEntry]:
    """Apply the caller's path and type filters, preserving discovery order.

    Raises:
        ValueError: If ``file_type`` is not one of the served corpus types.
    """
    filtered = entries
    if name_contains:
        needle = name_contains.strip().casefold()
        filtered = [entry for entry in filtered if needle in entry.relative_path.casefold()]
    if file_type:
        wanted = file_type.strip().lower().removeprefix(".")
        if wanted not in _SERVED_TYPES:
            served = ", ".join(sorted(_SERVED_TYPES))
            raise ValueError(f"unknown file_type '{file_type}'; served types are {served}")
        filtered = [entry for entry in filtered if entry.kind == wanted]
    return filtered


def _bounded(requested: int | None, ceiling: int) -> int:
    """Clamp a caller-supplied page size into ``1..ceiling``, defaulting to the ceiling."""
    if requested is None:
        return ceiling
    return max(1, min(requested, ceiling))


def _require_suffix(resolved: Path, expected: str, tool_name: str) -> None:
    """Reject an artifact whose type the tool cannot operate on.

    Raises:
        ToolExecutionError: If the resolved artifact does not have the ``expected`` suffix.
    """
    if resolved.suffix.lower() != expected:
        raise ToolExecutionError(
            f"{tool_name} operates on {expected} artifacts; {resolved.name} is "
            f"{resolved.suffix.lower() or 'untyped'}"
        )
