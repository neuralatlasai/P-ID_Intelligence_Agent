"""Cropped, magnified reads of a raster drawing.

A P&ID sheet is delivered as one image a few thousand pixels wide. Handed to a model whole,
it is downsampled until the instrument bubbles -- circles eight or ten pixels across
carrying the tags an engineer actually needs -- become unreadable smudges, and the honest
outcome is the model declining to read them.

So the drawing is read the way a person reads one: by leaning in. This module returns a
rectangle of the sheet magnified, which turns a ten-pixel bubble into a legible one.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf

__all__ = [
    "CONTEXT_MAX_EDGE",
    "DrawingRegionError",
    "RegionTooLargeError",
    "render_drawing_region",
    "render_whole_drawing",
]

CONTEXT_MAX_EDGE = 1400
"""Longest edge, in pixels, of any raster placed in model context.

Every image a tool returns is re-sent with the conversation on each subsequent model call,
so a picture's cost is its size multiplied by the number of turns that follow it. A
2604x1744 sheet is 1.1 MB of base64; across a twelve-call run that is thirteen megabytes
re-uploaded to say nothing new.

The ceiling costs no legibility because the model resamples a large image down to roughly
this scale before reading it anyway. Sending more pixels than it will look at is spend
without benefit.
"""


class DrawingRegionError(RuntimeError):
    """A drawing region could not be produced."""


class RegionTooLargeError(DrawingRegionError):
    """The magnified region would exceed the configured byte budget."""


def render_drawing_region(
    path: Path,
    *,
    x: int,
    y: int,
    width: int,
    height: int,
    scale: float,
    max_bytes: int,
) -> tuple[bytes, tuple[int, int, int, int]]:
    """Crop a raster drawing and magnify the crop.

    Args:
        path: Absolute path of a PNG already resolved under the corpus root.
        x: Left edge of the requested region, in source pixels from the left.
        y: Top edge of the requested region, in source pixels from the top.
        width: Region width in source pixels.
        height: Region height in source pixels.
        scale: Magnification applied to the crop. Three doubles a symbol's legibility
            without producing an image too large to send.
        max_bytes: Inclusive upper bound on the encoded PNG size.

    Returns:
        The PNG bytes and the region actually rendered as ``(x, y, width, height)``. The
        returned region is the request clamped to the sheet, so a caller that asked for a
        rectangle hanging off the edge is told what it really received rather than being
        left to assume.

    Raises:
        DrawingRegionError: If the file cannot be opened or the region is empty.
        RegionTooLargeError: If the encoded image exceeds ``max_bytes``.
    """
    try:
        with pymupdf.open(path) as document:
            page = document[0]
            sheet = page.rect
            left = max(0.0, min(float(x), sheet.x1))
            top = max(0.0, min(float(y), sheet.y1))
            right = max(left, min(left + float(width), sheet.x1))
            bottom = max(top, min(top + float(height), sheet.y1))
            if right - left < 1 or bottom - top < 1:
                raise DrawingRegionError(
                    f"region {x},{y} {width}x{height} lies outside {path.name}, "
                    f"which is {int(sheet.x1)}x{int(sheet.y1)} pixels"
                )
            clip = pymupdf.Rect(left, top, right, bottom)
            effective = _fit_scale(scale, right - left, bottom - top)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(effective, effective), clip=clip)
            encoded: bytes = pixmap.tobytes("png")
            region = (int(left), int(top), int(right - left), int(bottom - top))
    except DrawingRegionError:
        raise
    except Exception as exc:  # library boundary; translated for the tool layer
        raise DrawingRegionError(
            f"failed to render a region of {path.name}: {type(exc).__name__}"
        ) from exc

    if len(encoded) > max_bytes:
        raise RegionTooLargeError(
            f"the magnified region is {len(encoded)} bytes, above the configured limit of "
            f"{max_bytes}; request a smaller region or a lower scale"
        )
    return encoded, region


def _fit_scale(requested: float, width: float, height: float) -> float:
    """Reduce a magnification so the result stays within {@link CONTEXT_MAX_EDGE}.

    A caller asks for 3x because it wants a legible instrument bubble, not because it wants
    2100 pixels. When the two conflict the ceiling wins: the extra pixels would be discarded
    by the model and paid for on every following turn.
    """
    longest = max(width, height, 1.0)
    return max(0.1, min(requested, CONTEXT_MAX_EDGE / longest))


def render_whole_drawing(path: Path, *, max_bytes: int) -> bytes:
    """Render a whole drawing for context, bounded by {@link CONTEXT_MAX_EDGE}.

    Reading the file off disk and sending it verbatim is the obvious implementation and the
    expensive one: corpus sheets are larger than the model will look at, and the cost is
    paid again on every turn of the run.

    Args:
        path: Absolute path of a PNG already resolved under the corpus root.
        max_bytes: Inclusive upper bound on the encoded PNG size.

    Returns:
        PNG bytes, downscaled when the source exceeds the ceiling and byte-for-byte
        otherwise, so a small drawing is never re-encoded for no reason.

    Raises:
        DrawingRegionError: If the file cannot be opened.
        RegionTooLargeError: If the encoded image exceeds ``max_bytes``.
    """
    try:
        with pymupdf.open(path) as document:
            page = document[0]
            scale = _fit_scale(1.0, page.rect.x1, page.rect.y1)
            if scale >= 1.0:
                encoded = path.read_bytes()
            else:
                encoded = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale)).tobytes("png")
    except Exception as exc:  # library boundary; translated for the tool layer
        raise DrawingRegionError(f"failed to read {path.name}: {type(exc).__name__}") from exc

    if len(encoded) > max_bytes:
        raise RegionTooLargeError(
            f"{path.name} encodes to {len(encoded)} bytes, above the configured limit of "
            f"{max_bytes}"
        )
    return encoded
