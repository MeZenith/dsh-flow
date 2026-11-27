# Changelog

本项目的所有重要变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

## [0.6.0] - 2026-11-27

全面架构重构 + **独立直连飞书指挥官（流式回复 / 原生 `/` 菜单 / 竞争式工具审批）** + **Apple 极简设置台** + 全部 P0/P1 痛点与缺陷清零。

### Added

- **独立直连飞书指挥官（`src/remote/feishu/`）**：内置 `@larksuiteoapi/node-sdk` 惰性集成，无需安装 `dsh-im`、无需公网服务器、无需 Tailscale：
  - **自定义机器人名称与头像扫码建应用 + 零依赖高清矢量二维码（`qr-svg.js`）**：支持在扫码建应用前自定义名称、简介、内置公开头像库或自定义 `https://` 头像 URL，并内置标准 ISO/IEC 18004 SVG 二维码与对已有应用的「扫码一键补权」；
  - **实时流式回复卡片（`reply-stream.js`）**：挂接 DSH 原生 `agent/inbox/claimed`、`agent/assistant-stream`、`session/event`，优先走飞书 CardKit 原生流式打字机（自动降级 `message.patch`），过程展示调用中的工具与 `[⏹ 停止]` 按钮，答完原地定稿并附底部快捷操作栏；超长回答自动分片；
  - **开箱欢迎引导卡片 + 飞书原生 `/` 快捷指令菜单（`slash-commands.js`） + 图形化 `/mode` 模式切换卡片**：连接成功即发 3 秒上手指南卡片，自动注册 6 条飞书原生 `/` 菜单（`/m`、`/mode`、`/p`、`/stop`、`/help`、`/id`）；
  - **多项目随时指挥**：飞书发 `/m` 弹出项目指挥台卡片点选切换；支持 `@项目名 指令` 直发、`/new`、`/p`、`/stop`、`/id` 与群聊话题隔离；
  - **三大真互动审批卡片（含竞争式 DSH 工具审批）**：阶段门禁、连续报错熔断与 DSH 原生 `approval/request` 工具执行审批均推送可点击卡片，手机或桌面任意一端先决策即刻生效并原地同步置灰防误点；
  - **防打扰开关与文档直传**：桌面日常对话默认不刷手机，新增 `feishu.syncDesktopReplies` 开关按需同步，`.flow/docs/*.md` 与 HTML 预览直接作为文件发到飞书。
- **Apple 极简风格设置台（`src/client/`）**：重构为 4 个清爽分页（模式 / 工作流 / 飞书远程 / 提示词），全面引入分组 inset 列表、分段控件、滑动开关、步进器与折叠高级区；飞书页采用三态配对引导卡片。
- **传输无关远程控制中枢（`src/remote/hub.js` & `harness-bridge.js`）**：沉淀 7 个远程原语 + 统一事件总线，为后续 Mobile PWA / Quick Tunnel 与端到端加密通道预留零耦合接口。
- **模块化源码分层与自动化测试**：
  - 根目录下 29 个扁平 `.js` 模块重构为清晰的 `src/{shared,config,modes,workflow,prompts,gates,resilience,notify,remote,tools,commands}` 分层架构；
  - `client.js` 拆分为 `src/client/*` 并配零依赖构建脚本 `scripts/build-client.mjs`；
  - 新增 `scripts/sync-manifest.mjs` 自动同步并校验 `prompts/manifest.json` 哈希；
  - 引入 25 项 `node:test` 自动化回归测试套件（`npm test`）。
- **`.flow/docs/` 直接落盘策略（D-01）**：`docs.writePolicy` 默认改为 `'auto'`（仍可在设置页切回 `'ask'`），彻底消除写文档二次审批内耗。
- **新增命令与本地控制端点**：`/flow feishu status|connect|disconnect|test`、`/flow help`，以及 `/api/dsh-flow/notify/test` 与 `/api/dsh-flow/feishu/*`（含 `/welcome`、`/slash/sync`、`/onboard/upgrade`）。

### Fixed

- **飞书 SDK 与 DSH 凭据真实联调修复**：修复 `registerApp` 传入数字枚举 `lark.Domain.Feishu` 导致 `certificate has expired`、修正 `appPreset.desc` 与 `addons.callbacks.items`（`card.action.trigger`）、提取 `created.user_info.open_id`、`NO_PROXY` 同时豁免 `open.*` 与 `accounts.*`，以及对齐 DSH `ctx.credentials` 的 POSIX 凭据名规范（`DSH_FLOW_FEISHU_APP_SECRET`）与 `resolve/set/unset` 接口。

