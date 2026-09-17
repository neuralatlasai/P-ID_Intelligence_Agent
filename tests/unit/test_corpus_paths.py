"""Path containment, extension policy and size policy."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from pid_intelligence.corpus.paths import (
    ALLOWED_SUFFIXES,
    CorpusFileNotFoundError,
    FileTooLargeError,
    NotARegularFileError,
    PathEscapeError,
    UnsupportedSuffixError,
    resolve_corpus_path,
    to_relative_posix,
)

_LARGE = 32 * 1024 * 1024


def _resolve(relative: str, corpus_root: Path, *, max_bytes: int = _LARGE) -> Path:
    return resolve_corpus_path(relative, corpus_root=corpus_root, max_bytes=max_bytes)


def test_served_suffixes_are_exactly_png_pdf_and_graphml() -> None:
    assert set(ALLOWED_SUFFIXES) == {".png", ".pdf", ".graphml"}


def test_nested_relative_path_resolves_to_the_expected_file(corpus_root: Path) -> None:
    resolved = _resolve("area_100/PID-100.png", corpus_root)
    assert resolved == (corpus_root / "area_100" / "PID-100.png").resolve()


def test_backslash_separator_is_accepted_as_a_path_separator(corpus_root: Path) -> None:
    assert _resolve(r"area_100\PID-100.png", corpus_root).name == "PID-100.png"


def test_suffix_comparison_ignores_case(corpus_root: Path) -> None:
    upper = corpus_root / "area_100" / "UPPER.PNG"
    upper.write_bytes(b"\x89PNG\r\n\x1a\n")
    assert _resolve("area_100/UPPER.PNG", corpus_root).name == "UPPER.PNG"


def test_parent_traversal_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("../outside.png", corpus_root)


def test_deep_parent_traversal_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("area_100/../../../etc/passwd", corpus_root)


def test_absolute_posix_path_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("/etc/passwd", corpus_root)


def test_drive_qualified_path_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("C:/Windows/win.ini", corpus_root)


def test_unc_path_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve(r"\\server\share\file.png", corpus_root)


def test_nul_byte_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("area_100/PID-100.png\x00.txt", corpus_root)


def test_blank_path_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("   ", corpus_root)


def test_excessively_long_path_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(PathEscapeError):
        _resolve("a" * 2000 + ".png", corpus_root)


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation requires privilege")
def test_symlink_pointing_outside_the_corpus_is_rejected(
    corpus_root: Path,
    tmp_path: Path,
) -> None:
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"\x89PNG\r\n\x1a\n")
    (corpus_root / "escape.png").symlink_to(outside)
    with pytest.raises(PathEscapeError):
        _resolve("escape.png", corpus_root)


def test_missing_file_is_reported_as_not_found(corpus_root: Path) -> None:
    with pytest.raises(CorpusFileNotFoundError):
        _resolve("area_100/absent.png", corpus_root)


def test_directory_is_rejected_as_not_a_regular_file(corpus_root: Path) -> None:
    with pytest.raises((NotARegularFileError, UnsupportedSuffixError)):
        _resolve("area_100", corpus_root)


def test_unserved_extension_is_rejected(corpus_root: Path) -> None:
    with pytest.raises(UnsupportedSuffixError):
        _resolve("area_200/PID-200.JPG", corpus_root)


def test_oversized_file_is_rejected_before_any_byte_is_read(corpus_root: Path) -> None:
    oversized = corpus_root / "big.png"
    oversized.write_bytes(b"\x00" * 4096)
    with pytest.raises(FileTooLargeError) as caught:
        _resolve("big.png", corpus_root, max_bytes=1024)
    assert "4096" in str(caught.value)


def test_relative_posix_rendering_is_platform_independent(corpus_root: Path) -> None:
    resolved = _resolve("area_100/PID-100.png", corpus_root)
    assert to_relative_posix(resolved, corpus_root.resolve()) == "area_100/PID-100.png"
