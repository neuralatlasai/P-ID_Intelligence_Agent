"""Deterministic GraphML parsing and bounded topology queries.

GraphML in a P&ID corpus is structured topology evidence. Reducing it to image reasoning
throws away exactly the facts it encodes, so connectivity questions are answered here, in
deterministic code, and the model's role is to interpret and cross-check the result.

The parser preserves what the source graph asserts: directedness, parallel-edge identity,
node identifiers, and every node and edge attribute. A directed graph is never coerced to
undirected, and attributes that may carry instrument tags, line numbers, equipment classes
or revision metadata are never discarded.

Every query is bounded. When a bound truncates a result, the result says so explicitly, so
a partial neighbourhood is never mistaken for a complete one.

Every function here blocks. Async callers run them through a worker thread.
"""

from __future__ import annotations

from collections import Counter, deque
from collections.abc import Iterator
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Any

import networkx as nx

from pid_intelligence.corpus.cache import StatKeyedCache

__all__ = [
    "DRAFTING_LABELS",
    "EdgeRecord",
    "EquipmentReach",
    "GraphMlError",
    "GraphMlParseError",
    "GraphRepository",
    "GraphSummary",
    "NeighborhoodResult",
    "NodeNotFoundError",
    "NodeRecord",
    "PathResult",
    "SearchResult",
]

_MAX_ATTRIBUTE_CHARS = 200

DRAFTING_LABELS: frozenset[str] = frozenset(
    {"connector", "crossing", "arrow", "general", "background"}
)
"""Node labels that are drafting apparatus rather than plant equipment.

A line connector or a crossing is how a draughtsman joins two symbols on paper, not
something that exists in the plant. Connectivity questions walk through these and
stop at anything else, including labels this set does not recognise: an unknown
class is reported rather than silently walked past.
"""

# Work bound for an apparatus walk. Generous, because the output is what the query
# bounds and traversal is linear; this exists only to cap a pathological graph.
_MAX_APPARATUS_VISITS = 50_000
_LABEL_HISTOGRAM_LIMIT = 20


class GraphMlError(RuntimeError):
    """Base class for deterministic GraphML access failures."""


class GraphMlParseError(GraphMlError):
    """The file could not be parsed as GraphML.

    A malformed topology file is a visible failure. The agent may continue with drawing
    evidence, but it must report that structured topology was unavailable rather than
    imply the graph agreed with the drawing.
    """


class NodeNotFoundError(GraphMlError):
    """A requested node identifier does not exist in the graph."""


@dataclass(frozen=True, slots=True)
class NodeRecord:
    """One node and its preserved attributes.

    Attributes:
        node_id: The GraphML node identifier, used verbatim in citations and in
            follow-up queries.
        attributes: Every attribute the source file declared for this node, with values
            rendered as bounded strings.
    """

    node_id: str
    attributes: dict[str, str]

    def render(self) -> str:
        """Render the node as one text line for a tool result."""
        if not self.attributes:
            return self.node_id
        rendered = " ".join(f"{key}={value}" for key, value in sorted(self.attributes.items()))
        return f"{self.node_id} [{rendered}]"


@dataclass(frozen=True, slots=True)
class EdgeRecord:
    """One edge and its preserved attributes.

    Attributes:
        source: Identifier of the edge's source node.
        target: Identifier of the edge's target node.
        key: Parallel-edge discriminator for multigraphs, otherwise ``None``. Two edges
            between the same node pair are distinct records, never merged.
        directed: Whether the containing graph is directed. In a directed graph the
            source-to-target order is a topology fact.
        attributes: Every attribute the source file declared for this edge.
    """

    source: str
    target: str
    key: str | None
    directed: bool
    attributes: dict[str, str]

    def render(self) -> str:
        """Render the edge as one text line for a tool result."""
        arrow = "->" if self.directed else "--"
        head = f"{self.source} {arrow} {self.target}"
        if self.key is not None:
            head = f"{head} (parallel edge key={self.key})"
        if not self.attributes:
            return head
        rendered = " ".join(f"{key}={value}" for key, value in sorted(self.attributes.items()))
        return f"{head} [{rendered}]"


