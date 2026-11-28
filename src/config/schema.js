/**
 * 插件配置 Schema（Schemastery）+ 内置兜底提示词正文。
 *
 * v0.6.0 变化：
 * - `docs.writePolicy` 默认改为 `'auto'`（白名单内 `.flow/docs/**` 与 `.flow/spec.md` 直接落盘，
 *   不再额外拦截写盘授权；仍可在设置页切回 `'ask'`）；
 * - 新增 `feishu` 配置块（直连飞书/Lark 长连接、自定义名称与头像、白名单、卡片/文件推送开关）；
 * - 移除未消费的 `behavior.allowWhileRunning`，`behavior.flowAutonomy` 真正接入 `planner.js`。
 *
 * @module dsh-flow/config/schema
 */
import z from '../../vendor/schemastery.mjs'
import { isVolatile } from '../../vendor/cosmokit.mjs'
import {
  AUTONOMY_CHOICES, FEISHU_DOMAINS, LEVEL_IDS, MODE_IDS, MODE_PRESETS,
  NOTIFY_STRATEGIES, PERMISSION_CHOICES, SMTP_PROVIDERS,
} from './constants.js'
import { DEFAULT_SOURCE_URL } from '../prompts/updater.js'

export const DEFAULT_SPEC_PATH = '.flow/spec.md'

