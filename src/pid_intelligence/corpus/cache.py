"""Stat-keyed, bounded cache for derived corpus artifacts.

Parsed GraphML graphs and extracted PDF page text are expensive to produce and cheap to
invalidate: the source file's size and modification time identify the version the derived
value was built from. When either changes, the cached value is discarded rather than
returned.

Cached values are derived and disposable. Losing the cache changes latency, never
answers. The cache is process-local and never persisted.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, TypeVar

__all__ = ["CacheStats", "StatKeyedCache"]

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class CacheStats:
    """Observed cache behaviour.

    Attributes:
        hits: Lookups served from a cached value whose source file was unchanged.
        misses: Lookups that had to build the value, including stale-entry rebuilds.
        evictions: Entries dropped because the cache exceeded its capacity.
        size: Number of entries currently held.
    """

    hits: int
    misses: int
    evictions: int
    size: int


@dataclass(frozen=True, slots=True)
class _Fingerprint:
    """Identity of one version of a source file."""

    size_bytes: int
    mtime_ns: int


class StatKeyedCache(Generic[T]):
    """Bounded least-recently-used cache keyed by path and file fingerprint.

    The cache is safe to use from multiple threads. Value construction happens outside
    the lock, so a slow build does not block unrelated lookups; two concurrent misses for
    the same key may both build, and the later result wins. That is acceptable because
    the values are pure functions of file content.

    Type parameter ``T`` is the cached value type.
    """

    def __init__(self, *, max_entries: int) -> None:
        """Initialise an empty cache.

        Args:
            max_entries: Maximum number of entries retained. Must be positive.

        Raises:
            ValueError: If ``max_entries`` is not positive.
        """
        if max_entries <= 0:
            raise ValueError("max_entries must be positive")
        self._max_entries = max_entries
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, tuple[_Fingerprint, T]] = OrderedDict()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    def get_or_build(self, path: Path, build: Callable[[Path], T]) -> T:
        """Return the cached value for ``path``, building it when absent or stale.

        Args:
            path: Absolute path of the source file. Its current size and modification
                time form the cache key alongside the path itself.
            build: Callable that produces the derived value from the path. It is invoked
                outside the cache lock and any exception it raises propagates unchanged,
                leaving the cache unmodified.

        Returns:
            The cached or newly built value.

        Raises:
            OSError: If the source file's metadata cannot be read.
        """
        key = str(path)
        fingerprint = self._fingerprint(path)

        with self._lock:
            cached = self._entries.get(key)
            if cached is not None and cached[0] == fingerprint:
                self._entries.move_to_end(key)
                self._hits += 1
                return cached[1]
            self._misses += 1

        value = build(path)

        with self._lock:
            self._entries[key] = (fingerprint, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
                self._evictions += 1
        return value

    def invalidate(self, path: Path) -> None:
        """Drop any entry for ``path``, whether or not the source file still exists."""
        with self._lock:
            self._entries.pop(str(path), None)

    def clear(self) -> None:
        """Drop every entry. Counters are preserved for observability continuity."""
        with self._lock:
            self._entries.clear()

    def stats(self) -> CacheStats:
        """Return a snapshot of cache counters and current occupancy."""
        with self._lock:
            return CacheStats(
                hits=self._hits,
                misses=self._misses,
                evictions=self._evictions,
                size=len(self._entries),
            )

    @staticmethod
    def _fingerprint(path: Path) -> _Fingerprint:
        """Read the size and nanosecond modification time identifying this file version."""
        stat_result = path.stat()
        return _Fingerprint(size_bytes=stat_result.st_size, mtime_ns=stat_result.st_mtime_ns)
