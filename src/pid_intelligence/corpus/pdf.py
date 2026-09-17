"""Deterministic PDF inspection: page metadata, page rendering and text search.

P&ID PDFs are vector drawings, scanned images, specifications, revision logs or mixed
documents, so one access path is insufficient. This module provides the two deterministic
paths the architecture requires alongside whole-file delivery:

* page rendering, for high-fidelity visual inspection of one page;
* page text search, as a cheap retrieval step that narrows which pages are worth reading.

Text search is a retrieval optimisation. Text extracted from a drawing is frequently
incomplete, so it must never become the source of truth for connectivity.

Page numbers in this module's public API are **one-based**, matching what an engineer
reads off a document and what the agent cites as provenance. The zero-based index used by
the underlying library never crosses the module boundary.

Every function here blocks. Async callers run them through a worker thread.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import pymupdf

from pid_intelligence.corpus.cache import StatKeyedCache

__all__ = [
    "PdfDocumentInfo",
    "PdfEncryptedError",
    "PdfError",
    "PdfPageOutOfRangeError",
    "PdfReader",
    "PdfRenderTooLargeError",
    "PdfTextHit",
    "PdfUnreadableError",
]

_WHITESPACE_RUN: Final[re.Pattern[str]] = re.compile(r"\s+")
_DEFAULT_EXCERPT_CHARS: Final[int] = 160


class PdfError(RuntimeError):
    """Base class for deterministic PDF access failures.

    Messages name the corpus-relative path and the reason. They never contain document
    text beyond the short excerpts a search result is defined to return.
    """


class PdfUnreadableError(PdfError):
    """The file could not be opened or parsed as a PDF."""


class PdfEncryptedError(PdfError):
    """The document is encrypted and cannot be read without a password.

    The service holds no document passwords, so this is a terminal condition for the
    artifact rather than something to retry.
    """


class PdfPageOutOfRangeError(PdfError):
    """The requested one-based page number does not exist in the document."""


class PdfRenderTooLargeError(PdfError):
    """A rendered page exceeded the configured byte bound.

    Raised after rendering and before the image is handed to the model, so an
    unexpectedly large page is reported rather than silently truncated.
    """


@dataclass(frozen=True, slots=True)
class PdfDocumentInfo:
    """Structural metadata about one PDF.

    Attributes:
        page_count: Number of pages, always at least one for a readable document.
        title: Embedded document title, or ``None`` when absent or blank.
        producer: Embedded producer string, or ``None`` when absent or blank.
        is_encrypted: Whether the document declares encryption.
    """

    page_count: int
    title: str | None
    producer: str | None
    is_encrypted: bool


@dataclass(frozen=True, slots=True)
class PdfTextHit:
    """One text-search match.

    Attributes:
        page_number: One-based page on which the match occurred.
        excerpt: Short surrounding text with whitespace collapsed. Bounded by the
            caller's excerpt budget so a search result never becomes a document dump.
        match_count: Number of matches on that page.
    """

    page_number: int
    excerpt: str
    match_count: int


class PdfReader:
    """Bounded, read-only PDF operations over resolved corpus paths.

    The reader never writes to a document and never opens a path that has not already
    passed corpus path resolution. Extracted page text is cached per file version; the
    cache is derived state and its loss changes latency only.
    """

    def __init__(self, *, cache_max_entries: int) -> None:
        """Initialise a reader with a bounded page-text cache.

        Args:
            cache_max_entries: Maximum number of documents whose page text is retained.
        """
        self._text_cache: StatKeyedCache[tuple[str, ...]] = StatKeyedCache(
            max_entries=cache_max_entries
        )

    def document_info(self, path: Path) -> PdfDocumentInfo:
        """Read structural metadata without rendering or extracting text.

        Args:
            path: Absolute path of a PDF already resolved under the corpus root.

        Returns:
            The document's page count and identifying metadata.

        Raises:
            PdfEncryptedError: If the document requires a password.
            PdfUnreadableError: If the document cannot be opened or parsed.
        """
        with self._open(path) as document:
            metadata: dict[str, Any] = document.metadata or {}
            return PdfDocumentInfo(
                page_count=document.page_count,
                title=_clean_metadata(metadata.get("title")),
                producer=_clean_metadata(metadata.get("producer")),
                is_encrypted=bool(document.is_encrypted),
            )

    def render_page_png(
        self,
        path: Path,
        page_number: int,
        *,
        dpi: int,
        max_bytes: int,
    ) -> bytes:
        """Render one page to PNG bytes for high-detail visual inspection.

        Args:
            path: Absolute path of a PDF already resolved under the corpus root.
            page_number: One-based page number to render.
            dpi: Render resolution. Higher values resolve small P&ID symbols at the cost
                of image size.
            max_bytes: Inclusive upper bound on the encoded PNG size.

        Returns:
            PNG-encoded bytes of the rendered page.

        Raises:
            PdfPageOutOfRangeError: If ``page_number`` is below one or above the page
                count.
            PdfEncryptedError: If the document requires a password.
            PdfUnreadableError: If the document or the page cannot be rendered.
            PdfRenderTooLargeError: If the encoded image exceeds ``max_bytes``.
        """
        with self._open(path) as document:
            index = _to_index(page_number, document.page_count, path)
            try:
                pixmap = document[index].get_pixmap(dpi=dpi)
                encoded: bytes = pixmap.tobytes("png")
            except Exception as exc:  # library boundary; translated below
                raise PdfUnreadableError(
                    f"failed to render page {page_number} of {path.name}: {type(exc).__name__}"
                ) from exc

        if len(encoded) > max_bytes:
            raise PdfRenderTooLargeError(
                f"rendered page {page_number} of {path.name} is {len(encoded)} bytes, "
                f"above the configured limit of {max_bytes} bytes; retry with a lower dpi"
            )
        return encoded

    def page_texts(self, path: Path) -> tuple[str, ...]:
        """Return the extracted text of every page, indexed from zero.

        Extraction is cached per file version. A drawing with no embedded text layer
        yields empty strings rather than an error, because absence of text is a normal
        property of a scanned P&ID rather than a failure.

        Args:
            path: Absolute path of a PDF already resolved under the corpus root.

        Returns:
            One string per page, in page order.

        Raises:
            PdfEncryptedError: If the document requires a password.
            PdfUnreadableError: If the document cannot be opened or parsed.
        """
        return self._text_cache.get_or_build(path, self._extract_page_texts)

    def search_text(
        self,
        path: Path,
        query: str,
        *,
        max_hits: int,
        excerpt_chars: int = _DEFAULT_EXCERPT_CHARS,
    ) -> list[PdfTextHit]:
        """Find pages whose embedded text contains ``query``.

        Matching is case-insensitive and literal: the query is not interpreted as a
        regular expression, so tag strings containing ``.`` or ``-`` behave predictably.

        Args:
            path: Absolute path of a PDF already resolved under the corpus root.
            query: Literal text to find. Leading and trailing whitespace is ignored.
            max_hits: Maximum number of pages reported. Reaching the bound is visible to
                the caller through the returned length.
            excerpt_chars: Maximum characters of surrounding text per hit.

        Returns:
            Hits in ascending page order, at most ``max_hits`` entries.

        Raises:
            ValueError: If ``query`` is blank or ``max_hits`` is not positive.
            PdfEncryptedError: If the document requires a password.
            PdfUnreadableError: If the document cannot be opened or parsed.
        """
        needle = query.strip()
        if not needle:
            raise ValueError("search query must not be blank")
        if max_hits <= 0:
            raise ValueError("max_hits must be positive")

        folded_needle = needle.casefold()
        hits: list[PdfTextHit] = []

        for page_index, page_text in enumerate(self.page_texts(path)):
            if not page_text:
                continue
            folded_text = page_text.casefold()
            count = folded_text.count(folded_needle)
            if count == 0:
                continue
            hits.append(
                PdfTextHit(
                    page_number=page_index + 1,
                    excerpt=_excerpt(
                        page_text, folded_text.find(folded_needle), len(needle), excerpt_chars
                    ),
                    match_count=count,
                )
            )
            if len(hits) >= max_hits:
                break

        return hits

    def invalidate(self, path: Path) -> None:
        """Drop cached page text for one document."""
        self._text_cache.invalidate(path)

    def clear_cache(self) -> None:
        """Drop every cached page text so the next access re-extracts from disk."""
        self._text_cache.clear()

    def _extract_page_texts(self, path: Path) -> tuple[str, ...]:
        """Extract every page's text in one pass over the document."""
        with self._open(path) as document:
            try:
                return tuple(document[index].get_text() for index in range(document.page_count))
            except Exception as exc:  # library boundary; translated below
                raise PdfUnreadableError(
                    f"failed to extract text from {path.name}: {type(exc).__name__}"
                ) from exc

    @contextmanager
    def _open(self, path: Path) -> Iterator[pymupdf.Document]:
        """Open a PDF for reading, closing it deterministically on every exit path.

        Raises:
            PdfEncryptedError: If the document requires a password.
            PdfUnreadableError: If the document cannot be opened or parsed.
        """
        try:
            document = pymupdf.open(path)
        except Exception as exc:  # library boundary; translated below
            raise PdfUnreadableError(
                f"cannot open {path.name} as a PDF: {type(exc).__name__}"
            ) from exc

        try:
            if document.needs_pass:
                raise PdfEncryptedError(
                    f"{path.name} is password protected and cannot be inspected"
                )
            yield document
        finally:
            document.close()


def _to_index(page_number: int, page_count: int, path: Path) -> int:
    """Convert a one-based page number to a zero-based index, or reject it.

    Raises:
        PdfPageOutOfRangeError: If the page number falls outside ``1..page_count``.
    """
    if page_number < 1 or page_number > page_count:
        raise PdfPageOutOfRangeError(
            f"page {page_number} is out of range for {path.name}; valid pages are 1-{page_count}"
        )
    return page_number - 1


def _excerpt(page_text: str, match_start: int, match_length: int, excerpt_chars: int) -> str:
    """Build a whitespace-collapsed excerpt centred on the first match on a page."""
    if excerpt_chars <= 0:
        return ""
    padding = max((excerpt_chars - match_length) // 2, 0)
    start = max(match_start - padding, 0)
    end = min(match_start + match_length + padding, len(page_text))
    excerpt = _WHITESPACE_RUN.sub(" ", page_text[start:end]).strip()
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(page_text) else ""
    return f"{prefix}{excerpt}{suffix}"


def _clean_metadata(value: object) -> str | None:
    """Normalise an embedded metadata string, treating blanks as absent."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None
