# Flow 工作流与提示词管家 — DSH 能力核实报告

> 本文是编码前的能力基线。所有结论均来自**运行中安装的真实源码与运行时探测**，未使用任何推测性 API。
> 文中出现的 `packages/...` 路径均相对 DSH 源码检出根 `D:\deepseek-harness\`；`node_modules/...` 路径相对 profile 目录 `C:\Users\Admin\.dsh\profiles\web\`。

---

## 0. 核实目标与环境

| 项 | 值 |
|---|---|
| DSH CLI 版本 | `@deepseek-ai/dsh` **0.2.2-rc.4**（`apps/cli/package.json`） |
| 运行形态 | 源码启动（`DSH_INSTALL_DIR=D:\deepseek-harness\apps\cli`） |
| Profile | `web`（`C:\Users\Admin\.dsh\profiles\web`） |
| 生态侧已安装 | `dsh-team-control` **0.3.0** / `dsh-team-control-cli` / `dsh-team-control-ui`；`@xmanrui/dsh-im` **5.10.0** |
| 核实方法 | ① `cordis_inspect_query`（host `Service` / `Event` / `Config` / `Tool` 目录）② 逐文件读源码与 `.d.ts` ③ 对 sidecar 做真实 HTTP 探测 |

**运行态实测**：`127.0.0.1:4317` 处于监听（PID 42496，node），`GET /api/health` → `{"ok":true,"asOf":"2026-11-25T06:19:50.443Z","pid":42496}`，`GET /api/status` → `{"version":0,"teams":[],"members":[],"staleMembers":[],"degraded":false}`。

**结论口径**

- `原生直接可用` = 有公开 API / Hook，且语义与限制可精确描述。
- `有平替方案` = 缺少一步到位的 API，但可用框架内既有机制组合达成，代价明确。
- `不支持，需绕过` = 宿主没有该信号或该能力，必须自建。

---

## 1. 结论总表

| 需求模块 | 支持状态 | 对应真实 API / Hook / 机制 | 限制与踩坑预警 |
|---|---|---|---|
| **1. 三档权限代码切换** | **原生直接可用** | `ctx.permissionPresets.set(session, name)`；底层 `setSandboxMode(session, mode)`、`setApprovalPolicy(session, policy)`；`ctx.approval.setPolicy(agent, policy)`；读回 `ctx.sandboxPolicy.resolve({session})`、`ctx.permissionPresets.current(session)` | 写的是**会话日志**（`permission/preset` + `sandbox/mode` + `approval/policy`），可重放、可审计；不是内存开关 |
| **1b. 切换是否即时** | **原生直接可用（当前会话即时）** | `setSandboxMode` 注释原文 “Takes effect on the session's next confined call (bash or fs)”；`sandboxPolicy.resolve()` 每次调用都读该 fold | **不需要新建会话**。冷会话要先 `sessionController.resolveAgent()` 才能 `append`。默认预设表只有 `workspace-write` / `danger-full-access`，`read-only` 必须自己写进 `Config.presets`；`custom` / `auto` 是保留名 |
| **2. 读可用模型列表** | **原生直接可用** | `ctx.llm.listProviders(): LlmProviderInfo[]`；`ctx.llm.listModels(provider)`；`ctx.llm.resolveModelInfo(provider, model)`；聚合视图 `sessionController.modelCatalog(): ModelCatalog`（`groups` / `default` / `failures`） | 下拉框直接用 `modelCatalog`；`failures` 要展示（单个 provider 挂掉不该让整表空白） |
| **3. 会话级模型动态切换** | **原生直接可用** | `agent.model.select({provider, model, reasoningEffort?})` → 追加 log-only 的 `model/selection`；Remote 版 `sessionController.selectModel({sessionId, …})` | 只影响**下一步**（`agent/pre-step` 的 `modelSelection` 是已捕获值，`PreStepDecision` 无模型字段）。省略 `reasoningEffort` = 走适配器默认，不继承旧值。调用方自负能力校验。`agentDefaultModel.saveSelection()` 是**部署默认**，勿用于会话级切换 |
| **4. 系统提示词注入 Hook** | **原生直接可用** | `ctx.systemPrompt.section({name, order, text, interpolate?, complete?})`；`.context({name, order, text, required?})`；`.variable(name, provider)` → `{{name}}`；`.tools(provider)` | 标准做法是注册 section / context，**不是**监听 `system-prompt/assemble`。官方 practices 明确禁止用它加文本/工具；且 `complete` section 会在 waterfall 之后被还原 |
| **5. 精确拼接顺序 + Prefix Caching** | **原生直接可用（须按真规则排，不是“易变放底部”）** | `order` 为任意有限数，升序拼接、同序按名字 code-unit 排；`getSectionOrder()` 提供规范槽位（`HARNESS_IDENTITY -1000` / `DEPLOYMENT_PERSONA_PREFIX 0` / `PLAN_POLICY 500` / … / `DEPLOYMENT_PERSONA_SUFFIX 10200`）；缓存判定在 `SystemPromptProjection.project()` | 系统提示词是**一个字符串**落在 surface 节点 0。`in-history` 路由下变更后的非空文本**追加为新节点**（前缀仍命中）；否则**替换节点 0 → 整段前缀作废**。`startsSeries` 还会被“surface 内容代际变化”和“中途换工具集”强制打开。→ 不变的底座 + 勾选的全局提示词走 `section()`；随模式变化的内容走 `context()`（尾部 `<system-reminder>` user 消息） |
| **6. 设置页多套提示词 + 生效范围复选框** | **有平替方案** | Host 存储/校验原生：`static Config = z.object({…})`；`ctx.settings.describe()` 返回 `{ns, schema, value, revision, base, user}`；写入 `ctx.get('configEditor').edit(ctx.fiber.entry, …)` | **官方没有自动渲染插件表单的客户端**（`packages/settings/settings/README.md:39` 原文：`autoGenerate … for clients that build pages from the schema; no shipped client does so yet`）。对象数组必须走 `mutate(SettingsPathOpView[])`；`set(field, value)` 只接受标量字段 |
| **6b. 自定义设置页 UI** | **原生直接可用（需自写 Client 半）** | `ctx.configForms.get(NS)` → `ConfigForm<T>{ getSnapshot, subscribe, set, unset, mutate }`；`ctx.configForms.whileServed([NS], cb)`；`ctx.slots.inject('plugins.item', () => ctx.slots.register({ name:'plugins.item', id, order, label, locale, inject }, Component))` | 参照 `packages/client/ui-settings-shell/src/client/index.ts`。**不要** `require` 任何 `@deepseek-ai/dsh-client-*` 模块（只允许作 `dsh.client.inject` 排序项），控件自己写、只引 `--dsw-alias-*` token |
| **7. 代码主动触发 compact** | **原生直接可用** | `ctx.compaction.compactNow(agent, signal)`；`compactIfNeeded(agent, 'pressure' \| 'context-overflow', signal)`；`compactRegion(start, end, agent, signal?)` | 需 `ManualCompactAgentContext`（`Agent` 天然满足）；**必须空闲**，否则 `ManualCompactionError('busy')`；错误码分 `busy / cancelled / changed / summary / commit / persistence`；返回 `null` = 无安全区间 |
| **8. 压缩后自动重挂 `.flow/spec.md`** | **原生直接可用（框架自带该语义）** | `ctx.systemPrompt.context({ name:'flow:spec', order:<约 300>, required:true, text: () => readSpec() })` + `refreshContext()` | 机制真实存在：保留快照被 replacement 事件覆盖后置 `null`，下一步自动发**新快照**，文案自带“取代此前版本、含摘要中的旧值”。`required:true` 还能扛 `suppressRuntimeContext`。**坑**：内容每步都进请求 → 只放路径 + 摘要，全文交给工具读 |
| **9. 原生交互弹窗（4 选 1 / 阶段确认）** | **原生直接可用** | `ctx.userQuestions.ask({ questions, agent?, signal? })` → `AskUserQuestionAnswer`；带超时 `askTimed(request & {agent}, callId, timeoutMs)`；答案侧 `ctx.userQuestions.answer / attachWait` | 选项为 `options:[{label, description?}]` 四项 + `multiSelect:false`；“确认方案”用 `intent:{ kind:'plan-review', approve }`。**硬约束**：`assertLiveRoot` 对 `origin==='subagent'` 抛 `DELEGATED_CALLER` —— 子代理不能提问，必须父会话发问 |
| **10. 是否被 dsh-im 自动透传** | **原生直接可用（有前提）** | 转发白名单 `API_REMOTE_FORWARDED_EVENTS` 含 `{ event:'user-questions/request', mode:'waterfall' }` 与 `{ event:'approval/request' }`；dsh-im 5.10.0 将 `question/requested` 映射为 `kind:'question'` | 前提很硬：README 明写“**Web 或其他 Host 任务发起时，需要该 Session 恰好绑定一个已开启双向同步的私聊**”。未绑定只留在 Web。Web 与机器人可同时应答，先提交者生效 |
| **11. 检测 dsh-team-control 是否安装/运行** | **原生直接可用（探测）/ 有平替（调用）** | 安装态：`ctx.pluginManager.listBundles()` / `listPlugins()`（`fiberPhase` 判活）；运行态：`fetch(baseUrl + '/api/health')` | 该插件只声明 `export const name='dsh-team'`、`inject=['tools']`，**没有 `ctx.provide()`** → 无法进程内直调其服务。集成面只有两处：模型工具 `dsh_team_*`，以及 sidecar HTTP。配置源：`config.baseUrl` → `DSH_TEAM_URL` → 默认 `http://127.0.0.1:4317` |
| **12. 网络沙箱 / 127.0.0.1 REST + SSE** | **原生直接可用** | `ctx.sandbox.confine(argv, policy)` **只包进程 argv**，`SandboxPolicy` 是文件效应策略，不拦 Host 自身网络；Host 自身用 undici 发请求；`LOOPBACK_NO_PROXY = ['localhost','127.0.0.1','::1','[::1]']` 强制绕过代理 | sidecar SSE 为 `GET /api/events?team=&member=&lastEventId=`，`text/event-stream`，15s `: ping` 心跳，`Last-Event-ID` 断线重放（≤5000 条），帧型 `lease.warn / scope.request / decision / message.delivered / member.status / step.append`；**无 token 鉴权**（仅监听回环）。Node 原生 `fetch` 不支持 SSE 增量读 → 用 `http.request` 或 undici 手动读流 |
| **13. 监听每次工具调用结果/报错** | **原生直接可用** | `ctx.on('tools/result', (exec, result) => …)`（emit，冻结终态）；`'tools/pre-execute'`（allow/deny/cancel/ask）；`'tools/post-execute'`（accept/replace/block）；`ctx.tools.guard()`（单调否决）；`'agent/error'`；`session/event` 的 `tool/result.error{ name, code }` | 观察用 `tools/result`；改写才用 `post-execute`。`agent/request-error` 返回类型只有 `{ kind:'retry' } \| undefined`，**不能**在此中止 |
| **14. 代码级强制 Abort** | **原生直接可用** | `agent.cancel({ kind:'hook', reason:'flow:circuit' }, { keepInbox: true })`；温和版：`'agent/pre-step'` 返回 `{ kind:'reject' }`（→ `turn/end{kind:'blocked'}`）；跨代理 `ctx.subagents.interrupt(id, authority)`；`sessionController.cancel({ sessionId })` | `cancel` 立即中止当前回合与在飞工具调用，回合以 `aborted` + 该 cause 收尾；`reject` 不产生模型调用。计数状态不要写 session log |
| **15. 向前端推送弹窗/通知** | **有平替方案** | 三条真通道：① 会话投影 `ctx.sessionProjections.register({ key, wire:{ viewSchema, view } })` → Client 订阅快照（**无需 codegen**）；② 自有 Typert Remote `@Remote({ mode:'stream' })`（**需构建期 generator**）；③ 直接 `ctx.userQuestions.ask()` 弹原生卡片 | **不存在** “Host 直接 toast” 的 API；`ctx.actionCards` 是模型驱动的 `propose_action` 卡片（且由 `packages/experimental/action-cards` 提供），插件不能凭空弹。自绘通知需自己注册 `shell.overlay` 类 slot |
| **16. nodemailer / SMTP** | **原生直接可用** | Host 插件即 profile 的 ESM 包，`install_bundle` 用 pnpm 安装依赖；`nodemailer` 已物理存在于 profile `node_modules`（dsh-im 的依赖之一） | 应自行声明为 `dependencies` 让安装器装，不要依赖“碰巧被别人的依赖带进来”。发信属长耗时 → 放进 `agent.runMaintenance()` 或 `ctx.timer` 回调，勿阻塞 `tools/result` 的同步派发 |
| **17. 桌面端活跃/响应状态** | **不支持，需绕过** | Host 侧只有三个**间接**信号：`ctx.typertGateway.hasLiveClient()`、`'api-session/activity'`、`sessionController.state().pendingInput` | **没有 focus / visibility / lastSeen 事件**。网关 `heartbeat` 只是 WebSocket 传输层存活（两次丢心跳即断开），不等于用户在看。要实现“120 秒无操作”必须由 Client 半监听 `visibilitychange` / `focus` / `pointerdown` 并回报时间戳 |

