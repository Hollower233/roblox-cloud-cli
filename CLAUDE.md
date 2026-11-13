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
- 命令示例、权限、JSON 输出、退出码与备份恢复见 [命令参考](docs/cli-reference.md)。项目概览见 [README](README.md)。
- CI：`.github/workflows/ci.yml`。

## API Key 权限诊断

- 功能权限清单与差异检查：`src/auth/permissions.ts`；完整 Key 检查：`RobloxApi.inspectKey()`，保留资源范围且不拒绝禁用／过期状态；`identity()` 继续拒绝无效状态。
- CLI：`src/cli/commands/auth-permissions.ts`，命令 `auth permissions/check [--for <feature>]`；check 支持 `--universe <id-or-name>`、`--datastore <name>`；SDK：`permissionFeatures`、`checkKeyPermissions`。
- 清单离线；check 仅 introspect、不执行业务写操作，不把资源未知或配置通过视为真实业务访问已验证。退出码：0 配置通过，3 缺失／范围不匹配／未确认，4 Key 禁用或过期／无凭证，5 检查被拒绝。
- 离线验证：`tests/auth-permissions.test.ts`，虚构响应 `tests/fixtures/key-introspection.mjs`。新增 API 功能时同步维护权限清单。

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
- 离线验证：`tests/datastores.test.ts`、`tests/profile-history.test.ts`。

## 玩家封禁

- 封禁与解封模块：`src/moderation/restrictions.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/restrictions.test.ts`。

## 玩家清单

- 玩家清单与查找模块：`src/players/catalog.ts`；玩家解析接入：`src/profiles/copy.ts`。
- 本地存储：`src/storage/store.ts`；数据：应用数据目录下的 `players.json`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/players.test.ts`。

## 群组角色管理

- 角色查询、成员查询与批量添加/移除模块：`src/groups/roles.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/groups.test.ts`。

## 游戏标题与简介本地化

- 固定 18 种语言：`src/localization/languages.ts`，`read/write/enable/sync/import` 都只看这份清单；`localization read --all` 保留实时语言目录。
- 标题简介读写与支持语言管理：`src/localization/game-info.ts`。
- 源语言标题／简介由 `localization write` 自动定位 Universe 的 `rootPlace`，通过 Cloud Update Place 修改；不要直接 PATCH Universe 的 `displayName`。其他语言继续走本地化接口。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`。
- 离线验证：`tests/localization.test.ts`；真实只读验证：`scripts/localization-smoke.ts`。
- 本地备份：应用数据目录下的 `localization-backups/`。

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
- 离线验证：`tests/server-restart.test.ts`。

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

- 目标解析、查重、发布编排与版本复核：`src/studio/publish-as.ts`；界面自动化脚本：`src/studio/publish-as.ps1`，共享助手 `src/studio/studio-ui.ps1`，运行器 `src/studio/ui-script.ts`（脚本均仅 ASCII，参数为 base64 JSON，stdout 输出一行 `@@RESULT {json}`，进度写 stderr），构建时复制全部 `.ps1` 到 `dist/studio/`。
- 命令 `studio publish-as --to <game> (--place <place> | --new) [--pid] [--dry-run] [--debug-dir]`（`src/cli/main.ts`）；SDK 导出：`src/index.ts`。仅 Windows、英文 Studio 界面。
- 脚本注意：PowerShell 变量名不区分大小写，新增变量不得与已有变量（含 `$script:` 作用域）同名。
- 复核：覆盖用 Assets API 版本号（`asset:read`），新建用 Place 目录新增 ID；点击按钮前失败必未发布。
- 离线验证：`tests/studio-publish-as.test.ts`；真实界面只用 `--dry-run` 验证，真实发布需用户明确要求。

## Studio 带版本备注保存

- 编排、校验与本地账本：`src/studio/save-notes.ts`；界面脚本：`src/studio/save-notes.ps1`（共享 `studio-ui.ps1`）。
- 命令 `studio save --title <t> [--details <d>] [--pid] [--dry-run] [--debug-dir]`（`src/cli/main.ts`）；SDK 导出：`src/index.ts`。仅保存到当前 Place、不发布；仅 Windows、英文 Studio 界面。
- 打开顺序：UIA Invoke 菜单项 → 键盘+OCR 菜单 → 前台 `Ctrl+Alt+S`；菜单项置灰（Play Test 中）直接失败。字段按 OCR 标签版面定位，Save 按亮蓝像素识别。
- 不做线上回读、不需要 API Key：Save 后对话框关闭即成功；Team Create 下备注挂到当前最新版本。账本：应用数据目录 `place-versions/<PlaceId>.jsonl`。
- 离线验证：`tests/studio-save-notes.test.ts`；真实界面只用 `--dry-run` 验证，真实保存需用户明确要求。

## 游戏活动

