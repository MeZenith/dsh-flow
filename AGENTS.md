# AGENTS.md — `dsh-flow` AI 编程代理开发规范

> 本文档面向 AI 编码代理与自动化贡献者（DSH `@deepseek-ai/dsh-agent-instructions` 会自动加载根目录 `AGENTS.md`）。深入设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)、[docs/DEVELOPING.md](./docs/DEVELOPING.md) 与 [SECURITY.md](./SECURITY.md)。

## 1. 运行契约与工程快照

- **形态**：DeepSeek Harness（DSH）纯 ESM 插件（`"type": "module"`），零构建打包器（UI 由零依赖脚本串联输出）。
- **引擎要求**：`Node.js >= 22.0.0`、`dsh >= 0.2.0 < 0.3.0`（在 `index.js` / `src/plugin.js` 启动检查，缺依赖直接 fail-safe）。
- **许可证**：`Apache-2.0`（与 [LICENSE](./LICENSE)、[package.json](./package.json) 保持一致，由静态检查强约束）。
- **可选依赖**：仅 `@larksuiteoapi/node-sdk` 在飞书启用时动态 `import()`；其余核心模块、内置 SMTP、QR SVG、HTTP 路由均零外部依赖。

## 2. 常用命令速查

> Windows PowerShell 5.1 下串联命令请用 `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`，不要直接使用 `&&`。

```bash
npm ci                     # 按 lockfile 安装依赖（可选依赖缺省时核心测试仍须全绿）
npm run build:client       # 修改 src/client/* 后重建根目录 client.js
npm run manifest:sync      # 修改 prompts/** 或升级版本后重算 prompts/manifest.json sha256
npm run check              # 静态检查：语法 + console.log + 空 catch + 协议/引擎 + client.js/manifest 同步
npm run test:coverage      # 全量 node:test 套件 + src/ 覆盖率门禁（Line >= 80%, Branch >= 60%, Funcs >= 75%）
```

## 3. 目录所有权与职责边界

| 路径 | 职责边界 | 修改注意事项 |
| --- | --- | --- |
| `index.js` | 插件唯一根入口 | 仅具名导出 `{ name, inject, Config, apply }`，**严禁 `export default`** |
| `src/plugin.js` | Cordis 服务装配与生命周期回收 | 动态服务/路由必须挂在 `scoped` 上，`agent/disposed` 全量回收 |
| `src/config/` | Schema 与常量 | 改动后同步 `src/client/` 表单项与 [test/unit/config-and-index.test.mjs](./test/unit/config-and-index.test.mjs) |
| `src/modes/` | 五模式投影、切换与安全压缩 | `off` 模式零提示词注入；投影折叠 `command/run` 与 `tool/result` |
| `src/workflow/` | 分级（S/M/L）、编号文档 `01–07`、QA 交接 | 所有文件写入统一走 `src/shared/fs-safe.js` |
| `src/gates/` | 门禁票据、防并发 TOCTOU 结算器、路由 | `inFlight` 锁与空闲压缩唤醒顺序不可破坏 |
| `src/resilience/` | 连续报错熔断器、活跃追踪、Team SSE | 长生命周期句柄与定时器必须在 `forget()` / `dispose()` 清理 |
| `src/notify/` | 零依赖内置 SMTP/STARTTLS、IM 与延迟调度器 | 定时提醒须重查桌面活跃度；兼容有/无可选 `nodemailer` |
| `src/prompts/` | 提示词仓库、Tag 更新器与 HTTP 回环 API | 默认源锁定发布 Tag；HTTP API 必须过 `connection.requestRejection` |
| `src/remote/` | 传输无关 `RemoteHub`（7 原语）与 `harness-bridge` | **严禁把飞书逻辑耦合进核心工作流、门禁或熔断器** |
| `src/remote/feishu/` | 飞书直连指挥官（客户端/路由器/卡片/流式输出） | Fail-Closed 白名单、3 秒内返回 ACK toast、凭证加密与脱敏 |
| `src/shared/` | `fs-safe`、`state-store`、`diag`、`message` | 原子写盘 + 最近存在祖先 `realpathSync` 防软链逃逸 |
| `src/client/` → `client.js` | 设置页前端源码 → 编译产物 | **禁止手改 `client.js`**，改完源码跑 `npm run build:client` |
| `prompts/` | 官方提示词模板与 `manifest.json` | **禁止手改 `manifest.json`**，改完模板跑 `npm run manifest:sync` |
| `scripts/` & `test/` | 校验/构建/覆盖率门禁与 `node:test` 测试集 | 测试用内存桩，严禁发真实网络请求 |