@dataclass(frozen=True, slots=True)
class GraphSummary:
    """Graph-level metadata used to orient before querying.

    Attributes:
        directed: Whether the source graph declared directed edges.
        multigraph: Whether the source graph contains parallel edges.
        node_count: Total nodes.
        edge_count: Total edges, counting parallel edges separately.
        node_attribute_keys: Sorted union of attribute names present on nodes.
        edge_attribute_keys: Sorted union of attribute names present on edges.
        label_histogram: Most frequent values of the ``label`` node attribute, as
            ``(label, count)`` pairs in descending count order. Empty when no node
            carries a ``label`` attribute.
        isolated_node_count: Nodes with no incident edge.
    """

    directed: bool
    multigraph: bool
    node_count: int
    edge_count: int
    node_attribute_keys: tuple[str, ...]
    edge_attribute_keys: tuple[str, ...]
    label_histogram: tuple[tuple[str, int], ...]
    isolated_node_count: int


@dataclass(frozen=True, slots=True)
class SearchResult:
    """Nodes matching an identity query.

    Attributes:
        nodes: Matching nodes, in deterministic identifier order.
        total_matched: Number of matches before the result bound was applied.
        truncated: Whether ``nodes`` omits matches because of the bound.
    """

    nodes: tuple[NodeRecord, ...]
    total_matched: int
    truncated: bool


@dataclass(slots=True)
class NeighborhoodResult:
    """A bounded neighbourhood expansion around one node.

    Attributes:
        origin: The node the expansion started from.
        hops: Requested hop radius, after clamping to the configured maximum.
        nodes: Reached nodes including the origin, in discovery order.
        edges: Edges among the reached nodes.
        distances: Hop distance from the origin for each reached node.
        truncated: Whether a node or edge bound stopped the expansion early.
        truncation_reason: Human-readable cause when ``truncated`` is set.
    """

    origin: str
    hops: int
    nodes: list[NodeRecord] = field(default_factory=list)
    edges: list[EdgeRecord] = field(default_factory=list)
    distances: dict[str, int] = field(default_factory=dict)
    truncated: bool = False
    truncation_reason: str | None = None


@dataclass(slots=True)
class EquipmentReach:
    """The equipment one node is joined to through drafting apparatus.

    Attributes:
        origin: The node the walk started from.
        found: Equipment reached, as ``(node_id, label, hops)``, nearest first.
        apparatus_walked: Drafting nodes traversed to reach them.
        truncated: Whether a bound stopped the walk early.
        truncation_reason: Human-readable cause when ``truncated`` is set.
    """

    origin: str
    found: list[tuple[str, str, int]] = field(default_factory=list)
    apparatus_walked: int = 0
    truncated: bool = False
    truncation_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PathResult:
    """Outcome of a connection query between two nodes.

    Attributes:
        source: Requested source node.
        target: Requested target node.
        nodes: Node identifiers along the path, source first. Empty when no path exists
            within the cutoff.
        edges: Edges traversed, one per consecutive node pair. For a multigraph the
            lowest-sorting parallel edge between each pair is reported.
        found: Whether a path was found.
        cutoff: Maximum path length considered.
        respects_direction: Whether traversal honoured edge direction. True for a
            directed graph.
    """

    source: str
    target: str
    nodes: tuple[str, ...]
    edges: tuple[EdgeRecord, ...]
    found: bool
    cutoff: int
    respects_direction: bool


