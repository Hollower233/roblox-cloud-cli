# ☁️ Roblox Cloud CLI

用 `rbx` 在终端管理 Roblox 游戏。把发版、存档维护和本地化等重复操作写成命令，方便在多个游戏之间复用。

## 🛠️ 能做什么

- 🎮 **管理游戏和服务器** · 扫描并缓存游戏目录，查看服务器状态、重启旧服、调整 Place 人数上限。
- 💾 **管理玩家数据** · 查存档历史和排行榜，跨游戏复制 ProfileService 存档，批量清档。
- 🚀 **日常运营** · 封禁和解封玩家，调整群组角色，管理游戏内配置、A/B 实验和开发者产品。
- 🌐 **同步本地化** · 管理 18 种语言的游戏标题和简介，用 DeepSeek 补齐游戏内翻译并同步到多个游戏。
- 🎨 **处理图标与素材** · 从当前游戏图标生成倒计时，定时换图并恢复原图。上传开发者产品图标，也可以下载素材原图。
- 🪟 **操作 Windows Studio** · 打开或关闭项目，或将当前项目发布到指定 Place。

## ✨ 亮点

- **先审阅，再执行** · 清档可预览，正式执行前会备份。发布配置前需确认草稿哈希。
- **方便接入自动化** · CLI 支持 `--json`，核心能力也可通过 TypeScript SDK 调用。

## ⚡ 快速开始

需要 Node.js 22.13+。在仓库目录运行：

```sh
npm ci
npm run build
npm link
rbx --help
```

在 Windows 上可用 `rbx auth set` 保存 Roblox Open Cloud API Key。也可以在任意平台设置 `ROBLOX_API_KEY` 环境变量。配置后用 `rbx universe scan` 建立游戏目录，再运行 `rbx universe list` 查看。

[📚 命令参考](docs/cli-reference.md)