---

## 2. 五条关键技术真相

### 2.1 权限切换 = 写会话日志，不是改内存开关

`permissionPresets.set(session, name)` 的实现顺序（`packages/interaction/permission-presets/src/index.ts:398`、`:403`）：

1. 若选中预设与当前派生值不同 → `session.append('permission/preset', { preset })`；
2. 逐个比对旋钮，变化者分别写入：`setSandboxMode(session, spec.sandbox)` 与 `setApprovalPolicy(session, spec.approval)`。

`setSandboxMode` 的唯一实现只有一行 `session.append('sandbox/mode', { mode })`（`packages/sandbox/sandbox-policy/src/session-mode.ts:53`），其模块注释给出语义：

> `effective = projection state ?? the deployment default` —— 覆盖通过重放存活，两个会话不可能看到彼此的档位，也没有外部配置存储。

因此：**当前会话即时生效**，受限调用（bash 或 fs）拿到的就是新档位；`fork` 会带着该 fold 一起走。

预设表本身来自插件配置（`packages/interaction/permission-presets/src/index.ts:176-193`），默认只有两项：

```yaml
workspace-write:   { sandbox: workspace-write,   approval: ask   }
danger-full-access:{ sandbox: danger-full-access, approval: never }
```

要用“只读”档，必须在插件行配置里补一条，例如 `read-only: { sandbox: read-only, approval: ask }`。另有两个硬校验：`custom` / `auto` 是保留名（`:209-214`）；`ctx.shell.sandboxMode` 为 `undefined`（执行器不具限制能力）时该插件直接加载失败（`:215-217`）。

