# `.agent/scripts` — 工程治理与视觉验收脚本

Windows 环境统一通过 PowerShell 调用：

| 脚本 | 用途 | 示例命令 |
|---|---|---|
| [`verify-governance.ps1`](verify-governance.ps1) | 校验全部路由 `README.md` 行数 ≤ 300、治理与路由文档本地相对链接零断链，以及 [`.agent/lessons.md`](../lessons.md) 满 3 次规则是否均已升格至 [`docs/code-standards.md`](../../docs/code-standards.md) | `.\.agent\scripts\verify-governance.ps1` |
| [`new-proposal.ps1`](new-proposal.ps1) | 在 `.agent/notes/proposed/<slug>/` 下生成带「语义级变更声明」「UI 九维检查」「改后四步核对」与 `evidence/` 目录的标准立项文档 | `.\.agent\scripts\new-proposal.ps1 -Slug fix-focus -Subsystem web-client` |
| [`record-gif.ps1`](record-gif.ps1) | 从 Android 模拟器/真机实时录屏，或将 Web 录屏（`.webm`/`.mp4`）转换为调色板优化的真实操作 `.gif` 证据 | `.\.agent\scripts\record-gif.ps1 -Serial emulator-5556 -Seconds 8 -Out .\.agent\notes\proposed\<slug>\evidence\flow.gif` |
