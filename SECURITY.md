# Security Policy / 安全策略

## Supported Versions / 支持版本

| Version | Supported | Notes |
| --- | --- | --- |
| `0.6.1+` | ✅ Yes | Current hardened baseline (Apache-2.0, CI coverage gate, 3-tier high-risk approvals) |
| `0.6.0` | ⚠️ Security fixes backported via upgrade | Upgrade to `0.6.1+` strongly recommended |
| `< 0.6.0` | ❌ No | End of support |

## Reporting a Vulnerability / 漏洞上报

如果你发现安全隐患（权限绕过、凭据泄露、路径穿越、远程控制注入等），请**不要直接在公开 Issue 贴出可利用细节**，建议通过以下方式私密反馈：

1. 使用 GitHub 仓库的 **Security Advisories**（[`Security → Advisories → New draft security advisory`](https://github.com/MeZenith/dsh-flow/security/advisories/new)）；
2. 如无法访问 Advisories，可在 Issue 区简短留言请求私密联系方式，维护者将在 **72 小时内** 响应并给出修复或缓解时间表。

---

## Trust Model & Security Architecture / 安全信任模型

`dsh-flow` 将 **“本地 AI 编码代理”** 与 **“飞书/Lark 远程控制通道”** 解耦并通过多层代码级护栏约束边界：

1. **严格 Fail-Closed 白名单（`src/remote/feishu/router.js`）**
   - 当 `feishu.allowedOpenIds` 为空或仅空白时，**拒绝一切远程指令、模式切换、门禁结算与卡片按钮回调**，仅放行 `/id` 与 `/whoami` 用于查询本人 `open_id`；
   - **信任等价关系**：被加入 `allowedOpenIds` 的飞书账号等价于对本机当前运行中 DSH 会话的远程派活权限，请务必仅填入本人或严格受信任成员的 `open_id`。
2. **三档高危工具审批护栏（`src/remote/feishu/cards.js` & `index.js`）**
   - 审批拦截器会识别 Shell / 命令执行（`bash`/`shell`/`powershell`/`run_command` 等）与破坏性命令（`rm -rf`、`git push --force`、`git reset --hard` 等）；
   - 设置页「飞书远程 → 访问控制」提供三档策略：
     - `allow`（飞书直批，默认）：高危卡片切换红色告警，可快捷批准；
     - `pin`（PIN 二次确认）：飞书卡片隐藏直接允许按钮，必须通过 `/approve <approvalId> <PIN>` + `timingSafeEqual` 校验（且绝不在消息中回显明文 PIN）；
     - `desktop-only`（仅桌面确认）：高危操作在飞书侧仅能触发通知或点击「❌ 拒绝」，即使伪造回调也无法从远程放行，必须在桌面端确认。
3. **审批脱敏与凭据降级告警**
   - 发送到飞书的工具参数先经 `redactSensitiveValue` / `redactSensitiveText` 脱敏（过滤 Token、Authorization、私钥、连接串密码等），并用动态长度围栏包裹；
   - 飞书 `App Secret` 优先写入宿主加密凭据库（`ctx.credentials`），若宿主不支持并回退至明文配置或进程内存，启动日志与设置页「访问控制」面板会显示明确告警。
4. **提示词在线更新供应链护栏（`src/prompts/updater.js`）**
   - 官方默认更新源固定绑定对应发布 Tag（`v<version>`），不再默认跟踪可变的 `main` 分支；
   - 拉取清单时严格校验路径白名单（拒绝 `..` 与写入 `custom/`）、单文件流式 `512KB` 硬上限、`sha256` 一致性，并强制执行 `minPluginVersion` / `maxPluginVersion` 版本区间护栏，拒绝跨代拉取不兼容提示词。
5. **宿主准入与本地回环六道防线（`src/prompts/api.js` & `src/plugin.js`）**
   - HTTP 控制路由在 `scoped.inject(['webServer', 'connection'])` 下挂载：宿主不提供 `connection` 准入服务时不挂载任何 HTTP 路由；
   - 所有 `/api/dsh-flow/*` 请求优先经由 DSH 宿主 `ctx.connection.requestRejection(request)` 校验（未通过则返回 `401`/`403` 且空响应体、`cache-control: no-store`），在本地回环模式下再叠加回环 IP → `Host` 白名单 → `Origin` 同源 → 方法白名单（`405`）→ JSON `Content-Type`（`415`）与 `1MB` 体积上限（`413`），前端 `client.js` 同步携带 `credentials: 'same-origin'`。
6. **文件系统安全边界（`src/shared/fs-safe.js`）**
   - 文档写入与锚点持久化使用最近存在祖先 `realpathSync` 校验阻断符号链接逃逸，并采用临时文件原子替换落盘。

---

## Third-Party Dependency Disclosure / 第三方依赖与传递风险说明

- **核心与内置依赖**：工作流核心、配置、门禁、熔断器、HTTP API 与内置 SMTP 客户端均为 **零第三方运行时依赖**；`vendor/` 下仅随附 `schemastery@3.18.5` 与 `cosmokit@1.8.6`（MIT，见 [THIRD_PARTY_NOTES.md](./THIRD_PARTY_NOTES.md)）。
- **飞书 SDK 按需懒加载（`@larksuiteoapi/node-sdk ^1.73.0`）**：
  - 仅在开启并连接飞书远程功能时通过动态 `import()` 载入；未开启飞书功能的桌面用户运行时完全不加载该 SDK。
- **已知传递依赖风险评估（`axios` / `qs`）**：
  - `@larksuiteoapi/node-sdk` 的传递依赖中包含上游 `axios` 与 `qs`；在某些旧版本区间中存在针对通用代理/参数解析的 CVE 通告；
  - `dsh-flow` 仅在飞书入站/出站网关场景中向固定官方端点（`open.feishu.cn` / `open.larksuite.com` / `accounts.*`）发起请求，不将用户可控的任意 URL 直接透传给 `axios`；
  - 若需要严格消除 `npm audit` 告警，可在下游工程 `package.json` 中使用 `overrides` 锁定传递依赖版本，同时 CI 中已配置非阻塞 `npm audit --omit=dev` 报告留档以便持续追踪上游 SDK 更新。