### 2.2 模型切换只影响“下一步”，且框架已替你告知模型

`AgentModel.select()`（`packages/core/agent/src/model-selection.ts:112`）只做一件事：追加 `model/selection`。该事件的注释写明（`packages/core/agent/src/types.ts:117-121`）：

> `Log-only: it never enters derived model history.`

同时同文件的 `installModelSelection()`（`:157-174`）已在 `agent/pre-step` 上装好监听：当本步路由与上一次 `request/header` 的 provider/model 不同时，追加一条 user 消息

> `[model changed: assistant turns above this point were generated by <from>; the session continues with <to>]`

→ 模型换轨提示是**框架内置**的，不要重复实现。

限制来自 `agent/pre-step` 本身：payload 里的 `modelSelection` 是**已捕获**的 step 选择（`packages/core/agent-loop/src/agent.ts:294`），而 `PreStepDecision` 只有 `reject` / `enter{messages, startsRequestSeries?}`（`packages/core/agent/src/runtime-types.ts:139-146`）——**没有模型字段**。所以切换从下一步开始。

### 2.3 缓存友好排序 ≠ “易变内容放提示词底部”

系统提示词被打包成**一个字符串**，落成 surface 节点 0。`SystemPromptProjection.project()`（`packages/core/agent-loop/src/runtime-context.ts:99-114`）的规则是：

