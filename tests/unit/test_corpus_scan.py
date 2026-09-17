"""Recursive corpus discovery, inventory rendering and the scan snapshot cache."""

from __future__ import annotations

from pathlib import Path

from pid_intelligence.corpus.scan import CorpusScanner, format_inventory, scan_corpus


def test_scan_finds_served_files_in_nested_directories(corpus_root: Path) -> None:
    paths = {entry.relative_path for entry in scan_corpus(corpus_root)}
    assert "area_100/PID-100.png" in paths
    assert "area_100/PID-100-REV04.pdf" in paths
    assert "area_200/parallel.graphml" in paths


def test_scan_ignores_unserved_extensions(corpus_root: Path) -> None:
    paths = {entry.relative_path for entry in scan_corpus(corpus_root)}
    assert "area_200/PID-200.JPG" not in paths


def test_scan_matches_extensions_case_insensitively(corpus_root: Path) -> None:
    (corpus_root / "MIXED.GraphML").write_text("<graphml/>", encoding="utf-8")
    paths = {entry.relative_path for entry in scan_corpus(corpus_root)}
    assert "MIXED.GraphML" in paths


def test_scan_order_is_deterministic(corpus_root: Path) -> None:
    first = [entry.relative_path for entry in scan_corpus(corpus_root)]
    second = [entry.relative_path for entry in scan_corpus(corpus_root)]
    assert first == second == sorted(first)


def test_entries_carry_size_and_modification_time(corpus_root: Path) -> None:
    entry = next(e for e in scan_corpus(corpus_root) if e.relative_path.endswith(".pdf"))
    assert entry.kind == "pdf"
    assert entry.size_bytes > 0
    assert entry.mtime_iso.endswith("+00:00")


def test_relative_paths_use_forward_slashes(corpus_root: Path) -> None:
    assert all("\\" not in entry.relative_path for entry in scan_corpus(corpus_root))


def test_scan_returns_nothing_for_an_empty_corpus(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert scan_corpus(empty) == []


def test_inventory_reports_the_covered_range(corpus_root: Path) -> None:
    entries = scan_corpus(corpus_root)
    rendered = format_inventory(entries, total_matched=len(entries), offset=0)
    assert f"Showing 1-{len(entries)} of {len(entries)}" in rendered
    assert "TRUNCATED" not in rendered


def test_inventory_states_truncation_explicitly(corpus_root: Path) -> None:
    entries = scan_corpus(corpus_root)
    rendered = format_inventory(entries[:1], total_matched=len(entries), offset=0)
    assert "TRUNCATED" in rendered
    assert "offset=1" in rendered


def test_inventory_reports_an_empty_match_set() -> None:
    assert format_inventory([], total_matched=0, offset=0).startswith("No corpus files")


def test_scanner_serves_a_cached_snapshot_within_the_ttl(corpus_root: Path) -> None:
    clock_value = [0.0]
    scanner = CorpusScanner(corpus_root, cache_ttl_s=10.0, clock=lambda: clock_value[0])
    before = len(scanner.entries())

    (corpus_root / "late.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    assert len(scanner.entries()) == before

    clock_value[0] = 11.0
    assert len(scanner.entries()) == before + 1


def test_scanner_rescans_when_forced(corpus_root: Path) -> None:
    scanner = CorpusScanner(corpus_root, cache_ttl_s=1000.0)
    before = len(scanner.entries())
    (corpus_root / "forced.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    assert len(scanner.entries(force_rescan=True)) == before + 1


def test_scanner_rescans_after_invalidation(corpus_root: Path) -> None:
    scanner = CorpusScanner(corpus_root, cache_ttl_s=1000.0)
    before = len(scanner.entries())
    (corpus_root / "fresh.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    scanner.invalidate()
    assert len(scanner.entries()) == before + 1


def test_scanner_returns_a_copy_so_callers_cannot_corrupt_the_cache(corpus_root: Path) -> None:
    scanner = CorpusScanner(corpus_root, cache_ttl_s=1000.0)
    first = scanner.entries()
    first.clear()
    assert scanner.entries()