class GraphRepository:
    """Parsed-graph cache and bounded query surface over corpus GraphML files.

    Parsed graphs are cached per file version. The cache is derived state: losing it
    changes latency, never answers. Graph objects handed to queries are never mutated.
    """

    def __init__(
        self,
        *,
        cache_max_entries: int,
        max_hops: int,
        max_nodes: int,
        max_edges: int,
    ) -> None:
        """Initialise a repository with its query bounds.

        Args:
            cache_max_entries: Maximum number of parsed graphs retained.
            max_hops: Upper bound on neighbourhood radius and path length.
            max_nodes: Upper bound on nodes returned by any single query.
            max_edges: Upper bound on edges returned by any single query.
        """
        self._cache: StatKeyedCache[nx.Graph] = StatKeyedCache(max_entries=cache_max_entries)
        self._max_hops = max_hops
        self._max_nodes = max_nodes
        self._max_edges = max_edges

    @property
    def max_hops(self) -> int:
        """Return the configured upper bound on hop radius and path length."""
        return self._max_hops

    def load(self, path: Path) -> nx.Graph:
        """Parse a GraphML file, returning the cached graph when unchanged.

        Args:
            path: Absolute path of a ``.graphml`` file already resolved under the corpus
                root.

        Returns:
            A NetworkX graph whose class reflects the source: directed or undirected,
            multigraph when the source declares parallel edges.

        Raises:
            GraphMlParseError: If the file is not well-formed GraphML.
        """
        return self._cache.get_or_build(path, _parse_graphml)

    def invalidate(self, path: Path) -> None:
        """Drop the cached graph for one file."""
        self._cache.invalidate(path)

    def clear_cache(self) -> None:
        """Drop every cached graph so the next load re-parses from the filesystem."""
        self._cache.clear()

    def summary(self, path: Path) -> GraphSummary:
        """Describe a graph's shape, attribute vocabulary and label distribution.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.

        Returns:
            Graph-level metadata sufficient to choose the next query.

        Raises:
            GraphMlParseError: If the file cannot be parsed.
        """
        graph = self.load(path)
        node_keys: set[str] = set()
        labels: Counter[str] = Counter()
        for _, attributes in graph.nodes(data=True):
            node_keys.update(attributes.keys())
            label = attributes.get("label")
            if isinstance(label, str) and label:
                labels[label] += 1

        edge_keys: set[str] = set()
        for *_, attributes in graph.edges(data=True):
            edge_keys.update(attributes.keys())

        isolated = sum(1 for node in graph.nodes if graph.degree(node) == 0)

        return GraphSummary(
            directed=graph.is_directed(),
            multigraph=graph.is_multigraph(),
            node_count=graph.number_of_nodes(),
            edge_count=graph.number_of_edges(),
            node_attribute_keys=tuple(sorted(node_keys)),
            edge_attribute_keys=tuple(sorted(edge_keys)),
            label_histogram=tuple(labels.most_common(_LABEL_HISTOGRAM_LIMIT)),
            isolated_node_count=isolated,
        )

    def find_nodes(self, path: Path, query: str, *, limit: int | None = None) -> SearchResult:
        """Resolve asset or tag identity by matching node identifiers and attributes.

        Matching is a case-insensitive substring test against the node identifier and
        against every string attribute value, which is what tag resolution needs when a
        drawing writes ``FCV-2201`` and a graph writes ``fcv2201``.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.
            query: Substring to match. Leading and trailing whitespace is ignored.
            limit: Maximum nodes returned. Defaults to the configured node bound and is
                clamped to it.

        Returns:
            Matching nodes in identifier order, with the pre-truncation match count.

        Raises:
            ValueError: If ``query`` is blank.
            GraphMlParseError: If the file cannot be parsed.
        """
        needle = query.strip().casefold()
        if not needle:
            raise ValueError("node query must not be blank")

        effective_limit = self._clamp(limit, self._max_nodes)
        graph = self.load(path)

        matched: list[NodeRecord] = []
        total = 0
        for node_id in sorted(map(str, graph.nodes)):
            attributes = graph.nodes[node_id]
            if not _node_matches(node_id, attributes, needle):
                continue
            total += 1
            if len(matched) < effective_limit:
                matched.append(NodeRecord(node_id=node_id, attributes=_render_attrs(attributes)))

        return SearchResult(
            nodes=tuple(matched),
            total_matched=total,
            truncated=total > len(matched),
        )

    def neighbors(
        self,
        path: Path,
        node: str,
        *,
        hops: int = 1,
        max_nodes: int | None = None,
        max_edges: int | None = None,
    ) -> NeighborhoodResult:
        """Expand the bounded neighbourhood around one node.

        In a directed graph both predecessors and successors are reached, because local
        connectivity around an asset is a question about what it touches, not only about
        what it feeds. Edge direction is preserved in every returned edge record.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.
            node: Identifier of the origin node.
            hops: Radius of the expansion, clamped to the configured hop bound.
            max_nodes: Node bound for this query, clamped to the configured bound.
            max_edges: Edge bound for this query, clamped to the configured bound.

        Returns:
            The reached nodes and the edges among them, with hop distances and an
            explicit truncation flag.

        Raises:
            ValueError: If ``hops`` is below one.
            NodeNotFoundError: If ``node`` is absent from the graph.
            GraphMlParseError: If the file cannot be parsed.
        """
        if hops < 1:
            raise ValueError("hops must be at least 1")

        graph = self.load(path)
        origin = _require_node(graph, node)
        effective_hops = min(hops, self._max_hops)
        node_budget = self._clamp(max_nodes, self._max_nodes)
        edge_budget = self._clamp(max_edges, self._max_edges)

        result = NeighborhoodResult(origin=origin, hops=effective_hops)
        result.distances[origin] = 0
        result.nodes.append(
            NodeRecord(node_id=origin, attributes=_render_attrs(graph.nodes[origin]))
        )

        reached = {origin}
        queue: deque[tuple[str, int]] = deque([(origin, 0)])

        while queue:
            current, distance = queue.popleft()
            if distance >= effective_hops:
                continue
            for neighbor in _incident_nodes(graph, current):
                if neighbor in reached:
                    continue
                if len(reached) >= node_budget:
                    result.truncated = True
                    result.truncation_reason = (
                        f"node budget of {node_budget} reached before the "
                        f"{effective_hops}-hop neighbourhood was fully expanded"
                    )
                    queue.clear()
                    break
                reached.add(neighbor)
                result.distances[neighbor] = distance + 1
                result.nodes.append(
                    NodeRecord(node_id=neighbor, attributes=_render_attrs(graph.nodes[neighbor]))
                )
                queue.append((neighbor, distance + 1))

        for record in _edges_within(graph, reached):
            if len(result.edges) >= edge_budget:
                result.truncated = True
                result.truncation_reason = (
                    result.truncation_reason
                    or f"edge budget of {edge_budget} reached; further incident edges are omitted"
                )
                break
            result.edges.append(record)

        return result

    def connected_equipment(
        self,
        path: Path,
        node: str,
        *,
        limit: int | None = None,
    ) -> EquipmentReach:
        """Find the equipment a node is joined to, walking through drafting apparatus.

        This answers "what is X connected to" the way an engineer means it. A hop-bounded
        neighbourhood does not: on an extracted P&ID the nodes adjacent to a valve are
        line connectors and crossings, and they consume the hop budget before any real
        equipment is reached, so a four-hop expansion routinely reports nothing.

        The walk is breadth-first and expands a node only when its label is in
        :data:`DRAFTING_LABELS`. Anything else terminates its path and is reported: what
        lies beyond an item is connected to that item, not to the origin.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.
            node: Identifier of the origin node.
            limit: Most items to return, clamped to the configured node bound.

        Returns:
            Equipment reached, nearest first, with an explicit truncation flag.

        Raises:
            NodeNotFoundError: If ``node`` is absent from the graph.
            GraphMlParseError: If the file cannot be parsed.
        """
        graph = self.load(path)
        origin = _require_node(graph, node)
        budget = self._clamp(limit, self._max_nodes)
        result = EquipmentReach(origin=origin)

        seen = {origin}
        queue: deque[tuple[str, int]] = deque([(origin, 0)])
        visits = 0
        while queue:
            current, distance = queue.popleft()
            for neighbor in _incident_nodes(graph, current):
                if neighbor in seen:
                    continue
                seen.add(neighbor)
                label = str(graph.nodes[neighbor].get("label", "")).strip().casefold()
                if label in DRAFTING_LABELS:
                    visits += 1
                    if visits > _MAX_APPARATUS_VISITS:
                        result.truncated = True
                        result.truncation_reason = (
                            f"apparatus walk stopped after {_MAX_APPARATUS_VISITS} nodes"
                        )
                        queue.clear()
                        break
                    queue.append((neighbor, distance + 1))
                    continue
                result.found.append((neighbor, label or "unlabelled", distance + 1))
                if len(result.found) >= budget:
                    result.truncated = True
                    result.truncation_reason = (
                        f"item limit of {budget} reached; more equipment may be connected"
                    )
                    queue.clear()
                    break

        result.apparatus_walked = visits
        result.found.sort(key=lambda item: (item[2], item[0]))
        return result

    def shortest_path(
        self,
        path: Path,
        source: str,
        target: str,
        *,
        cutoff: int | None = None,
    ) -> PathResult:
        """Find a shortest connection between two nodes, bounded by a path-length cutoff.

        In a directed graph traversal honours edge direction, so an absent path is a
        statement about flow direction rather than about the absence of any relationship.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.
            source: Identifier of the start node.
            target: Identifier of the end node.
            cutoff: Maximum number of edges in the path. Defaults to the configured hop
                bound and is clamped to it.

        Returns:
            The path when one exists within the cutoff, otherwise a result with
            ``found`` unset. A source equal to the target yields a zero-length path.

        Raises:
            NodeNotFoundError: If either identifier is absent from the graph.
            GraphMlParseError: If the file cannot be parsed.
        """
        graph = self.load(path)
        start = _require_node(graph, source)
        end = _require_node(graph, target)
        effective_cutoff = self._clamp(cutoff, self._max_hops)

        try:
            node_path = nx.shortest_path(graph, source=start, target=end)
        except nx.NetworkXNoPath:
            node_path = None
        except nx.NodeNotFound as exc:  # pragma: no cover - guarded by _require_node
            raise NodeNotFoundError(str(exc)) from exc

        if node_path is None or (len(node_path) - 1) > effective_cutoff:
            return PathResult(
                source=start,
                target=end,
                nodes=(),
                edges=(),
                found=False,
                cutoff=effective_cutoff,
                respects_direction=graph.is_directed(),
            )

        identifiers = tuple(str(node) for node in node_path)
        return PathResult(
            source=start,
            target=end,
            nodes=identifiers,
            edges=tuple(_edges_along(graph, identifiers)),
            found=True,
            cutoff=effective_cutoff,
            respects_direction=graph.is_directed(),
        )

    def edge_lookup(
        self,
        path: Path,
        *,
        source: str | None = None,
        target: str | None = None,
        limit: int | None = None,
    ) -> tuple[tuple[EdgeRecord, ...], int]:
        """List edges incident to, or between, the given endpoints.

        Supplying both endpoints returns the edges between them, including every parallel
        edge. Supplying one endpoint returns that node's incident edges. Supplying neither
        is rejected, because an unfiltered edge dump is not a useful engineering answer
        and defeats the query bounds.

        Args:
            path: Absolute path of a resolved ``.graphml`` file.
            source: Identifier of one endpoint, or ``None``.
            target: Identifier of the other endpoint, or ``None``.
            limit: Maximum edges returned, clamped to the configured edge bound.

        Returns:
            A pair of the returned edge records and the total number of matching edges
            before truncation.

        Raises:
            ValueError: If neither ``source`` nor ``target`` is supplied.
            NodeNotFoundError: If a supplied identifier is absent from the graph.
            GraphMlParseError: If the file cannot be parsed.
        """
        if source is None and target is None:
            raise ValueError("edge lookup requires at least one of source or target")

        graph = self.load(path)
        start = _require_node(graph, source) if source is not None else None
        end = _require_node(graph, target) if target is not None else None
        effective_limit = self._clamp(limit, self._max_edges)

        matched: list[EdgeRecord] = []
        total = 0
        for record in _all_edges(graph):
            if not _edge_matches(record, start, end, directed=graph.is_directed()):
                continue
            total += 1
            if len(matched) < effective_limit:
                matched.append(record)

        return tuple(matched), total

    @staticmethod
    def _clamp(requested: int | None, ceiling: int) -> int:
        """Clamp a caller-supplied bound into ``1..ceiling``, defaulting to the ceiling."""
        if requested is None:
            return ceiling
        return max(1, min(requested, ceiling))


