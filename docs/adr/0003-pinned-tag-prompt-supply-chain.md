# ADR 0003: Pin Prompt Updater Default Source to Release Tags and Enforce Compatibility Bounds

- **Status**: Accepted
- **Date**: 2026-11-28

## Context

`src/prompts/updater.js` allows refreshing official workflow prompt templates from GitHub. Fetching from a mutable branch like `raw.githubusercontent.com/.../main/prompts` lets unreviewed `main` commits mutate behavior on older installed plugin versions or act as a prompt supply-chain vector.

## Decision

1. Pin `DEFAULT_SOURCE_URL` in `src/prompts/updater.js` to the immutable git tag matching `PLUGIN_VERSION` (`https://raw.githubusercontent.com/MeZenith/dsh-flow/v${PLUGIN_VERSION}/prompts`).
2. Require every remote `manifest.json` fetch to verify SHA-256 checksums for every downloaded file, enforce streaming byte limits (`MAX_BYTES`), and validate `minPluginVersion` / `maxPluginVersion` bounds (`checkPluginCompatibility()`) recorded by `scripts/sync-manifest.mjs`.

## Consequences

- Released plugin builds only auto-pull prompt manifests audited for their matching tag unless a user explicitly configures a custom mirror URL.
- Custom mirrors still benefit from SHA-256 integrity verification and compatibility range checks.
