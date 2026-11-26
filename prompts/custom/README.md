# 自定义目录（已外迁）

> **v0.5.1 起，用户私有提示词不再放在插件包内。**
>
> 新位置（按优先级）：
> 1. 配置 `prompts.customDir` 指定的目录；
> 2. `$DSH_PROFILE_DIR/data/dsh-flow/prompts/custom/subagents`；
> 3. `~/.dsh-flow/prompts/custom/subagents`（默认）。

旧版本放在本目录（`<plugin>/prompts/custom/subagents`）的文件，会在插件启动时**一次性无损迁入**新目录：
目标已有同名文件不覆盖，旧文件也不删除。确认迁移无误后，你可以自行清理本目录下的旧文件。

- `subagents/<id>.md`：子代理覆盖层。与官方同名时优先使用私有版本；官方文件永不被修改。
- `subagents/README.md`：自定义子代理目录。存在时替代官方目录；删除即恢复默认。
- 一键更新只同步官方 `prompts/` 目录，**永远不碰私有目录**。

文件名为 `README.md` 以外的其他 `.md` 均被视为子代理正文，请在子代理面板中创建与编辑。
