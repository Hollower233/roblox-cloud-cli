# Roblox Cloud CLI

- 本仓库为独立 TypeScript CLI，不修改 Roblox Studio。
- 项目系统记录在 AGENTS.md 与 CLAUDE.md 中保持一致。
- Key、Cookie、真实账号扫描结果不得提交。真实 API 测试显式运行，默认测试离线。

## 命令与业务模块

- 命令入口与输出：`src/cli/main.ts`、`src/cli/output.ts`。
- 游戏目录与模型：`src/universes/`；公共 SDK 入口：`src/index.ts`。
- Roblox API 与 HTTP：`src/roblox/api.ts`、`src/transport/http-client.ts`。
- 凭证与本地存储：`src/auth/`、`src/storage/`；统一错误：`src/core/errors.ts`。

## 验证与文档

- 离线测试与虚构响应样例：`tests/`、`tests/fixtures/`。
- 真实 API 冒烟测试：`scripts/live-smoke.ts`。
- 使用文档与 CI：`README.md`、`.github/workflows/ci.yml`。
