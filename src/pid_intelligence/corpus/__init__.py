"""Deterministic, read-only access to the local engineering corpus.

This subpackage owns every filesystem operation the agent can reach. It performs path
containment, extension and size policy, recursive discovery, PDF page rendering and
text search, and GraphML parsing and bounded graph queries.

Nothing in this subpackage mutates the corpus, and nothing in it calls a model.
"""

from __future__ import annotations

__all__: list[str] = []
