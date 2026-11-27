# 参与贡献 dsh-flow

欢迎任何形式的贡献！无论是提交 Bug 反馈、优化提示词模板、完善设置界面，还是为 `RemoteHub` 接入新的远程聊天通道（Telegram / 钉钉 / 企业微信 / Slack 等），我们都非常欢迎。

想找轻松上手的切入点，可以直接查看仓库中带有 [`good first issue`](https://github.com/MeZenith/dsh-flow/issues?q=is%3Aopen+label%3A%22good+first+issue%22) 或 [`help wanted`](https://github.com/MeZenith/dsh-flow/issues?q=is%3Aopen+label%3A%22help+wanted%22) 标签的 Issue。

## 本地开发环境

要求：**Node.js >= 22**（项目使用纯 ESM 模块，核心逻辑与前端构建脚本均为零外部构建依赖）。

```bash
# 1. 安装依赖
npm install

# 2. 如果修改了 src/client/*，重新编译根目录 client.js
npm run build:client

# 3. 如果修改了 prompts/*，同步 prompts/manifest.json 校验清单
npm run manifest:sync

# 4. 运行静态检查与全部自动化测试
npm run check && npm test
```

## 核心目录结构（贡献者导览）

| 路径 | 职责说明 | 适合贡献的方向 |
| --- | --- | --- |
| `src/remote/hub.js` & `src/remote/harness-bridge.js` | 传输无关的远程控制中枢（7 大原语 + 统一事件总线） | 接入新的 IM / 远程通道适配器 |
| `src/remote/feishu/` | 官方参考实现：直连飞书指挥官（`client.js` / `router.js` / `reply-stream.js` / `cards.js` / `onboarding.js`） | 飞书富媒体消息、交互卡片、多会话切换增强 |
| `src/modes/` & `src/workflow/` | 五大工作模式、复杂度分级、编号文档（01–07）与 QA 交接 | 工作流规则、文档校验与自动化细节 |
| `src/gates/` & `src/resilience/` | 阶段门禁票据/结算器、连续报错熔断器与 Team SSE 监控 | 门禁交互体验、异常处理与稳定性 |
| `src/client/` | 设置页前端 UI（编译输出为根目录 `client.js`） | 设置面板交互、样式与国际化文案（`src/client/i18n/`） |
| `prompts/` | Markdown 提示词模板（`base.md`、`modes/`、`subagents/`、`docs/`） | 新增垂直领域子代理或优化阶段提示词 |
| `test/` | 基于 `node:test` 的冒烟、单元与集成测试套件 | 补充回归测试与边界用例 |

## 提交 PR 前自检清单

1. 若改动了 `src/client/` 下的前端源码，请运行 `npm run build:client` 更新 `client.js`。
2. 若改动或新增了 `prompts/` 下的提示词文件，请运行 `npm run manifest:sync` 更新 `prompts/manifest.json`。
3. 确保 `npm run check` 与 `npm test` 全部通过（目前共 40 项测试，零失败）。
4. 修复 Bug 或新增功能时，请在 `test/` 下补充或更新对应测试。
5. 请勿提交本地私有调试文件（如 `.flow/`）、真实凭证、App Secret 或任何 Token。
