# Roblox Cloud CLI 命令参考

本手册记录 `rbx` 的命令用法、权限、输出格式与本地数据。项目概览见 [README](../README.md)。

## 安装与启动

需要 Node.js 22.13+（推荐 24）。在仓库目录执行：

```sh
npm ci
npm run build
npm link
rbx --help
```

不安装全局命令也可以执行 `node dist/cli/main.js` 或 `npm run dev --`。

示例中的游戏名、玩家名和目标 ID 均为演示值。执行前请替换为自己的目标。命令需要确认时，请使用它返回的 `confirmToken`。

## 凭证

```sh
rbx auth set
rbx auth status
rbx auth clear
rbx auth permissions
rbx auth permissions --for devproduct-sync
rbx auth check
rbx auth check --for devproduct-sync --universe 123456
rbx auth check --for profile-clear --universe 123456 --datastore Default
```

`auth set` 隐藏输入，联网验证后保存。Windows 使用当前 OS 用户的 DPAPI 加密，明文不会写入工具配置。`auth clear` 删除保存的凭证，保留目录缓存。

已有本地密钥文件时可使用 `rbx auth set --key-file <本地路径>`。此命令不删除原文件。不要把密钥文件加入 Git。

环境变量 `ROBLOX_API_KEY` 优先于保存的凭证，可供 CI、临时测试以及 macOS/Linux 使用。第一版 macOS/Linux 尚未实现持久凭证存储，需使用该环境变量。不要通过命令行参数直接传入密钥。

### 权限清单与 Key 配置检查

`auth permissions` 完全离线，不需要 Key；按功能列出 API 系统说明、精确 scope、操作和资源范围。`--for <feature>` 只显示一个功能；不带筛选时输出全部稳定功能标识及对应命令。API 系统名称为说明性分组，Roblox Dashboard 的显示名称可能不同。不要为了某一项功能直接授予清单中的全部权限。

`auth check` 读取当前生效的 Key，仅调用官方 `POST https://apis.roblox.com/api-keys/v1/introspect` 检查配置，不执行任何业务写操作，也不修改本地凭证或目录。环境变量仍优先于本地 DPAPI。默认按全部功能汇总；推荐指定 `--for`，并为游戏相关功能提供 `--universe <ID或本地目录精确名称>`。DataStore 功能支持 `--datastore <精确名称>`，此参数必须与 `--universe` 一起使用。

结果按每个操作的授权分别匹配，区分：

- `configured`：所需操作已配置，且此项可识别的资源范围覆盖指定目标；不代表真实业务调用已验证成功。
- `missing`：缺少 scope 或对应操作。
- `out-of-scope`：操作存在，但返回的游戏或 DataStore 范围未覆盖目标。
- `unknown`：缺少目标、DataStore 范围信息不全，或需要核实素材所属用户／群组，无法确认资源范围。

Universe 范围支持 `*`；按 Roblox 用户 Key 规则，未设置游戏范围表示不限制游戏。DataStore 限制按同一条 `{ universeId, datastoreName }` 匹配，不能把不同游戏的授权拼接使用；单条范围中省略可选的 `datastoreName` 表示该游戏下全部 DataStore，完全未返回 `universeDatastores` 时不假定全部可访问。素材 Owner 范围保留为 `unknown`。账号、群组角色、素材访问权及接口其他限制仍由 Roblox 校验，检查不会读取玩家实际存档来验证。

复制功能的 `datastore-copy` / `profile-copy` 检查目标游戏的 read/create/update；源游戏单独用 `--for datastore-get` 检查 read。权限清单的注释说明 `--with-values`、源语言修改和旧文件夹图标模式等条件差异；较宽的功能预设不等同于每个子选项的最小权限。

两个命令都支持全局 `--json` 和统一 `{ schemaVersion, status, data, warnings }` 信封。`auth check` 的 `data` 包含 `userId`、`enabled`、`expired`、`keyState`、`source`、`configurationState`、目标与逐功能／逐权限结果，以及始终为 `false` 的 `businessAccessVerified`；不输出 Key。已配置且可识别的范围全部通过时退出 0；缺权限、范围不匹配或范围未确认时退出 3；Key 禁用／过期或无凭证时退出 4；Roblox 拒绝检查时退出 5。禁用／过期的结构化回执仍保留诊断结果（`status: partial`）；无法取得回执时使用统一错误信封。未知功能和无效参数退出 2。

