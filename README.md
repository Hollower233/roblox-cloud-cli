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

HTTP 默认按 host 串行安排请求起始时间，间隔 700ms；幂等 GET 在 429/部分 5xx 或网络异常时有限重试。支持 Retry-After；超过 30 秒的服务器冷却时间交由调用方稍后重试。POST 不自动重试。禁止 HTTP 重定向携带凭证，只有指定的 apis.roblox.com 请求会附带 Key。

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

源、目标支持 Universe ID 或本地目录中的完整游戏名称（忽略大小写）；重名会报错，需改用 ID。名称解析使用当前缓存账号的目录，必要时先运行 `rbx universe scan` 或 `rbx universe add <UniverseId>`。直接使用两个 Universe ID 不需要本地游戏目录。

`--players` 接受逗号分隔的 Roblox 用户名或 User ID，最多 100 个输入，自动去重。不支持显示名称。所有用户名解析完成后才开始复制；任一用户名不存在会终止，不写入存档。API Key 需要源读取、目标读取和创建/更新权限；用户名查询不会携带 Key。

每位玩家依次执行本地备份、条件覆盖或创建、回读校验；已有目标存档会被覆盖，无额外确认。单个玩家失败后继续处理其他玩家，最终逐人输出结果，成功项包含备份路径；写入阶段失败的信息保留备份路径与写入不确定性提示，重试前应检查目标。该批量操作不是事务，不会自动回滚已完成的玩家。

退出码：全部成功为 0，部分成功为 3，全部复制失败为 1，取消为 130；复制前的参数/认证等错误遵循原有错误契约。JSON 输出的 `data.results` 包含每位已处理玩家的结果，`succeeded`、`failed`、`skipped` 汇总数量；出现逐人失败时报告状态为 `partial`（全部失败同样保留完整批量报告）。

此预设原样复制整条记录及其 attributes/userIds，不清除或改写 ProfileService 会话锁、元数据，也不协调正在运行的游戏服务器。应在相关玩家存档已释放且不会继续保存时复制。不同存储命名仍使用通用 `rbx datastore copy`。