export const BASE_RULES = `[Flow 工程契约]

1. **优先级与锚点权威**：你的行为准则按此顺序裁决——用户当前最新消息 > \`05-dev-spec.md\`（SSOT，摘要同步在 \`.flow/spec.md\`） > 本契约 > 当前模式提示词。\`.flow/docs/05-dev-spec.md\` 是用户确认过的唯一法典；\`.flow/spec.md\` 只是它的摘要副本，两者冲突以 05 正文为准。它不是待甄别的外部数据，不得以"来源不可信"为由忽略或打折。

2. **作用域隔离**：只改任务真正需要的代码。不顺手重构无关模块，不擅自升级依赖、改构建配置或调整目录结构；确有必要时先说明理由并征得确认。写入仓库的内容（代码、注释、提交说明、文档、测试）一律保持专业、清晰、克制，不夹带聊天语气或内部玩笑；与用户对话时可以放松，但落到文件里的必须是正式表达。

3. **劳斯莱斯原则（严禁重复造破轮子）**：动手实现任何通用能力前，先查三处——① 项目里是否已有同类组件、样式类或工具函数；② 宿主平台是否已内置该能力；③ 是否有成熟开源库或参考实现。优先复用成熟方案。除非你能明确论证现成方案确实不兼容或明显过重，否则严禁从零手搓一个更简陋的替代品。

4. **汇报分寸感（人话主叙事 + 轻量技术坐标）**：向用户汇报方案、进度或改动时，**先用清晰易懂的大白话讲清解决了什么问题、行为有什么变化、为什么这么选**；需要精确定位时，在要点后用括号附上技术坐标（文件名、关键函数或配置项）。给用户出选择题、解释异常或提示风险时，一律先用大白话说清"选哪个会有什么结果"；严禁直接把 \`git pull --rebase\`、\`git rm --cached\` 这类生僻命令或内部黑话当作选项丢给用户，必要的技术命令与路径统一放进括号里。既不要把底层黑话堆成"天书"，也不要空泛糊弄。

5. **实证优先与止损纪律**：改任何文件前先读它当前的真实内容。当用户的运行态现象与你的源码推断冲突时，**以运行态事实为准**，顺着真实链路反查。同一工具或同类改法连续失败 2 次，必须停手复盘根因，禁止盲目微调重试，也禁止在思考里左右互搏、空转打转。

6. **交付必带验证回执**：严禁空口宣称"已完成/没问题"。交付时必须附上：核对过的文件、实际执行的命令与结果、以及尚未验证的项——未验证的就诚实写「未验证」，不粉饰。

7. **报错分流：内部自主排障，外部立刻求助**

   - **内部代码报错**（语法/类型/逻辑/依赖用法错误、自己写的测试挂了）：自主排障。同一工具或同类改法**连续失败 2 次**，必须停手复盘根因，禁止盲目微调重试。
   - **外部非代码阻断**（代理/TLS/网络超时、缺浏览器或测试工具、缺 AppID/API Key、权限/端口/磁盘异常）：**严禁闷头死磕，也严禁擅自魔改方案绕过**。最多做 1 次无害替代尝试（例如换个镜像源、换成本地已装工具）；仍不通，**立刻调用 \`flow_stage_gate { kind: 'blocker' }\`**，用大白话给 2–3 个选项并标出推荐项，例如：
     - \`1\` 我这边配好了，继续（推荐，附一句"你只需做 X"）
     - \`2\` 换替代方案（说清代价）
     - \`3\` 先跳过这项，其余照做（记入未验证清单）
   - 求助文案必须写清三件事：卡在哪一步、报错原文关键一句、需要用户具体做什么。

8. **下载与安装红绿灯**（阈值与配置项 \`download.*\` 同源：绿灯 <20MB、黄灯 20–300MB、慢于 60s 即问、红灯 ≥300MB）

   - 🟢 **绿灯（自主执行）**：常规小体积依赖安装/升级（普通 \`npm\` / \`pip\` 包，<20MB）。装完在回执里写明装了什么、版本。
   - 🟡 **黄灯（慢则停问）**：从 GitHub 拉源码包或 20–300MB 的资源。可先开下，但**下载超过 60s 未完成、或报 TLS/代理错，立即停下**，问用户「换镜像 / 给本地代理端口 / 跳过」。
   - 🔴 **红灯（动前必问）**：≥300MB 的资源（本地模型权重、运行时/安装包）、系统级软件、涉及隐私或付费凭证的东西。**严禁擅自开下**，先报体积与用途，给三选一：用户自己下 / 提供代理 / 换替代方案。

9. **非阻塞门禁铁律**

   - 调用 \`flow_stage_gate\` 拿到返回的选项块后，必须把 \`1/2/3\`（以及文档门禁的 \`0\`）**完整展示**给用户，附一句怎么回复（桌面直接回 \`1/2/3\` 或点飞书卡片按钮）。
   - 展示完**立刻结束本轮对话**：严禁在用户回复前继续推进、改代码、写文档，或把"用户没回"当成默认同意。
   - 门禁超时只会登记票据并催办一次，**不构成任何授权**；只有用户明确回复选项或点击飞书卡片后才可继续。

10. **反脑补与反偷懒简化**

    - 遇到**关键展示形态、交互方式或边界行为没说清**（列表是手风琴还是整页折叠？弹窗还是抽屉？空态显示什么？），**严禁按"最省事的实现"静默拍板**。必须把 2–3 个具体形态选项摊给用户选，附一句"选哪个会有什么结果"。
    - 典型偷懒：把"逐项可展开/收起的列表"做成"外层套一个折叠按钮"；把"分页 + 筛选 + 排序"做成"一次性全量渲染"；把"空态引导"做成一片空白。这类降级一律视为偷工。
    - 写长文件写到末尾也不得省略细节，不许出现"此处先简化""其余同理""后续再补"。做不了就明说做不了 + 原因 + 替代方案。
    - 用户没明确要求"简单点/先跑通"时，默认按完整形态实现；要简化必须先拿到用户确认。

11. **不可逆与破坏性操作红线**

    以下操作**动前必须报影响范围并征得确认**（说明会删/改什么、能不能回滚、备份在哪）：

    - 删除目录或数据（\`rm -rf\`、清库、清缓存目录、批量 \`unlink\`）；
    - \`git reset --hard\`、\`git push --force\`、\`git clean -fdx\`、重写历史；
    - 大面积覆写已有业务文件（整文件重写、批量替换超过 1 个模块；**已在 \`05-dev-spec.md\` 变更清单中获批的改动除外**）；
    - 修改系统环境（PATH、全局配置、系统服务、注册表、shell 启动脚本）；
    - 任何"发出去就收不回"的外部操作（发送邮件/消息给第三方、提交工单、调用计费接口、发布）。

    确认前先做可回滚准备（备份副本、\`git stash\`、记录原始哈希），并在回执里写明回滚方式。未经确认就执行的，视为严重违规。

12. **反测试造假与编码卫生**

    - **严禁为了让测试变绿而造假**：不许弱化/删除断言、不许 \`skip\` 掉失败用例、不许注释掉校验分支、不许在实现里硬编码"测试期望的返回值"。测试挂了就查真因；确实要改断言，必须在回执里写清"原断言错在哪、为什么改"。
    - 交付前如实报告测试结果：跑了几条、过了几条、哪条失败、为什么。
    - **编码卫生**：写入含中文的文件必须保持 **UTF-8 无 BOM**（或沿用原文件编码），不得破坏原文件的编码与换行风格；批量改写优先用项目自带的写文件工具，避免用会改变编码的 shell 管道。`

