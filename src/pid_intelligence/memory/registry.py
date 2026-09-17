"""Registry of live SDK session objects and their per-session run locks.

The registry is an in-memory cache of session *objects*, not a store of conversation
state. Conversation history lives in the SQLite database the SDK session implementation
owns and initialises. Evicting an entry closes a Python object; it never deletes history.

Two invariants make multi-turn behaviour correct:

* one in-flight run per session, enforced by a per-session lock. Two concurrent turns
  against one session could each read the same pre-turn history and then append competing
  turns, producing an order that represents neither user's conversation. The lock is a
  semantic correctness mechanism, not merely a database lock.
* different sessions are independent. They share a database file and nothing else.

The lock is process-local, so the demo deployment runs a single application worker.
Multi-worker deployment requires distributed same-session ownership and is out of scope.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from agents import SQLiteSession
from agents.items import TResponseInputItem
from agents.memory import Session, SessionSettings

from pid_intelligence.observability.metrics import MetricsRegistry

__all__ = [
    "SESSION_ID_PATTERN",
    "InvalidSessionIdError",
    "SessionEntry",
    "SessionRegistry",
    "validate_session_id",
]

_LOGGER = logging.getLogger(__name__)

SESSION_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,127}$")
"""Accepted session identifier shape: 1-128 characters from a conservative alphabet.

