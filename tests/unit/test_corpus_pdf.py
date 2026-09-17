"""PDF metadata, page rendering, page indexing and text search."""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from pid_intelligence.corpus.pdf import (
    PdfEncryptedError,
    PdfPageOutOfRangeError,
    PdfReader,
    PdfRenderTooLargeError,
    PdfUnreadableError,
)

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@pytest.fixture
def reader() -> PdfReader:
    return PdfReader(cache_max_entries=4)


@pytest.fixture
def document(corpus_root: Path) -> Path:
    return corpus_root / "area_100" / "PID-100-REV04.pdf"


def test_document_info_reports_the_page_count(reader: PdfReader, document: Path) -> None:
    assert reader.document_info(document).page_count == 2


def test_rendered_page_is_png_encoded(reader: PdfReader, document: Path) -> None:
    rendered = reader.render_page_png(document, 1, dpi=72, max_bytes=5_000_000)
    assert rendered.startswith(_PNG_MAGIC)


def test_page_numbers_are_one_based(reader: PdfReader, document: Path) -> None:
    first = reader.render_page_png(document, 1, dpi=72, max_bytes=5_000_000)
    second = reader.render_page_png(document, 2, dpi=72, max_bytes=5_000_000)
    assert first != second


def test_page_zero_is_rejected(reader: PdfReader, document: Path) -> None:
    with pytest.raises(PdfPageOutOfRangeError, match="valid pages are 1-2"):
        reader.render_page_png(document, 0, dpi=72, max_bytes=5_000_000)


def test_page_beyond_the_document_is_rejected(reader: PdfReader, document: Path) -> None:
    with pytest.raises(PdfPageOutOfRangeError):
        reader.render_page_png(document, 3, dpi=72, max_bytes=5_000_000)


def test_oversized_render_is_reported_rather_than_truncated(
    reader: PdfReader,
    document: Path,
) -> None:
    with pytest.raises(PdfRenderTooLargeError, match="lower dpi"):
        reader.render_page_png(document, 1, dpi=300, max_bytes=16)


def test_corrupt_pdf_yields_an_explicit_error(reader: PdfReader, tmp_path: Path) -> None:
    broken = tmp_path / "corrupt.pdf"
    broken.write_bytes(b"%PDF-1.7\nthis is not a pdf body")
    with pytest.raises(PdfUnreadableError):
        reader.document_info(broken)


def test_encrypted_pdf_yields_an_explicit_error(reader: PdfReader, tmp_path: Path) -> None:
    encrypted = tmp_path / "locked.pdf"
    document = pymupdf.open()
    document.new_page().insert_text((72, 72), "classified")
    document.save(
        encrypted,
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        owner_pw="owner-secret",
        user_pw="user-secret",
    )
    document.close()
    with pytest.raises(PdfEncryptedError, match="password protected"):
        reader.document_info(encrypted)


def test_search_finds_the_page_that_mentions_a_term(
    reader: PdfReader,
    document: Path,
) -> None:
    hits = reader.search_text(document, "Supersedes", max_hits=5)
    assert [hit.page_number for hit in hits] == [1]


def test_search_is_case_insensitive(reader: PdfReader, document: Path) -> None:
    assert reader.search_text(document, "supersedes", max_hits=5)


def test_search_treats_the_query_literally(reader: PdfReader, document: Path) -> None:
    assert reader.search_text(document, "FCV-2201", max_hits=5)
    assert reader.search_text(document, "FCV.2201", max_hits=5) == []


def test_search_returns_nothing_for_an_absent_term(
    reader: PdfReader,
    document: Path,
) -> None:
    assert reader.search_text(document, "no-such-tag-anywhere", max_hits=5) == []


def test_search_honours_the_hit_bound(reader: PdfReader, tmp_path: Path) -> None:
    many = tmp_path / "many.pdf"
    document = pymupdf.open()
    for _ in range(5):
        document.new_page().insert_text((72, 72), "TAG-0001")
    document.save(many)
    document.close()
    assert len(reader.search_text(many, "TAG-0001", max_hits=2)) == 2


def test_search_excerpt_is_bounded(reader: PdfReader, tmp_path: Path) -> None:
    wordy = tmp_path / "wordy.pdf"
    document = pymupdf.open()
    page = document.new_page()
    for index in range(20):
        page.insert_text((36, 40 + index * 12), f"filler line {index} TAG-0002 filler")
    document.save(wordy)
    document.close()
    hit = reader.search_text(wordy, "TAG-0002", max_hits=1, excerpt_chars=40)[0]
    assert len(hit.excerpt) <= 60
    assert hit.match_count == 20


def test_search_rejects_a_blank_query(reader: PdfReader, document: Path) -> None:
    with pytest.raises(ValueError, match="must not be blank"):
        reader.search_text(document, "   ", max_hits=5)


def test_search_rejects_a_non_positive_hit_bound(reader: PdfReader, document: Path) -> None:
    with pytest.raises(ValueError, match="must be positive"):
        reader.search_text(document, "REVISION", max_hits=0)


def test_page_text_extraction_is_cached_per_file_version(
    reader: PdfReader,
    tmp_path: Path,
) -> None:
    path = tmp_path / "mutable.pdf"

    first = pymupdf.open()
    first.new_page().insert_text((72, 72), "ORIGINAL-TAG")
    first.save(path)
    first.close()
    assert reader.search_text(path, "ORIGINAL-TAG", max_hits=1)

    second = pymupdf.open()
    second.new_page().insert_text((72, 72), "REPLACEMENT-TAG")
    second.save(path)
    second.close()
    assert reader.search_text(path, "REPLACEMENT-TAG", max_hits=1)
    assert reader.search_text(path, "ORIGINAL-TAG", max_hits=1) == []


def test_reader_does_not_modify_the_source_document(
    reader: PdfReader,
    document: Path,
) -> None:
    before = document.read_bytes()
    reader.document_info(document)
    reader.render_page_png(document, 1, dpi=72, max_bytes=5_000_000)
    reader.search_text(document, "REVISION", max_hits=5)
    assert document.read_bytes() == before
