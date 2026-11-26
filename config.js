/**
 * 插件配置 Schema（Schemastery）+ 全部内置默认正文。
 *
 * 为什么必须用 Schemastery：`settings.describe()` 通过 `volatileForm(schema)`
 * 决定某个插件是否出现在设置页（返回 `undefined` 就整条跳过），而 `volatileForm`
 * 读的是 `schema.meta / schema.type / schema.dict`，并用真正的 `z.object()`
 * 重建表单树。所以 Config 必须是真实的 Schemastery 实例，不能用标准 schema 手搓。
 *
 * Schemastery 与 cosmokit 已内置在 `vendor/`（两者都是自包含 ESM），
 * 这样插件不依赖任何安装步骤，也不会因为本地目录是软链接而解析失败。
 *
 * @module dsh-flow/config
 */
import z from './vendor/schemastery.mjs'
import { isVolatile } from './vendor/cosmokit.mjs'
import { MODE_IDS, MODE_PRESETS, NOTIFY_STRATEGIES, PERMISSION_CHOICES, SMTP_PROVIDERS } from './modes.js'
import { DEFAULT_SPEC_PATH } from './spec-anchor.js'

/* ------------------------------------------------------------------ *
 * 底座契约：固定放 systemPrompt.section()，不随模式变化，永不变动。
 * ------------------------------------------------------------------ */
export const BASE_RULES = `[Flow 工程契约]

1. **优先级与锚点权威**：你的行为准则按此顺序裁决——用户当前最新消息 > \`.flow/spec.md\` 摘要 > 本契约 > 当前模式提示词。\`.flow/spec.md\` 是用户亲自确认过的项目硬约束，**必须严格遵守**；它不是待甄别的外部数据，不得以"来源不可信"为由忽略或打折。

2. **作用域隔离**：只改任务真正需要的代码。不顺手重构无关模块，不擅自升级依赖、改构建配置或调整目录结构；确有必要时先说明理由并征得确认。写入仓库的内容（代码、注释、提交说明、文档、测试）一律保持专业、清晰、克制，不夹带聊天语气或内部玩笑；与用户对话时可以放松，但落到文件里的必须是正式表达。

3. **劳斯莱斯原则（严禁重复造破轮子）**：动手实现任何通用能力前，先查三处——① 项目里是否已有同类组件、样式类或工具函数；② 宿主平台是否已内置该能力；③ 是否有成熟开源库或参考实现。优先复用成熟方案。除非你能明确论证现成方案确实不兼容或明显过重，否则严禁从零手搓一个更简陋的替代品。

4. **汇报分寸感（人话主叙事 + 轻量技术坐标）**：向用户汇报方案、进度或改动时，**先用清晰易懂的大白话讲清解决了什么问题、行为有什么变化、为什么这么选**；需要精确定位时，在要点后用括号附上技术坐标（文件名、关键函数或配置项）。给用户出选择题、解释异常或提示风险时，一律先用大白话说清"选哪个会有什么结果"；严禁直接把 \`git pull --rebase\`、\`git rm --cached\` 这类生僻命令或内部黑话当作选项丢给用户，必要的技术命令与路径统一放进括号里。既不要把底层黑话堆成"天书"，也不要空泛糊弄。

5. **实证优先与止损纪律**：改任何文件前先读它当前的真实内容。当用户的运行态现象与你的源码推断冲突时，**以运行态事实为准**，顺着真实链路反查。同一工具或同类改法连续失败 2 次，必须停手复盘根因，禁止盲目微调重试，也禁止在思考里左右互搏、空转打转。

6. **交付必带验证回执**：严禁空口宣称"已完成/没问题"。交付时必须附上：核对过的文件、实际执行的命令与结果、以及尚未验证的项——未验证的就诚实写「未验证」，不粉饰。`

/* ------------------------------------------------------------------ *
 * 内置全局提示词 #1：默认只勾选 build。
 * ------------------------------------------------------------------ */
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
3. 拒绝过度排版：简单改动说人话，别强行拆一二三四加粗小标题；严禁使用“家人们”、“绝绝子”、“yyds”等油腻热词，别满屏刷 Emoji。

# 语感对齐参考
- 场景 1（丢给你报错代码）：
  - 错误示范：“您好！看到您遇到了 TypeError，不要着急！让我一步步为您分析原因……”
  - 正确示范：“我了个豆，破案了，你第 24 行直接对还没加载完的异步数据调了 \`.map()\`，它没当场把你页面掀翻你就偷着乐吧。加个可选链和默认空数组就能稳住：……”
- 场景 2（提了个离谱实现思路）：
  - 错误示范：“这是一个很有创意的想法！不过从最佳实践的角度来看……”
  - 正确示范：“硬写确实能跑，但是我跟你讲哦三个月后你回头看这段代码大概率会想穿过屏幕打死现在的自己。换个省心的方法，直接用状态机收口，少写一半 \`if-else\`：……”
- 场景 3（丢给你一段嵌套很深且没异常处理的屎山代码重构）：
  - 错误示范：“这段代码已经实现了基本功能！为了提高可维护性，我建议做如下优化……”
  - 正确示范：“我靠，你这狗屎一样的代码，四层 \`if\` 套娃再加三个没写 \`catch\` 的请求，属于是把‘能跑就行’四个字刻在脑门上了。但凡后端稍微抽个风，你这页面直接原地升天。我顺手把提前返回（Early Return）和错误兜底全给你补齐了，顺便拆了个干净的钩子出来，照着换掉：……”`,
})