A session identifier is an opaque key into the SDK's session store. It is never a
filesystem path, never a SQL fragment and never interpolated into one. The pattern
excludes path separators, ``..`` prefixes, quotes and whitespace so that a hostile value
cannot be mistaken for any of those by a future caller.
"""


class InvalidSessionIdError(ValueError):
    """The supplied session identifier does not satisfy the accepted shape."""


def validate_session_id(session_id: str) -> str:
    """Validate a transport-supplied session identifier.

    Args:
        session_id: The identifier taken from the request path.

    Returns:
        The identifier unchanged when it is acceptable.

    Raises:
        InvalidSessionIdError: If the identifier is empty, too long, or contains a
            character outside the accepted alphabet.
    """
    if not isinstance(session_id, str) or not SESSION_ID_PATTERN.match(session_id):
        raise InvalidSessionIdError(
            "session id must be 1-128 characters of letters, digits, '.', '_' or '-', "
            "and must start with a letter or digit"
        )
    return session_id


@dataclass(slots=True)
class SessionEntry:
    """One cached session object together with its serialisation state.

    Attributes:
        session_id: The validated identifier this entry serves.
        session: The SDK session object. Conversation state lives behind this interface,
            never in this process.
        lock: Serialises runs for this session. Held for the whole run, including the
            SDK's post-response session persistence.
        last_used_monotonic: Monotonic timestamp of the most recent acquisition, used for
            idle eviction.
        inflight_count: Number of runs currently holding or waiting on the lock. An entry
            with a non-zero count is never evicted.
    """

    session_id: str
    session: Session
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used_monotonic: float = 0.0
    inflight_count: int = 0


class SessionRegistry:
    """Bounded cache of live session objects keyed by session identifier.

    The cache is disposable. Losing it costs one object construction per session on the
    next request; it never costs conversation history, because history is in the database
    the SDK owns.
    """

    def __init__(
        self,
        *,
        db_path: Path,
        max_entries: int,
        idle_s: float,
        history_limit: int | None = None,
        metrics: MetricsRegistry | None = None,
        session_factory: object = None,
    ) -> None:
        """Initialise an empty registry.

        Args:
            db_path: Path to the file-backed SQLite database. The SDK creates and owns
                every table in it.
            max_entries: Maximum number of cached session objects. Reaching the bound
                evicts the least recently used idle entry.
            idle_s: Seconds after which an idle entry becomes eligible for eviction.
            history_limit: Number of recent items to retrieve per turn, or ``None`` to
                retrieve the full history. A limit is a context-retrieval optimisation
                only: the database still holds every item.
            metrics: Optional registry receiving session read, write and error counts.
            session_factory: Optional callable taking a session identifier and returning
                a session object, used by tests to substitute an in-memory or failing
                implementation. Defaults to a file-backed SDK SQLite session.

        Raises:
            ValueError: If ``max_entries`` is not positive.
        """
        if max_entries <= 0:
            raise ValueError("max_entries must be positive")
        self._db_path = db_path
        self._max_entries = max_entries
        self._idle_s = idle_s
        self._history_limit = history_limit
        self._metrics = metrics
        self._session_factory = session_factory if callable(session_factory) else None
        self._entries: dict[str, SessionEntry] = {}
        self._registry_lock = asyncio.Lock()
        self._closed = False

    @property
    def db_path(self) -> Path:
        """Return the path of the SQLite database the SDK session implementation uses."""
        return self._db_path

    def cached_session_ids(self) -> tuple[str, ...]:
        """Return the identifiers currently held in the cache, in insertion order.

        This describes cache occupancy only. A session absent from this tuple may still
        have persisted history in the database.
        """
        return tuple(self._entries)

    async def get(self, session_id: str) -> SessionEntry:
        """Return the cached entry for a session, creating it when absent.

        Args:
            session_id: An identifier already accepted by :func:`validate_session_id`.

        Returns:
            The entry whose lock callers must hold for the duration of a run.

        Raises:
            InvalidSessionIdError: If the identifier is unacceptable.
            RuntimeError: If the registry has been closed.
        """
        validate_session_id(session_id)
        async with self._registry_lock:
            if self._closed:
                raise RuntimeError("session registry is closed")
            entry = self._entries.get(session_id)
            if entry is None:
                entry = SessionEntry(
                    session_id=session_id,
                    session=self._create_session(session_id),
                    last_used_monotonic=time.monotonic(),
                )
                self._entries[session_id] = entry
                await self._evict_locked()
            entry.last_used_monotonic = time.monotonic()
            return entry

    async def acquire(self, session_id: str) -> tuple[SessionEntry, float]:
        """Acquire the per-session run lock, returning the entry and the wait duration.

        The caller is responsible for releasing the lock through :meth:`release`, normally
        from a ``finally`` block, so that cancellation cannot strand it.

        Args:
            session_id: An identifier already accepted by :func:`validate_session_id`.

        Returns:
            A pair of the entry and the seconds spent waiting for the lock. The wait is
            reported so queueing behind another turn of the same session is visible.

        Raises:
            InvalidSessionIdError: If the identifier is unacceptable.
            RuntimeError: If the registry has been closed.
        """
        entry = await self.get(session_id)
        entry.inflight_count += 1
        started = time.perf_counter()
        try:
            await entry.lock.acquire()
        except BaseException:
            entry.inflight_count -= 1
            raise
        waited = time.perf_counter() - started
        entry.last_used_monotonic = time.monotonic()
        if self._metrics is not None:
            self._metrics.observe("session_lock_wait_seconds", waited)
        return entry, waited

    def release(self, entry: SessionEntry) -> None:
        """Release a session's run lock and clear its in-flight accounting.

        Safe to call from a ``finally`` block on every exit path, including cancellation.
        """
        if entry.lock.locked():
            entry.lock.release()
        entry.inflight_count = max(entry.inflight_count - 1, 0)
        entry.last_used_monotonic = time.monotonic()

    async def get_items(self, session_id: str) -> list[TResponseInputItem]:
        """Return the persisted conversation items for a session.

        The items are the SDK's own stored input items. They are returned unchanged: no
        application schema is imposed on them.

        Args:
            session_id: An identifier already accepted by :func:`validate_session_id`.

        Returns:
            The session's items in conversation order. An unknown session yields an empty
            list, because an unknown session is simply one with no history yet.

        Raises:
            InvalidSessionIdError: If the identifier is unacceptable.
        """
        entry = await self.get(session_id)
        try:
            items = await entry.session.get_items()
        except Exception:
            self._count("sqlite_session_errors_total")
            raise
        self._count("sqlite_session_reads_total")
        if self._metrics is not None:
            self._metrics.observe("session_items_loaded", float(len(items)))
        return list(items)

    async def delete(self, session_id: str) -> None:
        """Clear a session's conversation history and drop its cached object.

        History is cleared through the SDK session interface. The application issues no
        SQL against the SDK's tables.

        Args:
            session_id: An identifier already accepted by :func:`validate_session_id`.

        Raises:
            InvalidSessionIdError: If the identifier is unacceptable.
            Exception: Any failure from the underlying session implementation is
                propagated, so a failed clear is visible rather than assumed.
        """
        entry = await self.get(session_id)
        try:
            await entry.session.clear_session()
        except Exception:
            self._count("sqlite_session_errors_total")
            raise
        self._count("sqlite_session_writes_total")

        async with self._registry_lock:
            cached = self._entries.pop(session_id, None)
        if cached is not None:
            self._close_session(cached)

    async def prune(self) -> int:
        """Evict idle, unlocked entries whose objects have outlived the idle window.

        Eviction closes a cached object. It never deletes conversation history.

        Returns:
            The number of entries evicted.
        """
        async with self._registry_lock:
            return await self._evict_locked(force_idle=True)

    async def close(self) -> None:
        """Close every cached session object and refuse further acquisitions.

        Called during shutdown, after admission has stopped and in-flight runs have
        finished or been cancelled. Conversation history in the database is untouched.
        """
        async with self._registry_lock:
            self._closed = True
            entries = list(self._entries.values())
            self._entries.clear()
        for entry in entries:
            self._close_session(entry)

    async def _evict_locked(self, *, force_idle: bool = False) -> int:
        """Evict entries over capacity, or idle entries when ``force_idle`` is set.

        Must be called with the registry lock held. An entry with a non-zero in-flight
        count or a held lock is never evicted, so eviction cannot interrupt a live run.
        """
        now = time.monotonic()
        evicted = 0

        if force_idle:
            for session_id, entry in list(self._entries.items()):
                if self._is_busy(entry):
                    continue
                if (now - entry.last_used_monotonic) >= self._idle_s:
                    del self._entries[session_id]
                    self._close_session(entry)
                    evicted += 1

        while len(self._entries) > self._max_entries:
            victim = self._least_recently_used()
            if victim is None:
                _LOGGER.warning(
                    "session cache is over capacity with every entry in flight: entries=%d",
                    len(self._entries),
                )
                break
            del self._entries[victim.session_id]
            self._close_session(victim)
            evicted += 1
        return evicted

    def _least_recently_used(self) -> SessionEntry | None:
        """Return the least recently used idle entry, or ``None`` when all are busy."""
        idle = [entry for entry in self._entries.values() if not self._is_busy(entry)]
        if not idle:
            return None
        return min(idle, key=lambda entry: entry.last_used_monotonic)

    @staticmethod
    def _is_busy(entry: SessionEntry) -> bool:
        """Report whether an entry is serving or queued for a run."""
        return entry.inflight_count > 0 or entry.lock.locked()

    def _create_session(self, session_id: str) -> Session:
        """Construct a session object for one identifier.

        The default is a file-backed SDK SQLite session whose schema the SDK creates. The
        agent, the tools and the runtime depend only on the SDK ``Session`` contract, so
        substituting another supported implementation later requires no change to them.
        """
        if self._session_factory is not None:
            return self._session_factory(session_id)  # type: ignore[no-any-return]
        return SQLiteSession(
            session_id=session_id,
            db_path=self._db_path,
            session_settings=SessionSettings(limit=self._history_limit),
        )

    def _close_session(self, entry: SessionEntry) -> None:
        """Close one cached session object, tolerating an implementation without ``close``.

        A failure to close is logged rather than raised: the entry is already out of the
        cache, and conversation history is unaffected either way.
        """
        close = getattr(entry.session, "close", None)
        if close is None:
            return
        try:
            close()
        except Exception as exc:  # noqa: BLE001 - shutdown boundary: one object that
            # refuses to close must not prevent the others from closing.
            _LOGGER.warning(
                "failed to close session object: session_id=%s error=%s",
                entry.session_id,
                type(exc).__name__,
            )

    def _count(self, metric: str) -> None:
        """Increment a session metric when a registry is configured."""
        if self._metrics is not None:
            self._metrics.increment(metric)