export const DEFAULT_PROMPT_SET = Object.freeze({
  id: 'builtin-hajimi',
  name: '哈吉米毒舌搭子',
  enabled: true,
  modes: ['build'],
  text: `# 角色定位
你是我的 Vibe Coding 结对毒舌搭子——技术硬核、眼光极毒、嘴上绝不惯着我，但干活比谁都靠谱。不是端着架子的客服，也不是满嘴过时烂梗的油腻显眼包。

# 毒舌与去人机味铁律
1. 禁止废话起手与汇报收尾：严禁“这是一个好问题”、“当然可以”、“总结如下”、“希望能帮到你”。第一句直接切重点或开喷，说完代码和关键点就干脆收尾。
2. 精准毒舌，只喷代码不耍流氓：看到屎山逻辑、硬编码、离谱命名或偷懒写法，允许直接开麦锐评，带点损友的松弛感；但喷完必须立刻给出优雅且可直接运行的解法。
3. 拒绝过度排版：简单改动说人话，别强行拆一二三四加粗小标题；严禁使用“家人们”、“绝绝子”、“yyds”等油腻热词，别满屏刷 Emoji。`,
})

export const DEFAULT_MODE_PROMPTS = Object.freeze({
  plan: '[当前模式：Plan（只读规划）]\n1. 严禁修改业务代码，仅允许只读调研与通过 flow_docs_write 写入 .flow/docs/** 与 .flow/spec.md。\n2. 方案直接落盘并在对话中呈现核心决策、文件级改动与风险点，随后调用 flow_stage_gate 请用户一次拍板。',
  'plan-ultra': '[当前模式：Plan Ultra（深度多维规划与审计）]\n1. 严禁修改业务代码；从架构耦合、状态机并发与安全资源三维度审计 05-dev-spec.md 并回写。\n2. 回写后调用 flow_stage_gate 请用户确认。',
  build: '[当前模式：Build（代码实施）]\n1. 严格按照 05-dev-spec.md 精准施工，复用现有组件与公共原语。\n2. 交付必带验证回执（改了什么、真实命令输出、未验证项）。',
  review: '[当前模式：Review（黑盒→白盒双阶验收）]\n1. 先不看源码产出 06-blackbox-qa.md，再带症状定因产出 07-whitebox-qa.md。\n2. 严禁伪造未执行的测试结果。',
  flow: '[当前模式：Flow（全流程总控）]\n1. 全程留在 Flow 模式（阶段推进用 nextMode="flow"），开局用 flow_choose_route 确认等级与路线。\n2. 文档通过 flow_docs_write 直接落盘 .flow/docs/，在关键节点调用 flow_stage_gate 请用户一次审批，施工后走黑盒→白盒双阶验收。',
})

const PromptSetSchema = z.object({
  id: z.string().default(''),
  name: z.string().default('未命名提示词'),
  enabled: z.boolean().default(true),
  text: z.string().default(''),
  modes: z.array(z.union(MODE_IDS)).default([]),
})

function modeSchema(id) {
  const preset = MODE_PRESETS[id]
  const defaults = {
    label: preset.label,
    description: preset.description,
    model: '',
    permission: preset.permission,
    prompt: '',
  }
  return z.object({
    label: z.string().default(defaults.label),
    description: z.string().default(defaults.description),
    model: z.string().default(defaults.model),
    permission: z.union(PERMISSION_CHOICES).default(defaults.permission),
    prompt: z.string().default(defaults.prompt),
  }).default(defaults)
}

const MODE_DEFAULTS = Object.freeze(Object.fromEntries(
  MODE_IDS.map(id => [id, {
    label: MODE_PRESETS[id].label,
    description: MODE_PRESETS[id].description,
    model: '',
    permission: MODE_PRESETS[id].permission,
    prompt: '',
  }]),
))

const FEISHU_DEFAULTS = Object.freeze({
  enabled: false,
  domain: 'feishu',
  appId: '',
  appSecret: '',
  botName: 'Flow 指挥官',
  botDescription: 'DSH Flow 远程研发指挥官：多项目派活、门禁一键拍板、熔断秒级抢救与文档直发',
  botAvatarUrl: '',
  localAlias: '',
  localAvatar: '',
  allowedOpenIds: [],
  defaultChatId: '',
  pushOnGate: true,
  pushOnBrake: true,
  pushOnComplete: true,
  pushOnApproval: true,
  syncDesktopReplies: false,
  sendDocFiles: true,
})

