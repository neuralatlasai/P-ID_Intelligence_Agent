# Engineering Standards
## 1. Purpose
This file defines the mandatory engineering baseline for source code, repository structure, packaging, review, testing, release, and documentation.
Requirements use **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as normative terms.
Where IEEE/ISO/IEC defines process controls but not language syntax, the language ecosystem standard is authoritative.
## 2. Normative Baseline
- ISO/IEC/IEEE 12207:2026 — software life-cycle process framework.
- IEEE 730-2026 — software quality-assurance processes.
- IEEE 2675-2021 — reliable and secure build, package, deployment, and DevOps controls.
- ISO/IEC/IEEE 15289:2019 — life-cycle information-item/documentation content.
- Python PEP 8 — Python source-code style and naming.
- Python PEP 257 — public Python docstring conventions.
- Python Packaging User Guide / `pyproject.toml` — Python project packaging baseline.
- Google Python Style Guide — enterprise Python profile where PEP 8 leaves implementation choices open.
- GitHub protected-branch/ruleset controls — repository merge and review enforcement.
- Project-local rules MAY be stricter but MUST NOT silently contradict the governing language/runtime contract.
## 3. Repository Architecture
```text
repository/
├── pyproject.toml
├── README.md
├── LICENSE
├── CHANGELOG.md
├── SECURITY.md
├── CONTRIBUTING.md
├── standards.md
├── src/
│   └── <package_name>/
│       ├── __init__.py
│       └── ...
├── tests/
│   ├── unit/
│   ├── integration/
│   └── conftest.py
├── docs/
├── examples/
├── scripts/
└── .github/
    ├── workflows/
    ├── CODEOWNERS
    └── pull_request_template.md
```
- Distributable Python code MUST reside under `src/<package_name>/`.
- Tests MUST be outside the import package and MUST test the installed/importable package.
- Generated artifacts, caches, credentials, virtual environments, and local IDE state MUST NOT be committed.
- Build, test, lint, type-check, security, and release automation MUST be reproducible from repository-controlled configuration.
- Repository root MUST contain only project-level configuration, governance, documentation, and build entry points.
## 4. Python Naming and Source Layout
- Modules/packages: `lowercase` or `lowercase_with_underscores`; package names SHOULD remain short.
- Functions/methods/local variables: `snake_case`.
- Classes/exceptions: `CapWords`; exception classes MUST end in `Error` when semantically applicable.
- Constants: `UPPER_CASE_WITH_UNDERSCORES`.
- Non-public members: single leading underscore.
- First instance-method parameter: `self`; first class-method parameter: `cls`.
- Public API names MUST be stable, descriptive, unambiguous, and free of implementation-specific leakage.
- Wildcard imports (`from x import *`) MUST NOT be used in production modules.
- Imports MUST be explicit and grouped: standard library, third party, local package.
- Imports MUST normally be at module scope unless delayed import is technically required and documented.
## 5. Formatting
- Indentation MUST be four spaces; tabs MUST NOT be used for indentation.
- Source files MUST use UTF-8.
- Line length MUST follow the repository formatter/linter profile and MUST remain PEP-8-compatible unless a documented project rule overrides it.
- Statements SHOULD occupy one logical line; semicolon-packed statements MUST NOT be used.
- Binary-operator wrapping, hanging indentation, trailing commas, blank lines, and whitespace MUST be formatter-consistent.
- Formatting MUST be machine-enforced; formatting decisions MUST NOT depend on individual developer preference.
## 6. Types, Interfaces, and Contracts
- Public functions, methods, constructors, and exported data structures MUST carry type annotations unless technically impossible; public APIs MUST define input domain, output type, exceptions, side effects, and state mutation.
- `Any` SHOULD be restricted to integration boundaries, dynamic protocols, or explicitly justified escape hatches.
- Mutable default arguments MUST NOT be used.
- Public interfaces MUST NOT expose internal mutable state unless that mutability is part of the contract.
- Backward-incompatible public API changes MUST be versioned and documented.
## 7. Documentation
- Public modules, classes, functions, and methods MUST have docstrings conforming to PEP 257.
- A docstring MUST state behavior rather than restate the function signature.
- Public callable documentation MUST cover parameters, return semantics, raised exceptions, side effects, and operational constraints where applicable.
- `README.md` MUST define purpose, supported runtime, installation, minimal usage, test procedure, and compatibility policy.
- Architecture or externally significant design decisions SHOULD be recorded under `docs/`.
- Documentation MUST change in the same pull request as the behavior or interface it describes.
## 8. Error Handling and Logging
- Exceptions MUST represent exceptional conditions; they MUST NOT replace ordinary control flow.
- Broad exception capture (`except Exception`) MUST be limited to process/service boundaries and MUST preserve diagnostic context.
- Bare `except:` MUST NOT be used.
- Raised exceptions MUST preserve causality when translating lower-level failures.
- Secrets, credentials, authentication material, and sensitive payloads MUST NOT be logged.
- Libraries MUST NOT configure global application logging as an import side effect.
## 9. State, Concurrency, and Side Effects
- Module-level mutable global state SHOULD be avoided.
- Shared mutable state MUST have explicit ownership and synchronization semantics.
- Functions SHOULD separate deterministic computation from I/O and external side effects.
- Importing a module MUST NOT perform network calls, persistent writes, process termination, or destructive initialization.
- Resource ownership MUST be explicit; files, sockets, locks, sessions, and executors MUST be deterministically released.
## 10. Testing
- Every defect fix MUST include a regression test unless the failure cannot be reproduced deterministically.
- Public behavior MUST be covered by automated tests at the appropriate unit/integration/system boundary.
- Tests MUST be deterministic and MUST NOT depend on execution order.
- External services, clocks, randomness, filesystems, and environment-dependent behavior MUST be controlled or isolated.
- Test names MUST identify the behavior or invariant under test.
- CI MUST fail on test failure; flaky tests MUST be treated as defects, not retried indefinitely.
## 11. Static Analysis and Quality Gates
- CI MUST execute formatting verification, linting, type checking, tests, package build validation, and dependency/security checks.
- New code MUST NOT introduce unresolved high-severity security findings.
- Suppressions (`# noqa`, type-ignore, linter disable) MUST be minimal, localized, and justified.
- Dead code, unreachable branches, unused imports, and unused public parameters MUST NOT remain without documented purpose.
- Quality gates MUST run from clean environments and MUST be reproducible locally.
## 12. Dependency and Packaging Controls
- `pyproject.toml` MUST be the authoritative Python build/project metadata entry point.
- Runtime dependencies MUST be declared explicitly; undeclared transitive dependencies MUST NOT be intentionally imported; production dependencies SHOULD be minimized and reviewed for maintenance, licensing, provenance, and security.
- Package builds MUST produce reproducible, inspectable artifacts using a standards-compliant build backend.
- Importable package name, distribution name, supported Python versions, and optional dependency groups MUST be intentionally defined.
- Build artifacts MUST be tested before publication.
## 13. Configuration and Secrets
- Configuration MUST be externalizable and environment-specific values MUST NOT be hard-coded into source.
- Secrets MUST NOT exist in source code, committed configuration, examples, tests, or documentation.
- Required configuration MUST fail fast with actionable diagnostics.
- Configuration precedence and defaults MUST be deterministic and documented.
- Security-sensitive defaults MUST choose the safer behavior.
## 14. Git and Change Control
- Protected default branches MUST require pull-request-based changes and passing required CI status checks.
- At least one qualified reviewer SHOULD approve non-trivial production changes; higher-risk modules SHOULD use CODEOWNERS.
- Force-push and branch deletion MUST be disabled on protected release/default branches except controlled administration.
- Commits MUST be traceable to a change purpose; generated or unrelated modifications MUST NOT be mixed into a functional change.
- Reviews MUST evaluate correctness, interface compatibility, security, tests, documentation, and operational impact.
## 15. Release Engineering
- Releases MUST originate from version-controlled, reviewed, CI-validated source.
- Version changes MUST correspond to documented compatibility impact.
- Release notes/CHANGELOG MUST identify externally observable changes, fixes, deprecations, and breaking changes.
- Published artifacts MUST be immutable; corrections require a new release.
- Release workflows MUST prevent accidental publication from untrusted or unreviewed code.
- Rollback or recovery procedures SHOULD exist for deployable services and critical packages.
## 16. Security Engineering
- Least privilege MUST apply to CI identities, deployment/runtime credentials, and repository permissions; dependency and secret scanning MUST be enabled where supported.
- Inputs crossing trust boundaries MUST be validated before use.
- Command execution, path handling, serialization, deserialization, and dynamic code loading MUST be treated as security-sensitive boundaries.
- Security findings MUST be triaged by exploitability and impact; accepted risk MUST be documented.
## 17. Definition of Done
A change is complete only when:
1. Implementation conforms to this file and the applicable language/runtime specification.
2. Formatting, lint, typing, tests, build, and security gates pass.
3. Public API and compatibility impact are reviewed.
4. Documentation and examples are synchronized with behavior.
5. Repository, dependency, configuration, and security controls remain valid.
6. Required review and branch-protection conditions are satisfied.
7. Release-visible changes are recorded when applicable.
## 18. Conformance Rule
- **IEEE/ISO/IEC controls govern process, assurance, documentation, and lifecycle discipline.**
- **PEP/PyPA rules govern Python language style, documentation, and packaging details.**
- **Repository-platform controls govern enforceable review/merge policy.**
- No requirement in this file may be represented as an IEEE coding-style mandate unless IEEE explicitly specifies it.
- When two applicable rules conflict, the project MUST document the selected rule, its authority, and the reason for deviation.
