# Roblox Cloud CLI

- 本仓库为独立 TypeScript CLI，不修改 Roblox Studio。
- 项目系统记录在 AGENTS.md 与 CLAUDE.md 中保持一致。
- Key、Cookie、真实账号扫描结果不得提交。真实 API 测试显式运行，默认测试离线。

## 命令与业务模块

- 命令入口与输出：`src/cli/main.ts`、`src/cli/output.ts`。
- 游戏目录与模型：`src/universes/`；公共 SDK 入口：`src/index.ts`。
- Roblox API 与 HTTP：`src/roblox/api.ts`、`src/transport/http-client.ts`。
- 凭证与本地存储：`src/auth/`、`src/storage/`；统一错误：`src/core/errors.ts`。

## 验证与文档

- 离线测试与虚构响应样例：`tests/`、`tests/fixtures/`。
- 真实 API 冒烟测试：`scripts/live-smoke.ts`。
- 使用文档与 CI：`README.md`、`.github/workflows/ci.yml`。

## DataStore

- 单条数据读取与跨游戏复制：`src/datastores/entries.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/datastores.test.ts`；本地备份：应用数据目录下的 `datastore-backups/`。

## 本机素材缓存

- 清理模块：`src/cache/assets.ts`；SDK 导出：`src/index.ts`。
- 命令入口：`src/cli/main.ts`；离线验证：`tests/asset-cache.test.ts`。
- 缓存位置：`%LOCALAPPDATA%/Roblox/rbx-storage*` 与 `%TEMP%/Roblox/` 下的 `sounds`、`http`、`http-wob`。

## ProfileService 玩家存档

- 预设、宇宙与玩家解析、批量复制模块：`src/profiles/copy.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/profiles.test.ts`；备份：应用数据目录下的 `datastore-backups/`。

## 游戏图标倒计时

- 文件夹解析、图片校验与节点计划：`src/icons/frames.ts`；上传审核、换图与续跑：`src/icons/countdown.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/icons.test.ts`。
- 本地数据：应用数据目录下的 `icon-countdown/`（`assets.json` 素材缓存、`runs/` 进度、`anchors/` 相对时长锚点、`locks/` 运行锁）。

## 素材原图下载

- 下载与 Decal 纹理引用解析模块：`src/assets/download.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/asset-download.test.ts`；图片保存在用户指定路径或当前目录。

## 玩家清档

- 批量清档模块：`src/profiles/clear.ts`；底层存档读写：`src/datastores/entries.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/profile-clear.test.ts`、`tests/storage-cli.test.ts`；备份：应用数据目录下的 `datastore-backups/`。
