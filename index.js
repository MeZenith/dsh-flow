/**
 * dsh-flow 插件宿主入口（严格命名导出，严禁添加 export default）。
 *
 * 宿主 `Loader.unwrapExports()` 实现为 `exports.default ?? exports`：
 * 若添加 default 导出，会导致 `Config` / `inject` / `name` 全部丢失，设置页消失。
 *
 * @module dsh-flow
 */
export { name, inject, Config, apply } from './src/plugin.js'
