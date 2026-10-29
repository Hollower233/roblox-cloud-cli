# Roblox Cloud CLI

独立的 Roblox Cloud 命令行工具与 TypeScript SDK。提供 API Key 管理、游戏扫描、本地缓存、权限验证、游戏列表，以及标准 DataStore 单条读取与跨游戏复制。发布与分析尚未实现。

## 安装与启动

需要 Node.js 22.13+（推荐 24）。在仓库目录执行：

```sh
npm ci
npm run build
npm link
rbx --help
```

不安装全局命令也可以执行 `node dist/cli/main.js` 或 `npm run dev --`。

## 凭证

```sh
rbx auth set
rbx auth status
rbx auth clear
```

`auth set` 隐藏输入，联网验证后保存。Windows 使用当前 OS 用户的 DPAPI 加密，明文不会写入工具配置。`auth clear` 删除保存的凭证，保留目录缓存。

已有本地密钥文件时可使用 `rbx auth set --key-file <本地路径>`。此命令不删除原文件。不要把密钥文件加入 Git。

环境变量 `ROBLOX_API_KEY` 优先于保存的凭证，可供 CI、临时测试以及 macOS/Linux 使用。第一版 macOS/Linux 尚未实现持久凭证存储，需使用该环境变量。不要通过命令行参数直接传入密钥。

扫描与游戏权限查询需要：

- `legacy-group:manage`：可管理群组查询。
- `legacy-universe:manage`：Universe 管理权限查询。

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

## 玩家存档历史与合成审计

只读查询一个玩家的 ProfileService 历史版本，并从各版本累计的物品流水中去重汇总合成事件：

```powershell
rbx profile history "Example Production" --player ExamplePlayer --limit 10
rbx --json profile history 123456789 --player 12345 --limit 25
```

游戏支持 Universe ID 或本地目录中的完整名称；玩家支持一个用户名或 User ID。`--limit` 范围为 1–100，默认读取最新 10 个 Roblox 仍保留的版本。命令固定读取 `Default` / `global` / `PLAYER_{uid}`，不会写入、恢复或备份存档。

普通输出逐版本显示时间、货币、经验、物品数和 RPS 战绩，并列出去重后的 `fusion` 流水。JSON 输出保留版本 ID、数据摘要、合成事件 ID、时间、被消耗实例 ID、生成实例 ID及结果物品 ID，便于结合游戏配置表审计具体品质和显示名称。

API Key 需要 `universe-datastores.versions:list` 和 `universe-datastores.versions:read` 权限。历史版本由 Roblox 保留策略决定；未出现在接口结果中的旧版本无法由本命令恢复。模块：`src/profiles/history.ts`、`src/datastores/entries.ts`；离线验证：`tests/profile-history.test.ts`、`tests/datastores.test.ts`。

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

## 游戏图标倒计时

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
rbx player add FriesOverEverything
rbx player add FriesOverEverything --alias 水木
rbx player add AtysGames --alias 船长
rbx player list
rbx player find fries
rbx player alias FriesOverEverything 水木
rbx player remove FriesOverEverything
```

`add` 使用真实 Roblox 用户名在线查询 UID，不接受 Display Name、别名或 UID，也不需要 API Key。只有显式添加才保存；重复 UID 更新用户名，未传 `--alias` 时保留已有别名。`alias` 设置或替换一个别名。别名支持中文、最多 100 字符，不允许逗号、控制字符或纯数字。`remove` 仅移除本地记录。

`list`、`find`、`alias`、`remove` 只使用本地数据，不需要网络或凭证。匹配忽略大小写：UID 精确匹配；其他输入优先匹配完整用户名或完整别名，未命中时按用户名片段匹配。`find` 返回所有候选；需要单个玩家的命令在多个候选时返回参数错误并列出姓名、UID 和别名，须改用明确 UID 重试。别名也可能重名，不会自动选择其中一人。

`profile history`、`profile copy`（含 `--to`）、`profile clear`、`ban`、`unban` 和 `ban-status` 使用同样的清单解析。唯一片段或别名命中后直接使用保存的 UID；清单未命中的真实用户名保留在线查询，查询结果不自动写入清单。

```sh
rbx profile history "BVB TEST" --player fries
rbx profile history "BVB TEST" --player 水木
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

`localization` 管理游戏详情页的标题和简介，支持游戏名称（从本地游戏目录精确匹配，忽略大小写）或 Universe ID。语言目录每次从 Roblox 获取，不写死语言数量；输出全部创作者语言及地区版本，区分游戏已启用语言、返回的译文和未返回的内容。需要有效 API Key，英文原文通过 Cloud Universe 接口读取，私有游戏也可查询。

```sh
rbx localization read "Example Game"
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

语言代码与地区代码不同：`en` 是英文通用版本，`en-gb`/`en_gb` 是英国版本。英文、法文、葡萄牙文、西班牙文支持独立地区覆盖；其他地区代码输入会映射到对应语言通用版本，例如 `ja-jp` → `ja`。别名冲突会在写入前拒绝；源语言默认地区不能作为覆盖项（例如源语言是 `en` 时，使用 `en` 修改原文，不能用 `en-us` 覆盖）。额外返回的历史语言记录保留在 `translations` 中，不丢弃。

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
