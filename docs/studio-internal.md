# Studio Internal 补丁维护

本手册说明 rbx 如何给当前 Windows Studio 做 Internal 权限补丁，以及 Studio 更新后签名变化时怎么重新定位。日常用法见 [命令参考](cli-reference.md#打开-studio-项目windows)。

实现：[`src/studio/internal.ts`](../src/studio/internal.ts)。离线测试：[`tests/studio-internal.test.ts`](../tests/studio-internal.test.ts)。

## 边界

rbx 只做四件事：找最新 `RobloxStudioBeta.exe`、按固定定位链修改权限 helper 与配套零售版保护 guard、写出同目录 `RobloxStudioBeta_INTERNAL.exe`、启动时识别 Internal 会话。

不覆盖官方 exe。补丁失败返回 `STUDIO_PATCH_FAILED`，不回落官方副本。不刷新 `mcp.bat`，不改社区 `MCPPlugin.rbxmx`，不把 Plugin VM 抬成 RobloxScript。特权 Luau 走官方 `StudioMCP.exe` / `mcp.bat`，不走社区 `execute_luau`。

`AssistantSettings.UseElevatedCapabilities=true` 只是官方 MCP 的辅助开关，不是 Internal 补丁本身。

## 当前签名

定位链写死在 `planInternalPatch()`：

1. 在 PE 映像里找 ASCII 字符串 `[Internal]`（窗口标题后缀）。
2. 在 `.text` 里找 RIP-relative `lea r64,[rip+disp32]`（`48 8d ?? ?? ?? ?? ??`，ModRM 低 3 位为 `101`），目标正好是该字符串。
3. 从该 `lea` 往前最多 32 字节找 `E8` 近 call。
4. callee 开头 8 字节必须是 `cmp byte ptr [rip+disp32], 0 / je`：`80 3d ?? ?? ?? ?? 00 74`。解析 helper 内连续两个 `cmp` 的 RIP-relative 标志位地址。
5. 在 helper 后最多 `0x400` 字节内，查找依次检查相同两个标志位、失败时抛异常的零售版保护 guard；其函数头必须是 `sub rsp, imm8`，成功路径以匹配的 `add rsp, imm8 / ret` 收尾。
6. 把 helper 的 8 字节改成 `mov al,1; nop*5; ret`：`b0019090909090c3`；把 guard 开头 4 字节改成 `ret; nop*3`：`c3909090`。helper 被约百处调用；只改 helper 会开启 Internal 专用路径，但零售版 guard 仍会抛异常，导致项目加载后崩溃。

已知命中（`version-8d7a1009c17e4ff8`，`RobloxStudioBeta.exe`）：

- `fileOffset=42796256`
- `originalBytes=803daa3e8f0a0074`
- `patchedBytes=b0019090909090c3`
- 函数 VA 约 `0x1428d10e0`
- `guardFileOffset=42796512`
- `guardOriginalBytes=4883ec48`
- `guardPatchedBytes=c3909090`
- guard VA 约 `0x1428d11e0`

小更新若 helper 和 guard 的结构仍在，`rbx studio patch` 会按源 SHA-256 复用或重写 Internal 副本。offset 随版本变是正常的。

## 日常流程

Studio 更新后先关官方进程，再只打补丁：

```powershell
rbx studio patch
rbx --json studio patch --inspect
```

`--inspect` 只读官方 exe，不写 `RobloxStudioBeta_INTERNAL.exe`，也不改 Assistant 设置。成功时 JSON 含 `ok: true`、源 SHA-256，以及 helper 和 guard 各自的 offset / original bytes。失败时仍是 `STUDIO_PATCH_FAILED`，JSON 里会带已找到的 marker / lea / helper / guard 字节，方便对照本手册扩匹配。

回执在应用数据目录 `studio-internal/latest.json`（默认 `%LOCALAPPDATA%\roblox-cloud-cli\studio-internal\latest.json`）。保留 source/output SHA-256 和 plan，不提交真实 exe。

启动 Internal 会话：

```powershell
rbx studio open "<游戏名或 UniverseId>"
rbx studio list
```

`list` 的进程名同时认 `RobloxStudioBeta` 和 `RobloxStudioBeta_INTERNAL`。Internal 身份优先按进程命令行中的精确 exe 名识别；窗口标题可能因版本或本地化不显示 `[Internal]`。已有同 Place 官方会话时，默认 open 会报错，需先 close 或显式 `--stock`。

## 验证提权

标题带 `[Internal]` 只证明窗口标题路径走到了补丁函数；不带后缀也不能证明权限未生效。权限以官方 MCP 为准：

```lua
print(game:GetService("StudioService"):HasInternalPermission())
```

应返回 `true`。社区 `robloxstudio-mcp` 的 `execute_luau` 跑在 Plugin VM 的 `loadstring` 上，即使 Studio 已是 Internal，这条通道也不会变成 RobloxScript。不要用社区 MCP 当提权证据。

## 失败时怎么重定位

先看 `rbx --json studio patch --inspect` 停在哪一步，再只改对应匹配，不要换定位入口。

| inspect 字段 | 常见原因 | 处理 |
| --- | --- | --- |
| 无 `markerOffset` | `[Internal]` 被拆开、改名或改 UTF-16 | 搜 `Internal` / 窗口标题拼接；确认仍是标题后缀后再改 marker |
| 有 marker，无 `leaOffset` | `lea` 编码变了，或字符串只被间接引用 | 在 `.text` 按 marker VA 反查 RIP-relative 引用；必要时放宽 ModRM |
| 有 lea，无 `callOffset` | call 不在 lea 前 32 字节，或中间插入了别的指令 | 略微扩大前向窗口；核对 `test al,al` / `cmovne` 仍在 call 之后 |
| 有 call，`helperBytes` 不是 `80 3d .... 00 74` | 短 `je (74)` 变成近跳 `0f 84`，或 cmp 编码变了 | 扩 `isInternalHelper()`，补丁仍应让函数返回 1 且长度盖住原 prologue |
| 无 `guardOffset` | guard 移出扫描窗口、跳转编码变化，或不再直接检查同一标志位 | 反查 helper 两个 flag 的交叉引用，确认抛异常的保护函数；更新结构匹配和假 PE 测试，不可只跳过 guard 定位 |
| `ok=true` 但窗口无 `[Internal]` | 当前版本或本地化不显示后缀，或启动的不是 INTERNAL 副本 | 核对进程命令行的 exe 是否为 `RobloxStudioBeta_INTERNAL.exe`；用官方 MCP 再测 `HasInternalPermission()` |
| 启动后约十几秒崩溃，异常为 `0xe06d7363` | 只改了 helper，零售版 guard 仍在 Internal 路径抛 C++ 异常 | 确认产物同时包含 `guardPatchedBytes`，删除旧 Internal 副本后重新运行 `studio patch` |

手工核对（只读，不写盘）：

```powershell
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { inspectInternalPatch } from './src/studio/internal.ts'; const stock = process.argv[1]; const data = await readFile(stock); console.log(JSON.stringify(inspectInternalPatch(data), null, 2));" "%LOCALAPPDATA%\Roblox\Versions\<version>\RobloxStudioBeta.exe"
```

改匹配后必须：

1. 在 [`tests/studio-internal.test.ts`](../tests/studio-internal.test.ts) 增加新 helper、guard 或失败形态的假 PE，保留当前双补丁用例。
2. 对真实当前 exe 跑 `rbx --json studio patch --inspect`，确认 helper 与 guard 的原字节和 RVA。
3. 再 `rbx studio patch`，用官方 MCP 验证 `HasInternalPermission()`。
4. 把新的 helper / guard offset、original bytes 和版本目录记进本节「当前签名」。

不要为了让命令成功而静默启动官方 exe，也不要为了兼容去打官方 `RobloxStudioBeta.exe`。

## 不要扩的范围

- 不把社区 Plugin 身份提权写进同一条命令。
- 不内化 Vanta Publish Service / 第三方 MCP。
- 不把 `mcp.bat` 路径刷新塞进 `studio open`。
- 不提交 Studio 二进制、真实账号设置或 Assistant JSON。