## 4. 不可违背的硬不变量（红线）

1. **根导出契约**：[index.js](./index.js) 只保留具名导出（`name`, `inject`, `Config`, `apply`），绝不添加 `export default`。
2. **禁止手改派生文件**：[client.js](./client.js) 由 `src/client/*` 构建，[prompts/manifest.json](./prompts/manifest.json) 由 `prompts/**` 生成；改动上游必须执行 `npm run build:client` / `npm run manifest:sync` 并一起提交。
3. **HTTP 路由必须接入 DSH 准入检查**：所有 `/api/dsh-flow/*` 路由必须在 `scoped.inject(['webServer', 'connection'], ...)` 中注册；`guard()` 首步必须调用 `connection.requestRejection(request)`，缺失 `connection` 或被拒绝时返回空响应体 `401`/`403` + `cache-control: no-store`；前端请求必须携带 `credentials: 'same-origin'`。
4. **飞书远程控制默认关门（Fail-Closed）**：`allowedOpenIds` 为空或全空白时除 `/id`、`/whoami` 外一律拒绝；高危工具审批遵循三档策略（`allow` / `pin` + `timingSafeEqual` 校验 / `desktop-only`），且推送飞书卡片前必须经脱敏处理（绝不回显明文 PIN、Token、AppSecret）。
5. **受控文件边界**：工作区内文档写盘只允许通过 [src/shared/fs-safe.js](./src/shared/fs-safe.js) 的 `assertInsideRoot()`、`normalizeRelDir()`、`writeAtomic()` 完成，严禁绕过软链与路径穿越检查。
6. **提示词供应链安全**：[src/prompts/updater.js](./src/prompts/updater.js) 默认更新源保持绑定发布 Tag（`v${PLUGIN_VERSION}`），禁止切回可变 `main` 分支；所有远端清单须通过白名单、流式体积上限、SHA-256 及 `minPluginVersion`/`maxPluginVersion` 校验。
7. **生命周期无泄漏**：`ctx` 作用域内挂载的所有监听器、定时器、`AbortController` 必须在 `agent/disposed` 与卸载 `dispose()` 中清理；生产侧不阻塞退出的后台定时器保留 `.unref()`（若在 Node 22 `node:test` 下等待 `.unref()` 定时器，测试内需持有短周期 ref keepalive）。

## 5. 代码风格与卫生红线

- **编码与模块**：UTF-8 无 BOM；所有相对导入必须写明 `.js` / `.mjs` 扩展名。
- **日志与错误**：`src/` 内严禁残留 `console.log(`，诊断日志走 `logger` 或 `diag`。
- **空 `catch` 拦截**：`scripts/check-code.mjs` 禁止 `src/` 出现无说明空 `catch {}`；确需静默降级的清理或尽力路径，必须在 catch 体内标明 `/* dispose-path: ... */` 或 `/* best-effort: ... */`。
- **变更内聚**：只修改与当前任务直接相关的模块与测试，不顺手重写无关文件。

## 6. 测试、Git 与发布纪律

- **测试闭环**：所有修复与新特性必须在 `test/unit/` 或 `test/integration/` 补充可复用自动化用例（使用内存 Fake 对象，不依赖本机真实环境、真实飞书凭据或外网）。
- **提交规范**：采用小步原子化 Conventional Commits（`feat(...)` / `fix(...)` / `refactor(...)` / `test(...)` / `docs(...)` / `chore(...)`），每次提交前必过 `npm run check && npm run test:coverage`。
- **禁止污染仓库**：严禁提交 `.flow/` 私有状态/草稿文档、测试凭证、App Secret 或任何 Token；未获仓库维护者明确指令前，不擅自修改 `package.json` 版本号或打发布 Tag。
- **进一步阅读**：架构与数据流见 [ARCHITECTURE.md](./ARCHITECTURE.md)，本地调试与扩展配方见 [docs/DEVELOPING.md](./docs/DEVELOPING.md)，安全模型见 [SECURITY.md](./SECURITY.md)，决策背景见 [docs/adr/](./docs/adr/)，协作清单见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
