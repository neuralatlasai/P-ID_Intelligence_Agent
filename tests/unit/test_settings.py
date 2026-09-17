"""Configuration validation and fail-fast startup behaviour."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from pid_intelligence.settings import ConfigurationError, Settings


def _load(corpus_root: Path, tmp_path: Path, **overrides: object) -> Settings:
    return Settings.load_and_validate(
        CORPUS_ROOT=str(corpus_root),
        SQLITE_PATH=str(tmp_path / "sessions.sqlite3"),
        **overrides,
    )


def test_corpus_root_is_resolved_to_an_absolute_path(
    corpus_root: Path,
    tmp_path: Path,
) -> None:
    loaded = _load(corpus_root, tmp_path)
    assert loaded.corpus_root.is_absolute()
    assert loaded.corpus_root == corpus_root.resolve()


def test_sqlite_parent_directory_is_created(corpus_root: Path, tmp_path: Path) -> None:
    nested = tmp_path / "var" / "state" / "sessions.sqlite3"
    loaded = Settings.load_and_validate(
        CORPUS_ROOT=str(corpus_root),
        SQLITE_PATH=str(nested),
    )
    assert loaded.sqlite_path.parent.is_dir()


def test_missing_corpus_root_fails_startup(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="CORPUS_ROOT does not exist"):
        Settings.load_and_validate(
            CORPUS_ROOT=str(tmp_path / "absent"),
            SQLITE_PATH=str(tmp_path / "sessions.sqlite3"),
        )


def test_corpus_root_that_is_a_file_fails_startup(tmp_path: Path) -> None:
    not_a_directory = tmp_path / "corpus.txt"
    not_a_directory.write_text("", encoding="utf-8")
    with pytest.raises(ConfigurationError, match="not a directory"):
        Settings.load_and_validate(
            CORPUS_ROOT=str(not_a_directory),
            SQLITE_PATH=str(tmp_path / "sessions.sqlite3"),
        )


@pytest.mark.parametrize(
    "override",
    [
        {"RUN_DEADLINE_S": 0.0},
        {"RUN_DEADLINE_S": -1.0},
        {"MODEL_CALL_TIMEOUT_S": 0.0},
        {"TOOL_TIMEOUT_S": -0.5},
        {"MAX_AGENT_TURNS": 0},
        {"MAX_CONCURRENT_RUNS": 0},
        {"MAX_FUNCTION_TOOL_CONCURRENCY": -2},
        {"MAX_CORPUS_FILE_BYTES": 0},
        {"SESSION_CACHE_MAX_ENTRIES": 0},
    ],
)
def test_non_positive_bounds_are_rejected(
    corpus_root: Path,
    tmp_path: Path,
    override: dict[str, object],
) -> None:
    with pytest.raises(ConfigurationError):
        _load(corpus_root, tmp_path, **override)


def test_model_list_is_rejected_because_there_is_no_runtime_router(
    corpus_root: Path,
    tmp_path: Path,
) -> None:
    with pytest.raises(ConfigurationError, match="exactly one model identifier"):
        _load(corpus_root, tmp_path, OPENAI_MODEL="gpt-5,gpt-5-mini")


def test_blank_model_is_rejected(corpus_root: Path, tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError):
        _load(corpus_root, tmp_path, OPENAI_MODEL="   ")


def test_unknown_log_level_is_rejected(corpus_root: Path, tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="LOG_LEVEL"):
        _load(corpus_root, tmp_path, LOG_LEVEL="chatty")


def test_log_level_is_case_insensitive(corpus_root: Path, tmp_path: Path) -> None:
    loaded = _load(corpus_root, tmp_path, LOG_LEVEL="debug")
    assert loaded.log_level == "DEBUG"
    assert getattr(logging, loaded.log_level) == logging.DEBUG


def test_upstream_response_storage_is_disabled_by_default(
    corpus_root: Path,
    tmp_path: Path,
) -> None:
    assert _load(corpus_root, tmp_path).store_model_responses is False


def test_full_history_is_retrieved_by_default(corpus_root: Path, tmp_path: Path) -> None:
    assert _load(corpus_root, tmp_path).session_history_limit is None


def test_tracing_is_inert_without_a_credential(corpus_root: Path, tmp_path: Path) -> None:
    loaded = _load(corpus_root, tmp_path, ENABLE_TRACING=True, OPENAI_API_KEY=None)
    assert loaded.enable_tracing is True
    assert loaded.tracing_enabled is False


def test_retry_policy_is_bounded(corpus_root: Path, tmp_path: Path) -> None:
    retry = _load(corpus_root, tmp_path).model_retry_settings()
    assert retry.max_retries is not None
    assert retry.max_retries <= 8
    assert retry.backoff is not None
    assert retry.backoff.max_delay is not None


def test_settings_are_immutable(corpus_root: Path, tmp_path: Path) -> None:
    loaded = _load(corpus_root, tmp_path)
    with pytest.raises(Exception, match=r"frozen|immutable"):
        loaded.openai_model = "other"  # type: ignore[misc]


def test_description_never_exposes_the_credential(corpus_root: Path, tmp_path: Path) -> None:
    loaded = _load(corpus_root, tmp_path, OPENAI_API_KEY="sk-super-secret-value")
    described = loaded.describe()
    assert described["openai_api_key_present"] is True
    assert "sk-super-secret-value" not in repr(described)
    assert "openai_api_key" not in described


def test_environment_variables_are_read(
    corpus_root: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAX_AGENT_TURNS", "17")
    assert _load(corpus_root, tmp_path).max_agent_turns == 17
