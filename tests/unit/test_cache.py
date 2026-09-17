"""Stat-keyed cache invalidation, bounding and counters."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from pid_intelligence.corpus.cache import StatKeyedCache


def _write(path: Path, text: str, *, mtime_ns: int | None = None) -> Path:
    path.write_text(text, encoding="utf-8")
    if mtime_ns is not None:
        os.utime(path, ns=(mtime_ns, mtime_ns))
    return path


def test_a_repeated_lookup_is_served_from_the_cache(tmp_path: Path) -> None:
    source = _write(tmp_path / "a.txt", "one")
    builds: list[str] = []

    def build(path: Path) -> str:
        builds.append(path.name)
        return path.read_text(encoding="utf-8")

    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=4)
    assert cache.get_or_build(source, build) == "one"
    assert cache.get_or_build(source, build) == "one"
    assert builds == ["a.txt"]
    assert cache.stats().hits == 1


def test_a_changed_file_is_rebuilt(tmp_path: Path) -> None:
    source = _write(tmp_path / "a.txt", "one", mtime_ns=1_000_000_000_000_000_000)
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=4)
    assert cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8")) == "one"

    _write(source, "two", mtime_ns=2_000_000_000_000_000_000)
    assert cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8")) == "two"


def test_a_same_length_rewrite_with_a_new_timestamp_is_rebuilt(tmp_path: Path) -> None:
    source = _write(tmp_path / "a.txt", "aaa", mtime_ns=1_000_000_000_000_000_000)
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=4)
    assert cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8")) == "aaa"

    _write(source, "bbb", mtime_ns=3_000_000_000_000_000_000)
    assert cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8")) == "bbb"


def test_the_cache_is_bounded_and_evicts_least_recently_used(tmp_path: Path) -> None:
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=2)
    for name in ("a", "b", "c"):
        source = _write(tmp_path / f"{name}.txt", name)
        cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8"))
    stats = cache.stats()
    assert stats.size == 2
    assert stats.evictions == 1


def test_a_failed_build_leaves_the_cache_unchanged(tmp_path: Path) -> None:
    source = _write(tmp_path / "a.txt", "one")
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=2)

    def failing(_path: Path) -> str:
        raise ValueError("cannot build")

    with pytest.raises(ValueError, match="cannot build"):
        cache.get_or_build(source, failing)
    assert cache.stats().size == 0


def test_invalidate_drops_one_entry(tmp_path: Path) -> None:
    source = _write(tmp_path / "a.txt", "one")
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=2)
    cache.get_or_build(source, lambda p: p.read_text(encoding="utf-8"))
    cache.invalidate(source)
    assert cache.stats().size == 0


def test_clear_drops_every_entry(tmp_path: Path) -> None:
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=4)
    for name in ("a", "b"):
        cache.get_or_build(
            _write(tmp_path / f"{name}.txt", name),
            lambda p: p.read_text(encoding="utf-8"),
        )
    cache.clear()
    assert cache.stats().size == 0


def test_a_missing_source_file_propagates_an_os_error(tmp_path: Path) -> None:
    cache: StatKeyedCache[str] = StatKeyedCache(max_entries=2)
    with pytest.raises(OSError):
        cache.get_or_build(tmp_path / "absent.txt", lambda p: p.name)


def test_capacity_must_be_positive() -> None:
    with pytest.raises(ValueError, match="must be positive"):
        StatKeyedCache[str](max_entries=0)
