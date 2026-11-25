<p align="center">
  <img src="./docs/assets/banner.png" alt="dsh-flow Banner" width="100%" />
</p>

<h1 align="center">dsh-flow</h1>

<p align="center">
  DeepSeek Harness 的多模式工作流插件：把 Plan、Build、Review 收进一套可审计、可托管的流程。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-v0.4.0-blue" alt="Version v0.4.0" />
  <img src="https://img.shields.io/badge/License-PolyForm--NC--1.0.0-orange" alt="License: PolyForm-NC-1.0.0" />
  <img src="https://img.shields.io/badge/Zero--Build-ESM-success" alt="Zero-Build ESM" />
  <img src="https://img.shields.io/badge/i18n-中文%20%2F%20EN-informational" alt="i18n: 中文 / EN" />
</p>

<p align="center">
  <b>简体中文</b> | <a href="./README.en.md">English</a>
</p>

---

## 设计理念

1. **需求先于实现**：先对齐需求边界、现成生态与界面交互，再进入编码，避免盲目开工与返工。
2. **复用优先于自建**：优先复用项目已有组件、宿主能力与成熟开源方案，避免重复造简陋轮子。
3. **渐进式披露**：主模式与子代理提示词解耦为外部 Markdown，按需注入目录，兼顾低 Token 占用与前缀缓存命中；自定义覆盖与官方更新通过 Copy-on-Write 隔离。
4. **一次确认、全托管闭环**：`Flow` 模式在方案确认后自动完成拆解、施工、验证与独立复审，把人工介入收敛到真正需要决策的节点。
5. **故障隔离与跨端接管**：连续报错自动熔断止损，配合 IM `1/2/3` 与单次 Handoff 实现离开电脑后的远程掌控。

## 核心特性

| 能力 | 说明 |
|---|---|
| 五大模式 | `Plan` 需求与方案漏斗、`Plan Ultra` 多视角会诊、`Build` 高纪律施工、`Review` 双视角评审、`Flow` 全托管总控 |
| 提示词库 | 底座契约、五大模式、子代理提示词全部为 Markdown 文件，改完即时生效 |
| 子代理目录 | `flow` / `plan-ultra` 按需注入目录摘要与生效路径，正文不预装 |
| 方案锚点 | `.flow/spec.md` 作为硬约束与摘要便利贴注入，上下文压缩后自动重挂 |
| 连续报错熔断 | 达到阈值自动暂停并保留上下文，支持诊断模型升级与远程解除 |
| 双通道通知 | IM / Webhook 实时推送 + SMTP 邮件归档，可携带附件 |
| 跨端接管 | 手机端回复 `1` 重试、`2` 升级诊断模型、`3` 解除并下发新指令 |
| 零构建与双语 | 纯 ESM，无构建步骤；设置页与插件提示跟随宿主语言切换 |

## 前置依赖