```text
节点列表为空                     → append 新 system 节点（渲染值）
!inHistory || rendered === ''    → 清空后续节点 + 替换节点 0
startsSeries && latest !== rendered → 同上（重新基线化，前缀作废）
latest === rendered              → 不产生更新
其余（inHistory 且连续 series）  → append 一个新 system 节点（保留前缀）
```

其中 `inHistory` 来自路由能力（`preparedCall?.systemPromptUpdate === 'in-history'`，`agent.ts:460`），`startsSeries` 在三种情况被强制打开（`agent.ts:458-464`）：

1. pre-step 监听器显式声明；
2. `requestSurfaceGeneration !== session.surface.contentGeneration`（surface 被改写，例如压缩）；
3. `toolUpdate === undefined && toolsChanged(assembly.tools)`（该路由不支持工具增量更新时的工具集变化）。

**推论（这是 Flow 分层提示词的设计依据）**

| 内容 | 放哪 | 理由 |
|---|---|---|
| 不变的系统底座 | `systemPrompt.section()`，`order` 取很小的固定值 | 字节级稳定，永远命中前缀 |
| 用户勾选的“全局提示词” | 同上，`order` 段固定在 `-500 … 500` 之间 | 同一层内不变，整体仍稳定 |
| 随模式变化的提示词 | `systemPrompt.context()`（尾部 `<system-reminder>` user 消息）或 `agent.ctx` 上的 scoped section | 只追加、不动节点 0 |
| 每次都要成立的事实（spec 摘要、当前模式名） | `context({ required: true })` | 天然只在内容变化时才发新快照 |

本 profile 走 `llm-pi-ai`，其 `conversationUpdates()` 默认 `systemPromptUpdate: 'in-history'`（`packages/llm/llm-pi-ai/src/models.ts:75-79`）；DeepSeek 官方适配器同样声明 `'in-history'`（`packages/llm/llm-deepseek/src/models.ts:14`）。→ “追加而非替换”的路径可用。

### 2.4 `.flow/spec.md` 的压缩后保活是框架语义

`RuntimeContextProjection`（`packages/core/agent-loop/src/runtime-context.ts:125-181`）：

- 构造时从 surface 反向扫描，找到最近一条 `runtime-context` user 消息并记为 `retained{seq, sections}`；
- 监听 `session/event`：一旦出现 replacement surface 事件且其 `sourceEventSeqs` 含 `retained.seq`（压缩就是把一段 surface 换成摘要节点）→ `retained = null`；
- 此后 `project(sections)` 必然产出**新快照**，且因为 `retained !== undefined`，文案切换为带取代语义的版本：

> `The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.`

配合 `ctx.systemPrompt.refreshContext()` 在每次请求准入时重解析 `required` 上下文（`packages/core/system-prompt/src/index.ts:589-609`），结论是：**只要把 `.flow/spec.md` 注册成 `required` 的 runtime context，压缩后它会自动回来，无需监听压缩事件、无需手动 re-inject。**

### 2.5 原生提问的硬约束

`ctx.userQuestions.ask()`（`packages/interaction/user-questions/src/index.ts:291`）在准入阶段做两件事：

1. `assertLiveRoot(agent)`（`:137-149`）：传入 agent 必须是注册表中**同一个实例**，否则 `CALLER_NOT_LIVE`；且 `agent.session.header.origin === 'subagent'` 时抛 `DELEGATED_CALLER`，提示语明确要求“把未解决的问题写进子代理的最终结果”。
2. `intent` 校验（`:300-339`）：`plan-review` / `approval` 的 `approve` 等标签必须出现在 `options` 里；`approval` 还要求单问、不支持 `multiSelect`、不接受 `wait`。

→ **阶段确认必须由父会话（Lead）发起**，不能指望子代理或其团队工具代问。

---

## 3. 两条红线

### 红线一：不要给 Flow 自造 session event 类型

- `Session.append()` 无法给事件打 `ignorable: true`；读取方只接受带该标记的未知事件，否则**会话无法重新打开**。
- 唯一安全出口 `appendPluginRecord()`（`packages/core/session/src/index.ts:498`）被限定在 `packages/experimental/`；`packages/core/session/README.md:72` 原文：仓库外插件 “must not call it either”。
- `permissionPresets` 能声明 `'permission/preset'` 是因为它是仓内包，并通过 `declare module '@deepseek-ai/dsh-session/types'` 合并了 `SessionEventMap`。

