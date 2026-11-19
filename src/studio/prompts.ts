export const STUDIO_SAVE_PROMPT = `将当前 Studio Place 保存到 Roblox，并给本次新版本写备注。
1. 从任务取得源 Place ID、标题和详情，用官方 MCP 的 list_roblox_studios 选中对应的云端 Edit 会话。用 rbx --json places versions list --place <PlaceId> 记录最新版本。
2. 调用官方 MCP 的 save_place({studio_id}) 一次，省略 notes。最多等 30 秒，用同一 CLI 命令退避查询，确认 Saved 返回的确切版本高于基线且已出现在云端。无有效版本、旧版本或超时就停止并报告，不猜版本、不再保存。
3. 运行 rbx --json places version-notes set --place <PlaceId> --version <版本号> --title <标题> --details <详情>，以 CLI 的回读结果为准。`;

export const STUDIO_PUBLISH_PROMPT = `将当前 Studio 内容覆盖发布到任务指定的已有 Place。
1. 核对源 Place、目标 Universe、Place 和所有者 ID。用官方 MCP 的 list_roblox_studios 按源 Place ID 选中 Edit 会话，记录当前 Studio 输出位置。
2. 通过官方 MCP 的 execute_luau 在 Edit 会话再次核对源 Place ID，然后调用一次 game:GetService("StudioPublishService"):PublishAs(universeId, placeId, groupId, true, {}, false, false)。群组目标传实际 Group ID，个人目标传 0。
3. 只检查本次调用后的 Studio 新输出。必要时读该会话的 Studio 日志，用请求和完成日志核对目标 Place ID。返回 nil 仅表示已发起。指数退避，单次最多 30 秒，每个 Place 总计最多等 5 分钟。明确确认成功后继续，失败或超时则停止并报告，不自动重发。`;
