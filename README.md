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

可使用 `RBX_HOME` 环境变量或全局 `--home <目录>` 覆盖。缓存按 Roblox 用户 ID 隔离，切换 Key 不会把另一账号的数据混进来。

- `config.json`：当前账号与按账号保存的手动登记 ID。
- `credential.dpapi`：Windows 加密凭证。
- `catalog-<userId>.json`：带 schemaVersion 的游戏目录。
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