**做法**：模式/阶段状态落 `ctx.storageDomain.open({ name:'flow', version, tables, global })`（底层 `KvUnit.putRecord / loadAll / setGlobal`）。代价：`fork` / `replay` 不携带模式状态，UI 侧从存储读即可。

### 红线二：`dsh-team-control` 只能走 HTTP，不能走服务调用

实测该包：

```js
export const name = 'dsh-team'          // index.js:20
export const inject = ['tools']         // index.js:22
```

全文件只有 `ctx.inject(...)` 用于挂内层插件，**没有 `ctx.provide(...)`**。→ 没有可被 `ctx.get()` 拿到的 Cordis 服务。

集成面只有两处：

1. **模型工具** `dsh_team_create / spawn / status / task / send / report_task / dispatch / control / approve / report`；
2. **sidecar HTTP**：`baseUrl` 解析顺序 `config.baseUrl` → `DSH_TEAM_URL` → 默认 `http://127.0.0.1:4317`（`index.js:40-42`）；健康检查 `GET /api/health`（`:117-119`）；统一 `request()` 封装在 `:167`。

**不要硬编码端口**，从 `config` 读，这样与 sidecar 实际端口一致。

---

## 4. 生态联动契约（可直接编码依据）

### 4.1 dsh-team-control sidecar HTTP

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | `{ok, asOf, pid}`，1.5s 超时探活（插件自身即这么用） |
| `/api/status` | GET | `{asOf, version, teams, members, staleMembers, degraded}` |
| `/api/events` | GET (SSE) | `?team=&member=&lastEventId=`；`text/event-stream`；15s `: ping`；`Last-Event-ID` 重放 ≤5000 条 |
| `/api/events/history` | GET | 历史事件（dev-mock 中可见） |
| `/api/teams/:key` | GET | 团队详情 |
| `/api/agents/dispatch` | POST | 原子认领任务（置 running） |
| `/api/agents/report` | POST | 回写任务结果 |
| `/api/approvals`、`/api/approvals/:id/decide` | POST | 审批 |
| `/api/tasks/:id/todos` | POST | todo 整份替换 |
| `/api/messages` | POST | 成员消息 |

**SSE 帧型**（`sse.mjs` 的 `frameForEvent`）：`lease.warn`、`scope.request`、`decision`、`message.delivered`、`member.status`、`step.append`（兜底）。每条帧都带 `{id, teamId, memberId, taskId, ts}` 基座。

**鉴权**：`server.mjs` 注释明示“SSE（无鉴权：面板与 API 均改为免 token，sidecar 只监听本机回环）”。→ 不需要 token，但**只能访问回环地址**，不要把该端口暴露到非回环。

**读取方式**：Node 原生 `fetch` 不支持 SSE 增量读取，用 `http.request` 手动解析 `data:` / `event:` / `id:` 行，或 undici 的流式读取。

### 4.2 dsh-im 透传

- 转发链路的单一真源是 `API_REMOTE_FORWARDED_EVENTS`（`packages/api/remotes/src/remote-events.ts:29,57`），包含 `approval/request` 与 `user-questions/request`，均为 `waterfall`。
- 只有 **owner peer** 会收到转发的 waterfall 并且可以应答；`gateway.hasLiveClient()` 只统计未取消的 owner 应答流，且“这一同步观察不保证后续投递成功”（`packages/api/gateway/README.md:51`）。
- dsh-im 5.10.0 侧：`src/channels/shared/harness-client.mjs:2403-2440` 消费 `question/requested` / `approval/requested` 与其 `*_resolved`，映射为内部 `kind:'question' | 'approval'`；`src/channels/shared/harness-approval.mjs` 实现审批队列（含超时自动拒绝、卡片渲染、路由隔离）。
- README 摘录（`node_modules/@xmanrui/dsh-im/README.md`）：
  - `:359` 交互式提问 —— “回复选项序号、选项文字或自定义文字；多选时用逗号分隔”。
  - `:362` —— “**Web 或其他 Host 任务发起时，需要该 Session 恰好绑定一个已开启双向同步的私聊**”；“Web 与机器人可同时处理同一审批，先提交的生效，另一端随即失效”。

**对 Flow 的含义**：从 Web 会话发起的“4 选 1”只有在目标会话绑定同步私聊时才会出现在手机上；否则仅 Web。这属于**产品前置条件**，需在设置页显式提示用户。

---

## 5. MVP 最小可行架构

### 5.1 包结构（一个 bundle，两个插件行）

```text
dsh-flow/
  package.json          # dsh.bundle.patch -> ./cordis.patch.yml
                        # exports: "." ./index.js, "./client" ./client.js,
                        #          "./locale/*.json", "./icon", "./package.json"
  cordis.patch.yml      # 2 行 insert：flow（Host）、flow-client（Client）
  index.js              # Host: export function apply(ctx, config) + export const inject + export const Config
  client.js             # Client: 设置卡片 + 模式条 + 活跃心跳
  locale/{zh,en}.json   # meta.title / meta.description / meta.detail
  docs/DETAIL.md        # 插件详情页
  icon.svg
```

Host 半 `inject` 建议：`['tools', 'systemPrompt']` 为硬依赖；`permissionPresets`、`compaction`、`userQuestions`、`sessionProjections`、`settings`、`storageDomain` 通过 `ctx.inject([...], cb)` 作可选子级，缺失时降级而非崩溃。

