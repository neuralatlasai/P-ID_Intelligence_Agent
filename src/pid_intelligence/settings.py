"""Control-plane configuration for the P&ID Intelligence Agent backend.

Every operational bound of the service is expressed here as configuration rather than
as a literal buried in call sites. The settings object is immutable once validated and
is read-only to the data plane: no model output and no tool result may mutate it.

Loading is explicit. Importing this module reads no environment, touches no filesystem
and creates no directories; :meth:`Settings.load_and_validate` performs those actions.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Final

from agents import ModelRetryBackoffSettings, ModelRetrySettings
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = ["ConfigurationError", "Settings"]

PositiveFloat = Annotated[float, Field(gt=0.0)]
PositiveInt = Annotated[int, Field(gt=0)]

_VALID_LOG_LEVELS: Final[frozenset[str]] = frozenset(
    {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
)


class ConfigurationError(RuntimeError):
    """Raised when the process cannot start with the supplied configuration.

    The message is intended to be actionable for an operator: it names the setting, the
    observed value class and the corrective action. It never contains secret material.
    """


class Settings(BaseSettings):
    """Validated control-plane configuration.

    Values are sourced, in decreasing precedence, from explicit constructor arguments,
    process environment variables, and a development-only ``.env`` file. Defaults are
    chosen so that omitting an optional variable yields the safer behaviour: upstream
    response storage is disabled, tracing only exports when a credential exists, and
    every bound is finite.

    Attributes:
        openai_api_key: Credential for the OpenAI Responses API. Never logged, never
            placed in model context, never returned by a tool.
        openai_model: The single OpenAI model identifier used by the runtime. The
            service performs no runtime model routing.
        corpus_root: Absolute path to the read-only engineering corpus.
        sqlite_path: Absolute path to the file-backed SQLite database whose schema is
            owned and initialised by the Agents SDK session implementation.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
        validate_default=True,
        populate_by_name=True,
    )

    # -- Model plane -------------------------------------------------------------
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-5", alias="OPENAI_MODEL", min_length=1)
    store_model_responses: bool = Field(default=False, alias="STORE_MODEL_RESPONSES")

    # -- Local state -------------------------------------------------------------
    corpus_root: Path = Field(default=Path("data"), alias="CORPUS_ROOT")
    sqlite_path: Path = Field(default=Path("var/sessions.sqlite3"), alias="SQLITE_PATH")

    # -- Deadlines and bounds ----------------------------------------------------
    run_deadline_s: PositiveFloat = Field(default=300.0, alias="RUN_DEADLINE_S")
    model_call_timeout_s: PositiveFloat = Field(default=120.0, alias="MODEL_CALL_TIMEOUT_S")
    tool_timeout_s: PositiveFloat = Field(default=30.0, alias="TOOL_TIMEOUT_S")
    max_agent_turns: PositiveInt = Field(default=24, alias="MAX_AGENT_TURNS")
    max_concurrent_runs: PositiveInt = Field(default=4, alias="MAX_CONCURRENT_RUNS")
    max_function_tool_concurrency: PositiveInt = Field(
        default=4, alias="MAX_FUNCTION_TOOL_CONCURRENCY"
    )
    shutdown_grace_s: PositiveFloat = Field(default=30.0, alias="SHUTDOWN_GRACE_S")

    # -- Model retry policy ------------------------------------------------------
    model_max_retries: int = Field(default=2, ge=0, le=8, alias="MODEL_MAX_RETRIES")
    model_retry_initial_delay_s: PositiveFloat = Field(
        default=1.0, alias="MODEL_RETRY_INITIAL_DELAY_S"
    )
    model_retry_max_delay_s: PositiveFloat = Field(default=20.0, alias="MODEL_RETRY_MAX_DELAY_S")
    model_retry_multiplier: PositiveFloat = Field(default=2.0, alias="MODEL_RETRY_MULTIPLIER")
    model_retry_jitter: bool = Field(default=True, alias="MODEL_RETRY_JITTER")

    # -- Corpus bounds -----------------------------------------------------------
    max_corpus_file_bytes: PositiveInt = Field(
        default=32 * 1024 * 1024, alias="MAX_CORPUS_FILE_BYTES"
    )
    max_corpus_list_entries: PositiveInt = Field(default=200, alias="MAX_CORPUS_LIST_ENTRIES")
    corpus_scan_cache_ttl_s: float = Field(default=30.0, ge=0.0, alias="CORPUS_SCAN_CACHE_TTL_S")
    max_pdf_pages_per_tool_result: PositiveInt = Field(
        default=8, alias="MAX_PDF_PAGES_PER_TOOL_RESULT"
    )
    pdf_render_dpi: PositiveInt = Field(default=200, le=600, alias="PDF_RENDER_DPI")
    # Magnification applied to a cropped drawing region. Three is where an instrument
    # bubble on a 2600px sheet becomes legible without the encoded crop growing past
    # what is sensible to place in model context.
    drawing_region_scale: PositiveFloat = Field(default=3.0, le=8.0, alias="DRAWING_REGION_SCALE")
    max_pdf_text_hits: PositiveInt = Field(default=25, alias="MAX_PDF_TEXT_HITS")
    pdf_cache_max_entries: PositiveInt = Field(default=8, alias="PDF_CACHE_MAX_ENTRIES")

    # -- Graph query bounds ------------------------------------------------------
    max_graph_hops: PositiveInt = Field(default=4, le=16, alias="MAX_GRAPH_HOPS")
    max_graph_nodes: PositiveInt = Field(default=200, alias="MAX_GRAPH_NODES")
    max_graph_edges: PositiveInt = Field(default=400, alias="MAX_GRAPH_EDGES")
    graph_cache_max_entries: PositiveInt = Field(default=16, alias="GRAPH_CACHE_MAX_ENTRIES")

    # -- Session registry --------------------------------------------------------
    session_cache_max_entries: PositiveInt = Field(default=256, alias="SESSION_CACHE_MAX_ENTRIES")
    session_cache_idle_s: PositiveFloat = Field(default=900.0, alias="SESSION_CACHE_IDLE_S")
    session_cache_sweep_interval_s: PositiveFloat = Field(
        default=60.0, alias="SESSION_CACHE_SWEEP_INTERVAL_S"
    )
    session_history_limit: int | None = Field(default=None, ge=1, alias="SESSION_HISTORY_LIMIT")

    # -- Transport ---------------------------------------------------------------
    max_request_body_bytes: PositiveInt = Field(
        default=4 * 1024 * 1024, alias="MAX_REQUEST_BODY_BYTES"
    )
    host: str = Field(default="127.0.0.1", alias="HOST")
    port: int = Field(default=8000, ge=1, le=65535, alias="PORT")

    # -- Observability -----------------------------------------------------------
    enable_tracing: bool = Field(default=True, alias="ENABLE_TRACING")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @field_validator("log_level", mode="before")
    @classmethod
    def _normalise_log_level(cls, value: object) -> object:
        """Upper-case the log level so ``info`` and ``INFO`` behave identically."""
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("log_level")
    @classmethod
    def _check_log_level(cls, value: str) -> str:
        """Reject a log level the standard library logging module cannot resolve."""
        if value not in _VALID_LOG_LEVELS:
            allowed = ", ".join(sorted(_VALID_LOG_LEVELS))
            raise ValueError(f"LOG_LEVEL must be one of: {allowed}")
        return value

    @field_validator("openai_model")
    @classmethod
    def _check_single_model(cls, value: str) -> str:
        """Enforce that exactly one model identifier is configured.

        A comma- or whitespace-separated list would imply a runtime model router, which
        the architecture explicitly rejects.
        """
        stripped = value.strip()
        if not stripped:
            raise ValueError("OPENAI_MODEL must not be blank")
        if "," in stripped or any(character.isspace() for character in stripped):
            raise ValueError("OPENAI_MODEL must be exactly one model identifier")
        return stripped

    @property
    def tracing_enabled(self) -> bool:
        """Report whether SDK tracing can actually export.

        Trace export requires an API key. Enabling it without a key yields repeated
        export failures rather than useful traces, so the effective value is the
        conjunction of the operator's preference and credential availability.
        """
        return self.enable_tracing and bool(self.openai_api_key)

    def model_retry_settings(self) -> ModelRetrySettings:
        """Build the bounded model retry policy for the Agents SDK model settings.

        Returns:
            A retry policy with a finite attempt count and exponential backoff with
            jitter. The SDK applies it to transient provider and network failures only;
            it never produces an unbounded retry loop.
        """
        return ModelRetrySettings(
            max_retries=self.model_max_retries,
            backoff=ModelRetryBackoffSettings(
                initial_delay=self.model_retry_initial_delay_s,
                max_delay=self.model_retry_max_delay_s,
                multiplier=self.model_retry_multiplier,
                jitter=self.model_retry_jitter,
            ),
        )

    def describe(self) -> dict[str, object]:
        """Return a log-safe description of the effective configuration.

        The credential is reduced to a presence flag. No value returned by this method
        can be used to reconstruct secret material.

        Returns:
            A mapping suitable for structured startup logging.
        """
        payload: dict[str, object] = self.model_dump(mode="json", exclude={"openai_api_key"})
        payload["openai_api_key_present"] = bool(self.openai_api_key)
        return payload

    @classmethod
    def load_and_validate(cls, **overrides: object) -> Settings:
        """Load configuration from the environment and prove the process can start.

        Beyond field validation this performs the startup checks the architecture
        requires: the corpus root must resolve to an existing, readable directory, and
        the SQLite parent directory must exist or be creatable and must be writable.

        Args:
            **overrides: Explicit values that take precedence over the environment.
                Keys may use either the field name or the environment alias. Intended
                for tests and for embedding the service in another process.

        Returns:
            A frozen, fully validated instance whose ``corpus_root`` and ``sqlite_path``
            are absolute.

        Raises:
            ConfigurationError: If any value is invalid, the corpus root is missing or
                unreadable, or the SQLite location cannot be written.

        Side effects:
            Creates the SQLite parent directory when it does not already exist.
        """
        try:
            candidate = cls(**overrides)  # type: ignore[arg-type]
        except ConfigurationError:
            raise
        except Exception as exc:  # startup boundary; translated below
            raise ConfigurationError(f"invalid configuration: {exc}") from exc

        corpus_root = cls._resolve_corpus_root(candidate.corpus_root)
        sqlite_path = cls._prepare_sqlite_path(candidate.sqlite_path)
        return candidate.model_copy(update={"corpus_root": corpus_root, "sqlite_path": sqlite_path})

    @staticmethod
    def _resolve_corpus_root(configured: Path) -> Path:
        """Resolve the corpus root once, to an absolute path, and prove it is usable."""
        resolved = configured.expanduser().resolve()
        if not resolved.exists():
            raise ConfigurationError(
                f"CORPUS_ROOT does not exist: {resolved}. "
                "Create the directory or point CORPUS_ROOT at the engineering corpus."
            )
        if not resolved.is_dir():
            raise ConfigurationError(f"CORPUS_ROOT is not a directory: {resolved}")
        if not os.access(resolved, os.R_OK | os.X_OK):
            raise ConfigurationError(f"CORPUS_ROOT is not readable: {resolved}")
        return resolved

    @staticmethod
    def _prepare_sqlite_path(configured: Path) -> Path:
        """Resolve the SQLite path and prove the service can persist session history.

        Session durability is part of correctness, so an unwritable database location is
        a startup failure rather than a runtime surprise.
        """
        resolved = configured.expanduser().resolve()
        parent = resolved.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ConfigurationError(
                f"SQLITE_PATH parent directory cannot be created: {parent} ({exc.strerror})"
            ) from exc
        if not os.access(parent, os.W_OK | os.X_OK):
            raise ConfigurationError(f"SQLITE_PATH parent directory is not writable: {parent}")
        if resolved.exists() and not os.access(resolved, os.W_OK):
            raise ConfigurationError(f"SQLITE_PATH exists but is not writable: {resolved}")
        return resolved
