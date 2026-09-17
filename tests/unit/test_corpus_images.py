"""Bounds on the rasters that reach model context.

Every image a tool returns is re-sent with the conversation on each following model call,
so an oversized picture is not paid for once -- it is paid for on every remaining turn. A
run that loaded one whole sheet and one magnified crop was observed re-uploading roughly
twenty megabytes and exhausting the account's credits, which is what these bounds exist to
prevent.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from pid_intelligence.corpus.images import (
    CONTEXT_MAX_EDGE,
    DrawingRegionError,
    RegionTooLargeError,
    render_drawing_region,
    render_whole_drawing,
)


def _png(path: Path, width: int, height: int) -> Path:
    """Write a PNG of an exact size for the bound to be measured against."""
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height))
    pixmap.clear_with(255)
    path.write_bytes(pixmap.tobytes("png"))
    return path


def _size(data: bytes) -> tuple[int, int]:
    pixmap = pymupdf.Pixmap(data)
    return pixmap.width, pixmap.height


def test_a_large_sheet_is_downscaled_to_the_context_ceiling(tmp_path: Path) -> None:
    source = _png(tmp_path / "big.png", 2604, 1744)

    width, height = _size(render_whole_drawing(source, max_bytes=33_554_432))

    assert width == CONTEXT_MAX_EDGE
    # The aspect ratio is preserved, so geometry read off the image stays proportional.
    assert height == pytest.approx(1744 * CONTEXT_MAX_EDGE / 2604, abs=2)


def test_a_small_sheet_is_passed_through_untouched(tmp_path: Path) -> None:
    source = _png(tmp_path / "small.png", 400, 300)

    # Re-encoding a drawing that is already within the ceiling would cost fidelity for
    # nothing, so the original bytes are returned.
    assert render_whole_drawing(source, max_bytes=33_554_432) == source.read_bytes()


def test_magnification_is_capped_at_the_ceiling(tmp_path: Path) -> None:
    source = _png(tmp_path / "sheet.png", 2604, 1744)

    # 700 x 3 would be 2100px; the ceiling reduces the scale rather than the crop.
    data, region = render_drawing_region(
        source, x=0, y=0, width=700, height=600, scale=3.0, max_bytes=33_554_432
    )

    assert region == (0, 0, 700, 600)
    assert max(_size(data)) == CONTEXT_MAX_EDGE


def test_a_modest_magnification_is_honoured(tmp_path: Path) -> None:
    source = _png(tmp_path / "sheet.png", 2604, 1744)

    data, _ = render_drawing_region(
        source, x=0, y=0, width=400, height=300, scale=2.0, max_bytes=33_554_432
    )

    assert _size(data) == (800, 600)


def test_a_region_off_the_sheet_is_refused(tmp_path: Path) -> None:
    source = _png(tmp_path / "sheet.png", 200, 200)

    with pytest.raises(DrawingRegionError):
        render_drawing_region(
            source, x=500, y=500, width=100, height=100, scale=2.0, max_bytes=33_554_432
        )


def test_the_byte_ceiling_is_enforced(tmp_path: Path) -> None:
    source = _png(tmp_path / "sheet.png", 2604, 1744)

    with pytest.raises(RegionTooLargeError):
        render_whole_drawing(source, max_bytes=16)
