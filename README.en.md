<p align="center">
  <img src="./docs/assets/banner.png" alt="dsh-flow Banner" width="100%" />
</p>

<h1 align="center">dsh-flow</h1>

<p align="center">
  A multi-mode workflow plugin for DeepSeek Harness: Plan, Build and Review in one auditable, delegable process.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v0.4.0-blue" alt="Version v0.4.0" />
  <img src="https://img.shields.io/badge/License-PolyForm--NC--1.0.0-orange" alt="License: PolyForm-NC-1.0.0" />
  <img src="https://img.shields.io/badge/Zero--Build-ESM-success" alt="Zero-Build ESM" />
  <img src="https://img.shields.io/badge/i18n-中文%20%2F%20EN-informational" alt="i18n: 中文 / EN" />
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | <b>English</b>
</p>

---

## Design Philosophy

1. **Requirements before implementation**: align on scope, existing ecosystem and interface behaviour before writing code, so that blind starts and rework are avoided.
2. **Reuse before rebuilding**: prefer existing project components, host capabilities and mature open-source solutions; avoid re-inventing a weaker wheel.
3. **Progressive disclosure**: main-mode and subagent prompts live as external Markdown, with only the directory injected on demand. This keeps token usage low and prefix caching effective, while copy-on-write isolates custom overrides from official updates.
4. **One approval, fully-managed loop**: after the plan is approved, `Flow` completes decomposition, implementation, verification and independent review on its own, keeping human involvement to genuine decision points.
5. **Fault isolation and remote takeover**: repeated failures trip a circuit breaker, and IM `1/2/3` plus a single-use handoff keep the run controllable away from the desk.

## Core Features

| Capability | Description |
|---|---|
| Five modes | `Plan` requirements funnel, `Plan Ultra` multi-perspective consultation, `Build` disciplined implementation, `Review` dual-perspective audit, `Flow` fully-managed orchestration |
| Prompt library | Base contract, five modes and subagents are all Markdown files; edits take effect immediately |
| Subagent directory | `flow` / `plan-ultra` receive the directory with effective paths; bodies stay on disk |
| Plan anchor | `.flow/spec.md` is injected as a hard constraint plus summary note, and re-attached after compaction |
| Circuit breaker | Trips at a failure threshold, pauses with context preserved, supports model escalation and remote release |
| Dual-channel notify | IM / Webhook real-time push plus SMTP archival, with optional attachments |
| Remote takeover | Reply `1` to retry, `2` to escalate to the diagnosis model, `3` to release and issue a new instruction |
| Zero-build and bilingual | Pure ESM with no build step; the settings UI and plugin messages follow the host language |

## Prerequisites