def _parse_graphml(path: Path) -> nx.Graph:
    """Parse one GraphML file, preserving directedness and parallel-edge identity.

    NetworkX selects the graph class from the source: a ``directed`` edge default yields
    a directed graph, and the presence of parallel edges yields a multigraph. Neither is
    overridden here.

    Raises:
        GraphMlParseError: If the file is not well-formed GraphML.
    """
    try:
        graph = nx.read_graphml(path)
    except Exception as exc:  # library boundary; translated below
        raise GraphMlParseError(
            f"cannot parse {path.name} as GraphML: {type(exc).__name__}: {exc}"
        ) from exc
    return graph


def _require_node(graph: nx.Graph, node: str) -> str:
    """Return the node identifier as stored, or reject it with a deterministic error.

    GraphML identifiers are strings. A caller-supplied identifier is matched exactly
    first, then case-insensitively, so a model that reproduces a tag with different
    casing gets the node rather than a spurious absence.

    Raises:
        NodeNotFoundError: If no node matches.
    """
    candidate = node.strip()
    if not candidate:
        raise NodeNotFoundError("node identifier must not be blank")
    if graph.has_node(candidate):
        return candidate

    folded = candidate.casefold()
    for existing in graph.nodes:
        if str(existing).casefold() == folded:
            return str(existing)
    raise NodeNotFoundError(f"node '{candidate}' is not present in the graph")