SDK：`permissionFeatures(featureId?)`、`checkKeyPermissions(identity, options?)`、`RobloxApi.inspectKey()`。`inspectKey()` 保留资源范围并返回禁用／过期状态；现有 `identity()` 继续拒绝禁用／过期 Key。离线验证：`tests/auth-permissions.test.ts`。参考：[Key 检查接口](https://create.roblox.com/docs/cloud/auth/api-keys)、[Roblox 权限说明](https://create.roblox.com/docs/cloud/reference/scopes)。

扫描与游戏权限查询需要：

- `legacy-group:manage`：可管理群组查询。
- `legacy-universe:manage`：Universe 管理权限查询。
- `universe:read`：Cloud Universe 元数据读取。

这些名称来自 Roblox 官方接口定义。虽命名为 manage，游戏目录命令调用的相关接口都是只读查询。DataStore 命令另需相应的读取、创建或更新权限。API Key 的 scope 和账号的实际游戏权限是两层约束。

## 游戏目录

```sh
rbx universe scan
rbx universe list
rbx universe list --owner "My Studio" --visibility private
rbx universe list --sort ccu --json
rbx universe list --all
rbx universe add 123456789
rbx universe refresh
```

- `scan`：扫描个人公开游戏与可管理群组的游戏，分页去重，验证权限并补齐状态、Owner 和 CCU，保存到本地。
- `list`：只读取本地缓存，不访问网络或读取密钥。默认只显示缓存中 `canManage=true` 的记录；`--all` 包含未知或无管理权限的记录。
- `add`：检查给定 Universe 的管理权限，加入手动登记列表。用于补充扫描未覆盖的游戏；再次扫描会保留登记信息。
- `refresh`：更新已知游戏的权限与信息，不重新扫描群组。

`--owner` 支持 Owner ID 或名称子串，`--visibility` 支持 public/private/unknown，`--sort` 支持 name/ccu。`--user-id` 可选择另一份已经缓存的账号目录。

**覆盖限制：个人私密游戏不自动发现。** 实测个人游戏接口的其他筛选值返回 501；群组接口 `accessFilter=1` 可以返回私密游戏。扫描会通过结构化 warning 明确指出覆盖缺口。已知 ID 可手动添加。直接授予的其他个人创作者游戏协作权限也不由本扫描流程自动枚举。目录代表本次接口发现范围，不声称覆盖所有可能的协作资源。

扫描、刷新和 `add` 会顺带记录每个游戏的根 Place（`rootPlaceId`，来自 Cloud v2 Universe 的 `rootPlace`，私密游戏同样可得），`list` 显示为 ROOT PLACE ID 列；读取失败时保留旧值。

CCU 与公开状态都是采集时的快照。缓存保留 `detailsAt`、`metadataAt`、`permissionsAt`，刷新失败保留旧值与旧时间，不会把未知值转成 0 或私密。权限检查失败不等于无权限。

群组扫描失败保留旧记录并标记 stale；成功扫描但未再发现的旧游戏标记 not-seen，不擅自删除。表格会标明这些记录。`canManage` 只表示缓存时的账号管理权限，不承诺当前 Key 有权执行未来任何写操作。

## 输出契约

所有业务命令支持 `--json`。stdout 只输出一个 JSON 对象，进度写入 stderr；帮助和版本输出使用常规 CLI 格式。

```json
{
  "schemaVersion": 1,
  "status": "partial",
  "data": { "games": [] },
  "warnings": [
    {
      "code": "PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE",
      "message": "Personal private games are not included automatically; use universe add."
    }
  ]
}
```

JSON 内 CCU 保留整数，表格才格式化为 k。错误格式为 `{ "schemaVersion": 1, "status": "error", "error": { "code": "…", "message": "…", "httpStatus": 403 } }`。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功且没有 warning |
| 1 | 网络、存储或其他执行错误 |
| 2 | 参数错误或缺少所需本地目录 |
| 3 | 有可用结果，但存在覆盖缺口或部分失败 |
| 4 | 缺少凭证、凭证无效或过期 |
| 5 | 本次操作被权限拒绝 |
| 130 | 用户取消 |

**正常扫描也可能返回 3**，因为个人私密游戏未覆盖；这不代表缓存保存失败。自动化需接受 0/3 后检查 warnings。`list` 保留缓存中的 warning，也可能退出 3。

## 本地文件

Windows 默认在 `%LOCALAPPDATA%/roblox-cloud-cli/`；其他平台使用 `$XDG_DATA_HOME/roblox-cloud-cli/`，未设置时为 `~/.local/share/roblox-cloud-cli/`。

可使用 `RBX_HOME` 环境变量或全局 `--home <目录>` 覆盖。游戏目录按 Roblox 用户 ID 隔离；玩家清单在同一应用数据目录中共用，切换 Key 后仍然可用。

- `config.json`：当前账号与按账号保存的手动登记 ID。
- `credential.dpapi`：Windows 加密凭证。
- `catalog-<userId>.json`：带 schemaVersion 的游戏目录。
- `players.json`：本地共用的玩家清单（UID、真实用户名、可选别名），不要提交真实玩家数据。
- `.write.lock`：写入锁，包含持有进程 PID；程序正常退出会释放。崩溃遗留时先确认该进程已结束，再手动删除这个锁文件。

单文件写入使用临时文件加原子替换。配置和目录并非跨文件事务；手动添加先保存登记意图，再保存目录，中断后可再次扫描恢复。

## SDK

```ts
import { HttpClient, RobloxApi, CatalogService } from '@hollower233/roblox-cloud-cli';

const key = process.env.ROBLOX_API_KEY!;
const api = new RobloxApi(new HttpClient({ apiKey: key }), key);
const identity = await api.identity();
const catalog = await new CatalogService(api).scan(identity, null);
```

SDK 的业务层依赖 `RobloxGateway` 接口，可以注入 fake API 做离线测试。它不依赖 CLI，也不会自行保存目录。`LocalStore` 和 `CredentialStore` 为可独立使用的适配器。

HTTP 默认按 host 串行安排请求起始时间，间隔 700ms；幂等 GET 在 429/部分 5xx 或网络异常时有限重试。支持 Retry-After；超过 30 秒的服务器冷却时间交由调用方稍后重试。POST、PATCH（含 multipart 上传）不自动重试。禁止 HTTP 重定向携带凭证，只有指定的 apis.roblox.com 请求会附带 Key。

## 开发与验证

```sh
npm run check
npm run build
npm test
npm pack --dry-run
```

默认测试离线，使用虚构 ID 和响应结构。覆盖分页、重复游标、部分失败、权限区别、缓存版本、并发写锁、Windows DPAPI、JSON/退出码及凭证脱敏。

真实 API 冒烟测试需显式执行，使用环境变量 Key、保存的 Key，或 `RBX_LIVE_KEY_FILE` 指定已有本地文件：

```sh
npm run test:live
```

它测试编译后的 CLI，包括 auth status、scan、无 Key 的离线 list、add、refresh 和筛选；目录放在系统临时目录并在结束时清理。需要账号至少有一个可发现且可管理的游戏。不会修改远端游戏或 DataStore。GitHub Actions 仅跑离线测试，覆盖 Windows/Linux 与 Node 22/24。

## 扩展顺序

标准 DataStore 单条读取与跨 Universe 复制已接入；后续发布和分析分别作为业务模块扩展，复用凭证、HTTP、错误、输出和存储适配器。目前不包含动态插件系统。

## DataStore 模块

- 读取与单条复制：`src/datastores/entries.ts`。
- CLI 命令入口：`src/cli/main.ts`；公共 SDK 导出：`src/index.ts`。
- 离线测试：`tests/datastores.test.ts`；备份文件：应用数据目录的 `datastore-backups/`。

## 官方资料

- [API Key 与 introspect](https://create.roblox.com/docs/cloud/auth/api-keys)
- [群组接口](https://create.roblox.com/docs/cloud/reference/features/groups)
- [Universe 接口](https://create.roblox.com/docs/cloud/reference/features/universes)
- [官方 OpenAPI 定义](https://github.com/Roblox/creator-docs/blob/main/content/en-us/reference/cloud/openapi.json)

## 清理本机游戏素材缓存（Windows）

```sh
rbx cache clear
```

此命令无需 API Key，不联网；始终返回一个 JSON 对象（无需 `--json`），不弹窗、不询问、不终止进程。它不清理 CLI 的游戏目录缓存，`--home` 不改变 Roblox 素材缓存位置。

删除前检查 Roblox Studio 和 Player。任意一个仍在运行时，整次清理不执行，退出码为 1。agent 应根据 `code`、`actionRequired` 和 `processes` 提示用户自行关闭相应程序，等待用户关闭后重新调用；不得把 blocked 当成清理完成。

```json
{"schemaVersion":1,"status":"blocked","code":"STUDIO_RUNNING","actionRequired":"close_studio","processes":[{"name":"RobloxStudioBeta","pid":123}],"targets":[]}
```

Player 对应 `PLAYER_RUNNING` / `close_player`。两者都在时优先返回 Studio 动作，`processes` 包含检测到的相关进程。进程检查失败返回 `PROCESS_CHECK_FAILED`，同样不删除文件。

清理范围固定为 `%LOCALAPPDATA%/Roblox/` 下的 `rbx-storage`、`rbx-storage-sc`、`rbx-storage.db`、`rbx-storage.db-wal`、`rbx-storage.db-shm`，以及 `%TEMP%/Roblox/` 下的 `sounds`、`http`、`http-wob`。保留项目、安装目录、插件、配置和其他临时目录；拒绝链接形式的缓存目标。

成功返回 `status: success` / `code: CACHE_CLEARED`，退出码 0；逐项结果在 `targets`，状态为 `deleted` 或 `absent`。遇到占用、访问错误或复查时缓存重新生成，返回 `status: partial` / `code: CACHE_CLEAR_INCOMPLETE`，退出码 3，失败项带系统错误码。agent 应报告残留，不能宣称已完成无缓存测试。

此命令的 JSON 契约在顶层直接返回 `code`、`processes`、`targets`，区别于其他命令的 `data` 包装。非 Windows 返回 `UNSUPPORTED_PLATFORM`；路径缺失或无法检查时也阻止执行。

缓存位置是当前版本的固定清单，未来 Roblox 更新后可能需要调整。成功只表示复查时这些目标不存在；检测后用户重新启动程序仍可能产生新缓存。首次加载测试应清理后直接进入目标游戏。

## 玩家存档复制预设

`profile copy` 默认使用 `profileservice` 预设：DataStore 为 `Default`，Key 为全大写 `PLAYER_{uid}`，scope 为 `global`。这是本项目的命名约定，不是 ProfileService 强制的格式。

```sh
rbx profile copy "Example Production" "Example Development" --players "ExamplePlayerOne,ExamplePlayerTwo"
rbx profile copy 123456789 987654321 --players "12345,67890" --preset profileservice --json
```

跨玩家复制：`--players` 只填一个源玩家，`--to` 指定目标玩家（用户名或 User ID），把源 `PLAYER_{源uid}` 写入目标 `PLAYER_{目标uid}`，并把条目 `userIds` 改写为目标玩家；源、目标游戏可以相同（但不能是同一玩家）。同样先备份目标、写入后回读校验。

```sh
rbx profile copy "Example Production" "Example Development" --players ExamplePlayerOne --to ExamplePlayerTwo
```

源、目标支持 Universe ID 或本地目录中的完整游戏名称（忽略大小写）；重名会报错，需改用 ID。名称解析使用当前缓存账号的目录，必要时先运行 `rbx universe scan` 或 `rbx universe add <UniverseId>`。直接使用两个 Universe ID 不需要本地游戏目录。

`--players` 接受逗号分隔的 Roblox 用户名或 User ID，最多 100 个输入，自动去重。不支持显示名称。所有用户名解析完成后才开始复制；任一用户名不存在会终止，不写入存档。API Key 需要源读取、目标读取和创建/更新权限；用户名查询不会携带 Key。

每位玩家依次执行本地备份、条件覆盖或创建、回读校验；已有目标存档会被覆盖，无额外确认。单个玩家失败后继续处理其他玩家，最终逐人输出结果，成功项包含备份路径；写入阶段失败的信息保留备份路径与写入不确定性提示，重试前应检查目标。该批量操作不是事务，不会自动回滚已完成的玩家。

退出码：全部成功为 0，部分成功为 3，全部复制失败为 1，取消为 130；复制前的参数/认证等错误遵循原有错误契约。JSON 输出的 `data.results` 包含每位已处理玩家的结果，`succeeded`、`failed`、`skipped` 汇总数量；出现逐人失败时报告状态为 `partial`（全部失败同样保留完整批量报告）。

此预设原样复制整条记录及其 attributes/userIds，不清除或改写 ProfileService 会话锁、元数据，也不协调正在运行的游戏服务器。应在相关玩家存档已释放且不会继续保存时复制。不同存储命名仍使用通用 `rbx datastore copy`。

## 列出 DataStore Key

```sh
rbx datastore list 123456789 ExampleStore --prefix PLAYER_ --limit 500
rbx --json datastore list 123456789 ExampleStore --with-values
```

自动按 cursor 翻页；`--limit` 默认不限，`--scope` 默认 `global`。`--with-values` 对每个 Key 逐条读取值（输出 `key<TAB>JSON`）。JSON 输出为 `{ universeId, datastore, count, entries: [{ key, value? }] }`；翻页或读值中途失败但已有结果时状态为 `partial`、退出码 3。API Key 需要 `universe-datastores.objects:list`（读值另需 `objects:read`）。模块：`src/datastores/entries.ts`；离线验证：`tests/datastores.test.ts`。

## 查询 Ordered DataStore 排行榜

```sh
rbx --json datastore ordered list 123456789 ExampleLeaderboard --limit 50
rbx --json datastore ordered get 123456789 ExampleLeaderboard 42
```

两个命令都接受 Universe ID 或本地游戏目录中的游戏名，`--scope` 默认为 `global`。在 Creator Hub 的 Open Cloud API Keys 中，为目标 Universe 给 API Key 授予 `universe.ordered-data-store.scope.entry:read`。查询使用 [Roblox Open Cloud Ordered DataStore](https://create.roblox.com/docs/cloud/guides/data-stores#external-persistent-leaderboard)。

- `list` 默认按分数从高到低取前 50 条，使用 API 的分页令牌继续读取，直至达到 `--limit` 或榜单读完。JSON 的 `data.entries` 为 `[{ key, score }]`，`data.count` 为返回条目数。
- `get` 按原样传入条目键，JSON 的 `data.score` 为分数，条目不存在时为 `null`。榜单名次以 `list` 的排序为准。

TypeScript SDK 提供 `OrderedDataStoreEntries.list()` 和 `OrderedDataStoreEntries.get()`。

## 玩家存档历史与合成审计

只读查询一个玩家的 ProfileService 历史版本，并从各版本累计的物品流水中去重汇总合成事件：

```powershell
rbx profile history "Example Production" --player ExamplePlayer --limit 10
rbx --json profile history 123456789 --player 12345 --limit 25
```

游戏支持 Universe ID 或本地目录中的完整名称；玩家支持一个用户名或 User ID。`--limit` 范围为 1–100，默认读取最新 10 个 Roblox 仍保留的版本。命令固定读取 `Default` / `global` / `PLAYER_{uid}`，不会写入、恢复或备份存档。

普通输出逐版本显示时间、货币、经验、物品数和 RPS 战绩，并列出去重后的 `fusion` 流水。JSON 输出保留版本 ID、数据摘要、合成事件 ID、时间、被消耗实例 ID、生成实例 ID及结果物品 ID，便于结合游戏配置表审计具体品质和显示名称。

API Key 需要 `universe-datastores.versions:list` 和 `universe-datastores.objects:read` 权限（版本列表使用旧接口，版本内容实际通过 Cloud v2 entry 读取）。历史版本由 Roblox 保留策略决定；未出现在接口结果中的旧版本无法由本命令恢复。模块：`src/profiles/history.ts`、`src/datastores/entries.ts`；离线验证：`tests/profile-history.test.ts`、`tests/datastores.test.ts`。

## 玩家清档

按游戏名（本地目录中的完整名称）或 Universe ID，删除指定账号的玩家存档：

```powershell
# 只读预览：调用 API 检查存档，不删除、不创建备份
node --import tsx src/cli/main.ts profile clear "Example Development" --players "ExamplePlayerOne,ExamplePlayerTwo" --dry-run

# 正式清档：先备份，再删除并回读校验
node --import tsx src/cli/main.ts profile clear 987654321 --players "12345,67890"

# 机器可读结果
node --import tsx src/cli/main.ts --json profile clear 987654321 --players "12345,67890"
```

支持 `--preset profileservice`（默认）：仅处理 `Default` / `global` / `PLAYER_{uid}`，不清空整个 DataStore，不涉及其他游戏、排行榜或其他 Key。账号可以混用用户名和 User ID，解析后去重。API Key 需要目标游戏的 `universe-datastores.objects:read` 和 `universe-datastores.objects:delete` 权限。

**先让相关玩家离线并确保服务器已释放存档，执行期间不要重新进入。** 命令发现 `MetaData.ActiveSession` 或 `MetaData.ForceLoadSession` 时拒绝清档，不提供强制绕过。删除后，下次进入通常由游戏自己的初始化逻辑创建新档。

每条已有存档都先备份完整原始 JSON、版本、attributes 和 userIds 到应用数据目录的 `datastore-backups/`；备份失败不删除。删除前再次检查版本及内容，发生变化则拒绝删除。Roblox DELETE 接口不支持 `matchVersion`，这次检查不能消除检查与删除之间的并发窗口，不能替代玩家离线。删除请求不自动重试，之后回读确认不存在；失败会保留备份，并提示删除可能已经发生。备份仅保存在本机，当前未提供自动恢复命令。

结果 `cleared` 表示已删除并校验不存在，`missing` 表示原本无存档（不创建备份），`would-clear` 表示预览发现可清理存档。单个账号失败不会阻止其他账号；JSON 包含逐账号结果、备份路径和成功/失败/跳过数量。全部失败退出码为 1，部分失败为 3，取消为 130。

模块：`src/profiles/clear.ts`、`src/datastores/entries.ts`；离线验证：`tests/profile-clear.test.ts`、`tests/storage-cli.test.ts`。

## 自动生成游戏图标倒计时

无需预制图片：每次新建任务都下载线上当前的根 Place Icon 作为底图，保存原素材 ID，再叠加 35% 黑色遮罩、内置白色沙漏 SVG 和固定粗体文字。图片输出为 512×512 PNG。字体使用随依赖分发的 Archivo Black（OFL-1.1），文字先转矢量轮廓，跨电脑不依赖系统字体。

默认完整一套 **31 张**：`24h、23h、…、1h、30mins、15mins、10mins、5mins、1min`，以及独立的 `SOON!`、`NOW!`。新建正式任务仅生成本次剩余时间内的节点，SOON/NOW 始终提前生成、上传和审核；超过 24 小时启动时保持原图，剩余 24 小时再开始。若线上当前图标已经带文字／倒计时，这些内容会直接保留在底图中。

```sh
# 只下载并在本地生成完整预览，不上传、不修改游戏；输出目录不能已存在
rbx icon generate 123456789 --output "D:/倒计时预览"
rbx icon generate 123456789 --nodes "3h,1h,30mins,10mins,1min" --output "D:/自定义预览"

# 创建任务：恢复时间必填，必须晚于目标时间
rbx icon countdown 123456789 --at "2026-11-06 20:00" --restore-at "2026-11-07 22:00"
rbx icon countdown 123456789 --in 3h --restore-at "2026-11-07 22:00"
rbx icon countdown 123456789 --in 3h --restore-at "2026-11-07 22:00" --dry-run

# 另开终端，在实际发版完成后切 NOW；预设恢复时间不变
rbx icon now 123456789

# 离线查看完整状态；中断后按原参数和进度续跑
rbx icon status 123456789
rbx icon resume 123456789

# 随时立即恢复原图并结束任务，后续节点不再切换
rbx icon restore 123456789
```

**流程**：提前生成和审核 → 自动倒计时 → 目标时刻自动 SOON → 人工指令 NOW → 固定时间恢复原图。NOW 可以提前手动触发，之后所有倒计时／SOON 节点停止；恢复时间与是否执行 NOW 无关。恢复时直接设置保存的原素材引用，不重新上传原图，也不因图标被另行修改而跳过恢复。手动恢复是幂等操作；任务结束后 NOW 会报错。

`--at` 接受本机时间或带时区的 ISO；`--in` 从本次全部素材审核通过后开始计时，首次确定后保存在任务中，续跑不顺延。`--nodes` 为逗号分隔的唯一正时长，每个节点最多 24 小时，也支持秒级节点用于显式测试。`--moderation-timeout` 默认 `30m`，每次续跑可重新设置等待时长。审核拒绝／超时会退出，保留任务和素材引用；使用 `resume` 重新查询审核，或 `restore` 结束任务。缓存按 Owner 和生成图片内容哈希复用，复用前重新查询审核状态；本地图片被修改会拒绝上传。

**运行条件**：`countdown`／`resume` 是前台常驻调度器，电脑和进程必须保持运行；`now`／`restore` 可在另一进程执行。Ctrl+C 后需 `resume` 才会继续自动切换。错过多个节点只补最近一个；恢复时间已过时优先恢复，不补 SOON/NOW。API 请求、网络和 Roblox 展示缓存可能造成延迟。每个 Universe 仅允许一个未结束任务；与旧文件夹倒计时互斥。生成命令需要读取图标和原图的权限；任务还需要素材上传／更新权限，通常为 `asset:read`、`asset:write`、`legacy-asset:manage`，以及对应 Universe／Owner 的访问范围。正式任务的 Universe 需已在本地游戏目录。

`--dry-run` 只读本地状态和计算节点，不联网、不写文件；它不能预览实际底图，图片预览使用 `generate`。自动生成模式不接受旧模式的 `--restore-after`、`--reset`、`--no-cache`。`--json` 的任务执行过程按 NDJSON 输出事件，最后一行输出任务状态；`status` 输出单个 JSON 对象。

**本地数据**：应用数据目录的 `icon-countdown/tasks/<universeId>.json` 保存当前任务，`generated/<taskId>/` 保存原图、SVG、PNG、清单和总览；旧任务素材保留供复查。`generated-assets/` 保存按 Owner／内容哈希划分的素材缓存，`locks/` 保存短操作锁与调度进程锁。真实素材和测试结果不写入仓库。

**验证**：默认离线测试为 `tests/icon-tasks.test.ts`。真实测试会上传并修改指定游戏，须显式设置 `RBX_LIVE_GENERATED_ICON_UNIVERSE` 后运行 `npm run test:live:icons`（先 `npm run build`）。脚本测试短倒计时、SOON、人工 NOW、定时恢复和恢复幂等性，保存原图标引用并在失败时尝试恢复。真实日志保存在本地 `icon-countdown/live-smoke/`。

## 游戏图标倒计时（预制文件夹兼容模式）

在更新上线前按时间节点自动切换游戏图标（根 Place 的 Icon）。所有图片先上传并全部通过审核，才开始倒计时，到点只切换素材引用，不再等待上传。

```sh
rbx icon countdown 123456789 "D:/倒计时素材" --at "2026-09-14 23:00"
rbx icon countdown 123456789 "D:/倒计时素材" --in 3h
rbx icon countdown 123456789 "D:/倒计时素材" --in 3h --dry-run
rbx icon countdown 123456789 "D:/倒计时素材" --at "2026-09-14 23:00" --restore-after 1h
```

- `--at`：目标时刻，本机时区的 `YYYY-MM-DD HH:MM[:SS]`，或带时区的 ISO-8601。
- `--in`：相对时长，从**所有图片审核通过的那一刻**开始计时。二者必须选一个。
- `--dry-run`：只读本地文件夹和本地进度，打印计划，不调用 API、不写文件。
- `--moderation-timeout <时长>`：审核最长等待时间，默认 `30m`。
- `--no-cache`：不复用已上传的素材，重新上传。
- `--reset`：仅用于 `--in`，丢弃该文件夹未完成的倒计时，从头开始。
- `--restore-after <时长>`：`now` 之后再过这么久，自动换回倒计时开始前的原图标。

Universe 必须已在本地游戏目录中（`rbx universe scan` 或 `rbx universe add`），素材以游戏 Owner（个人或群组）身份上传。API Key 需要 `asset:read` 与 `asset:write`。

**文件夹规则**：文件名（去掉扩展名）即节点，支持 `.png/.jpg/.jpeg`，其他扩展名的文件忽略。时长写法如 `3h`、`24hrs`、`1hr`、`30mins`、`1min`、`1h30m`、`45s`、`1d`，目标时刻的图为 `now`（或 `0`）。文件名无法解析、两个文件时长相同、不是真实 PNG/JPEG、非正方形、超过 20 MB 都会在上传前一次性报错；小于 512×512 只警告。

**节点规则**：R 为计划确定时（审核通过时）距离目标的剩余时间。

- 必须有 `now`，并且至少还有一张时长 ≤ R 的图，否则报错。
- 时长 > R 的图跳过，也不会上传。
- 每张图严格在「目标 − 时长」时切换；第一个节点之前保持原图标，节点之间允许有空档。
- 默认切换到 `now` 后结束，不恢复原图标；原图标素材 ID 会在输出与进度文件中给出。
- 使用 `--restore-after` 时，原图标在上传前读取；该 Place 没有自定义图标会直接报错。Roblox 的图标读取接口是最终一致的，改图后几分钟内仍可能偶尔读到旧值，因此读取图标时需连续 3 次结果一致才采用；读到的原图标若是本次倒计时的某张图，会拒绝开始。到恢复时间时，当前图标是原图或本次倒计时的任意一张就发送换回请求，否则视为被人手动改过并跳过恢复。续跑必须使用相同的 `--restore-after`。

**审核**：任意一张被拒或等待超时，整个任务失败，不切换任何图标。素材按「文件内容 SHA-256 + Owner」缓存，再次运行只重新查询审核状态；被拒记录同样缓存。

**中断与续跑**：命令在前台常驻，逐秒显示剩余时间，Ctrl+C 安全退出。切换失败会直接报错退出。用同样的参数重新运行即可续跑：已完成的节点跳过，素材走缓存；错过多个节点时只补最近的一个，更早的丢弃；目标时刻已过但 `now` 未执行时会补执行 `now`。`--in` 会记住第一次算出的目标时刻，完成后自动失效。同一 Universe 同时只能运行一个倒计时，崩溃遗留的锁在原进程结束后自动接管。

**输出**：`--json` 时 stdout 每行一个事件（NDJSON）：`scanned`、`asset`、`moderation`、`planned`、`waiting`、`missed`、`icon`、`restore-waiting`、`restored`、`restore-skipped`、`completed`，出错时最后一行为标准错误对象。`--dry-run --json` 仍输出单个 JSON 对象。审核被拒、审核超时的错误码分别为 `MODERATION_REJECTED`、`MODERATION_TIMEOUT`，退出码 1。

真实冒烟测试默认不会改图标。需要显式设置 `RBX_LIVE_ICON_UNIVERSE`（Universe ID）与 `RBX_LIVE_ICON_DIR`（至少含 `1min.png` 和 `now.png`）后运行 `npm run test:live`，它会真实切换该游戏图标，`RBX_LIVE_ICON_IN` 可调整时长（默认 `1m`）。

**本地文件**：应用数据目录下的 `icon-countdown/`。

- `assets.json`：素材缓存。
- `runs/`：每次倒计时的进度与原图标。
- `anchors/`：`--in` 目标时刻锚点。
- `locks/`：运行锁。

**模块位置**

- 文件夹解析与计划：`src/icons/frames.ts`；上传审核与续跑：`src/icons/countdown.ts`。
- 命令入口：`src/cli/main.ts`；SDK 导出：`src/index.ts`；离线测试：`tests/icons.test.ts`。

## 玩家封禁与解封

按整个体验（Universe）操作，支持游戏目录中的名称或 Universe ID，玩家支持 Username 或 UserId。

```powershell
rbx ban 123 --player 456 --duration 30m --reason "Temporary maintenance" --dry-run
rbx ban 123 --player 456 --duration 30m --reason "Temporary maintenance"
rbx ban 123 --player 456 --permanent --reason "Experience rules violation"
rbx ban-status 123 --player 456
rbx unban 123 --player 456
```

封禁必须指定 --duration（整数加 s/m/h/d）或 --permanent，二者互斥。--reason 为玩家可见原因；--private-reason 为内部原因。默认仅针对指定账号，显式 --include-alts 才启用关联账号封禁。封禁、解封支持 --dry-run 和全局 --json；预览只解析目标，不更新封禁，也不验证写入权限。

API Key 需对目标体验拥有 universe.user-restriction:write；查询需 universe.user-restriction:read。封禁会阻止进入并踢出已加入的玩家，但清档仍须等待存档会话释放。封禁请求不会自动重试；响应丢失时先查询状态。解封仅修改体验级限制，不清除单独的 Place 级封禁。

官方协议：https://create.roblox.com/docs/cloud/reference/features/bans-and-blocks

## 玩家清单

```sh
rbx player add ExamplePlayerOne
rbx player add ExamplePlayerOne --alias 示例甲
rbx player add ExamplePlayerTwo --alias 示例乙
rbx player list
rbx player find PlayerOne
rbx player alias ExamplePlayerOne 示例甲
rbx player remove ExamplePlayerOne
```

`add` 使用真实 Roblox 用户名在线查询 UID，不接受 Display Name、别名或 UID，也不需要 API Key。只有显式添加才保存；重复 UID 更新用户名，未传 `--alias` 时保留已有别名。`alias` 设置或替换一个别名。别名支持中文、最多 100 字符，不允许逗号、控制字符或纯数字。`remove` 仅移除本地记录。

`list`、`find`、`alias`、`remove` 只使用本地数据，不需要网络或凭证。匹配忽略大小写：UID 精确匹配；其他输入优先匹配完整用户名或完整别名，未命中时按用户名片段匹配。`find` 返回所有候选；需要单个玩家的命令在多个候选时返回参数错误并列出姓名、UID 和别名，须改用明确 UID 重试。别名也可能重名，不会自动选择其中一人。

`profile history`、`profile copy`（含 `--to`）、`profile clear`、`ban`、`unban` 和 `ban-status` 使用同样的清单解析。唯一片段或别名命中后直接使用保存的 UID；清单未命中的真实用户名保留在线查询，查询结果不自动写入清单。

```sh
rbx profile history "Example Test" --player PlayerOne
rbx profile history "Example Test" --player 示例甲
```

清单存于应用数据目录的 `players.json`，不按登录账号或游戏拆分。用户名是添加时的快照；玩家改名后可用新用户名重新 `add`，相同 UID 会更新原记录。`--json` 的列表/查询数据为 `{ players: [...] }`，添加/修改为 `{ player: ... }`，移除为 `{ removed: ... }`；每条记录为 `{ userId, name, alias? }`。

SDK 可用 `PlayerCatalogService(new LocalStore(home))` 管理清单；`resolveProfilePlayers(input, http, savedPlayers)` 接收可选的本地记录列表。SDK 添加已解析的玩家时调用 `service.add(player, alias?)`，可先用 `resolveProfilePlayers(username, http)` 获取真实 UID。

## 群组角色管理

通用群组角色命令支持任意可见角色，不绑定 Tester 或特定群组。需要有效 API Key；查询要求 `group:read`，添加/移除（包括预览）要求 `group:read` 和 `group:write`。`legacy-group:manage` 不替代这两个 scope。

```sh
rbx group roles 123
rbx group member 123 --players "ExampleUser,456"
rbx group role grant 123 --role "Tester" --players "ExampleUser,456" --dry-run
rbx group role grant 123 --role-id 789 --players-file ./players.txt
rbx group role revoke 123 --role-id 789 --players "456"
rbx --json group role grant 123 --role "Moderator" --players "456,457"
```

示例 ID 与玩家名均为占位。`--role` 按完整名称区分大小写匹配，重名要求改用 `--role-id`；ID 是角色 ID，不是 rank。两个选项必须且只能指定一个。玩家使用 `--players` 或 `--players-file` 二选一，最多 100 个输入，按 UID 去重；支持用户名、数字 User ID、本地玩家清单别名/唯一片段和 `https://www.roblox.com/users/<UserId>/profile` 链接。文件为 UTF-8，支持每行一个或逗号分隔，不带表头。玩家解析结果不会自动保存。

角色列表仅代表当前账号可见的角色，`management: unknown` 表示未能预先确认管理权限。CLI 检查 Key 的 scope，但不根据 rank 猜测账号能否操作具体玩家；最终由 Roblox 检查账号权限、角色层级和资源访问限制。403 会显示拒绝及可能的检查方向，不声称知道具体原因。命令不支持修改自己的角色、Guest 或 Owner 角色。`--dry-run` 在线解析玩家、查询角色与当前成员状态，不提交修改，也不能证明账号具有实际写入权限。

添加/移除使用 Open Cloud `assignRole` / `unassignRole`，保留其他角色；未入群不会自动加入或接受申请。读取完整 `roles` 数组，缺失时拒绝修改，不用最高角色字段 `role` 推断完整权限。角色和成员查询均处理分页，成员按 UID 过滤，无需扫描整个群组。

每次写入后回读确认目标角色是否存在/消失；为容忍查询延迟，最多回读 4 次，额外等待依次为 300/600/900 毫秒，不自动重试写入。每个玩家结果为 `success`（回读确认）、`unchanged`（无需修改）、`planned`（预览）、`not-member`（未入群）、`error`（查询失败或明确拒绝）、`unverified`（已尝试写入但未确认结果）。出现 `unverified` 时先用 `group member` 核对再决定重试。单个玩家失败继续处理其他人；取消或 Key 失效停止，未处理人数见 `skipped`。批量操作非原子操作，无自动回滚。

JSON 的添加/移除结果包含 `groupId`、`role`、`action`、`dryRun`、`players`、`results`、`skipped`；成员查询包含 `groupId`、`results`，未入群的 `member` 为 `null`。部分失败/未入群/待核对使用统一 warnings 和退出码 3；整批参数或权限错误使用统一错误输出。

SDK 导出 `GroupRoles`、`groupPlayerInput` 及对应类型：

```ts
const identity = await new RobloxApi(http, apiKey).identity();
const groups = new GroupRoles(http, identity); // http 需配置同一个 apiKey
await groups.roles('123');
await groups.member('123', '456');
await groups.change('123', { name: 'Tester' }, ['456'], 'grant', true); // 预览
await groups.change('123', { id: '789' }, ['456'], 'revoke');
```

接口仍为 Beta，参考 [Roblox 群组 API](https://create.roblox.com/docs/cloud/reference/features/groups.md) 和 [成员过滤规则](https://create.roblox.com/docs/cloud/reference/patterns.md)。默认测试只用虚构响应；真实 API 测试需显式执行。

## 游戏标题与简介本地化

`localization` 管理游戏详情页的标题和简介，支持游戏名称（从本地游戏目录精确匹配，忽略大小写）或 Universe ID。工具固定管理 18 种语言（Roblox 官方自动翻译支持的语言）：`en`、`es`、`pt`、`ru`、`id`、`fr`、`de`、`ko`、`ja`、`it`、`tr`、`ar`、`th`、`vi`、`pl`、`zh-hans`、`zh-hant`、`hi`。Roblox 未公开各语言用户比例，清单顺序只是估算。`read` 默认只输出这些语言及其地区版本，不请求 Roblox 语言目录；`read --all` 实时获取全部创作者语言。输出区分游戏已启用语言、返回的译文和未返回的内容。需要有效 API Key，英文原文通过 Cloud Universe 接口读取，私有游戏也可查询。

```sh
rbx localization read "Example Game"
rbx localization read "Example Game" --all
rbx --json localization read 123
rbx localization write "Example Game" --file ./translations.json --dry-run
rbx --json localization write "Example Game" --file ./translations.json
```

写入文件是 UTF-8 JSON，按语言或地区代码组织，只填写需要修改的字段：

```json
{
  "ja": { "title": "サンプルゲーム" },
  "zh-hans": { "title": "示例游戏", "description": "示例游戏简介。" },
  "fr-ca": { "title": "Jeu exemple" }
}
```

可以一次提交全部译文，也可以只修正一个语言的标题。未提供的语言、标题或简介均保留。字段只支持 `title` 和 `description` 字符串，不接受 `null`、删除指令或 `read` 的完整 JSON 输出信封；读取结果需要先整理为上述编辑文件。源语言（例如 `en`）仍使用同一个 `localization write` 命令：CLI 从 Cloud Universe 返回的 `rootPlace` 定位根 Place，再通过 Cloud Update Place 的字段掩码接口修改 `displayName` 和／或 `description`，需要对应根 Place 的写权限。不能直接修改 Universe 的 `displayName` 代替根 Place 更新，该操作可能返回成功却不改变源标题。其他译文、支持语言管理使用 `legacy-game-internationalization` 接口，最终由 Roblox 校验 Key 和资源权限。译文标题与简介分开提交，单批最多 25 个语言。

语言代码与地区代码不同：`en` 是英文通用版本，`en-gb`/`en_gb` 是英国版本。英文、法文、葡萄牙文、西班牙文支持独立地区覆盖；其他地区代码输入会映射到对应语言通用版本，例如 `ja-jp` → `ja`。别名冲突会在写入前拒绝；源语言默认地区不能作为覆盖项（例如源语言是 `en` 时，使用 `en` 修改原文，不能用 `en-us` 覆盖）。`write` 拒绝白名单外的语言，整条命令在提交前报错；游戏的源语言不在白名单内时仍可读写。默认 `read` 隐藏白名单外的线上译文，`read --all` 和写入备份保留这些记录，线上内容不受影响。

写入时自动添加本次所需、尚未启用的支持语言，并回读确认；地区覆盖依附于对应语言组，例如写 `fr-ca` 时检查并按需添加 `fr`，不向支持语言接口添加 `Locale`（该接口会拒绝）。对新增语言明确关闭标题/简介自动翻译，不主动开启任何自动翻译。已有语言的自动翻译开关保持原样，手动译文优先展示。新增语言或其中一个字段失败会单独报告，其他字段继续处理；添加成功的语言不会因后续译文失败而自动移除。`--dry-run` 只读取、校验并预览字段和待添加语言，不添加语言、不写入、不生成备份，也不能证明写入权限。

实际写入前，CLI 在应用数据目录的 `localization-backups/` 保存原始快照和请求，备份失败则不提交修改。SDK 可通过 `backupDirectory` 启用同样的备份。批量操作不是原子操作，不自动回滚；写入后最多回读 4 次，只重试读取、不重试修改。每个字段输出 `success`、`error`、`unverified`，预览时为 `planned`；出现失败或待确认项时，CLI 输出 warnings 并退出 3。`unverified` 表示无法确认，先读取检查，再决定是否重试。

读取保留 `null` 与空字符串的区别；`null` 表示接口没有返回该项译文，不能由此断言玩家一定看到什么。地区项显示独立覆盖值，不推测自动翻译或回退后的最终展示。Roblox 将空手动译文视为使用原文的信号；若写入空字符串后接口仅返回 `null`，本工具保守报告 `unverified`。读取结果不将 `updateType` 当作翻译来源，不能据其判断手动/自动译文。参考 [Roblox 本地化说明](https://create.roblox.com/docs/production/localization) 和 [手动及地区翻译](https://create.roblox.com/docs/production/localization/add-translations)。

SDK：

```ts
import { GameInfoLocalization, HttpClient } from '@hollower233/roblox-cloud-cli';
const localization = new GameInfoLocalization(new HttpClient({ apiKey }));
const snapshot = await localization.read('123');
await localization.write('123', { ja: { title: 'サンプルゲーム' } }, {
  backupDirectory: '/path/to/localization-backups',
  dryRun: true,
});
```

默认离线测试位于 `tests/localization.test.ts`。显式设置 `RBX_LIVE_LOCALIZATION_UNIVERSE` 后运行 `npm run test:live:localization`，仅验证真实读取与只读预览，不写游戏、不保存真实响应到仓库。

## 游戏内本地化表（Studio 本地化表 → DeepSeek → 云端）

本地化表以 Studio 中的 ModuleScript 为唯一来源：主表 `本地化表` 存英文原文和简体中文（由人或 Agent 维护，CLI 只读），子模块 `本地化表.<语言代码>` 存其他语言（每行 `["英文原文"] = "译文",`，顺序与主表一致，由 CLI 生成）。英文原文逐字作为主键。云端只接收单向推送：只处理无 Key、无 Context 的通用条目，只新增和修改，从不删除。

```bash
# 新游戏：源语言设为 en，启用 18 种固定语言并开启自动翻译，使用翻译表、开启自动采集文本、关闭自动删除（幂等）
rbx localization enable "Example Production" --dry-run
rbx localization enable 123 456

# DeepSeek：Key 用 DPAPI 保存（DEEPSEEK_API_KEY 优先）；每次运行都会拉取模型列表
rbx deepseek auth set
rbx deepseek models
rbx deepseek config --model deepseek-flash

# 新项目还没有本地化表：生成空主表（默认 ./本地化表.rbxm，已存在需 --force），
# 用 import_rbxm 导入到 game.ServerStorage["项目文档"]（不存在先建 Folder）后按表头写条目
rbx localization init --out ./本地化表.rbxm

# Agent 先用 robloxstudio-mcp 的 export_rbxm 导出 game.ServerStorage["项目文档"]["本地化表"]
rbx localization sync 123 456 --source ./本地化表.rbxm --dry-run
rbx localization sync 123 456 --source ./本地化表.rbxm
rbx localization sync 123 --source ./本地化表.rbxm --retranslate "Play Again"

# 首次接入：把某个游戏云端已有的译文填入本地空位（--human-only 只要人工译文）
rbx localization import 123 --source ./本地化表.rbxm
rbx localization export --source ./本地化表.rbxm --out ./localization.json
rbx localization show "Leave" --source-file ./本地化表.rbxm
```

`sync` 的流程：
1. 每个目标游戏必须已开启本地化（源语言 en、使用翻译表），否则报错并提示先运行 `enable`，不翻译、不写入。
2. 读取各游戏已启用语言的并集，与 18 种固定语言取交集，找出本地缺失的「原文 × 语言」。zh-hans 来自主表，不翻译。白名单外已启用的语言留在线上，云端译文保留，但不再翻译和推送。
3. DeepSeek 翻译：连续原文 × 一组语言为一批（默认每批不超过 120 个译文，12 种语言一组），默认 8 路并发（`--concurrency`）。逐条校验占位符（`{a:int}`）和标签（`<font>`），不合格的单独重试两次，仍失败则不写入并列在 warnings。译文同时写入应用数据目录 `localization-cache/translations.jsonl`，中断后重跑不重复付费。
4. 写出本地化表 `.rbxm`（默认 `<source>.synced.rbxm`），根模块名为 `本地化表__sync`；不再被主表引用的旧译文会被清理，白名单外的语言子模块会被删除，删除的语言和译文数会输出（`--dry-run` 只预览）。`--out` 指向源文件时会覆盖原表。
5. 逐个游戏推送该游戏启用语言中与云端不一致的译文：推送前把云端全部条目备份到 `localization-backups/`，按 `maxEntriesPerUpdate` 分批；一个游戏失败不影响其他游戏。原文超过 `maxSourceLength`（目前 300）会被跳过并报告。
6. 输出摘要：各语言新译文数、模型和 token 用量、每个游戏新增/修改/被拒数量。

`enable` 只处理 18 种固定语言，已启用的其他语言及其自动翻译开关保持原样。`import` 只导入固定语言，其他语言计入跳过统计。

写回 Studio：`import_rbxm` 把输出文件导入到本地化表所在的父级，再用 `execute_luau` 执行输出中的 `studioSwapLuau`。它比较新旧主表的 Source，一致才删除旧表并把新表改名，不一致则丢弃导入，需要重新导出并 sync。

`.rbxm` 读写由 `src/localization/rbxm.ts` 实现（读取 LZ4/ZSTD，写出使用 ZSTD），只保留 ModuleScript 的 Name 和 Source。

## Configs 与 A/B 实验

正式命令为 `rbx configs`、`rbx experiments`，支持 Universe ID 或本地游戏目录中的精确名称。读取需要目标游戏的 `universe:read`，修改还需要 `universe:write`。Configs API 为 Beta，Experiments API 为 Experimental；当前仅管理 `InExperienceConfig` 与游戏内配置实验，不管理 matchmaking 实验。

命令注册位于 `src/cli/commands/`，共用 `src/cli/context.ts` 的凭证、游戏解析、JSON 输出和执行回执；SDK 复用相同业务模块。增加其他资源时可新增命令模块，不必把业务继续堆进 `main.ts`。本版本未加入任意 URL 调用器或跨接口自动发布流程。

### Configs

```sh
rbx configs read "Example Game"
rbx --json configs read 123 --full
rbx configs draft read 123
rbx configs draft set 123 --file ./configs.json --dry-run
rbx configs draft set 123 --file ./configs.json
rbx configs publish 123 --draft-hash "HASH_FROM_DRAFT" --message "Example change"
rbx configs history 123 --limit 20 --skip 0
rbx configs restore 123 REVISION_ID --dry-run
rbx configs restore 123 REVISION_ID
```

`configs.json` 是纯键值对象，例：

```json
{
  "exampleWaitSeconds": 0,
  "exampleExperimentEnabled": false
}
```

`draft set` 只 PATCH 文件提供的键，省略的键保留，`null` 表示删除该键。已有草稿时自动读取当前草稿哈希并通过 `previousDraftHash` 防止覆盖并发编辑；也可用 `--draft-hash` 指定之前审阅的预期哈希。文件不要包含 CLI 的 `schemaVersion/status/data` 输出信封。支持布尔、数字、字符串及 JSON 值，具体产品值限制仍由 Roblox 校验。

发布后草稿会清空。草稿接口返回 404 时，CLI 会确认已发布配置或所属游戏可访问，再返回 `exists: false`、`draftHash: null`、`entries: {}`；已有草稿返回 `exists: true`。新游戏还没有 Configs 仓库时，CLI 通过官方 Universe 元数据接口独立验证访问权限；验证成功后配置读取返回 `exists: false` 和空 `entries`，历史返回空 `revisions`，允许 `draft set` 首次初始化仓库。配置仓库已存在时读取返回 `exists: true`。无草稿时首次创建不发送旧哈希，也允许 `restore` 暂存历史恢复；`publish` 则提示先暂存变更。401、403、服务错误及游戏本身不可访问的错误均继续上报。首次创建缺少可用的旧哈希，客户端会在写前再次检查是否出现草稿；这项检查不构成服务器端原子的“仅在不存在时创建”保证。

草稿修改不会直接上线。`publish` 要求显式传入已经审阅的草稿哈希，发布的是**整个草稿的全部变更**，包括其他工具已暂存的内容。发布前会检查哈希；不一致时拒绝操作，不自动读取新哈希后强行发布。`--strategy Immediate` 为默认即时发布，`--strategy GradualRollout` 为 15 分钟渐进发布。`restore` 会替换当前草稿，**只暂存历史恢复，不自动发布**；确认返回的新 `draftHash` 后再运行 `publish`。

CLI 在真实写入前将已发布值、当前草稿和请求保存到应用数据目录的 `config-backups/`；备份失败不提交修改。SDK 通过 `backupDirectory` 启用备份。`--dry-run` 只读取、校验和显示请求，不写入或备份，也不能证明写权限。

### 实验

```sh
rbx experiments list 123 --limit 20 --skip 0
rbx experiments get 123 EXPERIMENT_ID
rbx experiments create 123 --file ./experiment.json --dry-run
rbx experiments create 123 --file ./experiment.json
rbx experiments update 123 EXPERIMENT_ID --file ./experiment.json --dry-run
rbx experiments start 123 EXPERIMENT_ID
rbx experiments schedule 123 EXPERIMENT_ID --at "2099-10-25T18:00:00+08:00"
rbx experiments stats 123 EXPERIMENT_ID
rbx experiments complete 123 EXPERIMENT_ID --variant VARIANT_ID --dry-run
rbx experiments complete 123 EXPERIMENT_ID --no-winner
rbx experiments operation 123 OPERATION_ID
```

`experiment.json` 的完整示例在 `tests/fixtures/config-experiment.json`，使用虚构键 `exampleWaitSeconds`，A/B 权重各 50%，曝光比例 100%，周期 14 天，目标为次日留存。基线组**引用当前已发布的值**，不填写 `entryValue`；处理组通过 `entryValue` 提供实验值。因此要做 0 对 8 秒实验，先将该键的基线值发布为 0，再创建 B 组值为 8 的实验。创建命令只创建草稿，不自动启动、不发布启用开关。

输入须提供完整可修改字段，包括 `name`、`experimentConfiguration`、`exposurePercent`、`durationSeconds`、`universeGoalMetric`；可选 `description`。`update` 是**完整替换可修改字段**，不能只传一个修改项。当前校验 14–60 天、一个基线加 1–2 个处理组、同一配置键、不同标签、权重合计 100%。文件格式见 [官方实验指南](https://create.roblox.com/docs/cloud/guides/experiments)。运行或排程后的实验配置由 Roblox 限制修改。

`complete` 必须显式二选一：`--variant` 传的是 API 返回的 `variantMeta.variantId`，不是 A/B 标签，选中变体会发布其配置值；`--no-winner` 不选择赢家，恢复之前的配置值。命令不会自动改变你自己的其他启用开关。`stats` 是异步诊断统计，官方可能需要至少 24 小时的实验数据，不能将它当作完整留存或收益分析报告。

实验变更默认等待异步操作完成，最多轮询 60 秒。可用 `--no-wait` 立即返回操作 ID，或 `--timeout 120` 调整等待秒数（CLI 最多 3600）。超时返回 `pending`，操作可能继续在云端执行；用 `operation` 查询或继续等待，**不要重新创建实验**。实验及变体 ID 始终作为字符串处理，支持超出 JavaScript 安全整数范围的 ID。CLI 写前备份保存到 `experiment-backups/`；SDK 可选 `backupDirectory`。

### 回执、SDK 与验证

输出沿用 `--json`、统一错误和退出码。写回执的 `state`：

| 状态 | 含义 |
| --- | --- |
| `planned` | 预览，未提交 |
| `verified` | 草稿回读哈希一致，或实验异步操作已完成且未返回错误 |
| `submitted` | Configs 发布接口已返回配置版本，并附上读取到的值；不保证全部在线服务器已刷新 |
| `pending` | 已取得操作 ID，等待时间内尚未完成 |
| `unverified` | 写入响应丢失、回读失败、并发覆盖或操作失败，需检查回执 |

`pending` 和 `unverified` 产生 warnings，CLI 退出 3。响应丢失时可能没有操作 ID，此时先通过实验列表/详情或配置草稿/历史核对结果。写操作不会自动重试，已知 HTTP 拒绝仍报正常错误；异步失败的结构化错误保留在 `response.error`。本地备份只供人工恢复和诊断，不承诺多个 API 的事务回滚。

```ts
import { ConfigRepository, Experiments, HttpClient } from '@hollower233/roblox-cloud-cli';
const http = new HttpClient({ apiKey });
const configs = new ConfigRepository(http);
const staged = await configs.setDraft('123', { exampleWaitSeconds: 0 }, {
  backupDirectory: '/path/to/config-backups',
});
// 审阅 staged.readback 与哈希后，另行调用 publish。
const experiments = new Experiments(http);
const receipt = await experiments.start('123', 'EXPERIMENT_ID', { wait: false });
if (receipt.operationId) {
  const operation = await experiments.getOperation('123', receipt.operationId);
  await experiments.wait('123', operation, { timeoutMs: 60000 });
}
```

离线验证：`tests/configs.test.ts`、`tests/experiments.test.ts`、`tests/cloud-cli.test.ts`。显式设置 `RBX_LIVE_CLOUD_UNIVERSE` 后运行 `npm run test:live:cloud`；可选 `RBX_LIVE_CLOUD_EXPERIMENT` 追加实验详情验证。该冒烟脚本只发 GET，不启动实验、不发布配置、不把真实响应保存到仓库。

接口参考：[Configs](https://create.roblox.com/docs/cloud/reference/features/configs)、[Experiments](https://create.roblox.com/docs/cloud/reference/features/experiments)。

## 服务器重启

```powershell
rbx --json servers status --universe 123
rbx --json servers restart --universe 123
rbx --json servers restart --universe 123 --countdown
rbx --json servers restart --universe 123 --all
rbx --json servers restart --universe 123 --all --countdown
rbx --json servers restart --universe 123 --place 456
rbx --json servers restart --universe 123 --place 456 --all --countdown
```

`servers status` 使用 Roblox 的 Beta 只读影响预估接口，要求目标宇宙的 `universe:read` 权限。`activeServers` 是活跃服务器总数，包含旧服。`outdatedServers` 是 Roblox 预估只重启旧服时会影响的数量。`places` 按 Place 列出相同的两项数据，已移出宇宙的 Place 不计入汇总。SDK 对应调用为 `getUniverseServerStatus(http, '123')`。

必须显式传入数字 Universe ID。省略 `--place` 时覆盖该宇宙的所有活跃 Place；指定 `--place <id>` 时仅重启该 Place。默认立即重启旧服。`--all` 纳入当前版本，不扩大 Place 范围；`--countdown` 由 Roblox 固定延迟一分钟。Place ID 必须为正的安全整数，归属与实际访问权由 Roblox 校验，失败不会回退为全宇宙重启。使用现有 API Key，需为目标宇宙授权 `universe:write`。命令直接提交，无需交互或提前录入本地游戏目录。

回执的 `data.state: "submitted"` 表示 Roblox 接收了请求。实际重启由 Roblox 执行，Stable 接口不返回重启 ID。遇到超时等无法确认的结果，命令返回 `unverified` 并退出 3。先在 Creator Hub 的服务器管理查看进度，再决定是否重新提交。

SDK 对应调用为 `restartUniverseServers(http, '123', { placeIds: ['456'], all: false, countdown: true })`。`placeIds` 可指定多个 Place，自动去重并作为数字数组发送；省略时覆盖所有活跃 Place，显式空数组或无效 ID 会在请求前报错。回执 `request.body.placeIds` 保留选定范围。写请求不自动重试。接口参考 [Restart Universe Servers](https://create.roblox.com/docs/cloud/reference/features/universes#Cloud_RestartUniverseServers)。

## 打开 Studio 项目（Windows）

```powershell
rbx studio open "Example Test"            # 本地目录中的游戏名（不区分大小写），打开根 Place
rbx studio open "<UniverseId>"           # Universe ID
rbx studio open --place "<RootPlaceId>"
rbx --json studio open "Example Test" --timeout 180
rbx studio open "Example Test" --no-wait  # 启动后立即返回
rbx studio list                       # 已打开的编辑会话：PID、Place、Universe、窗口标题
rbx studio close "Example Test" "Example Preview"   # 软关闭，可一次传多个游戏
rbx studio close --place "<RootPlaceId>"
rbx studio close --pid "<EditorPid>" --force  # 强制结束编辑器及其 Team Test 进程，丢弃未保存改动
rbx studio close --all                # 软关闭全部编辑会话（不可与 --force 同用）
```

- `close` 默认软关闭：向窗口发送关闭请求（等同点 ×），Studio 自己处理保存。若有未保存改动会弹保存提示，超时（默认 30 秒，`--timeout` 调整）后仍未关的会话返回 `pending` 并带 `STUDIO_CLOSE_PENDING` warning、退出码 3，需人工在 Studio 里处理后再查 `studio list`。`--force` 才会结束进程，并连带结束命令行 `-editpid` 指向该编辑器的 Team Test 服务端/客户端。

- 不需要 API Key。优先用本地游戏目录的 `rootPlaceId`；目录没有时调用公开接口 `develop.roblox.com/v1/universes/{id}`（根 Place）或 `apis.roblox.com/universes/v1/places/{id}/universe`（Place 所属 Universe），私密游戏同样可用。重名游戏报错并列出候选 Universe ID。
- 同一 Place 已有编辑会话时不重复启动，只切到前台并返回 `alreadyOpen: true`。按进程命令行的 `-task EditPlace -placeId` 识别，Team Test 的服务端/客户端进程不计入；窗口标题是本地化名，不用于匹配。
- 新启动时取 `%LOCALAPPDATA%\Roblox\Versions` 下修改时间最新的 `RobloxStudioBeta.exe`（不读注册表协议，注册表可能指向旧版本），参数为 `-task EditPlace -placeId <P> -universeId <U>`。这是 Studio 自身使用但未公开文档化的参数，Roblox 改版可能失效。
- 默认等待窗口标题变为 `<名称> - Roblox Studio` 视为加载完成（`ready: true`），默认超时 120 秒，超时返回 `TIMEOUT`。加载完成不代表 MCP 插件已连接，连接状态以 MCP 为准。
- 模块：`src/studio/launch.ts`；SDK：`resolveStudioTarget`、`openStudio`、`listStudioSessions`、`windowsStudioSystem`。离线测试：`tests/studio.test.ts`。
## Studio Publish As（Windows）

把本机已打开的 Studio 编辑会话，通过 File > Publish As 发布到目录中任意游戏的指定 Place，或作为新 Place 加入。面向 agent 调用，不做交互确认；先用 `--dry-run` 检查。

```sh
rbx studio publish-as --to "<UniverseId>" --place "Example Lobby" --dry-run --json
rbx studio publish-as --to "Example Development" --place "<PlaceId>" --json
rbx studio publish-as --to "Example Sandbox" --new --pid "<EditorPid>" --json
```

- `--to`：Universe ID 或本地目录中的精确游戏名；`--place`：Place ID 或精确 Place 名；`--new`：新建 Place。两者必选其一。
- `--pid`：源 Studio 编辑进程，多个会话时必填（见 `studio list`）。`--debug-dir` 保存每一步截图。
- 目标先由本地目录（群组名、游戏名）和公开 Place 目录换算成对话框显示的文字；个人游戏对应 `My Experiences`。同一 Owner 下同名游戏、同一游戏内同名 Place 在操作界面前直接拒绝（退出码 2），因为对话框无法区分。
- 界面操作由内置脚本 `src/studio/publish-as.ps1` 完成：UI Automation 定位窗口并展开 File 菜单，Qt 不暴露的部分用 PrintWindow 截图 + Windows 中英文 OCR + PostMessage 后台点击/按键，坐标按对话框实际 DPI 缩放；每一步校验，识别不到就停。
- 发布后复核：覆盖时比较 Assets API 中 Place 的最新版本号（需 API Key 的 `asset:read`）；新建时在 Place 目录中查找新增 ID。界面成功但 API 未确认时状态为 `partial`（退出码 3）。点击 Overwrite/Create 之前的失败一定未发布；点击之后界面读取失败且未见新版本时报错 `STUDIO_UI_ERROR` 并说明状态未知，先检查再重试。
- 限制：Studio 必须是英文界面且不能最小化；不移动真实鼠标，但展开菜单会把 Studio 短暂拉到前台、对话框会在屏幕上显示约 10 秒，期间操作电脑可能导致失败。个人私密游戏不在目录中，同名冲突只能在界面上发现。
- 离线验证：`tests/studio-publish-as.test.ts`。

## Studio 带版本备注保存（Windows）

把本机已打开的 Studio 编辑会话通过 File > Save to Roblox with Notes 保存到**当前 Place**，并填写版本标题与详情。只保存版本，不发布上线。Publish As 对话框没有备注栏，需要备注时先用本命令保存。

```powershell
rbx studio save --title "v1.2.3 修复结算" --details "修复结算界面`n调整掉落" --dry-run --json
rbx studio save --title "v1.2.3 修复结算" --details "第一行\n第二行" --pid "<EditorPid>" --json
```

- `--title` 必填，单行；`--details` 可选，真实换行或字面量 `\n` 都按换行输入。拒绝 Tab 及其他控制字符（后台按键会移动焦点或关闭对话框）。
- `--pid`：多个会话时必填。`--dry-run` 填好标题和详情、确认 Save 可用后点 Cancel，不保存。`--debug-dir` 保存每一步截图。
- 界面脚本：`src/studio/save-notes.ps1`，共享 `src/studio/studio-ui.ps1`。打开对话框依次尝试 UIA 调用菜单项、键盘 + OCR 导航菜单、前台按 `Ctrl+Alt+S`（会短暂抢焦点，结束后交还）。菜单项置灰（如 Play Test 中）直接报错，不再尝试。
- 对话框是引擎渲染的插件窗口，UIA 看不到输入框：按 OCR 识别的标签版面定位字段，后台点击并逐字输入；输入前要求两个字段为空（显示占位文字），输入后回读，Save 按钮按亮蓝色像素识别（禁用时为暗蓝）。已打开的同名对话框会先关闭，其中未保存的文字丢弃。
- 不做线上回读、不需要 API Key：点击 Save 后对话框关闭即视为成功。点击 Save 前的失败一定未保存；点击后对话框未关闭报 `STUDIO_UI_ERROR`，状态未知，先查版本历史再重试。输出中的 `titleOcr` / `detailsOcr` 只是诊断信息。
- Team Create 下备注会挂到当前最新的已有版本上，不一定立即产生新版本号。
- 本地账本：每次成功保存追加到应用数据目录 `place-versions/<PlaceId>.jsonl`，记录时间、Place、标题与详情；dry-run 不写。
- 离线验证：`tests/studio-save-notes.test.ts`。真实界面只用 `--dry-run` 验证，真实保存需用户明确要求。

## Place 服务器人数上限

一个 Universe 可以包含多个 Place，人数上限按 Place 分别设置。`--universe` 接受 Universe ID 或本地游戏目录中的精确名称。

```powershell
rbx places list --universe <UniverseId>
rbx places update --universe <UniverseId> --place <PlaceId> --max-players 20
rbx places update --universe <UniverseId> --all --max-players 20
```

`list` 分页列出所有 Place，显示名称、ID、是否主 Place 和每服人数上限。`update` 必须且只能指定 `--place` 或 `--all`；人数为正整数，Roblox 判定实际允许范围。使用 Open Cloud API Key；写入权限为目标 Universe 的 `universe.place:write`。仅 PATCH `serverSize`，不修改其他配置；写入前读取原值，写入后回读验证。不会自动关闭 Studio 或重启服务器，Team Create 冲突会返回明确错误。

批量写入逐个执行，某个 Place 失败后继续其他 Place，保留成功结果；退出码 `3` 表示存在失败或未确认的项目。JSON 结果包含每个 Place 的 `before/requested/after/state`，状态为 `verified`、`failed` 或 `unverified`。网络中断或回读失败时不自动重试写入，应查询当前配置后再决定是否重试。

SDK 导出 `listPlaces(http, universeId)`、`getPlace(http, universeId, placeId)`、`updatePlaces(http, universeId, { placeId?, all?, maxPlayers })`。

离线测试：`tests/places.test.ts`。显式真实写测试会记录原配置到应用数据目录 `place-backups/`，通过 CLI 测试查询、条件允许时的 `--all` 原值写入、首个 Place 临时调整及恢复：

```powershell
$env:RBX_LIVE_PLACES_UNIVERSE = '<测试 Universe ID>'
npm run test:live:places
```

## 开发者产品同步（Studio 开发者产品表 → 宇宙）

以 Studio 的 `game.ServerStorage["项目文档"]["开发者产品"]`（ModuleScript）为唯一来源，单向同步到一个或多个宇宙的开发者产品；不从宇宙拉取、不回写 Studio。

```lua
-- 开发者产品：en = Roblox 商品名（同步主键，与游戏代码 productKey 一致）；zh 仅供阅读，不同步；price 为 Robux 正整数（写算好的值，不写公式）。
-- 同步：export_rbxm 导出本模块后执行 rbx devproduct sync <游戏...> --source ./开发者产品.rbxm
return {
	{ en = "Example Boost", zh = "示例加成", price = 19 },
	{ en = "Example Refill", zh = "示例补给", price = 49 },
}
```

导出：robloxstudio-mcp 的 `export_rbxm` 导出 `game.ServerStorage["项目文档"]["开发者产品"]` 为 `.rbxm`，作为 `--source`。只允许 `en`、`zh`、`price` 三个字段；`en` 为空、首尾有空格或重复，`price` 不是正整数，出现未知字段或空表时整次报错，不发任何请求。

```sh
rbx devproduct list "Example Development"
rbx devproduct icon "Example Development" 123456789 --image ./coin-boost.png --dry-run
rbx devproduct icon "Example Development" 123456789 --image ./coin-boost.png
rbx devproduct sync "Example Development" "Example Test" --source ./开发者产品.rbxm
rbx devproduct sync "Example Development" "Example Test" --source ./开发者产品.rbxm --confirm "<confirmToken>"
```

- `list <游戏>`：只读，分页拉取到最后一页（`nextPageToken` 为空），列出 ProductId、价格、是否在售、是否开地区定价、图标状态、名称，重名商品带警告（退出码 3）。任何一页失败或页标记重复即报错，不输出半份列表。图标状态本身不改变查询退出码。
- `sync <游戏...> --source <rbxm>`：每个宇宙先完整拉取商品列表，再按英文名精确匹配：
  1. 匹配上：仅价格不同时只 PATCH `price`，其他字段不动。
  2. 匹配不上：优先复用闲置商品（云端有、表里没有、非 immutable），按 ProductId 从小到大依次分给表中顺序靠前的行；复用会改 `name`、`price`，并设为在售、关闭地区定价、清空描述，图标保留原样。
  3. 闲置用完后新建：在售、关闭地区定价，无描述和图标。
  4. 未被复用的闲置商品只在结果中列出，不删除、不下架。
- 某个宇宙商品列表拉不全，或存在重名商品时，该宇宙整体拒绝（`PRODUCT_LIST_INCOMPLETE` / `DUPLICATE_PRODUCT_NAMES`），不写入；其他宇宙照常。

**两步确认（仅复用时）**：diff 中没有 `reuse` 时直接写入，返回 diff 与逐项回读结果。只要任一宇宙出现 `reuse`，所有宇宙整批都不写入，返回 `status: "confirmation_required"`、`confirmToken`、`agentInstruction`，退出码 **6**。Agent 必须把完整 diff（每条 reuse 的旧名 → 新名）展示给用户，获得明确同意后用相同参数加 `--confirm <confirmToken>` 再执行，不得自行确认。确认码由表内容和各宇宙云端快照计算；执行前重新拉取并重算，表或云端有任何变化时确认码失效，返回 `stale: true` 和新的 diff/确认码，不写入。

**风险（由使用者把关）**：表必须列全游戏实际使用的商品——代码里写死但没进表的商品名会被当作闲置改名复用。被复用的旧商品若还有未处理完的收据，Roblox 补发时会按新商品发货。

写入前把该宇宙全部商品与计划动作备份到应用数据目录 `devproduct-backups/`（失败则不写该宇宙）；每次写入后读取单个商品核对名称、价格与在售状态；该读取是最终一致的（实测约 2 秒内会在新旧值间跳动，新建商品可能短暂 404），不一致时按 1/2/3/5 秒间隔重读，最多 5 次，结果中 `readbacks` 为读取次数；地区定价不参与核对。写入不自动重试；`failed` 为明确拒绝，`unverified` 为响应丢失或回读不符，先 `devproduct list` 核对再决定是否重跑（重跑前要确认 create 是否已生效，避免重名）。列表同样可能滞后，刚新建后立即重跑 sync 可能看不到新商品而再次新建，新建后请间隔片刻再重跑。存在失败、未确认或被拒绝的宇宙时状态为 `partial`、退出码 3。

API Key 需目标宇宙的 `developer-product:read`（list/sync/icon）与 `developer-product:write`（sync/icon 写入）。接口：[Developer Products (Beta)](https://create.roblox.com/docs/cloud/reference/features/developer-products)。SDK：`listDeveloperProducts`、`planUniverse`、`syncDeveloperProducts`、`loadDeveloperProductTable`、`uploadDeveloperProductIcon`、`classifyDeveloperProductIcon`。

图标分类只在本地检查 ID，不下载图片、不调用缩略图接口，无需额外权限。列表 JSON 的每个产品、SDK 读取/创建返回的 `DeveloperProduct`，以及图标上传回执中的 `readback` 都包含派生字段 `iconStatus`：

| `iconStatus` | 人类可读输出 | 判定 |
| --- | --- | --- |
| `missing` | 未配置 | `iconImageAssetId` 为空或 0（产品结果中统一为 `null`） |
| `placeholder` | 已知占位图 | 命中集中维护的已知占位图 ID，目前为 `88963008124478` |
| `configured` | 已配置（显示未验证） | 其他非空 ID，不代表审核通过或图片正常显示 |

非空 `iconImageAssetId` 不能直接视为正常图标。已知占位图清单来自人工核对，不是 Roblox 官方保证不变、完整的默认 ID 清单；未收录的占位图仍可能被分类为 `configured`。SDK 的 `classifyDeveloperProductIcon(iconImageAssetId)` 使用同一规则；原始非零 ID 保留，便于核对。

`devproduct icon <game> <productId> --image <path>` 更新单个产品的默认图标。接受静态 PNG/JPEG（本地限制 20 MiB、4000 万像素），自动校正方向并等比缩小至 512×512 内，不裁剪，保留透明度，转 PNG 后用 multipart `imageFile` 上传。只发送图标字段。`--dry-run` 校验图片并读取产品，不上传或生成备份。正式上传前保存原产品配置（含旧图标 ID）及本次上传的 PNG 到 `devproduct-backups/`；这些记录不是旧图标原文件，也不提供一键恢复。不可修改的商品直接拒绝。SDK 的 `ProductFields.imageFile` 接受 Blob，可供底层创建/更新接口直接使用；底层接口不做图片规范化和备份。

上传只提交一次，随后最多回读 5 次（间隔 0/1/2/3/5 秒）。观察到变化的 `iconImageAssetId` 且 `iconStatus` 为 `configured` 时返回 `verified`，仅表示图标引用已更新并排除了已知占位图，不代表图片审核已通过或显示正常。占位图回读会继续等待；最后一次回读仍为占位图时返回 `unverified`、`ICON_PLACEHOLDER`，未配置或 ID 未变化时为 `ICON_NOT_VERIFIED`；上传响应丢失也返回 `unverified`，不自动补传。未确认退出码 3，先用 `devproduct list <game> --json` 检查，避免盲目重复上传。默认离线验证：`tests/devproduct-icon.test.ts`。

离线测试：`tests/devproducts.test.ts`。显式真实写测试：

```powershell
$env:RBX_LIVE_DEVPRODUCTS_UNIVERSE = '<开发服 Universe ID>'
npm run build; npm run test:live:devproducts
```

它在开发宇宙验证完整翻页、改价并还原、新建、复用的两步确认（无确认码/错误码/过期码均不写入）。开发者产品无法删除，脚本最多保留一个 `ZZ CLI Test …` 商品（下架状态），后续运行复用它；结束时还原所有原商品价格。

## 游戏活动（Events）

管理 Creator Dashboard「活动与更新」中的活动，支持名称、副标题、说明、类别、起止时间、进入 Place、公开／私人可见性和图片。不包含页面链接到的旧版更新通知。使用官方 [Game Events API（Experimental）](https://create.roblox.com/docs/cloud/reference/features/virtual-events.md)，无需 Cookie 或 Studio。图片通过 [Assets API](https://create.roblox.com/docs/cloud/guides/usage-assets) 单独上传后绑定。

```powershell
rbx events rules
rbx events categories
rbx events list "Example Game"
rbx events list 123456 --all --visibility private
rbx events list 123456 --starts-after "2026-12-01T00:00:00-08:00" --ends-before "2027-01-01T00:00:00-08:00"
rbx events get 9007199254740993123

# 创建预览；审阅后去掉 --dry-run 才会提交
rbx events create 123456 --title "Winter Festival" --subtitle "New quests await" --description "Complete seasonal quests." --start "2026-12-01T18:00:00-08:00" --end "2026-12-08T18:00:00-08:00" --visibility private --category festival --dry-run

# 群组托管活动用 --group；进入非根 Place 用 --place
rbx events create "Example Game" --file ./event.json --dry-run
rbx events update 9007199254740993123 --title "Updated Festival" --dry-run
rbx events update 9007199254740993123 --visibility public --dry-run
rbx events delete 9007199254740993123 --dry-run

# 图片单独上传，以便失败后复用 ID；--user 与 --group 必须且只能选一个
rbx events upload-image ./festival.png --group 123456 --dry-run
rbx events upload-image ./festival.png --group 123456
rbx events image-operation operations/example_operation
rbx events update 9007199254740993123 --thumbnail 456789 --dry-run

rbx auth check --for events-write --universe 123456
rbx auth permissions --for events-image
```

`<game>` 接受 Universe ID 或本地游戏目录精确名称。`get/update/delete` 直接使用活动 ID，不需要指定游戏；修改和删除先读取所属宇宙及原值。活动 ID 可超过 2^53，CLI 和 SDK 全程保留字符串，SDK 调用也必须传字符串。Place、群组和图片素材 ID 必须是正安全整数。

`list` 自动完成分页并拒绝循环游标。默认由服务端列出进行中和未来活动；`--all` 设置 `endsAfter=1970-01-01T00:00:00Z`，包含结束活动。可按 `--visibility public/private/moderated` 以及 `--starts-before/--starts-after/--ends-before/--ends-after` 筛选。显式结束时间筛选优先于 `--all`。空列表不证明目标宇宙存在或有编辑权限。

创建必须提供 `title/subtitle/startTime/endTime/visibility`。`--category` 和 `--thumbnail` 支持多个值，按输入顺序从 rank 0 排列。类别必须来自 `events categories`，不允许重复类别、图片或 rank。省略图片时使用 Roblox 的默认体验缩略图；省略 Place 时使用根 Place。群组活动通过 `--group <id>` 指定 host，省略时使用当前认证用户。可见性写入只接受 `public/private`，`moderated` 由服务端管理。活动名等文本仍需通过 Roblox 服务端审核与长度校验；本地限制说明不超过 1000 字符。时间必须包含秒和 `Z` 或 UTC 偏移，统一转为 UTC；拒绝无时区、无效日期和结束不晚于开始的计划。只修改起点或终点时，合并线上原值检查时间先后。

`--file` 使用 UTF-8 JSON，不能与任何活动字段参数混用。创建文件示例（全部为虚构数据）：

```json
{
  "title": "Winter Festival",
  "subtitle": "New quests await",
  "description": "Complete seasonal quests.",
  "startTime": "2026-12-01T18:00:00-08:00",
  "endTime": "2026-12-08T18:00:00-08:00",
  "visibility": "private",
  "groupId": 123456,
  "placeId": 234567,
  "categories": [{ "category": "festival", "rank": 0 }],
  "thumbnails": [{ "mediaId": 456789, "rank": 0 }]
}
```

修改文件只放要变更的字段（不允许 `groupId`）；未提供字段不变，拒绝未知字段、`null` 和空更新。清空说明可用 `--description ""` 或 JSON `"description": ""`；清空图片／类别用 JSON `"thumbnails": []`／`"categories": []`。图片和类别数组按整体替换处理。

所有写命令支持 `--dry-run`：创建只校验和展示请求，修改／删除会读取原活动但不写入，图片只在本地解码校验；均不上传、不生成备份。正式写入前在应用数据目录 `event-backups/` 保存原活动和计划请求，失败则不提交。创建、修改后回读并核对请求字段，创建时指定的群组也核对 host；响应中 `allThumbnailsCreated=false` 或回读不符时为 `unverified`。删除是永久删除，以服务端 204 确认，备份只能用于手动重建内容，无法恢复原活动 ID、RSVP 或通知状态。没有自动恢复命令。

图片接受静态 PNG/JPEG，限制原文件 20 MiB、4000 万像素，校正方向后转 PNG，保留尺寸和透明度。上传前保存请求摘要和本次 PNG，提交后保存操作 ID 到 `.operation.json`，最多只读查询 10 次，每次间隔 2 秒；未完成返回 `pending` 和 `operationId`，用 `image-operation <operationId>` 继续查询，不能直接重传。上传完成时 `response.mediaId` 可用于创建或修改的 `--thumbnail`，`moderationState` 仅为上传响应提供的状态；`verified` 只表示上传操作完成或活动引用一致，不证明审核通过或显示正常。图片回执的 `universeId` 为空字符串，因为素材属于指定 creator，尚未绑定游戏。

写入不自动重试。网络中断、超时、5xx、响应格式异常或回读失败可能发生在服务器已生效之后，返回 `unverified`；已知的活动 ID、操作 ID、响应及错误保留在输出和备份旁 `.result.json`，先查询再决定是否重跑。支持全局 `--json`，沿用 `{ schemaVersion, status, data, warnings }`；计划或确认成功退出 0，`pending/unverified` 退出 3，参数错误退出 2，无凭证／无效 Key 退出 4，403 退出 5，其余明确错误使用通用错误退出码。审核或服务端业务拒绝不会被包装成成功。

权限：`events-read` 为 `universe.event:read`；`events-write` 为目标游戏的 `universe.event:read/write`（创建后回读、修改删除前读取）；`events-image` 为 creator 范围的 `asset:read/write`，`events-image-read` 为 `asset:read`。已有素材 ID 的绑定不额外申请素材上传权限。账号及群组角色仍需 Roblox 的实际活动管理权限。

SDK：`new GameEvents(http).list/get/create/update/delete`、`eventCategories`、`eventId`、`eventTime`、`validateEventFields`、`eventRules`、`eventTextSummary`、`validateEventText`、`uploadEventImage`、`getEventImageOperation`。活动写方法可传 `{ dryRun, backupDirectory }`；CLI 必定备份，SDK 活动备份目录可选；图片正式上传必须指定备份目录。离线验证：`tests/events.test.ts`，使用虚构响应和临时图片；默认测试不访问真实 API。

### 活动文本校验与规则提示

`rbx events rules` 完全离线、无需 Key，返回标题／副标题／说明的限制、计数方式、时间和可见性规则、仍需服务端确认的项目，以及规则来源。`create/update --help` 也显示文本上限。规则统一维护在 `src/events/rules.ts`，CLI 参数与 JSON 文件、SDK、正式提交与 `--dry-run` 使用同一份校验；超限在获取凭证或请求 API 前拒绝（SDK 不发请求），退出码 2。

| 字段 | 上限（UTF-16 code units） | 空值规则 |
| --- | --- | --- |
| `title` | 25 | 创建必填；不能空白 |
| `subtitle` | 25 | 创建必填；不能空白 |
| `description` | 1000 | 可省略；空字符串清空 |

长度按 JavaScript `string.length` 计算，不是可见字形数，也不是 UTF-8 字节数。普通汉字一般计 1，`😀` 计 2；变体选择符、连接符、组合音标分别计数。例如 `🛍️ Trading Plaza Is Here!` 为 26，`🛍 Trading Plaza Is Here!` 为 25。CLI 不会自动去空格、截断、规范化或删除 emoji；报错包含具体字段、当前长度／上限、超出数量及 `events rules` 提示。

来源是 **2026-11-13 核对的 Roblox 官方 Creator Dashboard 前端表单规则**：常量模块将 title/subtitle/description 分别设置为 25/25/1000，表单将它们用于 `maxLength` 校验。来源链接与核对日期可在 `events rules` 中查看。这是离线规则快照，不是 Game Events API 在错误中返回的长度元数据；平台前端规则将来可能变化。

CLI 创建与修改回执新增 `data.validation`：`scope=local-text`、计数方式、逐个已提交文本字段的 `length/maxLength/remaining`、规则来源及 `serverChecksIncluded=false`。未提供的 PATCH 字段不纳入计数，也不被替换。`--dry-run` 的状态为 `planned`，只表示本地输入校验和请求预览完成；不代表 Roblox 已接受、审核通过或账号具备业务访问权。

服务端仍可能因审核、权限、名额、时间／Place 资格等拒绝输入。活动写入的 400 ProblemDetails 会显示经过凭证脱敏、控制字符清理和长度限制的诊断；若返回 `InvalidTitleOrDescriptionException`，提示查看规则并核实审核等服务端条件，不把该异常一律解释为超长，也不自动换文案或重试写入。