- **B-01**：为 `src/prompts/store.js` 补齐 `info()`，彻底修复 `/flow prompts list` 崩溃。
- **B-02**：重构 `src/client/` 组件边界，将所有 React Hooks 置于条件返回之前，消除 React Error #310。
- **B-03**：门禁批准切模式时通过执行 `/flow <nextMode>` 写入 `command/run`，修复 `flowMode` 投影与顶部模式芯片不同步。
- **B-04**：`attachAgentModeContext` 正确传入 `agent` 与 `stateStore`，修复会话级 S/M/L 等级不反映到提示词块的问题。
- **B-05**：桌面会话仅有 1 张待决门禁时允许直接回复裸 `1/2/3/0`（支持多行意见），兑现界面承诺，并在同会话 `reject` 后用 `followup` 正确唤醒回合。
- **B-06**：将 `tickets.supersede()` 移至全部文档/派单校验通过之后，修复参数被拒时误作废旧票的缺陷。
- **B-07**：`kind:'acceptance'` 显式指定 `docIds:['06']` 时仅要求 `06-blackbox-qa.md`，不再强求尚未生成的 `07`。
- **B-08**：修复内置 `smtp-client.js` 丢失多行 `250-` EHLO 能力（导致 STARTTLS 误失败）、`AUTH PLAIN/LOGIN` 回退错误、头部 CRLF 注入与连接超时缺失。
- **B-09**：修复 `team-sse.js` 删除非终态成员导致首个成员结束即误报全队完成、漏检 `error.cause.code`、`CRLF` 分帧与 `Last-Event-ID` 断点续传。
- **B-10**：修复熔断器正则误吞 `"100个文件"` / `"3个按钮"`、桌面锁定态 `3 <指令>` 未剥离前缀、以及解锁后延迟弹出过期熔断提醒（保存并取消通知句柄）。
- **B-11**：统一 `fs-safe.js` 最近存在祖先 `realpathSync` 符号链接防护与并发安全原子写，覆盖 `spec-anchor`、`docs` 与 `gates.json`。
- **B-12**：修复本地 API 畸形百分号编码 `URIError`、HEAD 响应体、校验失败错返 500 及写响应泄露绝对路径。
- **M-01 ~ M-12**：修复设置页保存/新建失焦竞态、恢复默认/更新不刷新草稿、`promptSets` 按下标展开错位、SMTP/飞书密码框缺占位符与清空覆盖风险、缺失的设置项控件、无效 `bot.list` RPC、`pathsOverlap('src/*.js','src/*.ts')` 误报、`/flow gate answer` 大小写与唤醒、单票 `release`、开局自定义升降级解析、`agent/disposed` 内存清理等。

### Changed

- `.gitignore` 改为标准黑名单模式，`package.json.files` 改为目录级声明，不再漏提交/漏打包新模块。
- 提示词 `prompts/base.md`、`prompts/modes/plan.md`、`prompts/modes/flow.md` 与 `prompts/subagents/README.md` 同步至 v0.6.0 规范并更新 `prompts/manifest.json`。

## [0.5.1] - 2026-11-26

安全补丁：修掉本地接口的跨站注入面，并把用户私有提示词迁出插件包目录。

### Security

- **本地接口五道防线**（`prompt-api.js`）：回环对端 → `Host` 白名单（挡 DNS Rebinding）→ `Origin` 同源校验 → 方法白名单（`405` + `Allow`）→ `PUT` 强制 `application/json`（`415`）。跨站表单/脚本再也打不进来，本地 curl 与同源页面不受影响。
- **路径脱敏**：`GET /api/dsh-flow/prompts` 不再返回盘符与完整家目录前缀，`root` / `officialDir` / `customDir` 与每条 `path` / `resolvedPath` 统一收敛为 `~/…` 或 `…/尾两级`。

### Fixed

- **私有提示词不再随插件升级丢失**：`custom/` 从 `<plugin>/prompts/custom` 迁到 `$DSH_PROFILE_DIR/data/dsh-flow/prompts/custom`（回落 `~/.dsh-flow/prompts/custom`，可用 `prompts.customDir` 覆写）。启动时一次性无损迁移：目标已有同名文件不覆盖，旧文件不删除。
- **镜像回退透明化**：回退到 jsDelivr 时，回执与日志都明确写出"已切换镜像 <域名>"，不再只是一句"主源不可达"。
- **team 监听静默退避**：未安装 / 未运行 `dsh-team-control`（连接被拒）时起步退避 30s、只提示一次，不再高频重连刷日志。