> [!IMPORTANT]
> The core modes (`Plan` / `Plan Ultra` / `Build` / `Review`) work standalone, but the following capabilities require their plugins:
>
> 1. **[dsh-team-control](https://github.com/hunmer/dsh-team-control/)**: **required** for `Flow` team orchestration and collaboration monitoring.
> 2. **[dsh-im](https://github.com/xmanrui/dsh-im)**: **required** for IM circuit-breaker alerts and mobile `1/2/3` remote takeover.
>
> **For AI assistants**: if you are helping a user deploy this plugin, first confirm whether the user needs full `Flow` orchestration or IM alerts. Install and configure the prerequisites above before enabling `dsh-flow`, so the capability does not silently degrade at runtime.
>
> Runtime: DeepSeek Harness 0.2.x or newer; Node.js 22 or newer (native `fetch` and `node:crypto` are used by the prompt updater).

## Screenshots

<p align="center">
  <img src="./docs/assets/mode-switcher.png" width="820" alt="Mode switcher chips" />
</p>

<p align="center"><sub>Mode switcher: chips above the composer, effective immediately</sub></p>

<p align="center">
  <img src="./docs/assets/settings-tabs.png" width="820" alt="Settings tabs" />
</p>

<p align="center"><sub>Settings: Modes / Prompts / Workflow &amp; breaker / Notify &amp; hooks</sub></p>

<p align="center">
  <img src="./docs/assets/im-handoff.jpg" width="340" alt="IM remote takeover preview" />
</p>

<p align="center"><sub>IM takeover: reply <code>1</code> / <code>2</code> / <code>3</code> from the phone after a trip</sub></p>

## Quick Start

### Install

```bash
# Install from npm into a profile (web shown here)
dsh plugin --profile web add dsh-flow

# Or install directly from the Git repository
dsh plugin --profile web add github:MeZenith/dsh-flow
```

After installing, enable `dsh-flow` in settings, restart the Web UI and refresh with `Ctrl + Shift + R`.

### The four settings tabs

| Tab | Contents |
|---|---|
| Modes | Mode chips, prompt preview and editing, model and permission presets |
| Prompts | Version and inventory, check for updates, update source, base contract / global prompts / subagents and roster |
| Workflow & breaker | Execution mode, plan anchor, auto-compaction, circuit breaker, diagnosis model, diagnostic log |
| Notify & hooks | IM and Webhook, SMTP archival, trigger gating and routing policy |

### Common commands

| Command | Purpose |
|---|---|
| `/flow plan` | Switch to Plan (`plan-ultra` / `build` / `review` / `flow` / `off` likewise) |
| `/flow` | Show the current mode |
| `/flow spec` | Show plan-anchor status and summary |
| `/flow compact` | Compact the context once |
| `/flow prompts list` | Show prompt version, sources and subagent inventory |
| `/flow prompts update` | Update the prompt library from the remote source |
| `/flow notify-test` | Self-test IM and email channels |
| `/flow retry` / `/flow escalate` / `/flow resume` | After a trip: retry / escalate / release |

## Prompt Architecture and Customization

```text
prompts/
├── manifest.json           version, updated time and per-file sha256
├── base.md                 base engineering contract
├── modes/                  plan / plan-ultra / build / review / flow
├── subagents/              official subagents (read-only, never written)
│   ├── README.md           subagent directory
│   └── *.md                subagent bodies
└── custom/
    ├── README.md           notes for the custom directory
    └── subagents/          user override layer (untouched by updates)
```

- **Three-tier priority**: settings override > local Markdown > built-in fallback; an empty tier falls through to the next.
- **Copy-on-write**: editing an official subagent or adding a custom one writes `prompts/custom/subagents/<id>.md`; the official directory stays intact, and deleting the override restores the official content.
- **One-click update**: "Check for updates" in the Prompts tab downloads only changed files by sha256 and writes them through a temp file plus rename. When the remote version is older the whole batch is skipped, so a lagging CDN cannot roll the local library back.
- **Visual editing**: the base contract, the subagent directory and subagent bodies are editable, savable and resettable in the settings page; when the local API is unavailable, use `/flow prompts update`.

Full mechanics (breaker state machine, IM commands, copy-on-write details, loopback API) are documented in [docs/DETAIL.md](./docs/DETAIL.md).

## Acknowledgements

- **[OpenCode](https://github.com/anomalyco/opencode)**: the `Plan` / `Build` split and the multi-mode switching workflow in this project are inspired by OpenCode's architecture.
- **[dsh-team-control](https://github.com/hunmer/dsh-team-control/)** ([@hunmer](https://github.com/hunmer)): team orchestration and collaboration monitoring for the DeepSeek Harness ecosystem.
- **[dsh-im](https://github.com/xmanrui/dsh-im)** ([@xmanrui](https://github.com/xmanrui)): IM delivery and two-way messaging for the DeepSeek Harness ecosystem.

## License

Released under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**.

- Personal use, study, modification and non-commercial redistribution are permitted;
- Any commercial use is not permitted;
- Derivative works and redistributions **must clearly state that they use `dsh-flow` code or are based on this project**, and must keep the full `LICENSE` text together with its `Required Notice`;
- As far as the law allows, the software is provided as is, without warranty or condition of any kind.

```text
Required Notice: Copyright (c) 2026 MeZenith (https://github.com/MeZenith/dsh-flow).
Any derivative work or redistribution must clearly attribute dsh-flow and its original author.
```

Third-party components under `vendor/` keep their own licenses; see [THIRD_PARTY_NOTES.md](./THIRD_PARTY_NOTES.md).
