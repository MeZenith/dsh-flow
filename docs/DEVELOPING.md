# Developing `dsh-flow`

This guide covers local setup, test/coverage gates, runtime debugging tools, and common extension patterns.

## Prerequisites & 5-Minute Setup

- **Node.js**: `>= 22.0.0` (tested in CI on Node 22 and Node 24, Ubuntu and Windows)
- **Package type**: Pure ESM (`"type": "module"`), zero production dependencies (`@larksuiteoapi/node-sdk` and `nodemailer` are optional runtime dependencies loaded gracefully on demand)

```bash
npm ci
npm run check          # Syntax check (all files), empty-catch & console.log guard, client.js sync, manifest sha256 sync
npm run test:coverage  # Full node:test suite + src/ coverage gate (Line >= 80%, Branch >= 60%, Funcs >= 75%)
```

### Derived Artifacts

Never hand-edit generated files directly:

1. **Settings UI (`client.js`)**: Edit modules under `src/client/`, then rebuild:
   ```bash
   npm run build:client
   ```
2. **Prompt Manifest (`prompts/manifest.json`)**: After editing `prompts/**/*.md`, recompute hashes:
   ```bash
   npm run manifest:sync
   ```

## Debugging Playbook

### 1. Diagnostic Sink (`diag` & `circuit.debugLog`)

- `src/shared/diag.js` emits structured `[flow:diag]` events to `logger.info` and optionally appends to `.flow/diag.log` inside the workspace when `circuit.debugLog` is enabled.
- Inspect circuit-breaker decisions (`preStep`, `observe`, `lock`, `unlock`, `handoff`) and Feishu allowlist/routing decisions by passing `diag` in tests or enabling `circuit.debugLog` in DSH settings.

### 2. Local Loopback API (`/api/flow/*`)

Mounted on DSH's `webServer` service by `src/prompts/api.js` when running inside DSH:

- Prompt listing & manual update check (`GET /api/flow/prompts`, `POST /api/flow/prompts/update`)
- Feishu onboarding QR lifecycle & connection test (`POST /api/flow/feishu/*`)
- Notification channel smoke test (`POST /api/flow/notify/test`)

### 3. Running Targeted Tests Quickly

```bash
node --test test/unit/feishu-router-branches.test.mjs
node --test test/integration/plugin-lifecycle.test.mjs
```

Always finish with `npm run check` and `npm run test:coverage` before opening a PR.

## Extension Recipes

### Recipe A: Add a New Tool or Slash Subcommand

1. Implement the tool factory under `src/tools/` (use `rootGuard(exec)` from `src/tools/common.js` to validate active session & cwd) and register it in `src/tools/index.js`.
2. Or add a `/flow <subcmd>` handler under `src/commands/` and wire it in `src/commands/index.js`.
3. Add unit tests covering both valid execution and guard/error paths under `test/unit/`.

### Recipe B: Add a Feishu Slash Command or Card Action

1. Build cards cleanly using builders in `src/remote/feishu/cards.js` (respect button wrapping limits: max 3 buttons per row, concise labels).
2. Handle inbound commands or `card.action.trigger` `kind` in `src/remote/feishu/router.js` after the `isAllowedUser()` gate. Remember Feishu card actions must return a toast ACK synchronously within 3 seconds and run slow work in the background.
3. Add branch assertions in `test/unit/feishu-router-branches.test.mjs` or `test/integration/remote-feishu.test.mjs`.

### Recipe C: Connect a New Remote Channel via `RemoteHub`

1. Keep your adapter under `src/remote/<channel>/`—do not couple channel-specific APIs into `src/workflow/`, `src/gates/`, or `src/resilience/`.
2. Subscribe to `hub.onEvent((type, payload) => ...)` (`gate:created`, `gate:settled`, `brake:tripped`, `brake:unlocked`, `docs:ready`, `session:completed`) and call the 7 primitives (`listWorkspaces`, `listSessions`, `sendPrompt`, `switchMode`, `abortSession`, `settleGate`, `resolveBrake`, plus `getGateDigest`, `listPending`).
3. See [ARCHITECTURE.md](../ARCHITECTURE.md) and ADR files under `docs/adr/` before altering shared contracts.