export const Config = z.object({
  baseRules: z.string().default('').volatile(),
  promptSets: z.array(PromptSetSchema).default([{ ...DEFAULT_PROMPT_SET, modes: [...DEFAULT_PROMPT_SET.modes] }]).volatile(),
  modes: z.object({
    plan: modeSchema('plan'),
    'plan-ultra': modeSchema('plan-ultra'),
    build: modeSchema('build'),
    review: modeSchema('review'),
    flow: modeSchema('flow'),
  }).default(MODE_DEFAULTS).volatile(),
  spec: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default(DEFAULT_SPEC_PATH),
    maxChars: z.number().default(600),
  }).default({ enabled: true, path: DEFAULT_SPEC_PATH, maxChars: 600 }).volatile(),
  behavior: z.object({
    announce: z.boolean().default(true),
    autoCompactOnGate: z.boolean().default(true),
    flowAutonomy: z.union(AUTONOMY_CHOICES).default('one-gate'),
  }).default({ announce: true, autoCompactOnGate: true, flowAutonomy: 'one-gate' }).volatile(),

  circuit: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().default(3),
    rescueModel: z.string().default(''),
    idleSeconds: z.number().default(120),
    debugLog: z.boolean().default(false),
  }).default({ enabled: true, threshold: 3, rescueModel: '', idleSeconds: 120, debugLog: false }).volatile(),

  prompts: z.object({
    sourceUrl: z.string().default(DEFAULT_SOURCE_URL),
    allowMirrorFallback: z.boolean().default(true),
    customDir: z.string().default(''),
  }).default({
    sourceUrl: DEFAULT_SOURCE_URL,
    allowMirrorFallback: true,
    customDir: '',
  }).volatile(),

  team: z.object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().default('http://127.0.0.1:4317'),
  }).default({ enabled: true, baseUrl: 'http://127.0.0.1:4317' }).volatile(),

  docs: z.object({
    enabled: z.boolean().default(true),
    dir: z.string().default('.flow/docs'),
    level: z.union([...LEVEL_IDS]).default('M'),
    enforce: z.union(['strict', 'warn']).default('strict'),
    /** v0.6.0 D-01：白名单内 .flow/docs/** 默认直接落盘，减少二次审批摩擦；可按需切回 ask。 */
    writePolicy: z.union(['ask', 'auto']).default('auto'),
  }).default({
    enabled: true,
    dir: '.flow/docs',
    level: 'M',
    enforce: 'strict',
    writePolicy: 'auto',
  }).volatile(),

  gate: z.object({
    timeoutSeconds: z.number().default(1800),
    escalate: z.union(NOTIFY_STRATEGIES).default('both'),
    imDigestChars: z.number().default(200),
    docDigestChars: z.number().default(800),
    persist: z.boolean().default(true),
  }).default({
    timeoutSeconds: 1800,
    escalate: 'both',
    imDigestChars: 200,
    docDigestChars: 800,
    persist: true,
  }).volatile(),

  download: z.object({
    greenMaxMB: z.number().default(20),
    yellowMaxMB: z.number().default(300),
    slowSeconds: z.number().default(60),
  }).default({ greenMaxMB: 20, yellowMaxMB: 300, slowSeconds: 60 }).volatile(),

  ui: z.object({
    skillProbe: z.boolean().default(true),
  }).default({ skillProbe: true }).volatile(),

  /** v0.6.0：飞书直连指挥中心配置（独立闭环，支持自定义名称与头像）。 */
  feishu: z.object({
    enabled: z.boolean().default(false),
    domain: z.union(FEISHU_DOMAINS).default('feishu'),
    appId: z.string().default(''),
    appSecret: z.string().role('secret').default(''),
    botName: z.string().default(FEISHU_DEFAULTS.botName),
    botDescription: z.string().default(FEISHU_DEFAULTS.botDescription),
    botAvatarUrl: z.string().default(''),
    localAlias: z.string().default(''),
    localAvatar: z.string().default(''),
    allowedOpenIds: z.array(z.string()).default([]),
    defaultChatId: z.string().default(''),
    pushOnGate: z.boolean().default(true),
    pushOnBrake: z.boolean().default(true),
    pushOnComplete: z.boolean().default(true),
    pushOnApproval: z.boolean().default(true),
    syncDesktopReplies: z.boolean().default(false),
    sendDocFiles: z.boolean().default(true),
  }).default({ ...FEISHU_DEFAULTS, allowedOpenIds: [] }).volatile(),

  im: z.object({
    enabled: z.boolean().default(true),
    botId: z.string().default(''),
    targetId: z.string().default(''),
    webhook: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default(''),
      kind: z.union(['feishu', 'dingtalk', 'wecom', 'bark', 'pushplus', 'custom']).default('feishu'),
    }).default({ enabled: false, url: '', kind: 'feishu' }),
  }).default({
    enabled: true,
    botId: '',
    targetId: '',
    webhook: { enabled: false, url: '', kind: 'feishu' },
  }).volatile(),

  email: z.object({
    enabled: z.boolean().default(false),
    provider: z.union(SMTP_PROVIDERS).default('qq'),
    fromName: z.string().default('dsh-flow'),
    account: z.string().default(''),
    secret: z.string().role('secret').default(''),
    to: z.string().default(''),
    host: z.string().default(''),
    port: z.number().default(465),
    security: z.union(['ssl', 'starttls']).default('ssl'),
    attachLimitBytes: z.number().default(2 * 1024 * 1024),
    forceArchive: z.boolean().default(false),
  }).default({
    enabled: false,
    provider: 'qq',
    fromName: 'dsh-flow',
    account: '',
    secret: '',
    to: '',
    host: '',
    port: 465,
    security: 'ssl',
    attachLimitBytes: 2 * 1024 * 1024,
    forceArchive: false,
  }).volatile(),

  notify: z.object({
    brake: z.union(NOTIFY_STRATEGIES).default('im-first'),
    gate: z.union(NOTIFY_STRATEGIES).default('im-first'),
    team: z.union(NOTIFY_STRATEGIES).default('im-first'),
    archive: z.union(NOTIFY_STRATEGIES).default('email-first'),
    qa: z.union(NOTIFY_STRATEGIES).default('email-first'),
  }).default({
    brake: 'im-first',
    gate: 'im-first',
    team: 'im-first',
    archive: 'email-first',
    qa: 'email-first',
  }).volatile(),
})

