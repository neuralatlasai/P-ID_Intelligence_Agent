"""Corpus path containment, extension policy and size policy.

Every tool that accepts a caller-supplied path resolves it through
:func:`resolve_corpus_path`. No other code path in the package is permitted to turn a
model-supplied string into a filesystem read.

The resolver enforces, in order: syntactic rejection of absolute paths, drive-qualified
paths and NUL bytes; symlink-resolving containment under the corpus root; existence;
regular-file type; allowed suffix; and configured size bound. Size is checked from
``stat`` before any byte is read, so an oversized artifact is rejected without being
loaded or encoded.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Final

__all__ = [
    "ALLOWED_SUFFIXES",
    "CorpusFileNotFoundError",
    "CorpusPathError",
    "FileTooLargeError",
    "NotARegularFileError",
    "PathEscapeError",
    "UnsupportedSuffixError",
    "resolve_corpus_path",
    "to_relative_posix",
]

ALLOWED_SUFFIXES: Final[frozenset[str]] = frozenset({".png", ".pdf", ".graphml"})
"""Corpus extensions the backend serves. Comparison is case-insensitive.

Any other extension present under the corpus root is ignored by discovery and rejected
by the resolver. That rejection is deterministic and produces a model-visible reason.
"""

_MAX_RELATIVE_PATH_CHARS: Final[int] = 1024
_DRIVE_PREFIX_CHARS: Final[int] = 2


class CorpusPathError(ValueError):
    """Base class for every rejection of a caller-supplied corpus path.

    Instances carry a message that names the offending relative path and the policy that
    rejected it. Messages never include file contents.
    """


class PathEscapeError(CorpusPathError):
    """The requested path resolves outside the configured corpus root."""


class UnsupportedSuffixError(CorpusPathError):
    """The requested path has an extension the corpus policy does not serve."""


class CorpusFileNotFoundError(CorpusPathError):
    """The requested path is contained and well formed but does not exist."""


class NotARegularFileError(CorpusPathError):
    """The requested path exists but is a directory, device or other non-regular file."""


class FileTooLargeError(CorpusPathError):
    """The requested file exceeds the configured per-artifact byte bound."""


def to_relative_posix(path: Path, corpus_root: Path) -> str:
    """Render an absolute corpus path as a stable, corpus-relative POSIX string.

    The POSIX form is the identifier the agent cites as provenance and the identifier it
    passes back to tools, so it must be identical on every platform.

    Args:
        path: An absolute path already proven to lie under ``corpus_root``.
        corpus_root: The absolute, resolved corpus root.

    Returns:
        A forward-slash separated path relative to ``corpus_root``.

    Raises:
        ValueError: If ``path`` is not relative to ``corpus_root``.
    """
    return PurePosixPath(path.relative_to(corpus_root).as_posix()).as_posix()


def resolve_corpus_path(
    relative_path: str,
    *,
    corpus_root: Path,
    max_bytes: int,
    allowed_suffixes: frozenset[str] = ALLOWED_SUFFIXES,
) -> Path:
    """Resolve a caller-supplied relative path to a safe, readable corpus file.

    Args:
        relative_path: A corpus-relative path as supplied by the model or an HTTP
            caller. Forward and backward slashes are both accepted as separators.
        corpus_root: The absolute, already-resolved corpus root.
        max_bytes: Inclusive upper bound on the file size in bytes.
        allowed_suffixes: Lower-case extensions the corpus policy serves.

    Returns:
        The absolute, symlink-resolved path of a regular file inside ``corpus_root``
        whose suffix is allowed and whose size is within ``max_bytes``.

    Raises:
        PathEscapeError: If the path is absolute, drive-qualified, contains a NUL byte,
            is unreasonably long, or resolves outside ``corpus_root`` — including via a
            symlink that points out of the corpus.
        CorpusFileNotFoundError: If no filesystem entry exists at the resolved path.
        NotARegularFileError: If the resolved entry is not a regular file.
        UnsupportedSuffixError: If the suffix is not in ``allowed_suffixes``.
        FileTooLargeError: If the file exceeds ``max_bytes``.

    Side effects:
        Reads directory metadata only. No file content is opened or read.
    """
    cleaned = _validate_syntax(relative_path)
    candidate = _resolve_within_root(cleaned, corpus_root)

    if not candidate.exists():
        raise CorpusFileNotFoundError(f"corpus file not found: {cleaned}")
    if not candidate.is_file():
        raise NotARegularFileError(f"corpus path is not a regular file: {cleaned}")

    suffix = candidate.suffix.lower()
    if suffix not in allowed_suffixes:
        served = ", ".join(sorted(allowed_suffixes))
        raise UnsupportedSuffixError(
            f"unsupported corpus type '{suffix or '(none)'}' for {cleaned}; served types: {served}"
        )

    size_bytes = candidate.stat().st_size
    if size_bytes > max_bytes:
        raise FileTooLargeError(
            f"corpus file {cleaned} is {size_bytes} bytes, "
            f"above the configured limit of {max_bytes} bytes"
        )

    return candidate


def _validate_syntax(relative_path: str) -> str:
    """Reject path shapes that must never reach the filesystem.

    Rejecting these syntactically, before resolution, yields a precise diagnostic and
    keeps the containment check from being the only line of defence.
    """
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise PathEscapeError("corpus path must be a non-empty relative path")

    cleaned = relative_path.strip().replace("\\", "/")

    if "\x00" in cleaned:
        raise PathEscapeError("corpus path must not contain NUL bytes")
    if len(cleaned) > _MAX_RELATIVE_PATH_CHARS:
        raise PathEscapeError(f"corpus path exceeds {_MAX_RELATIVE_PATH_CHARS} characters")
    if cleaned.startswith("/") or cleaned.startswith("//"):
        raise PathEscapeError(f"corpus path must be relative, got absolute path: {cleaned}")
    if len(cleaned) >= _DRIVE_PREFIX_CHARS and cleaned[1] == ":":
        raise PathEscapeError(f"corpus path must be relative, got drive-qualified path: {cleaned}")

    return cleaned


def _resolve_within_root(cleaned: str, corpus_root: Path) -> Path:
    """Join a cleaned relative path to the root and prove containment after resolution.

    ``Path.resolve`` follows symlinks, so a symlink inside the corpus that points
    outside it fails the subsequent containment check rather than silently escaping.
    """
    try:
        candidate = (corpus_root / cleaned).resolve()
    except OSError as exc:
        raise PathEscapeError(f"corpus path cannot be resolved: {cleaned}") from exc

    if not candidate.is_relative_to(corpus_root):
        raise PathEscapeError(f"corpus path escapes the corpus root: {cleaned}")
    return candidate
