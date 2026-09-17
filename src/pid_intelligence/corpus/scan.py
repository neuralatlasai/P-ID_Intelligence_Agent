"""Recursive discovery of the engineering corpus.

Discovery walks the corpus root without following symlinked directories, proves every
candidate is contained under the root after symlink resolution, normalises suffix case,
collects size and modification time from ``stat``, and sorts the result deterministically.

No file content is read. Byte access is the file loader's responsibility, not discovery's.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pid_intelligence.corpus.paths import ALLOWED_SUFFIXES, to_relative_posix

__all__ = [
    "CorpusEntry",
    "CorpusScanner",
    "format_inventory",
    "scan_corpus",
]


@dataclass(frozen=True, slots=True)
class CorpusEntry:
    """One discovered corpus artifact.

    Attributes:
        relative_path: Forward-slash path relative to the corpus root. This is the
            identifier tools accept and the agent cites as provenance.
        suffix: Lower-case extension including the leading dot, for example ``.graphml``.
        size_bytes: File size reported by ``stat`` at discovery time.
        mtime: POSIX modification timestamp. Operational metadata only: it orders
            inspection priority and invalidates caches, and is never engineering
            revision truth.
    """

    relative_path: str
    suffix: str
    size_bytes: int
    mtime: float

    @property
    def kind(self) -> str:
        """Return the suffix without its leading dot, for example ``graphml``."""
        return self.suffix.removeprefix(".")

    @property
    def mtime_iso(self) -> str:
        """Return the modification time as a UTC ISO-8601 string with second precision."""
        return datetime.fromtimestamp(self.mtime, tz=UTC).isoformat(timespec="seconds")


def scan_corpus(
    corpus_root: Path,
    *,
    allowed_suffixes: frozenset[str] = ALLOWED_SUFFIXES,
) -> list[CorpusEntry]:
    """Recursively enumerate served artifacts beneath the corpus root.

    Args:
        corpus_root: Absolute, resolved corpus root.
        allowed_suffixes: Lower-case extensions to include. Files with any other
            extension are ignored silently, which is the deterministic behaviour the
            corpus policy specifies for unsupported types.

    Returns:
        Entries sorted by ``relative_path`` so repeated scans of an unchanged corpus are
        byte-identical.

    Side effects:
        Reads directory entries and file metadata. Follows no symlinked directory and
        returns no entry that resolves outside ``corpus_root``.
    """
    entries = list(_walk(corpus_root, allowed_suffixes))
    entries.sort(key=lambda entry: entry.relative_path)
    return entries


def _walk(corpus_root: Path, allowed_suffixes: frozenset[str]) -> Iterator[CorpusEntry]:
    """Yield contained, served files beneath the root without following directory links."""
    for directory, subdirectories, filenames in os.walk(corpus_root, followlinks=False):
        subdirectories.sort()
        filenames.sort()
        for filename in filenames:
            entry = _describe(Path(directory) / filename, corpus_root, allowed_suffixes)
            if entry is not None:
                yield entry


def _describe(
    path: Path,
    corpus_root: Path,
    allowed_suffixes: frozenset[str],
) -> CorpusEntry | None:
    """Build an entry for one candidate, or return ``None`` if policy excludes it.

    A candidate is excluded when its suffix is not served, when it is not a regular
    file, when its metadata cannot be read, or when it resolves outside the corpus root
    — the last case covers a symlinked file pointing out of the corpus.
    """
    suffix = path.suffix.lower()
    if suffix not in allowed_suffixes:
        return None

    try:
        resolved = path.resolve()
        if not resolved.is_relative_to(corpus_root):
            return None
        stat_result = resolved.stat()
    except OSError:
        return None

    if not resolved.is_file():
        return None

    return CorpusEntry(
        relative_path=to_relative_posix(resolved, corpus_root),
        suffix=suffix,
        size_bytes=stat_result.st_size,
        mtime=stat_result.st_mtime,
    )


def format_inventory(
    entries: Iterable[CorpusEntry],
    *,
    total_matched: int,
    offset: int,
) -> str:
    """Render corpus entries as the plain-text inventory the model reads.

    The format is a tool result, not a public backend contract: one artifact per line as
    ``path | kind | N bytes | mtime=<iso8601>``, followed by an explicit statement of
    how much of the matching set the page covers.

    Args:
        entries: The page of entries to render, already sliced by the caller.
        total_matched: Number of entries matching the caller's filters before paging.
        offset: Index of the first rendered entry within the matching set.

    Returns:
        A newline-separated inventory. When the page does not cover the whole matching
        set the text states the truncation explicitly so the model never mistakes a page
        for the full corpus.
    """
    lines = [
        f"{entry.relative_path} | {entry.kind} | {entry.size_bytes} bytes | mtime={entry.mtime_iso}"
        for entry in entries
    ]
    shown = len(lines)

    if total_matched == 0:
        return "No corpus files match the requested filters."

    end = offset + shown
    header = f"Showing {offset + 1}-{end} of {total_matched} matching corpus files."
    if end < total_matched:
        footer = (
            f"TRUNCATED: {total_matched - end} further matching files are not listed. "
            f"Request offset={end} to continue, or narrow the filters."
        )
        return "\n".join([header, *lines, footer])
    return "\n".join([header, *lines])


class CorpusScanner:
    """Time-bounded cache over :func:`scan_corpus`.

    A corpus of several thousand artifacts is walked in milliseconds, but a single agent
    run may list it repeatedly. The cache holds one derived, disposable snapshot for a
    configured time-to-live; correctness never depends on it, and a TTL of zero disables
    it entirely.

    The instance is safe to share across threads and across concurrent runs. It is
    process-local derived state, not a corpus metadata database.
    """

    def __init__(
        self,
        corpus_root: Path,
        *,
        cache_ttl_s: float,
        allowed_suffixes: frozenset[str] = ALLOWED_SUFFIXES,
        clock: object = None,
    ) -> None:
        """Initialise a scanner bound to one corpus root.

        Args:
            corpus_root: Absolute, resolved corpus root.
            cache_ttl_s: Seconds a snapshot stays fresh. Zero disables caching.
            allowed_suffixes: Lower-case extensions to include.
            clock: Optional zero-argument monotonic time source, for deterministic
                tests. Defaults to :func:`time.monotonic`.
        """
        self._corpus_root = corpus_root
        self._cache_ttl_s = cache_ttl_s
        self._allowed_suffixes = allowed_suffixes
        self._clock = clock if callable(clock) else time.monotonic
        self._lock = threading.Lock()
        self._cached: list[CorpusEntry] | None = None
        self._cached_at = 0.0

    @property
    def corpus_root(self) -> Path:
        """Return the absolute corpus root this scanner enumerates."""
        return self._corpus_root

    def entries(self, *, force_rescan: bool = False) -> list[CorpusEntry]:
        """Return the current corpus inventory, rescanning when the snapshot is stale.

        Args:
            force_rescan: Discard any cached snapshot and walk the filesystem. Used when
                a file is observed to have disappeared between listing and loading.

        Returns:
            A fresh list of entries sorted by relative path. The returned list is a copy;
            mutating it does not affect the cache.
        """
        with self._lock:
            now = self._clock()
            fresh = (
                not force_rescan
                and self._cached is not None
                and self._cache_ttl_s > 0.0
                and (now - self._cached_at) < self._cache_ttl_s
            )
            if fresh and self._cached is not None:
                return list(self._cached)

            scanned = scan_corpus(self._corpus_root, allowed_suffixes=self._allowed_suffixes)
            self._cached = scanned
            self._cached_at = now
            return list(scanned)

    def invalidate(self) -> None:
        """Drop the cached snapshot so the next call rescans the filesystem."""
        with self._lock:
            self._cached = None
            self._cached_at = 0.0