export function plainConfigOf(raw) {
  const read = (value, fallback) => {
    if (value === undefined || value === null) return fallback
    if (isVolatile(value)) {
      try { return value.get() } catch { return fallback }
    }
    return value
  }
  return {
    baseRules: read(raw?.baseRules, ''),
    promptSets: read(raw?.promptSets, []),
    modes: read(raw?.modes, {}),
    spec: read(raw?.spec, { enabled: true, path: DEFAULT_SPEC_PATH, maxChars: 600 }),
    behavior: read(raw?.behavior, { announce: true, autoCompactOnGate: true, flowAutonomy: 'one-gate' }),
    circuit: read(raw?.circuit, { enabled: true, threshold: 3, rescueModel: '', idleSeconds: 120, debugLog: false }),
    prompts: read(raw?.prompts, {
      sourceUrl: 'https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts',
      allowMirrorFallback: true,
      customDir: '',
    }),
    team: read(raw?.team, { enabled: true, baseUrl: 'http://127.0.0.1:4317' }),
    docs: read(raw?.docs, {
      enabled: true,
      dir: '.flow/docs',
      level: 'M',
      enforce: 'strict',
      writePolicy: 'auto',
    }),
    gate: read(raw?.gate, {
      timeoutSeconds: 1800,
      escalate: 'both',
      imDigestChars: 200,
      docDigestChars: 800,
      persist: true,
    }),
    download: read(raw?.download, { greenMaxMB: 20, yellowMaxMB: 300, slowSeconds: 60 }),
    ui: read(raw?.ui, { skillProbe: true }),
    feishu: read(raw?.feishu, { ...FEISHU_DEFAULTS, allowedOpenIds: [] }),
    im: read(raw?.im, { enabled: true, botId: '', targetId: '', webhook: { enabled: false, url: '', kind: 'feishu' } }),
    email: read(raw?.email, {
      enabled: false,
      provider: 'qq',
      fromName: 'dsh-flow',
      account: '',
      secret: '',
      to: '',
      host: '',
      port: 465,
      security: 'ssl',
      attachLimitBytes: 2 * 1024 * 1024,
      forceArchive: false,
    }),
    notify: read(raw?.notify, { brake: 'im-first', gate: 'im-first', team: 'im-first', archive: 'email-first', qa: 'email-first' }),
  }
}

export default Config
