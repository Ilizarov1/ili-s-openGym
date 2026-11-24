# RN 智能检索与动作库交互优化执行计划

> 对应设计文档：[RN_UI_AND_SEARCH_UX_DESIGN.md](RN_UI_AND_SEARCH_UX_DESIGN.md)  
> 工具链与模拟器验收基线：[rn-android.md](../../.agents/skills/opengym-development/references/rn-android.md)

---

## 0. 实施约定与工作区隔离

- **仅修改 `mobile-rn/`**，不改动 `frontend/` 与 `api/`，且不触碰主工作区已有未提交文件（`docs/ai-exercise-search/eval/manifest.json`、`frontend/scripts/ai-search-eval.test.mjs`、`docs/ai-exercise-search/evidence/hinted-replay-2026-11-23.json`）。
- 在独立 worktree（分支建议：`feat/rn-ai-search-ux`）内完成编码、静态检查、单元验证、Release APK 构建验签与模拟器设备验收。
- Windows 命令统一使用 PowerShell。

---

## 1. 分阶段执行清单

### 阶段 A：匹配扩充与媒体落盘（纯逻辑与基础能力）

1. **修改 `mobile-rn/src/agent/ai-search-matcher.ts`**
   - 导出 `AI_SEARCH_DISPLAY_LIMIT = 10` 及 `expandAiSearchMatch`。
   - 为 `matchAiSearch` 增加可选参数 `options?: { maxItems?: number }`；默认保持与现有调用兼容。
   - 新增单测 `mobile-rn/scripts/ai-search-expand.test.mjs`，验证：
     - 原始主候选不足 10 项时可按二次 `searchScored` + 部位/器械维度补足至最多 10 项；
     - 不重复、不篡改原始高/中置信度主候选顺序与 `level`；
     - `structured.candidates` 为空且主候选为 0 时（如 `fallback-only`）仍返回 0 项。
   - 执行单测：
     ```powershell
     node --test .\mobile-rn\scripts\ai-search-expand.test.mjs
     ```
2. **修改 `mobile-rn/src/exerciseMedia.ts`、`mobile-rn/src/design/patterns/MediaThumb.tsx`、`mobile-rn/src/screens/ExerciseDetailScreen.tsx`、`mobile-rn/App.tsx`**
   - 实现 `localCustomMediaUri` 与 `saveCustomExerciseImage`，将 AI 图片按 SHA-256 写入工作区私有目录 `photoDirectory(connection)` 并生成标准 `MediaRefLike`。
   - 更新 `useExerciseMedia` 与 `MediaThumb`，优先读取本地私有文件，保证刚创建的自定义动作（无论离线练习模式还是已连接模式）立即显示图片缩略图与详情大图。
   - 更新 `App.tsx` 的 `onCustom` 签名以接收可选 `PhotoUpload`，连接模式下入队 `photoUploads` 供同步上传 `/api/media/{hash}`；核对 `PlanEditorScreen.tsx` 的 `onCustom` 类型对齐。

### 阶段 B：UI 交互重构与需求接入（`ExerciseLibraryScreen.tsx`）

1. **R1 强制描述文本**：
   - 启动弹层 `ai-launch-sheet` 标记 `描述（必填）`，禁用空文本提交并在仅选照片时给出提示。
   - 底部追问栏 `renderFollowUp` 与 `sendAiFollowUpText` 强制 `text.trim().length > 0`；仅附带图片未写描述时禁用发送并提示。
2. **R2 接入 10 项结果**：
   - `runAiTurn` 调用 `matchAiSearch(..., { maxItems: AI_SEARCH_DISPLAY_LIMIT })`。
3. **R3 列表末尾新建自定义动作**：
   - `renderAiContent()` 末尾（非 `running` 时）添加 `ai-create-custom` 行。
   - 升级 `library-custom-sheet`：支持名称、多行描述/备注（`desc`）、部位 `Chip`、器械 `Chip` 及带入 AI 图片的缩略图预览与移除。
   - 绑定保存逻辑：有图时先落盘生成 `MediaRefLike` 与 `PhotoUpload`，保存至 `profile.customEx`，并由 AI 创建链路在保存后调用 `exitAi()` 且跳转展示新动作 `ExerciseDetailScreen`。
4. **R4 界面交互四项调整**：
   - AI 模式下隐藏顶部 `library-search`。
   - 将 `renderFollowUp()` 移出 `FlatList` 的 `ListFooterComponent`，放到 `FlatList` 下方作为固定底栏，并使用 `KeyboardAvoidingView` + 键盘可见状态适配（覆盖 Tab 页与 Modal 选择器两种宿主环境）。
   - 优化 `renderAiSummary()`、底部固定追问栏、`ai-launch-sheet` 内部间距与顶部分隔线。
   - `rowView()` 删除 `library-detail-*`（`info` 图标按钮），普通模式与 `replacing` 模式统一采用 `ListRow` 的 `onPressBody` 打开详情，右侧保留收藏星标与选择/编辑按钮。

### 阶段 C：静态检查与规范门禁

在 `mobile-rn/` 目录下执行：

```powershell
cd mobile-rn
npm.cmd run check
node --test .\scripts\ai-search-expand.test.mjs
node --no-warnings .\scripts\fuse-suggestion-check.mjs
```

