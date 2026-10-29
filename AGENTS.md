# Roblox Cloud CLI

- 本仓库为独立 TypeScript CLI，不修改 Roblox Studio。
- 项目系统记录在 AGENTS.md 与 CLAUDE.md 中保持一致。
- Key、Cookie、真实账号扫描结果不得提交。真实 API 测试显式运行，默认测试离线。
- 将可复用的 Roblox API 操作沉淀为正式 CLI/SDK 能力；实现前先与用户确认目标与边界，避免依赖一次性脚本。

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

## 玩家存档历史

- 历史版本与 ProfileService 摘要模块：`src/datastores/entries.ts`、`src/profiles/history.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/datastores.test.ts`、`tests/profile-history.test.ts`；使用文档：`README.md`。

## 玩家封禁

- 封禁与解封模块：`src/moderation/restrictions.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/restrictions.test.ts`；使用文档：`README.md`。

## 玩家清单

- 玩家清单与查找模块：`src/players/catalog.ts`；玩家解析接入：`src/profiles/copy.ts`。
- 本地存储：`src/storage/store.ts`；数据：应用数据目录下的 `players.json`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/players.test.ts`；使用文档：`README.md`。

## 群组角色管理

- 角色查询、成员查询与批量添加/移除模块：`src/groups/roles.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/groups.test.ts`；使用文档：`README.md`。

## 游戏标题与简介本地化

- 语言目录、标题简介读写与支持语言管理：`src/localization/game-info.ts`。
- 源语言标题／简介由 `localization write` 自动定位 Universe 的 `rootPlace`，通过 Cloud Update Place 修改；不要直接 PATCH Universe 的 `displayName`。其他语言继续走本地化接口。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/localization.test.ts`；真实只读验证：`scripts/localization-smoke.ts`。
- 本地备份：应用数据目录下的 `localization-backups/`；使用文档：`README.md`。

## Configs 与 A/B 实验

- 配置草稿、发布与历史恢复：`src/configs/repository.ts`；实验及异步操作：`src/experiments/experiments.ts`。
- 公共请求回执与备份：`src/cloud/common.ts`；命令上下文：`src/cli/context.ts`；命令注册：`src/cli/commands/`。
- CLI：`configs`、`experiments`；SDK 导出：`src/index.ts`。仅管理 InExperienceConfig 和游戏内配置实验。
- 离线验证：`tests/configs.test.ts`、`tests/experiments.test.ts`、`tests/cloud-cli.test.ts`；显式真实只读验证：`scripts/cloud-management-smoke.ts`。
- 本地备份：应用数据目录下的 `config-backups/`、`experiment-backups/`。发布必须提供审阅的草稿哈希；异步未完成保留操作 ID，不重试写入。
