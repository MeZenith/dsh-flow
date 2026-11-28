# ADR 0001: Switch Project License from PolyForm Noncommercial to Apache-2.0

- **Status**: Accepted
- **Date**: 2026-11-28

## Context

Earlier releases (`<= 0.6.1` prior to repository hardening) shipped under `PolyForm-Noncommercial-1.0.0`. While intended to deter unauthorized commercial redistribution, a noncommercial license blocks usage inside corporate engineering teams and creates legal uncertainty for third-party contributors submitting pull requests.

## Decision

Switch `dsh-flow` to **Apache License 2.0** (`Apache-2.0`) across `LICENSE`, `package.json`, `README.md`, `README.en.md`, and enforce license consistency in `scripts/check-code.mjs`.

## Consequences

- Professional developers and organizations can install, audit, fork, and contribute improvements without commercial-use friction.
- Patents and trademark disclaimers follow standard OSI-approved Apache-2.0 terms.
- Requires explicit license metadata alignment verified automatically on every CI run.
