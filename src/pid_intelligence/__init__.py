"""P&ID Intelligence Agent backend.

The package exposes a thin backend around the OpenAI Agents SDK. The SDK owns the
agent loop, tool dispatch, model calls, session persistence and tracing. This package
owns HTTP admission, session selection, corpus safety, deterministic GraphML/PDF
operations, concurrency, deadlines and observability.

Importing this package performs no I/O, no network access and no configuration load.
Call :func:`pid_intelligence.settings.Settings.load_and_validate` explicitly to obtain
a validated configuration object.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