### 5.2 Host 半：`ctx.provide('flow')` 一个服务，七个模块

| 模块 | 实现要点 | 真实 API |
|---|---|---|
| 模式状态 | 真相在 `storageDomain`（键 = sessionId）；热缓存用 **host-only** 投影，仅当需要展示时才加 `wire.view` | `ctx.storageDomain.open`、`ctx.sessionProjections.register` |
| `setMode(agent, mode)` 事务 | ①`agent.model.select()` ②`permissionPresets.set(agent.session, preset)` ③先 dispose 旧模式 scoped 注册、再在 `agent.ctx` 注册新模式的 `section/context/tools` ④落存储并广播 | `agent.model.select`、`permissionPresets.set`、`agent.ctx` 上的 `systemPrompt.section/context` |
| 分层提示词 | 底座 + 勾选的全局提示词 → 全局 `section({ order:-500…500 })`（永不变）；模式差异 → `agent.ctx` 上 scoped `section`（同名即遮蔽全局）；易变事实 + 锚点 → `context({ required:true })` | `systemPrompt.section / context`、`getSectionOrder` |
| 锚点保活 | `context({ name:'flow:spec', required:true, text: () => cacheByMtime('.flow/spec.md') })`；文件缺失返回空串 | 压缩后重挂由 `RuntimeContextProjection` 自动完成 |
| 熔断 | `tools/result` 累计连续 `isError` / `error.code`，滑动窗口状态放存储；达阈值 → `agent.cancel({ kind:'hook', reason:'flow:circuit' }, { keepInbox:true })`；熔断期内用 `ctx.tools.guard()` 做单调否决 | `tools/result`、`agent.cancel`、`ctx.tools.guard` |
| 阶段闸门 | 每次切阶段前 `ctx.userQuestions.ask({ agent, questions:[{ id, header, question, options:[4 项], multiSelect:false, intent:{ kind:'plan-review', approve } }] })`，无答案不推进 | `ctx.userQuestions.ask` |
| 团队联动 | SSE 客户端：`GET /api/events?team=X&lastEventId=N`，指数退避重连；把 `decision` / `member.status` / `step.append` 帧映射为阶段事件 | `http.request` 手写流式读取 |
| 邮件通知 | `agent/turn-stopping` / `workflow/end` / 团队任务终帧触发；120s 定时器 `ctx.timer.timeout`；先查 Client 心跳时间戳，再看 `hasLiveClient()` | `nodemailer`、`ctx.timer.timeout`、`typertGateway.hasLiveClient()` |
| compact | 阶段落定后 `compactNow(agent, signal)`，按 `ManualCompactionError.code` 分档决定重试或告警 | `ctx.compaction.compactNow` |

### 5.3 Client 半：只做三件事

1. **设置卡片**：`configForms.get('flow')` → 多套提示词列表 + 每套的模式/模型复选框；对象数组用 `mutate`，别用 `set`。注册进 `plugins.item`，用 `whileServed` 门控。
2. **会话内模式条**：读投影值（Host 若加 `wire.view` 则直接拿，否则用 host-only 投影 + 自建推送），点击调 Host 的切模式方法。
3. **活跃心跳**：`visibilitychange` / `focus` / `pointerdown` 节流上报时间戳。

### 5.4 分三步落地

| 阶段 | 交付 | 验收方式 |
|---|---|---|
| **S1 单开关** | Plan ↔ Build 两模式；只影响模型 + 权限预设 + 一段 scoped 提示词；投影 + 模式条跑通 | 切模式后下一回合的 `request/header` 里 provider/model 变了；`/permission` 显示的新档位正确 |
| **S2 锚点 + 闸门** | `.flow/spec.md` 走 `required` context；`userQuestions.ask` 做阶段确认 | 手动 `compactNow` 后再发一轮，确认 spec 内容回到请求里；确认卡片同时出现在 Web 与手机（前提：绑定同步私聊） |
| **S3 熔断 + 团队 + 邮件** | 3 次连续失败 → `cancel` + 通知；接 SSE；加 SMTP 与 120s 判定 | 构造连续失败工具调用，确认回合以 `aborted` 收尾且 inbox 未丢；停掉浏览器焦点 120s 后收到邮件 |

---

## 6. 明确不做

- 自造 session 事件类型（见红线一）。
- 监听 `system-prompt/assemble` 添加文本或工具。
- 会话中途变更工具集（会强制打开 `startsSeries`，前缀缓存作废）。
- 硬编码 `4317`；假设 `dsh-team-control` 有可调服务。
- 把“用户活跃”寄托在 `typertGateway.hasLiveClient()` 单点上。
- 用 `agentDefaultModel.saveSelection()` 实现会话级模型切换。
- 在 Client 半 `require` 任何 `@deepseek-ai/dsh-client-*` 模块。

---

## 7. 证据索引

### 7.1 权限