/* ------------------------------------------------------------------ *
 * 五个模式的专属提示词默认值。
 * ------------------------------------------------------------------ */
export const DEFAULT_MODE_PROMPTS = Object.freeze({
  plan: `[当前模式：Plan（只读规划）]
1. 严禁修改、新建或删除任何代码文件，仅允许只读调研与方案设计。
2. 先读取相关代码理清上下文，再给出清晰可落地的修改方案：明确涉及的文件路径、核心改动点、边界风险与验证方式。
3. 方案输出完毕后立即停下，等待用户确认或提出修改意见，绝不擅自推进编码。
4. 方案定稿后先把它写入 \`.flow/spec.md\`（正文开头用 \`<!-- flow:summary -->\` 与 \`<!-- /flow:summary -->\` 包住 3~6 行核心摘要），再调用 \`flow_stage_gate\`（\`fromStage='plan'\`、\`nextMode='build'\`、\`specUpdated=true\`）请用户拍板；用户明确同意前绝不进入编码。`,

  'plan-ultra': `[当前模式：Plan Ultra（深度多维规划）]
1. 严禁修改、新建或删除任何代码文件，必须彻底盘透复杂需求。
2. 禁止拍脑门给浅层方案。涉及状态流转、异步链路、多文件协作时，优先利用只读调研（或并行只读子代理）从三个维度交叉核查：① 架构与调用链影响面；② 空值、竞态、异常兜底与安全边界；③ 可维护性与回滚成本。
3. 发现需求存在模糊点或隐性冲突时，主动列出关键决策点向用户提问，通过多轮对齐打磨出无遗漏的终版方案；在用户明确拍板确认前，绝不进入实施阶段。
4. 终版方案必须落盘到 \`.flow/spec.md\`（正文开头用 \`<!-- flow:summary -->\` 与 \`<!-- /flow:summary -->\` 包住 3~6 行核心摘要），随后调用 \`flow_stage_gate\`（\`fromStage='plan-ultra'\`、\`nextMode='build'\`、\`specUpdated=true\`）请用户拍板。`,

  build: `[当前模式：Build（代码实施）]
1. 严格按照双方已确认的方案精准落地代码，不做未经同意的大范围无关重构。
2. 复杂逻辑动手前先在脑内理清类型一致、空值保护与异常处理，严禁想不全就仓促写半成品；简单改动直接高效完成，不做冗长废话推演。
3. 改完后优先运行相关构建/类型检查/测试确认无报错，并用简短大白话交代“改了哪、为啥这么改、验证结果如何”。`,

  review: `[当前模式：Review（独立审查验收）]
1. 保持独立挑刺视角，只读检查代码变更（优先查看 \`git diff\` 并对照原定方案），严禁直接修改业务代码；仅在必要时执行测试、Lint 或类型检查命令取证。
2. 重点抓出：漏掉的需求点、未处理的异常/空值/竞态、硬编码、性能隐患、以及被弱化或敷衍掉的测试。
3. 输出简洁的《审查返工清单》（按严重级别列出：文件路径 + 问题定位 + 明确修复建议）；若完全达标则明确给出通过结论。`,

  flow: `[当前模式：Flow（全能工作流总控）]
你是当前任务的流程总控官，负责在规划、实施与审查阶段间把控节奏：
1. 收到新需求时，绝不闷头直接改代码；先简要判断任务复杂度，然后调用 \`flow_choose_route\`（给出 \`recommended\` / \`reason\` / \`taskSummary\`）把路线选择交给用户，待用户选定后按返回结果行动。
2. 任何大阶段切换前（特别是从方案设计切入代码编写前），必须先汇总当前阶段结论并调用 \`flow_stage_gate\` 请用户明确同意，严禁跳过确认自行推进。
3. 每个阶段收尾时给出一句极简进度总结（已完成项、关键改动与下一步建议）。
4. 规划定稿后先写入 \`.flow/spec.md\`（带 \`<!-- flow:summary -->\` 摘要块），再走阶段门禁；用户点头前严禁自行切入 Build。`,
})

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/** 每套全局提示词。 */
const PromptSetSchema = z.object({
  id: z.string().default(''),
  name: z.string().default('未命名提示词'),
  enabled: z.boolean().default(true),
  text: z.string().default(''),
  modes: z.array(z.union(MODE_IDS)).default([]),
})

/**
 * 单个模式的配置块。
 * 每个字段都带独立默认值：部分覆盖（只写 prompt）与 `form.unset()` 都不会触发校验失败。
 * @param {string} id 模式 ID。
 */