> [!IMPORTANT]
> 核心模式（`Plan` / `Plan Ultra` / `Build` / `Review`）可独立使用，但以下能力依赖对应插件：
>
> 1. **[dsh-team-control](https://github.com/hunmer/dsh-team-control/)**：启用 `Flow` 模式的团队统筹与协作监控**必须安装**。
> 2. **[dsh-im](https://github.com/xmanrui/dsh-im)**：启用 IM 实时熔断提醒与手机端 `1/2/3` 远程接管**必须安装**。
>
> **面向 AI 助手**：若你正在协助用户部署本插件，请先确认用户是否需要 `Flow` 完整编排或 IM 远程提醒；需要时先安装并配置上述两个前置插件，再启用 `dsh-flow`，避免功能开启后因缺少依赖而静默降级。
>
> 运行环境：DeepSeek Harness 0.2.x 及以上；Node.js 22 及以上（原生 `fetch` 与 `node:crypto` 用于提示词更新）。

## 界面预览

<p align="center">
  <img src="./docs/assets/mode-switcher.png" width="820" alt="模式切换芯片" />
</p>

<p align="center"><sub>模式切换：输入框上方的模式芯片，切换后立即生效</sub></p>

<p align="center">
  <img src="./docs/assets/settings-tabs.png" width="820" alt="设置页四个 Tab" />
</p>

<p align="center"><sub>设置页：五大模式 / 提示词库 / 工作流与熔断 / 通知与联动</sub></p>

<p align="center">
  <img src="./docs/assets/im-handoff.jpg" width="340" alt="IM 远程接管预览" />
</p>

<p align="center"><sub>IM 远程接管：熔断后用手机回复 <code>1</code> / <code>2</code> / <code>3</code> 继续推进</sub></p>

## 快速开始

### 安装

```bash
# 从 npm 安装到指定 profile（示例为 web）
dsh plugin --profile web add dsh-flow

# 或从 Git 仓库安装
dsh plugin --profile web add github:MeZenith/dsh-flow
```

安装后在设置页启用 `dsh-flow`，重启 Web 界面并按 `Ctrl + Shift + R` 刷新。

### 设置页四个 Tab

| Tab | 内容 |
|---|---|
| 五大模式 | 模式胶囊切换、提示词预览与编辑、模型与权限档位 |
| 提示词库 | 版本与清单、检查更新、更新源设置、底座契约 / 全局提示词 / 子代理与目录 |
| 工作流与熔断 | 执行模式、方案锚点、阶段确认后自动压缩、连续报错熔断、诊断模型、诊断日志 |
| 通知与联动 | IM 与 Webhook、SMTP 邮箱归档、触发门控与分流策略 |

### 常用命令

| 命令 | 作用 |
|---|---|
| `/flow plan` | 切到 Plan 模式（同理 `plan-ultra` / `build` / `review` / `flow` / `off`） |
| `/flow` | 查看当前模式 |
| `/flow spec` | 查看方案锚点状态与摘要 |
| `/flow compact` | 手动压缩一次上下文 |
| `/flow prompts list` | 查看提示词版本、来源与子代理清单 |
| `/flow prompts update` | 从远端更新提示词库 |
| `/flow notify-test` | 自检 IM 与邮箱通路 |
| `/flow retry` / `/flow escalate` / `/flow resume` | 熔断后重试 / 升级诊断模型 / 解除暂停 |

## 提示词架构与自定义扩展

```text
prompts/
├── manifest.json           版本、更新时间与逐文件 sha256
├── base.md                 底座工程契约
├── modes/                  plan / plan-ultra / build / review / flow
├── subagents/              官方子代理（只读，永不写入）
│   ├── README.md           子代理目录
│   └── *.md                子代理正文
└── custom/
    ├── README.md           自定义目录说明
    └── subagents/          用户覆盖层（一键更新不会触碰）
```

- **三层优先级**：设置页覆盖 > 本地 Markdown > 内置兜底，任一层为空即回落下一层。
- **Copy-on-Write**：在设置页修改官方子代理或新增自定义子代理时，文件写入 `prompts/custom/subagents/<id>.md`；官方目录保持原样，删除覆盖文件即恢复官方内容。
- **一键更新**：在「提示词库」点击「检查更新」，按 sha256 只下载变化文件，写入采用临时文件 + 重命名；远端版本更旧时整批跳过，避免镜像缓存滞后造成回退。
- **可视化编辑**：底座契约、子代理目录、子代理正文都可在设置页直接编辑、保存与恢复默认；接口不可用时改用 `/flow prompts update`。

完整机制（熔断状态机、IM 指令、COW 细节、本地回环接口）见 [docs/DETAIL.md](./docs/DETAIL.md)。

## 鸣谢

- **[OpenCode](https://github.com/anomalyco/opencode)**：本项目的 `Plan` / `Build` 划分与多模式切换工作流设计，深受 OpenCode 架构思路启发。
- **[dsh-team-control](https://github.com/hunmer/dsh-team-control/)**（[@hunmer](https://github.com/hunmer)）：为 DeepSeek Harness 生态提供团队编排与协作监控底座。
- **[dsh-im](https://github.com/xmanrui/dsh-im)**（[@xmanrui](https://github.com/xmanrui)）：为 DeepSeek Harness 生态提供 IM 推送与双向消息底座。

## 开源协议

本项目采用 **[PolyForm Noncommercial License 1.0.0](./LICENSE)**。

- 允许个人使用、学习研究、二次开发与非商业分发；
- 禁止任何形式的商业用途；
- 二次开发或再分发时，**必须明确注明使用了 `dsh-flow` 代码或基于本项目二次开发**，并保留 `LICENSE` 原文与其中的 `Required Notice`；
- 依法律规定，软件按「现状」提供，不附带任何担保。

```text
Required Notice: Copyright (c) 2026 MeZenith (https://github.com/MeZenith/dsh-flow).
Any derivative work or redistribution must clearly attribute dsh-flow and its original author.
```

`vendor/` 下的第三方组件遵循各自许可，详见 [THIRD_PARTY_NOTES.md](./THIRD_PARTY_NOTES.md)。