### Changed

- 安装与升级文档统一为 **GitHub 仓库分发**：优先 `dsh plugin update`，仅在拉不到最新提交或 link 安装报 `already-installed` 时 `remove + add`；不再出现 npm 包安装引导。
- `docs/DETAIL.md` 补齐 HTTP 契约（`403` / `405` / `415`）、路径脱敏说明与私有目录位置。

### Docs

- 清理 `README.md` 遗留的两处合并冲突标记。
- README（中英）与 `docs/DETAIL.md` 增加「升级与更新」小节与数据安全说明。

## [0.5.0] - 2026-11-26

从"提示词流程"升级为**工程级 SOP 编排引擎**：分级、编号文档、可遥控门禁、派单白名单与双阶验收全部落到代码与自检里。

### Added

- **S / M / L 复杂度分级**：`flow-level.js` 持有唯一矩阵（S 不产编号文档但强制 1 轮交互确认；M 交 01/03/05/06/07；L 交全套 01–07），路由工具与门禁都读它。
- **`.flow/docs/` 七份编号文档与 SSOT**：`flow-docs.js` + 7 份模板（`prompts/docs/*`），`05-dev-spec.md` 为唯一法典；`flow_docs_init` / `flow_docs_check` / `flow_docs_write` 三个工具负责骨架、校验与受控写入。
- **桌面 / IM 统一遥控门禁**：`gate-tickets.js` + `gate-router.js` + `gate-settle.js`，非阻塞建票即返回，桌面回 `1/2/3`、IM 回 `#票据号 1 意见` 都能结算；超时只登记票据并催办一次，绝不视为同意。
- **R7 草稿先行**：申请写文档授权必须带 `draftContent`，草稿只进内存与邮件 `.draft.md` 附件、不落盘；IM 回 `0` 时未落盘会自动回退读草稿。
- **UI 设计 Skill 探测**：`flow-ui-skill.js` + `flow_ui_skill` 工具，识别 `taste` / `impeccable` 并给分流建议，未装时给纯对话三选一（不弹门禁）。
- **派单声明与白名单**：`dispatch-declare.js` + `flow_dispatch_declare`，真实探测派单工具 / 只读能力 / `agentPreset` 列表，校验共享入口保护与路径 glob 重叠，输出固定 `[调度声明]` 一行；M/L 进入施工未声明即拦截。
- **黑盒 → 白盒双阶验收**：`qa-handoff.js` + `flow_qa_handoff`，06 症状 → 白盒简报 → 06+07 修复包，返工 1–3 轮放行、第 4 轮硬拦；qa 通知正文置顶 🔴 阻塞项与人工点验清单，附件带两份报告。
- **设置页新增「文档与门禁」卡片**（第 3 个 Tab 内）：默认等级、文档目录、门禁超时、IM 摘要字数、UI Skill 探测开关与下载红绿灯只读展示，中英文案齐备。

### Changed

- `base.md` / `BASE_RULES` 扩到 **12 条**：新增报错分流、下载红绿灯、非阻塞门禁、反脑补、不可逆操作红线、反测试造假与编码卫生。
- 6 份模式提示词重写：Flow 全程留在 Flow（`nextMode:'flow'`），内联需求/落盘/施工/验收细则；Plan 补 5 维追问与正反示范；Review 拆成 06/07 两套格式。
- 10 份子代理提示词统一以【子代理硬隔离尾注】收尾（禁调 `flow_*`、禁套娃、禁直接问用户）。
- `types`：`GATE_NEXT_MODES` 增加 `flow`；新增 `download` / `ui` / `docs` / `gate` 配置块与 `notify.qa`。
- 提示词清单升级到 `manifest.json@0.5.0`（24 个文件，含 7 份文档模板），与 `prompt-updater` 白名单交叉断言。

### Fixed

- 修复 `prompt-bridge.js` 的 `DOCS_CONTEXT` TDZ 导入崩溃（新增真实 `import()` 冒烟用例兜底）。
- 修复"IM 迟到答复只改票据状态、不落授权/不切模式"的连体问题，副作用统一收敛到结算器。
- 修复 `.gitignore` 白名单模式下新模块被静默忽略的问题。

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

[Unreleased]: https://github.com/MeZenith/dsh-flow/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/MeZenith/dsh-flow/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/MeZenith/dsh-flow/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/MeZenith/dsh-flow/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MeZenith/dsh-flow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MeZenith/dsh-flow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MeZenith/dsh-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MeZenith/dsh-flow/releases/tag/v0.1.0
