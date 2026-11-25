# Changelog

本项目的所有重要变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [0.4.0] - 2026-11-25

以 Markdown 文件化提示词库与可视化提示词管理为核心的版本。

### Added

- **Markdown 提示词库**：`prompts/` 目录下的 `base.md`、`modes/*.md`、`subagents/*.md` 与 `manifest.json` 成为权威内容源，修改文件即时生效。
- **三层提示词优先级**：设置页覆盖 > 本地 Markdown > 代码内置兜底，逐层回落，缺文件不会导致功能失效。
- **子代理 Copy-on-Write 覆盖层**：改名与新增一律写入 `prompts/custom/subagents/`，官方目录永不被修改；读取优先级为自定义优先。
- **子代理目录动态生成**：注入 `Flow` / `Plan Ultra` 的目录条目附带每个子代理实际生效的文件路径。
- **本地回环接口**：`GET /api/dsh-flow/prompts`、`POST /api/dsh-flow/prompts/update`、`PUT|DELETE /api/dsh-flow/subagents/:id`、`PUT|DELETE /api/dsh-flow/roster`，仅允许 `127.0.0.1` / `::1`。
- **提示词一键更新**：零依赖 `fetch` 拉取远端清单，逐文件 sha256 比对、原子写入、白名单与路径穿越防护。
- **镜像回退开关**：新增 `prompts.allowMirrorFallback`，主源不可达时可回退到 jsDelivr 镜像，并回报主源失败原因。
- **防降级保护**：比对远端与本地 `manifest.json` 的版本号与 `updatedAt`，远端更旧时整批跳过，避免镜像缓存滞后覆盖较新的本地文件。
- **设置页四 Tab**：`五大模式` / `提示词库` / `工作流与熔断` / `通知与联动`，卡片间距统一。
- **提示词库可视化编辑**：版本与清单展示、检查更新、更新源设置、三个子视图（底座契约 / 全局提示词 / 子代理与目录）、子代理新建与删除。
- **执行模式档位**：`behavior.flowAutonomy` 支持 `one-gate`（全托管）与 `step-by-step`（分阶段确认）。
- 新增 `/flow prompts list` 与 `/flow prompts update` 命令。

### Changed

- `modes.*.prompt` 与 `baseRules` 默认值改为空串，正文改由 Markdown 提供，配置仅作为覆盖槽位。
- 诊断日志开关由 `diagnostics.enabled` 迁入 `circuit.debugLog`，并支持环境变量 `DSH_FLOW_DEBUG=1` 临时开启。
- 设置页文案统一为产品术语，清理口语化表述，辅助说明压缩为单句。
- 官方子代理目录改名为「子代理目录」，并重算 `manifest.json`。

### Fixed

- 修复五大模式提示词输入框在无覆盖时显示空白的问题，改为直接展示本地 Markdown 正文。
- 修复 `custom/subagents/README.md` 被误判为目录覆盖、导致目录摘要被替换的问题。
- 修复设置页面板在声明前求值导致的重复声明与暂时性死区错误。

## [0.3.0] - 2026-11-24

以故障止损与跨端接管为核心的版本。

### Added

- **连续报错熔断**：按阈值累计失败次数，触发后暂停会话并保留上下文。
- **IM 远程接管**：手机端回复 `1` 重试、`2` 升级到诊断模型、`3` 解除暂停并下发新指令。
- **单次 Handoff**：熔断后绑定一次带 TTL 的指令转交，超时或使用后自动失效。
- **双通道通知**：IM 推送与 SMTP 邮箱归档并行，支持 Webhook 兜底。
- **事件分流策略**：按事件类型选择推送渠道组合。
- **通知自检命令**：`/flow notify-test` 当场回报 IM 与邮箱的成败原因。

### Changed

- 告警渲染与通知改为在同一批次内完成，避免重复告警。
- IM 入站文本会剥离来源包装后再解析数字指令。

### Fixed

- 修复同一事件触发两次告警的问题（结算与兜底定时器重复执行）。
- 修复 IM 入站指令因来源包装导致 `1` 无法匹配的问题。
- 修复远程转交读取了错误的会话字段，导致内联指令转交失败的问题。

## [0.2.0] - 2026-11-23

以方案锚点与门禁为核心的版本。

### Added

- **`.flow/spec.md` 方案锚点**：把用户确认过的方案写入稳定文件，并以「便利贴」形式注入摘要。
- **阶段门禁**：跨大阶段前需要显式确认，确认后才切换模式。
- **安全压缩**：阶段确认后自动压缩上下文，压缩后重新下发锚点与模式约束。
- 压缩与门禁相关命令：`/flow spec`、`/flow compact`。

### Changed

- 模式注入拆分为「固定底座 section」与「动态模式 context」，保证系统提示词前缀稳定。

## [0.1.0] - 2026-11-22

首个可用版本。

### Added

- **五大模式**：`Plan` / `Plan Ultra` / `Build` / `Review` / `Flow`，支持 `off` 关闭态。
- **分层提示词注入**：底座契约走固定 section，模式内容走运行时 context。
- **按模式绑定默认模型与权限档位**。
- **设置页**：模式胶囊切换、底层提示词编辑、模型与权限配置。

[Unreleased]: https://github.com/MeZenith/dsh-flow/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/MeZenith/dsh-flow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MeZenith/dsh-flow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MeZenith/dsh-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MeZenith/dsh-flow/releases/tag/v0.1.0