> 若 `eslint`、`lint:rules`、`tsc --noEmit` 或 `design:check` 任一报错，必须修复至全绿。

### 阶段 D：Android Release APK 构建与验签

1. 检查工具链环境变量（`JAVA_HOME`、`ANDROID_HOME` 位于 `$env:LOCALAPPDATA\RnToolchain`）：
   ```powershell
   $toolchain = Join-Path $env:LOCALAPPDATA 'RnToolchain'
   $env:ANDROID_HOME = Join-Path $toolchain 'android-sdk'
   $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
   $env:ANDROID_AVD_HOME = Join-Path $toolchain 'avd'
   $env:PATH = "$($env:ANDROID_HOME)\platform-tools;$($env:ANDROID_HOME)\emulator;$env:PATH"
   ```
2. 执行 prebuild、stage catalogue media 与 Gradle Release 构建（若 `prebuild` 覆盖 `android/` 资产，确保按 `mobile-rn/scripts/README.md` 确认 `catalogue:stage` 状态）：
   ```powershell
   cd mobile-rn
   npx.cmd expo prebuild --platform android --no-install
   npm.cmd run catalogue:stage
   cd android
   .\gradlew.bat :app:assembleRelease
   ```
3. 产物验签与记录哈希：
   ```powershell
   $apk = Resolve-Path .\app\build\outputs\apk\release\app-release.apk
   & (Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat') verify --verbose $apk
   & (Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\aapt.exe') dump badging $apk | Select-String -Pattern "package:|application-label"
   Get-FileHash -Algorithm SHA256 $apk
   ```

### 阶段 E：模拟器动态申请与实机验收（AC1–AC8）

严格遵循 [rn-android.md](../../.agents/skills/opengym-development/references/rn-android.md) 设备池规范：

1. 使用 `agent-device devices --platform android --json` 和 `agent-device device status --platform android --json` 查找空闲模拟器（`openGymRnQa` / `openGymRnQaWorker`），若均未启动则冷启动一台后通过 `agent-device open com.android.settings --platform android --serial <serial> --json` 原子申请设备（全部占用时使用 `--wait 600000`）。
2. 将 Release APK 安装到申请到的设备：`agent-device install dev.opengym.rn $apk --platform android --serial <serial>` 并启动 `agent-device open dev.opengym.rn --platform android --serial <serial>`。
3. 预置/配置本地测试所需 `fixture` 模型配置（或走 UI「我的/设置 → Agent 配置」确保至少有一个可用的 `fixture` 配置，若练习模式默认已内置 `fixture` 则直接使用），并准备一张测试图片用于照片选择流程验证（或使用设备相册/测试图片验证图片带入与渲染）。
4. 逐条执行并截图存证至工作区产物目录（如 `mobile-rn/dist/ui/ai-search-ux/`）：
   - **V1（AC8）**：打开「动作库」Tab，确认行右侧没有 `info` 按钮；点击某内置动作图片/标题进入 `ExerciseDetailScreen`，返回后再点右侧 `+` 验证直接触发选择/开始；进入训练或计划替换流程确认一致。
   - **V2（AC1 + AC7）**：点击搜索栏 `✨` 打开 `ai-launch-sheet`，验证仅空白（及选图但无描述）时 `ai-submit` 为禁用状态并截图；核查弹层内部间距。
   - **V3（AC2 + AC5 + AC7）**：输入描述（如 `"哑铃推胸"` / `"胸肌器械"`）提交检索，确认：
     - 检索结果页顶部无 `library-search` 输入框；
     - 摘要卡片与首条候选卡片之间间距清晰；
     - 候选项数量达到 10 项（滑动列表计数核验）。
   - **V4（AC6 + AC1）**：点击底部追问输入框 `ai-follow-up` 唤起软键盘，截图确认整个底部追问栏被完整顶起至键盘上方且文字可见；输入空文本时发送按钮不可点。
   - **V5（AC3 + AC4）**：滚动到 AI 结果末尾，点击 `ai-create-custom`（「没找到合适的？新建自定义动作」），核查预填的名称、描述（含用户检索描述）、部位、器械（若有图则包含图片缩略图及可移除验证），保存后确认退出 AI 模式并打开新建动作的 `ExerciseDetailScreen`，查看描述与图片正常展示，返回动作库后该自建动作可见。
   - **V6**：跑一遍已有五 Tab 冒烟核心路径（或 `five-tab-smoke.ps1` 适配检查，注：若旧脚本依赖 `library-detail-*` 则记录因 R4 移除 `info` 按钮带来的脚本变化，不因此误判）。
5. **异常兜底与设备释放（必做）**：
   - 将整个验收流程放在 `try { ... } finally { agent-device close --json }` 内，确保结束后释放设备声明；
   - 执行 `agent-device device status --platform android --json` 核对当前工作区不再持有任何声明。

---

## 2. 回退策略

- 若合并或验收阶段发现回归，所有改动均收敛在 `mobile-rn/`（单次功能分支提交），可直接 `git revert` 对应提交或切换回原分支。
- `expandAiSearchMatch` 与 `saveCustomExerciseImage` 均向下兼容已有数据结构，不修改持久化表结构或同步协议，回退无数据迁移成本。