def _node_matches(node_id: str, attributes: dict[str, Any], needle: str) -> bool:
    """Report whether a node's identifier or any string attribute contains ``needle``."""
    if needle in node_id.casefold():
        return True
    return any(
        needle in str(value).casefold() for value in attributes.values() if isinstance(value, str)
    )


def _render_attrs(attributes: dict[str, Any]) -> dict[str, str]:
    """Render attribute values as bounded strings, preserving every declared key."""
    rendered: dict[str, str] = {}
    for key, value in attributes.items():
        text = str(value)
        if len(text) > _MAX_ATTRIBUTE_CHARS:
            text = f"{text[:_MAX_ATTRIBUTE_CHARS]}...(truncated)"
        rendered[str(key)] = text
    return rendered


def _incident_nodes(graph: nx.Graph, node: str) -> Iterator[str]:
    """Yield every node adjacent to ``node``, ignoring direction, in identifier order.

    Direction is deliberately ignored for neighbourhood discovery and preserved in the
    returned edge records: an instrument upstream of a valve is part of that valve's
    local connectivity regardless of which way the line runs.
    """
    if graph.is_directed():
        adjacent = set(graph.successors(node)) | set(graph.predecessors(node))
    else:
        adjacent = set(graph.neighbors(node))
    yield from sorted(str(item) for item in adjacent)