| 位置 | 内容 |
|---|---|
| `packages/interaction/permission-presets/src/index.ts:398` | `set(session, name)` 写入口 |
| 同上 `:403-418` | `apply()`：先 `permission/preset`，再逐旋钮写入 |
| 同上 `:176-193` | `static Config` 默认预设表（仅两项） |
| 同上 `:209-217` | `custom`/`auto` 保留；无限制执行器时加载失败 |
| 同上 `:254-275` | `/permission <preset>` 命令（用户侧写路径） |
| `packages/sandbox/sandbox-policy/src/session-mode.ts:53` | `setSandboxMode` = 一次 `append('sandbox/mode')` |
| 同上 `:26-38` | `sandbox/mode` 事件定义（log-only、可重放） |
| `packages/sandbox/sandbox-policy/src/index.ts` | `resolve(request)` / `overrideOf(session)` / `registerWritableRoot` |

### 7.2 模型

| 位置 | 内容 |
|---|---|
| `packages/core/agent/src/model-selection.ts:112` | `select()` 追加 `model/selection` |
| 同上 `:78-80` | 投影 fold：`model/selection` → pending；`request/header` → lastUsed |
| 同上 `:157-174` | `installModelSelection`：模型换轨 user 通知 |
| `packages/core/agent/src/types.ts:79-86` | `ModelSelection` 结构 |
| 同上 `:117-121` | `model/selection` 为 log-only，不入模型历史 |
| `packages/core/agent/src/runtime-types.ts:54-72` | `Model{ current(), select() }` |
| 同上 `:190-213` | Agent 增强面：`options/session/model/inbox/status/ctx/cancel/runMaintenance/...` |
| `packages/llm/llm/src/index.ts` | `listProviders / listModels / resolveModelInfo / prepareCall / stream` |

### 7.3 提示词

| 位置 | 内容 |
|---|---|
| `packages/core/system-prompt/src/index.ts:485` | `section()` |
| 同上 `:520` | `context()` |
| 同上 `:552` | `tools()` |
| 同上 `:568` | `variable()` |
| 同上 `:501` / `:510` | `getSectionOrder()` / `getContextOrder()` |
| 同上 `:136-173` | `SECTION_ORDERS` 全部槽位 |
| 同上 `:178-186` | `CONTEXT_ORDERS` 全部槽位 |
| 同上 `:589-609` | `refreshContext()` |
| 同上 `:621-696` | `assemble()`（含 complete section 与 scoped 遮蔽规则） |
| 同上 `:24-31` | `system-prompt/assemble` waterfall 注释（complete section 会被还原） |
| `packages/core/agent-loop/src/runtime-context.ts:46-55` | `SystemPromptDecisionInput{ inHistory, startsSeries }` |
| 同上 `:99-114` | `SystemPromptProjection.project()` 全部分支 |
| 同上 `:125-181` | `RuntimeContextProjection`（压缩后重挂语义） |
| `packages/core/agent-loop/src/agent.ts:294-323` | `preStep()`：assemble + waterfall + 默认 decision |
| 同上 `:448-467` | 每步重渲染、`startsSeries` 判定、commit |
| 同上 `:452-483` | `refreshContext()` 与 runtime-context 准入 |
| `packages/llm/llm-deepseek/src/models.ts:14` | DeepSeek 声明 `'in-history'` |
| `packages/llm/llm-pi-ai/src/models.ts:75-79` | pi-ai 默认 `'in-history'` |
| `packages/preset/agent-preset/skills/dsh-doc/references/practices.md:16-18` | waterfall 必须 `next()`；加文本用 `section()`；勿监听 `assemble` |
| 同上 `:26-29` | 用投影持有派生状态；`whenIdle()` 的语义陷阱 |

### 7.4 设置页

| 位置 | 内容 |
|---|---|
| `packages/settings/settings/README.md:39` | `autoGenerate` 说明 + “no shipped client does so yet” |
| `packages/settings/settings/src/index.ts:312-327` | `describe()` 组装 `{ns, schema, value, revision, autoGenerate}` |
| `packages/client/ui-settings/src/client/config-form-types.ts` | `ConfigFormSnapshot` / `ConfigForm{ set, unset, mutate }` |
| `packages/client/ui-settings/src/client/config-form.ts:236,258,308` | `ConfigForms` 服务、`get()`、`whileServed()` |
| `packages/client/ui-settings-shell/src/client/index.ts` | 官方参考实现（`inject = ['slots','locale','configForms']`，注册 `plugins.item`） |
| `packages/preset/.../references/configuration.md:3-12` | `configEditor.edit(ctx.fiber.entry, …)` 用法 |
| `packages/preset/.../references/host-plugin.md:60-65` | 插件导出形态与 `Config` 校验时机 |
| `practices.md:34-37` | UI：用 slot + theme token；不要 `require` client 包 |

### 7.5 压缩

| 位置 | 内容 |
|---|---|
| `packages/compaction/compaction/src/index.ts:162-166` | `compactNow(agent, signal, sourceCommandId?)` |
| 同上 `:136-140` | `compactIfNeeded(agent, trigger, signal)` |
| 同上 `:187-192` | `compactRegion(start, end, agent, signal?)` |
| 同上 `:35-41` | `ManualCompactionErrorCode` 六档 |
| 同上 `:77-86` | `ManualCompactAgentContext`（含 `runMaintenance`） |
| 同上 `:32` | `CompactionTrigger = 'pressure' \| 'context-overflow'` |

### 7.6 提问与 IM

