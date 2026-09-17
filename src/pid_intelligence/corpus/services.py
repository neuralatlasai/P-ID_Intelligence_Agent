"""Construction of the deterministic corpus services shared by tools and readiness checks.

The scanner, PDF reader and graph repository each hold process-local derived caches, so
the service constructs one of each at startup and shares them. Bundling them here keeps
that ownership explicit: the agent factory, the tool factories and the readiness probe all
receive the same instances rather than building private copies with divergent caches.

Construction performs no filesystem access beyond what the settings loader already proved.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pid_intelligence.corpus.graphml import GraphRepository
from pid_intelligence.corpus.pdf import PdfReader
from pid_intelligence.corpus.scan import CorpusScanner
from pid_intelligence.settings import Settings

__all__ = ["CorpusServices", "build_corpus_services"]


@dataclass(frozen=True, slots=True)
class CorpusServices:
    """The deterministic corpus components shared across one process.

    Attributes:
        corpus_root: Absolute, resolved corpus root every component is bound to.
        scanner: Recursive discovery with a time-bounded snapshot cache.
        pdf_reader: Page rendering and text search with a per-file-version text cache.
        graphs: GraphML parsing and bounded topology queries with a parsed-graph cache.
    """

    corpus_root: Path
    scanner: CorpusScanner
    pdf_reader: PdfReader
    graphs: GraphRepository

    def invalidate_caches(self) -> None:
        """Drop every derived cache so the next access re-reads the filesystem.

        Used when a file is observed to have changed or disappeared mid-run. Cached
        values are derived and disposable, so dropping them is always safe.
        """
        self.scanner.invalidate()
        self.pdf_reader.clear_cache()
        self.graphs.clear_cache()


def build_corpus_services(settings: Settings) -> CorpusServices:
    """Construct the corpus services for one process from validated settings.

    Args:
        settings: Validated configuration whose ``corpus_root`` is absolute and proven
            to exist.

    Returns:
        A bundle holding one scanner, one PDF reader and one graph repository, each
        configured with the bounds declared in ``settings``.
    """
    return CorpusServices(
        corpus_root=settings.corpus_root,
        scanner=CorpusScanner(
            settings.corpus_root,
            cache_ttl_s=settings.corpus_scan_cache_ttl_s,
        ),
        pdf_reader=PdfReader(cache_max_entries=settings.pdf_cache_max_entries),
        graphs=GraphRepository(
            cache_max_entries=settings.graph_cache_max_entries,
            max_hops=settings.max_graph_hops,
            max_nodes=settings.max_graph_nodes,
            max_edges=settings.max_graph_edges,
        ),
    )
