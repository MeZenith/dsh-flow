# ADR 0002: Retain Zero-Dependency Built-In SMTP Client with Optional `nodemailer`

- **Status**: Accepted
- **Date**: 2026-11-28

## Context

`dsh-flow` installs inside the DeepSeek Harness plugin ecosystem where minimal install footprint and offline resilience matter. At the same time, some users rely on complex enterprise mail relays or non-standard auth flows.

## Decision

Keep the built-in zero-dependency SMTP/SMTPS/STARTTLS client (`src/notify/smtp-client.js`) alongside preset configurations (`src/notify/smtp-presets.js`), while probing optional `nodemailer` dynamically in `src/notify/email.js` only if installed in the host environment.

## Consequences

- Fresh `npm ci --omit=optional` environments require zero runtime mail packages and remain CI-testable against real local TLS/TCP sockets (`test/unit/notify-channels.test.mjs`).
- Maintainers own CRLF escaping, header sanitization (`sanitizeHeader()`), and basic AUTH LOGIN/PLAIN framing inside `smtp-client.js`; regression tests must explicitly run both `transport: 'builtin'` and mock transport cases.