| 位置 | 内容 |
|---|---|
| `packages/interaction/user-questions/src/index.ts:291` | `ask()` |
| 同上 `:137-149` | `assertLiveRoot`（`CALLER_NOT_LIVE` / `DELEGATED_CALLER`） |
| 同上 `:300-339` | `intent` 与选项校验 |
| 同上 `:265-274` | `askTimed` 的超时分支（`{ pending:true, callId }`） |
| `packages/interaction/user-questions/src/types.ts:10-70` | `AskUserQuestionOption / Item` |
| 同上 `:24-52` | `AskUserQuestionIntent`（`plan-review` / `approval`） |
| 同上 `:174-178` | `user-questions/request` waterfall 签名 |
| `packages/api/remotes/src/remote-events.ts:29,57` | 转发白名单两行 |
| `packages/api/gateway/README.md:51` | owner peer 才能应答；`hasLiveClient()` 精确语义 |
| `node_modules/@xmanrui/dsh-im/src/channels/shared/harness-client.mjs:2403-2440` | `question/requested` / `approval/requested` 映射 |
| `node_modules/@xmanrui/dsh-im/src/channels/shared/harness-approval.mjs` | 审批队列实现 |
| `node_modules/@xmanrui/dsh-im/README.md:254,359-362` | 双向同步前提、交互式提问、远程审批 |

### 7.7 团队联动

| 位置 | 内容 |
|---|---|
| `node_modules/dsh-team-control/package.json` | `version 0.3.0`，`dependencies: dsh-team-control-cli ^0.3.0` |
| `node_modules/dsh-team-control/cordis.patch.yml` | 行 `dsh-team`，`config: { baseUrl, autoStart }` |
| `node_modules/dsh-team-control/index.js:20,22` | `name='dsh-team'`、`inject=['tools']` |
| 同上 `:40-42` | `baseUrl` 解析链与端口提取 |
| 同上 `:117-119` | `isUp()` = `fetch(baseUrl + '/api/health')` |
| 同上 `:143-157` | 不可达 / 启动超时的报错文案 |
| 同上 `:167` | 统一 `request()` |
| `node_modules/dsh-team-control-cli/src/server.mjs:290` | `/api/events` 路由 |
| 同上（同段注释） | “SSE 无鉴权，仅监听本机回环” |
| `node_modules/dsh-team-control-cli/src/sse.mjs:39-40` | `text/event-stream` 响应头 |
| 同上 `frameForEvent()` | 六种帧型映射 |
| 同上 `SseHub` | 15s 心跳、`lastEventId` 重放（≤5000） |

### 7.8 事件 / 熔断 / 推送 / 网络

| 位置 | 内容 |
|---|---|
| `packages/core/tools/src/contracts.ts:375` | `PreToolDecision`（allow/deny/cancel/ask） |
| 同上 `:381-386` | `PostToolDecision`（accept/block） |
| 同上 `:390+` | `ToolRestriction` 与 `ToolGuard` 语义 |
| `packages/core/agent/src/runtime-types.ts:205-213` | `Agent.cancel(cause, options)` |
| 同上 `:139-146` | `PreStepDecision`（无模型字段） |
| 同上 `:43-51` | `CancelOptions{ keepInbox }` |
| `packages/core/agent-loop/src/agent.ts:352-356,408-424` | `reject` → `blocked`；abort → `aborted` + cause |
| `packages/session/session-projection/src` | `register({ key, wire:{ viewSchema, view } })` |
| `packages/typert/generator/README.md:77,116` | Remote 需构建期产出 `lib/typert.*` 与 `./remote` 导出 |
| `packages/client/ui-chat/src/client/apply.ts:326` | `shell.overlay` + `shell.quota-notice` 注册示例 |
| `packages/sandbox/src/index.ts` | `confine(argv, policy)` —— 仅包装进程 argv |
| `packages/web/web-fetch-http/src/provider.ts:119` | Host 自身用 `undici` 发请求 |
| `packages/util/http-proxy/src/policy.ts:33` | `LOOPBACK_NO_PROXY` 强制绕过回环 |
| `packages/util/http-proxy/src/install.ts:186` | 替换全局 dispatcher，即 `fetch` 解析目标 |
| `packages/api/gateway/src/stream-server.ts:47,148` | WebSocket 心跳（传输层存活，非用户活跃） |

### 7.9 红线

| 位置 | 内容 |
|---|---|
| `packages/preset/.../references/practices.md:21` | 不得自造 session 事件类型；`appendPluginRecord` 仅限 experimental |
| `packages/core/session/README.md:72` | 仓外插件同样不得调用 `appendPluginRecord` |
| `packages/core/session/src/index.ts:498` | `appendPluginRecord` 定义与 `PluginRecordMap` 约束 |

---

## 8. 待编码阶段确认的三个开放项

1. **设置页的“生效范围”粒度**：以模式为维度、模型为维度，还是“模式 × 模型”二维矩阵？二维更精确但表单复杂度显著上升。
2. **`.flow/spec.md` 的层级**：单文件，还是 `.flow/spec.md` + `.flow/stages/*.md` 分层？后者需要多份 `required` context，注意 token 预算。
3. **熔断后的恢复语义**：`cancel` 后是回到 idle 等用户输入，还是自动 `followup` 一条“已熔断，请确认”的提问？后者会消耗一次模型调用。
