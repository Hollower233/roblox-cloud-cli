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
- Ordered DataStore 只读查榜和按键查分：`src/datastores/ordered.ts`，命令 `datastore ordered list/get`，权限 `universe.ordered-data-store.scope.entry:read`，离线验证 `tests/ordered-datastores.test.ts`。

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

## 自动生成倒计时任务

- 模板与图片合成：`src/icons/render.ts`；线上图标获取、审核、任务状态与调度：`src/icons/tasks.ts`；跨进程锁：`src/icons/lock.ts`。
- CLI 接入：`src/cli/commands/icon-tasks.ts`、`src/cli/main.ts`；SDK 导出：`src/index.ts`。命令：`icon generate/countdown/status/now/restore/resume`；旧文件夹模式保持兼容。
- 默认每小时 24h..1h，再 30/15/10/5/1 分钟，加 SOON/NOW，共 31 张；每次从线上当前 Icon 获取底图，内置 SVG／固定字体转路径／35% 遮罩。
- 流程：审核全部素材后自动倒计时 → SOON；人工 NOW 停止后续倒计时；`--restore-at` 独立固定恢复，无条件切回保存的原素材。手动恢复结束任务，恢复优先于过期节点。调度进程需持续运行，中断后 `resume`。
- 本地：`icon-countdown/tasks/`、`generated/`、`generated-assets/`、`locks/`；不提交真实素材与账号结果。
- 离线：`tests/icon-tasks.test.ts`；显式真实写测试：`scripts/icon-tasks-smoke.ts`，环境变量 `RBX_LIVE_GENERATED_ICON_UNIVERSE`，命令 `npm run test:live:icons`。

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