def _all_edges(graph: nx.Graph) -> Iterator[EdgeRecord]:
    """Yield every edge as a record, keeping parallel edges distinct."""
    directed = graph.is_directed()
    if graph.is_multigraph():
        for source, target, key, attributes in graph.edges(keys=True, data=True):
            yield EdgeRecord(
                source=str(source),
                target=str(target),
                key=str(key),
                directed=directed,
                attributes=_render_attrs(attributes),
            )
        return
    for source, target, attributes in graph.edges(data=True):
        yield EdgeRecord(
            source=str(source),
            target=str(target),
            key=None,
            directed=directed,
            attributes=_render_attrs(attributes),
        )


def _edges_within(graph: nx.Graph, nodes: set[str]) -> Iterator[EdgeRecord]:
    """Yield edges whose endpoints both lie inside ``nodes``, in deterministic order."""
    for record in sorted(
        _all_edges(graph), key=lambda item: (item.source, item.target, item.key or "")
    ):
        if record.source in nodes and record.target in nodes:
            yield record


def _edges_along(graph: nx.Graph, node_path: tuple[str, ...]) -> Iterator[EdgeRecord]:
    """Yield one edge record per consecutive pair along a path.

    The graph's edges are indexed once rather than rescanned per pair, so the cost is
    linear in the graph size regardless of path length. For a multigraph the
    lowest-sorting parallel edge between each pair is reported; the edge-lookup query
    exposes the full parallel set when it matters.
    """
    wanted = set(pairwise(node_path))
    if not wanted:
        return

    directed = graph.is_directed()
    best: dict[tuple[str, str], EdgeRecord] = {}
    for record in _all_edges(graph):
        for pair in wanted:
            if not _connects(record, pair[0], pair[1], directed=directed):
                continue
            incumbent = best.get(pair)
            if incumbent is None or _edge_order(record) < _edge_order(incumbent):
                best[pair] = record

    for source, target in pairwise(node_path):
        chosen = best.get((source, target))
        if chosen is not None:
            yield chosen


def _edge_order(record: EdgeRecord) -> tuple[str, str, str]:
    """Return the deterministic ordering key for an edge record."""
    return (record.key or "", record.source, record.target)


def _connects(record: EdgeRecord, source: str, target: str, *, directed: bool) -> bool:
    """Report whether an edge joins ``source`` to ``target`` under the graph's semantics."""
    if record.source == source and record.target == target:
        return True
    return not directed and record.source == target and record.target == source


def _edge_matches(
    record: EdgeRecord,
    source: str | None,
    target: str | None,
    *,
    directed: bool,
) -> bool:
    """Report whether an edge satisfies an endpoint filter."""
    if source is not None and target is not None:
        return _connects(record, source, target, directed=directed)
    endpoint = source if source is not None else target
    return endpoint in (record.source, record.target)
