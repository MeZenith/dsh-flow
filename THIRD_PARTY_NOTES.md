# 第三方代码与开源依赖说明

本插件采用「内置极简 Schema 依赖 + 惰性加载飞书官方 SDK」的双策略，兼顾零构建运行体验与直连飞书能力。

## 1. 内置运行时依赖（`vendor/`）

| 文件 | 上游 | 版本 | 许可 | 处理 |
|---|---|---|---|---|
| `vendor/schemastery.mjs` | `@deepseek-ai/schemastery` | 3.18.5 | MIT | 原样复制 `lib/index.mjs`，仅将 `from "@deepseek-ai/cosmokit"` 改写为 `from "./cosmokit.mjs"` |
| `vendor/cosmokit.mjs` | `@deepseek-ai/cosmokit` | 1.8.6 | MIT | 原样复制 `lib/index.js`（无任何 import） |

上游许可原文已随副本保留在 `vendor/LICENSE`（MIT，Copyright (c) 2021-present Shigma）。

## 2. 外部依赖（`package.json` `dependencies`）

| 包名 | 版本范围 | 许可 | 用途 |
|---|---|---|---|
| `@larksuiteoapi/node-sdk` | `^1.73.0` | MIT | v0.6.0 直连飞书 / Lark 指挥官（扫码建应用 `registerApp`、出站 WebSocket 长连接 `WSClient`、互动卡片回调与文件直传）。通过 `src/remote/feishu/sdk-loader.js` 惰性加载，未安装依赖时主插件仍可正常运行。 |

## 3. 设计参考致谢

- 飞书扫码建应用流程、权限集与 WebSocket 断线重连实践参考了 [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT License）。

---

本项目自身的许可为 PolyForm-Noncommercial-1.0.0（见根目录 `LICENSE`）；该限制**不适用于** `vendor/` 与上述第三方 MIT 开源组件。