- 固定 18 种语言：`src/localization/languages.ts`，`read/write/enable/sync/import` 都只看这份清单；`localization read --all` 保留实时语言目录。
- 标题简介读写与支持语言管理：`src/localization/game-info.ts`。
- 源语言标题／简介由 `localization write` 自动定位 Universe 的 `rootPlace`，通过 Cloud Update Place 修改；不要直接 PATCH Universe 的 `displayName`。其他语言继续走本地化接口。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/localization.test.ts`；真实只读验证：`scripts/localization-smoke.ts`。
- 本地备份：应用数据目录下的 `localization-backups/`；使用文档：`README.md`。

## 倒计时诊断日志

- CLI 诊断模块：`src/cli/countdown-log.ts`；接入：`src/cli/main.ts`。
- 本地诊断：应用数据目录下的 `icon-countdown/logs/*.diagnostic.ndjson`。
- 离线验证：`tests/countdown-log.test.ts`。

## Configs 与 A/B 实验

- 配置草稿、发布与历史恢复：`src/configs/repository.ts`；实验及异步操作：`src/experiments/experiments.ts`。
- 公共请求回执与备份：`src/cloud/common.ts`；命令上下文：`src/cli/context.ts`；命令注册：`src/cli/commands/`。
- CLI：`configs`、`experiments`；SDK 导出：`src/index.ts`。仅管理 InExperienceConfig 和游戏内配置实验。
- 离线验证：`tests/configs.test.ts`、`tests/experiments.test.ts`、`tests/cloud-cli.test.ts`；显式真实只读验证：`scripts/cloud-management-smoke.ts`。
- 本地备份：应用数据目录下的 `config-backups/`、`experiment-backups/`。发布必须提供审阅的草稿哈希；异步未完成保留操作 ID，不重试写入。

## Place 服务器人数上限

- 模块：`src/universes/places.ts`；CLI：`src/cli/commands/places.ts`，命令 `places list/update --universe <id-or-name>`；SDK 导出：`src/index.ts`。
- `update` 必须且只能选择 `--place <id>` 或 `--all`，`--max-players` 为正整数；仅更新 Cloud Place 的 `serverSize`，权限 `universe.place:write`。写前读原值、写后回读；批量逐项报告，失败退出码 3，不自动重试写入，不关闭 Studio 或重启服务器。
- 离线：`tests/places.test.ts`；显式真实写验证：`scripts/places-smoke.ts`，环境变量 `RBX_LIVE_PLACES_UNIVERSE`，命令 `npm run test:live:places`。原值备份在应用数据目录 `place-backups/`，测试后恢复。

## 服务器重启

- 重启模块：`src/universes/restart.ts`；命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- `servers restart --universe <ID>` 默认立即重启所有活跃 Place 的旧服。`--all` 纳入当前版本，`--countdown` 由 Roblox 延迟一分钟。
- `servers status --universe <ID>` 通过只读重启影响预估接口汇总活跃服务器和预计受影响的旧服。
- 离线验证：`tests/server-restart.test.ts`；使用文档：`README.md`。

## 游戏内本地化表

- Studio 本地化表 `.rbxm` 读写：`src/localization/rbxm.ts`、`src/localization/lua-table.ts`、`src/localization/table.ts`；主表（en/zh）只读，语言子模块由 CLI 生成。
- 云端翻译表、开启本地化：`src/localization/cloud-table.ts`；同步与首次导入：`src/localization/sync.ts`；DeepSeek 客户端与批量翻译：`src/translation/deepseek.ts`。
- CLI：`localization init/enable/sync/import/export/show`、`deepseek auth/models/config`（`src/cli/commands/localization-table.ts`）；SDK 导出：`src/index.ts`。
- 云端只增改通用条目（无 Key、无 Context），从不发送 delete；`sync` 只处理已启用语言与固定清单的交集，写出 `.rbxm` 时删除清单外语言；推送前备份到 `localization-backups/table-*.json`。DeepSeek Key 存 `deepseek.dpapi`，模型配置 `deepseek.json`，译文缓存 `localization-cache/translations.jsonl`。
- 离线验证：`tests/localization-table.test.ts`。

## 打开 Studio 项目

- 启动与会话识别：`src/studio/launch.ts`；命令 `studio open [game] [--place <id>] [--no-wait] [--timeout <s>]`、`studio list`（`src/cli/main.ts`）；SDK 导出：`src/index.ts`。仅 Windows，不需要 API Key。
- 目标解析优先用游戏目录的 `rootPlaceId`（扫描/刷新时从 Cloud v2 Universe 的 `rootPlace` 记录），缺失时走公开 `develop.roblox.com` / `apis.roblox.com/universes/v1/places/{id}/universe`。
- 已打开同 Place 的编辑会话（命令行 `-task EditPlace -placeId`）只切前台；否则用 `Versions` 下最新 `RobloxStudioBeta.exe -task EditPlace -placeId -universeId` 启动，窗口标题变为 `* - Roblox Studio` 视为加载完成。参数未公开文档化。
- `studio close [games...] [--place] [--pid] [--all] [--force] [--timeout]`：默认软关闭（CloseMainWindow，Studio 自行弹保存提示，超时未关返回 `pending`），`--force` 结束编辑器及 `-editpid` 指向它的 Team Test 进程；`--all` 不可与 `--force` 同用。
- 离线验证：`tests/studio.test.ts`。

## Studio Publish As

- 目标解析、查重、发布编排与版本复核：`src/studio/publish-as.ts`；界面自动化脚本：`src/studio/publish-as.ps1`（仅 ASCII，参数为 base64 JSON，stdout 输出一行 `@@RESULT {json}`，进度写 stderr），构建时复制到 `dist/studio/`。
- 命令 `studio publish-as --to <game> (--place <place> | --new) [--pid] [--dry-run] [--debug-dir]`（`src/cli/main.ts`）；SDK 导出：`src/index.ts`。仅 Windows、英文 Studio 界面。
- 脚本注意：PowerShell 变量名不区分大小写，新增变量不得与已有变量（含 `$script:` 作用域）同名。
- 复核：覆盖用 Assets API 版本号（`asset:read`），新建用 Place 目录新增 ID；点击按钮前失败必未发布。
- 离线验证：`tests/studio-publish-as.test.ts`；真实界面只用 `--dry-run` 验证，真实发布需用户明确要求。

## 开发者产品同步

- 接口、表解析、分页：`src/devproducts/products.ts`；diff 计划、确认码、执行与备份：`src/devproducts/sync.ts`；通用行解析 `parseRecordRows`：`src/localization/lua-table.ts`。
- CLI：`src/cli/commands/devproducts.ts`，命令 `devproduct list <游戏>`、`devproduct sync <游戏...> --source <rbxm> [--confirm <token>]`；SDK 导出：`src/index.ts`。
- 来源为 Studio `项目文档/开发者产品` 的 `{ en, zh, price }` 行，单向推送；按 en 匹配改价，匹配不上先复用表外商品（ProductId 升序）再新建；重名或列表拉不全则拒绝该宇宙。
- 出现 reuse 时整批不写，返回 `confirmation_required` + `confirmToken` + `agentInstruction`，退出码 6；确认码绑定表与云端快照，变化即失效。写后回读最终一致，不符时按 READBACK_DELAYS_MS 重读（只重读不重写）。权限 `developer-product:read/write`。
- 离线：`tests/devproducts.test.ts`；真实写：`scripts/devproducts-smoke.ts`，环境变量 `RBX_LIVE_DEVPRODUCTS_UNIVERSE`，命令 `npm run test:live:devproducts`。备份：应用数据目录 `devproduct-backups/`。
