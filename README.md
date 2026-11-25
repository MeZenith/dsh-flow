# dsh-flow

DSH 插件：五大快捷工作流模式 + 分层提示词注入 + 按模式绑定默认模型。

许可：源码可见，**不可商用、可修改、须标注来源** —— 见 [LICENSE](LICENSE)；
`vendor/` 下的第三方组件仍为 MIT，见 [THIRD_PARTY_NOTES.md](THIRD_PARTY_NOTES.md)。

设计依据与逐条 API 核实结论见 [docs/flow-api-research.md](docs/flow-api-research.md)。

## 目录

```
package.json           bundle 清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml       一行 Host 插件；Client 半由 dsh.client 自动发现
index.js               Host 入口：投影 / 提示词 / 命令 / Agent 接线
config.js              Schemastery Config + 全部内置默认正文
modes.js               模式表、白名单、模型 key 编解码、权限映射
mode-plan.js           纯函数：由配置 + 模式算出注入文本
mode-projection.js     flowMode 投影（从 command/run 派生）
prompt-bridge.js       底座 section + 每 Agent 动态 context
commands.js            /flow 命令与切换事务
client.js              Client 半（自包含：模式芯片 + 设置页）
vendor/                内置 Schemastery + cosmokit（见 THIRD_PARTY_NOTES.md）
locale/                meta.title / meta.description / meta.detail
docs/DETAIL.md         插件详情页
```

## 安装

在 DSH 里用插件管理器安装本目录（绝对路径）：

```
插件 → 添加插件 → 选择目录 E:\Admin\Documents\ds工作区\dsh-flow
```

安装会做三件事：把本目录作为依赖写进 profile、把 `cordis.patch.yml` 里的 `flow`
行插入组合、重新加载 profile。**没有构建步骤**，也**没有安装依赖**（`vendor/` 已内置）。

## 启用与验证

1. 打开 **设置 → 插件**，确认出现 `Flow 工作流与提示词管家` 一行，且状态为已启用。
2. 打开 **设置 → Flow 工作流**（左侧设置导航，排在「IM 设置」之后、「Market」之前），
   能看到两个区块：「全局提示词」与「五大模式」，
   且默认已有一套 `哈吉米毒舌搭子`（仅勾选 Build）。
3. 回到任意会话的聊天输入区，`开发权限` 芯片右侧应出现 `普通模式` 芯片。
4. 点开芯片选 `Plan`：
   - 芯片文案变为 `Plan`；
   - 输入区上方权限显示变为只读；
   - 对话里出现一条 `/flow plan` 命令记录；
   - 下一轮回复开始遵守 Plan 的只读规划约束。
5. 在设置页把 Plan 的提示词改一句，返回会话再切一次 Plan，确认注入文本已更新。
6. 点「恢复默认」后重开设置页，该段文本回到内置默认。

## 回滚

`插件 → 移除`（或在 profile 的 `cordis.patch.yml` 里给 `flow` 行加 `disabled: true`）。
模式状态是会话日志里的普通命令事件，移除插件不会破坏任何会话。