- 活动模型、校验、分页与写入回读：`src/events/events.ts`；图片上传与异步操作查询：`src/events/images.ts`；结果持久化：`src/events/receipts.ts`。
- CLI：`src/cli/commands/events.ts`，命令 `events categories/list/get/create/update/delete/upload-image/image-operation`；SDK：`GameEvents`、`uploadEventImage`、`getEventImageOperation`，由 `src/index.ts` 导出。仅管理游戏活动，不包含旧版更新通知；API 为 Experimental。
- 活动 ID 超过 2^53，必须用十进制字符串，不使用普通 `id()` 或 Number；其他 ID 继续要求安全整数。时间必须带时区；PATCH 只发送显式字段，单端时间修改与原时间合并校验。创建、修改后核对回读字段及 `allThumbnailsCreated`，删除以 204 确认；不自动重试写入，结果不明返回 `unverified`、退出码 3。
- 图片分步上传，显式指定 User/Group creator；PNG/JPEG 转 PNG，通过 Assets API 上传，返回 mediaId 供 `--thumbnail` 绑定。保留未完成操作 ID，`image-operation` 只读查询；上传完成及引用核对不代表审核通过或正常显示。活动权限 `universe.event:read/write`；图片 `asset:read/write`。
- CLI 写前备份与写后回执：应用数据目录 `event-backups/`（原配置/请求、`.result.json`；图片另存 `.png`、已接受操作 `.operation.json`）。删除备份不能恢复原活动 ID 或 RSVP；SDK 活动备份目录可选，图片上传必须提供备份目录。
- 默认列表为进行中及未来活动，`--all` 包含结束活动；完整翻页并拒绝循环游标。离线验证：`tests/events.test.ts`，仅虚构数据，不运行真实写入。
- 文本规则唯一源头：`src/events/rules.ts`；`events rules` 离线显示规则与来源，SDK 导出 `eventRules/eventTextSummary/validateEventText`。按官方 Dashboard 前端快照（2026-11-13）校验 title/subtitle/description 的 25/25/1000 UTF-16 单位上限，emoji、变体符、连接符计入；不自动截断或改写。CLI 参数／文件与 SDK 同步校验，超限早于请求；CLI 创建修改回执 `validation` 显示已提供字段的长度与剩余量，声明本地校验不包含服务端审核。400 文本异常提示规则，不断言必为超长；HTTP 诊断脱敏且限制输出长度。

## 开发者产品同步

- 单产品默认图标上传：`src/devproducts/icon.ts`，命令 `devproduct icon <游戏> <productId> --image <path> [--dry-run]`，SDK `uploadDeveloperProductIcon`。PNG/JPEG 等比缩小至 512×512 内，保留透明度；PATCH 只发 `imageFile`，写前备份配置与上传 PNG，写后回读图标 ID，最多 5 次，只读重试。仅 ID 变化且 `iconStatus=configured` 时为 `verified`，只表示引用变更并排除已知占位图，不代表审核通过或显示正常；占位图继续回读，最终仍为占位图时报 `ICON_PLACEHOLDER`，未确认退出码 3。权限 `developer-product:read/write`；离线 `tests/devproduct-icon.test.ts`。

- 图标 ID 分类：`src/devproducts/products.ts`，SDK `classifyDeveloperProductIcon` 与类型 `DeveloperProductIconStatus`。`DeveloperProduct.iconStatus` / `devproduct list` 区分 `missing`（空或 0）、`placeholder`（已知占位图 ID 集合，目前 `88963008124478`）、`configured`（其他非空 ID，显示未验证）；保留非零原 ID，不额外请求缩略图、不新增权限，查询退出码不受图标状态影响。不得仅凭非空 ID 断言正常图标；清单不是官方完整默认 ID 表。离线 `tests/devproducts.test.ts`。

- 接口、表解析、分页：`src/devproducts/products.ts`；diff 计划、确认码、执行与备份：`src/devproducts/sync.ts`；通用行解析 `parseRecordRows`：`src/localization/lua-table.ts`。
- CLI：`src/cli/commands/devproducts.ts`，命令 `devproduct list <游戏>`、`devproduct sync <游戏...> --source <rbxm> [--confirm <token>]`；SDK 导出：`src/index.ts`。
- 来源为 Studio `项目文档/开发者产品` 的 `{ en, zh, price }` 行，单向推送；按 en 匹配改价，匹配不上先复用表外商品（ProductId 升序）再新建；重名或列表拉不全则拒绝该宇宙。
- 出现 reuse 时整批不写，返回 `confirmation_required` + `confirmToken` + `agentInstruction`，退出码 6；确认码绑定表与云端快照，变化即失效。写后回读最终一致，不符时按 READBACK_DELAYS_MS 重读（只重读不重写）。权限 `developer-product:read/write`。
- 离线：`tests/devproducts.test.ts`；真实写：`scripts/devproducts-smoke.ts`，环境变量 `RBX_LIVE_DEVPRODUCTS_UNIVERSE`，命令 `npm run test:live:devproducts`。备份：应用数据目录 `devproduct-backups/`。
