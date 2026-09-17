"""Run the quality gate exactly as CI does, from one command on any platform.

    python scripts/gate.py            # formatting, lint, types, tests
    python scripts/gate.py --fix      # format and autofix first, then the gate
    python scripts/gate.py --build    # also build and inspect the distribution

Every step is the same command CI runs, so a green run here means a green run there. The
script stops at the first failure and reports which step failed, because a gate that keeps
going produces a wall of output in which the first real problem is hard to find.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

Step = tuple[str, list[str]]

# Exit code this script uses to mean "the tool is not installed", distinct from a failure.
NOT_INSTALLED = 127

GATE: list[Step] = [
    ("formatting", ["ruff", "format", "--check", "src", "tests"]),
    ("lint", ["ruff", "check", "src", "tests"]),
    ("types", ["mypy"]),
    ("tests", ["pytest"]),
]

FIX: list[Step] = [
    ("format", ["ruff", "format", "src", "tests"]),
    ("autofix", ["ruff", "check", "--fix", "src", "tests"]),
]

BUILD: list[Step] = [
    ("build", [sys.executable, "-m", "build"]),
    ("inspect", [sys.executable, "-m", "twine", "check", "dist/*"]),
]


def run(name: str, command: list[str]) -> int:
    """Run one step in the repository root and report its outcome.

    Returns:
        The process exit code, or ``NOT_INSTALLED`` when the executable is absent.
    """
    executable = command[0]
    if executable != sys.executable and shutil.which(executable) is None:
        print(f"[{name}] SKIPPED: {executable} is not installed")
        return NOT_INSTALLED

    print(f"[{name}] {' '.join(command)}")
    completed = subprocess.run(command, cwd=ROOT, check=False)  # noqa: S603
    if completed.returncode == 0:
        print(f"[{name}] ok")
    else:
        print(f"[{name}] FAILED with exit code {completed.returncode}")
    return completed.returncode


def main() -> int:
    """Parse arguments and run the selected steps, stopping at the first failure."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true", help="format and autofix first")
    parser.add_argument("--build", action="store_true", help="also build the distribution")
    args = parser.parse_args()

    steps = [*(FIX if args.fix else []), *GATE, *(BUILD if args.build else [])]

    for name, command in steps:
        code = run(name, command)
        if code == NOT_INSTALLED:
            continue
        if code != 0:
            print(f"\ngate failed at: {name}")
            return code

    print("\ngate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