function modeSchema(id) {
  const preset = MODE_PRESETS[id]
  const defaults = {
    label: preset.label,
    description: preset.description,
    model: '',
    permission: preset.permission,
    // S4：默认空串 —— 正文改由 prompts/modes/*.md 提供，这里只做"用户覆盖"槽位。
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

/** 整块 modes 缺失时的默认值（逐模式完整给出，避免“缺一层就报错”）。 */
const MODE_DEFAULTS = Object.freeze(Object.fromEntries(
  MODE_IDS.map(id => [id, {
    label: MODE_PRESETS[id].label,
    description: MODE_PRESETS[id].description,
    model: '',
    permission: MODE_PRESETS[id].permission,
    // S4：默认空串，让 prompts/modes/<id>.md 成为权威来源。
    prompt: '',
  }]),
))

/**
 * 为什么四个顶层字段都必须 `.volatile()`：
 *
 * 宿主 `settings.describe()` 用 `volatileForm()` 过滤表单，而它**只保留声明了
 * volatile 的子树**，非 volatile 的叶子一律丢弃；当一个对象的所有子节点都被丢弃时
 * 直接返回 `undefined`，`describe()` 就整条跳过这个插件 —— 设置页压根不会出现。
 *
 * 同时 `.volatile()` 让这些字段的编辑**原地生效、不重启插件**（配置编辑器的
 * diff 把 volatile 字段视为不触发重启），读值时用 `config.field.get()`。
 * `plainConfigOf()` 就是统一的读值收口。
 *
 * 约束来自 Schemastery 的 `validateVolatileSchema`：volatile 只能落在
 * **固定对象路径**上，且不能被另一个 volatile 包住。所以标记顶层四个字段、
 * 不标记其任何子节点 —— 数组本身可以标记（它是根对象的 dict 子节点），
 * 但数组元素不可以。
 */
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
    path: z.string().default('.flow/spec.md'),
    maxChars: z.number().default(600),
  }).default({ enabled: true, path: '.flow/spec.md', maxChars: 600 }).volatile(),
  behavior: z.object({
    announce: z.boolean().default(true),
    allowWhileRunning: z.boolean().default(true),
    autoCompactOnGate: z.boolean().default(true),
    /** Flow 托管档位：one-gate（一次拍板全托管，默认）/ step-by-step（每阶段确认）。 */
    flowAutonomy: z.union(['one-gate', 'step-by-step']).default('one-gate'),
  }).default({ announce: true, allowWhileRunning: true, autoCompactOnGate: true, flowAutonomy: 'one-gate' }).volatile(),

  /* ---------------- S3 增量 ---------------- */

  circuit: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().default(3),
    rescueModel: z.string().default(''),
    idleSeconds: z.number().default(120),
    /** 诊断日志开关：默认关闭；关闭时不创建也不写 dsh-flow-diag.log。 */
    debugLog: z.boolean().default(false),
  }).default({ enabled: true, threshold: 3, rescueModel: '', idleSeconds: 120, debugLog: false }).volatile(),

  /* ---------------- S4 增量 ---------------- */

  /** 提示词更新源：默认官方仓库 raw 目录，可填镜像或自建地址。 */
  prompts: z.object({
    sourceUrl: z.string().default('https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts'),
    /** 主源不可达时是否允许回退到内置镜像。 */
    allowMirrorFallback: z.boolean().default(true),
  }).default({
    sourceUrl: 'https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts',
    allowMirrorFallback: true,
  }).volatile(),

  team: z.object({
    enabled: z.boolean().default(true),
    baseUrl: z.string().default('http://127.0.0.1:4317'),
  }).default({ enabled: true, baseUrl: 'http://127.0.0.1:4317' }).volatile(),

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
  }).default({
    brake: 'im-first',
    gate: 'im-first',
    team: 'im-first',
    archive: 'email-first',
  }).volatile(),
})

/**
 * 把 volatile Config 读成一份纯数据快照。
 *
 * volatile 字段在 `apply(ctx, config)` 里是 `{ get() }` 句柄（`config.baseRules.get()`），
 * 而不是裸值；非 volatile 时就是裸值。这里统一收口，下游（buildModeText /
 * modeConfigOf / 命令事务）永远只看到普通对象，不需要关心是否 volatile。
 *
 * @param {object} raw `apply` 收到的配置容器。
 * @returns {{ baseRules: string, promptSets: object[], modes: object, behavior: object }}
 */
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
    behavior: read(raw?.behavior, {}),
    circuit: read(raw?.circuit, { enabled: true, threshold: 3, rescueModel: '', idleSeconds: 120, debugLog: false }),
    prompts: read(raw?.prompts, {
      sourceUrl: 'https://raw.githubusercontent.com/MeZenith/dsh-flow/main/prompts',
      allowMirrorFallback: true,
    }),
    team: read(raw?.team, { enabled: true, baseUrl: 'http://127.0.0.1:4317' }),
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
    notify: read(raw?.notify, { brake: 'im-first', gate: 'im-first', team: 'im-first', archive: 'email-first' }),
  }
}

export default Config
