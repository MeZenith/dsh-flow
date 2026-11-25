# 第三方代码说明

本插件在 `vendor/` 下内置了两份上游代码，目的是让 Host 半**零安装依赖**即可运行，
同时避免本地目录安装为软链接时裸模块解析失败。

| 文件 | 上游 | 版本 | 许可 | 处理 |
|---|---|---|---|---|
| `vendor/schemastery.mjs` | `@deepseek-ai/schemastery` | 3.18.5 | MIT | 原样复制 `lib/index.mjs`，仅把 `from "@deepseek-ai/cosmokit"` 改写为 `from "./cosmokit.mjs"` |
| `vendor/cosmokit.mjs` | `@deepseek-ai/cosmokit` | 1.8.6 | MIT | 原样复制 `lib/index.js`（该文件本身无任何 import） |

为什么必须内置 Schemastery：宿主 `settings.describe()` 通过
`volatileForm(schema)` 判断一个插件是否出现在设置页 —— 返回 `undefined` 就整条跳过，
而 `volatileForm` 读的是 `schema.meta / schema.type / schema.dict`，并用真正的
`z.object()` 重建表单树。所以插件 Config 必须是真实的 Schemastery 实例。

升级方式：用新版本的 `lib/index.mjs` / `lib/index.js` 覆盖 `vendor/` 下同名文件，
再做一次同样的 import 改写即可。上游均为 MIT，保留其许可声明即符合要求 ——
上游许可原文已随副本放在 `vendor/LICENSE`（MIT，Copyright (c) 2021-present Shigma）。

本项目自身的许可是"源码可见 / 不可商用 / 可修改 / 须标注来源"，见根目录 `LICENSE`；
该限制**不适用于** `vendor/` 下的第三方文件，它们仍然完全按 MIT 授权。
