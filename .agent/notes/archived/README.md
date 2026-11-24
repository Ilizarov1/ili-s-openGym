# 归档

这里保存已完成需求的设计、实施计划、验收记录和证据索引。归档文档不再维护，只用于追溯当时的实现范围、验收结果和已知限制。仍在进行中的功能留在 [`docs/`](../docs/README.md)。

| 归档 | 状态 | 现行文档 |
|---|---|---|
| [NestJS API 迁移](nestjs-migration/DESIGN.md) | A1–A11 主体验收通过；真实 Passkey 截图、RN 照片上传和远端 CI 未闭环，Nix 本轮暂缓 | [`api/openapi.yaml`](../api/openapi.yaml)、[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) |
| [RN 训练组行与递减组](rn-workout-set-ui/DESIGN.md) | V01–V11 通过（2026-11-20），包含组行、组菜单、递减段、旧草稿和独立 API 回读 | [`docs/dev/SET_TYPES.md`](../docs/dev/SET_TYPES.md)、[`docs/RN_MIGRATION_STATUS.md`](../docs/RN_MIGRATION_STATUS.md) |
| [RN 替换动作选择器](rn-replacement-picker/DESIGN.md) | V1–V6 通过；V6 的预设备选直接切换只做了静态核对 | [`docs/rn-exercise-search/DESIGN.md`](../docs/rn-exercise-search/DESIGN.md) |
| [RN Android 0.1.x 实施与验收](RN_ANDROID_EXECUTION.md) | 0.1.0–0.1.6 的构建、回归和验收记录 | [`docs/RN_MIGRATION_STATUS.md`](../docs/RN_MIGRATION_STATUS.md)、[`mobile-rn/scripts/README.md`](../mobile-rn/scripts/README.md) |
| [RN 设计系统执行](RN_UI_EXECUTION.md) | 设计系统、Gallery 和模拟器验收 | [`docs/RN_UI_DESIGN_SYSTEM.md`](../docs/RN_UI_DESIGN_SYSTEM.md)、[`docs/RN_UI_VISUAL_TESTING.md`](../docs/RN_UI_VISUAL_TESTING.md) |
| [P2 高级训练与动作库](rn-p2-training-library/README.md) | 需求、设计、执行步骤和验收目标；逐项完成状态以迁移清单为准 | [`docs/rn-p2/README.md`](../docs/rn-p2/README.md)、[`docs/RN_MIGRATION_STATUS.md`](../docs/RN_MIGRATION_STATUS.md) |
| [RN 迁移状态与待验清单](RN_MIGRATION_STATUS.md) | RN 0.1.x / P0–P2 / Agent 与 AI 检索历史迁移清单（已停止维护） | [`docs/subsystem/mobile-rn/README.md`](../../../docs/subsystem/mobile-rn/README.md) |

## 证据

验收截图、AVD 和旧 APK 属于本机构建产物，不纳入版本控制。`mobile-rn/dist/` 中已清理历史 AVD、导出目录和旧 APK；保留最新 APK 以及仍被文档引用的少量日志和截图。需要重跑时，按各归档文档中的命令和 fixture 步骤重新生成。

## 链接约定

归档目录与 `docs/` 保持相同的目录深度，因此指向 `api/`、`mobile-rn/`、`frontend/` 等仓库根目录的相对链接仍然有效。归档文档指向 `docs/` 的链接已改为 `../../docs/...`；位于归档根目录的 `RN_ANDROID_EXECUTION.md` 和 `RN_UI_EXECUTION.md` 使用 `../docs/...`。
