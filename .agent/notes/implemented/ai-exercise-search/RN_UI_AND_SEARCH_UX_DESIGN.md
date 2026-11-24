# RN 智能检索与动作库交互优化设计

> 仅修改 `mobile-rn/`（不改动 `frontend/` 和 `api/`），遵循 [RN 设计系统规范](../RN_UI_DESIGN_SYSTEM.md) 与 [RN 视觉测试规范](../RN_UI_VISUAL_TESTING.md)。

## 1. 背景与目标

当前 RN 端动作库与 AI 智能检索在输入约束、结果覆盖面、兜底建档与交互布局上存在 4 类问题：

1. **描述文本未强制输入**：在发起 AI 检索和底部追问时，若只选照片不填描述，仍可直接提交；模型缺少用户的器械/体感/动作意图描述，识别与后续自定义建档信息也不完整。
2. **检索备选项偏少**：共享匹配器 `createExerciseAiSearch()` 默认最多返回 5 条候选项；在器械外观相似或动作有多种变式时，用户往往需要翻看更多备选才能找到目标动作。
3. **无兜底自建动作入口**：当 AI 检索结果里没有合适动作时，用户无法直接把当前输入描述和照片转为自定义动作，需要退出检索重新手填。
4. **界面交互与布局问题**：
   - 检索完成后页面同时显示顶部 `library-search` 与底部 `ai-follow-up` 两个输入框，造成视觉冗余和误触。
   - 底部追问输入框位于 `FlatList` 的 `ListFooterComponent` 内，且未配置 Android 键盘避让；聚焦输入时软键盘会遮挡输入框，看不到输入内容。
   - 底部输入区与摘要卡片、照片预览、启动弹层内的元素间距偏紧且不统一。
   - 动作库普通模式下，右侧仍有 `info` 详情按钮，点击行其余区域则直接选中动作，与「替换动作」模式（`replacing === true` 时点击缩略图及正文进详情、右侧仅保留星标和动作按钮）不一致。

---

## 2. 需求范围与编号验收条件

### 2.1 需求范围

- **仅修改 `mobile-rn/`**：不改 `api/`、`frontend/`、共享任务提示词与 Web 端行为。
- 复用现有 `mobile-rn/src/agent/`、`mobile-rn/src/librarySearch.ts`、`mobile-rn/src/body/photos.ts` 与 `mobile-rn/src/design/` 组件及语义 token。

### 2.2 编号验收条件（AC1–AC9）

| 编号 | 动作 / 前置条件 | 可观察结果 |
| --- | --- | --- |
| **AC1** | 打开「AI 检索动作」弹层，不填描述（无论是否已选照片）观察提交按钮与提示；在 AI 检索结果页清空底部追问框（仅选照片或不填文字）观察发送按钮。 | 启动弹层主按钮 `ai-submit` 禁用且不可提交；已选照片但未填描述时提示先填写简短描述。底部追问栏仅当 `text.trim().length > 0` 时发送按钮可用，选了图片未填文字时展示明确提示且拒绝空文本提交。 |
| **AC2** | 输入描述发起 AI 检索，返回候选与兜底信息（单测 + 模拟器 `fixture` / 真实检索）。 | `matchAiSearch` 在 RN 端默认扩展至最多 **10** 项去重候选项（当模型返回 `candidates` 为空且零命中如 `fallback-only` 时不强行凑数）；已匹配的原始主候选保持原有顺序与 `level`，补充项按相似度/部位/器械顺序补足并标明出处原因与 `low` 置信度。 |
| **AC3** | AI 检索完成后滑动到候选列表末尾，点击「没找到合适的？新建自定义动作」（`ai-create-custom`）。 | 打开新建自定义动作弹层，自动带入本次检索描述（建议动作名称 + 完整描述文本）、推测部位/器械，并在有检索图片时展示图片缩略图预览（支持移除）。 |
| **AC4** | 在 AC3 弹层点击保存自定义动作。 | 新动作写入 `profile.customEx`（包含 `n`、`bp`、`eq`、`desc`，有图时包含标准 `MediaRef` 并落盘至工作区私有目录 `photoDirectory(connection)`；若已登录服务器同步加入 `photoUploads` 队列）；退出 AI 检索态并进入新建动作的 `ExerciseDetailScreen`，可在详情中直接看到描述与照片，且在动作库列表中缩略图正常显示。 |
| **AC5** | 进入 AI 检索状态（`running` / `ready` / `error`）。 | 顶部原生搜索框 `library-search` 隐藏不再渲染，页面仅保留底部追问输入框 `ai-follow-up`。 |
| **AC6** | 在 AI 检索结果页（Tab 模式与 Modal 替换/加动作模式）点击底部追问输入框 `ai-follow-up` 唤起软键盘。 | 软键盘弹出后，底部追问栏完整顶起至键盘上方，输入框内容、相机按钮和发送按钮均清晰可见、不被遮挡。 |
| **AC7** | 核查 AI 启动弹层（`ai-launch-sheet`）、AI 摘要卡片（`renderAiSummary`）与底部追问栏（`renderFollowUp`）间距及视觉层级。 | 摘要卡片与候选列表之间留有明显间距（`theme.space.md`）；底部追问栏使用独立分隔底栏（`sep` 顶边框、统一内边距和行内 `theme.space.sm` 间距），拍照图片预览区与输入框之间间隔清晰；启动弹层表单各区块保持 `theme.space.md` 间距。 |
| **AC8** | 在动作库 Tab、计划加动作、训练中加动作及替换动作模式查看动作列表行并点击行内元素。 | 右侧不再出现 `info` 详情图标按钮（`library-detail-*` 移除）；点击动作缩略图、标题或副标题等非右侧 icon 区域时统一进入 `ExerciseDetailScreen`；点击右侧 `star`/`starFill` 切换收藏，点击 `+` 直接选中/替换，点击自建动作 `pencil` 打开编辑。 |
| **AC9** | 执行 RN 静态检查、单元测试与 Android Release 构建验签。 | `npm.cmd run check`（ESLint + 自定义规则 + `tsc --noEmit` + `design:check`）全部通过；新增纯函数单测通过；Release APK 通过 `apksigner verify`、`aapt dump badging` 核验并完成真机模拟器 AC1–AC8 交互截图验收。 |

---

## 3. 详细技术设计

### 3.1 R1：强制输入简短描述文本

1. **启动弹层（`ai-launch-sheet`）**：
   - `TextField` 标签调整为 `描述（必填）`，helper 提示：`请填写简短描述（例如：坐姿推胸机、哑铃侧平举），可同时附带照片。`
   - 提交按钮禁用条件从 `!aiSheetText.trim() && !aiDraftImage` 改为 `!aiSheetText.trim()`；当 `aiDraftImage` 已选择但 `!aiSheetText.trim()` 时显示轻提示：`"已选择图片，请再输入一句简短描述后开始检索。"`。
   - `submitAiSheet()` 首行防御校验：`if (!text) return;`。
2. **底部追问栏（`renderFollowUp`）**：
   - `canSend` 改为 `!running && !limitReached && aiFollowUpText.trim().length > 0`。
   - 当用户已附带 `aiFollowUpImage` 但 `aiFollowUpText.trim()` 为空时，展示提示：`"已选择图片，请输入补充描述后发送"`。
   - `sendAiFollowUpText(text, image, mediaAttemptId)` 入口校验：`if (!trimmed) return;`（所有点击 `clarifications` chip 的追问均自带非空 `chip.prompt`，可正常触发）。
   - 不改动 `api/agent-runtime/tasks/exercise-search.js` 契约，服务端/共享运行态继续兼容。

### 3.2 R2：检索备选项扩充至 10 项（RN 端纯函数扩展）

由于 `frontend/src/lib/exercise-ai-search.js` 硬编码 `.slice(0, 5)` 且本需求**仅修改 RN 端**，在 `mobile-rn/src/agent/ai-search-matcher.ts` 实现 RN 端扩展逻辑，同时保留原有函数签名向后兼容（确保 `frontend/scripts/ai-search-eval-adapters.mjs` 离线评估脚本不受破坏）：

```text
matchAiSearch(source, structured, hintText, diagnostics?, options?)
  ├── 1. 先调用共享 matcherFor(source).match({ structured }, { hintText, diagnostics })
  │      -> 得到基础 result（最多 5 条主候选 + fallback + clarifications）
  ├── 2. 读取 targetLimit = options?.maxItems ?? 5
  │      - 若 targetLimit <= result.items.length 或 (result.items.length === 0 && structuredCandidates.length === 0)
  │        直接返回 result（保证纯闲聊/非健身图/fallback-only 不强行填充动作）
  └── 3. 调用 expandAiSearchMatch(source, structured, hintText, result, targetLimit)
         -> 在保持 result.items 顺序与 level 不变的前提下，用 seen Set 去重补足至 targetLimit（10 项）：
            (a) 二次召回池：依次用每个 model candidate 的 name / nameEn 与 hintText 调用 source.aiSearch.searchScored
                按得分降序收集尚未入列的候选（rationale 标注 `相近匹配 · ${bodyPart} · ${equipment}`，level = 'low'）
            (b) 维度兜底池：若仍不足 10 项，依据 fallback.bodyParts / fallback.equipment 与候选中的 bodyPart / equipment：
                优先级 1：同时命中目标部位与器械
                优先级 2：命中目标部位
                优先级 3：命中器械
                补充至 10 项（rationale 标注 `按部位/器械补充 · ...`，level = 'low'）
```

- 在 `mobile-rn/src/agent/ai-search-matcher.ts` 导出常量 `AI_SEARCH_DISPLAY_LIMIT = 10` 及纯函数 `expandAiSearchMatch`。
- 在 `ExerciseLibraryScreen.tsx` 中调用 `matchAiSearch(..., { maxItems: AI_SEARCH_DISPLAY_LIMIT })`。
- `ai-search-eval-adapters.mjs` 不传第 5 个参数，保持默认 5 条与 Web/评测基线一致。

### 3.3 R3：列表末尾结合描述和图片新建自定义动作

#### 3.3.1 入口与表单预填

- 在 `renderAiContent()` 末尾（`ai.status !== 'running'` 时）新增动作卡片：
  - `testID="ai-create-custom"`
  - `leading={<IconTile name="plusCircle" size="md" tone="soft" />}`
  - `title="没找到合适的？新建自定义动作"`
  - `subtitle={ai.latestImage ? '将结合你的描述和已选图片创建' : '将结合你的描述快速创建'}`
  - `chevron`
- 扩展 `editing` 状态及 `library-custom-sheet`：
  - 状态不仅支持 `CustomExercise`，还可携带草稿媒体与来源标记：
    - `customNameValue`：动作名称（必填，最大 80 字）。从 AI 入口进入时，优先取 `ai.latestText` 首个短句（按标点 `，。、；！？\n` 切分并截断至 24 字）作为建议名称。
    - `customDescValue`：动作描述 / 备注（多行文本，最大 500 字，写入 `CustomExercise.desc`）。从 AI 入口进入时预填：`用户描述：${ai.latestText}`（若 `ai.fallback?.understanding` 存在且未重复，可追加参考说明或单独显示参考提示，默认把用户描述预填进输入框便于直接修改）。
    - `customBodyPart`：部位 `Chip` 单选（默认 `ai.fallback?.bodyParts?.[0]` 或 `'full body'`）。
    - `customEquipment`：器械 `Chip` 单选（默认 `ai.fallback?.equipment?.[0]` 或 `'other'`）。
    - `customAiImage`：若从 AI 入口进入且 `ai.latestImage` 存在，展示该图片缩略图（56×56）、说明文案及「移除图片」按钮。用户也可在普通创建自定义动作流程中选择图片（复用相册/拍照可选或保留 AI 带入图片，本次重点打通 AI 图片带入 + 移除能力）。

#### 3.3.2 AI 图片持久化为自定义动作媒体

复用现有 `mobile-rn/src/body/photos.ts` 与 `mobile-rn/src/exerciseMedia.ts` 的内容寻址私有目录与上传队列机制，不重复发明存储协议：

1. **在 `mobile-rn/src/exerciseMedia.ts` 新增**：
   - `localCustomMediaUri(ref: NormalizedMediaRef, connection: Connection | null): string | null`
     - 根据 `photoDirectory(connection)` 与 `{ref.hash}.{ext}` 定位本地缓存文件，存在时返回 `file.uri`。
   - `saveCustomExerciseImage(image: { mime: string; width: number; height: number; dataUrl: string }, connection: Connection | null): Promise<{ ref: MediaRefLike; fileUri: string }>`
     - 解析 `dataUrl` 的 Base64 数据并解码为 `Uint8Array`（只支持 `image/jpeg`、`image/png`、`image/webp`、`image/gif`）。
     - 通过 `expo-crypto` 计算 `SHA-256` 十六进制摘要 `hash`。
     - 写入 `new File(photoDirectory(connection), `${hash}.${ext}`)`。
     - 返回符合 `frontend/src/lib/media-refs.js` `normalizeMediaRef` 规范的 `MediaRefLike`（`{ kind: 'image', hash, mime, size, width, height, at }`）及 `fileUri`。
2. **更新 `useExerciseMedia`**：
   - 当 `custom === true` 且 `mediaRef` 存在时，先调用 `localCustomMediaUri(mediaRef, connection)` 检查本地私有目录。
   - 若命中本地文件：直接返回 `{ kind: mediaRef.kind, uri: localUri, posterUri: localUri, loading: false, origin: 'custom' }`（即使处于离线/练习模式也能立即显示照片）。
   - 若本地未命中再按原流程检查 `connection` 与 `/api/media/{hash}` 下载。
3. **更新 `mobile-rn/src/design/patterns/MediaThumb.tsx`**：
   - 增加可选属性 `customUri?: string | null`。
   - 渲染优先级：`customUri ? { uri: customUri } : (local ?? (url ? { uri: url } : null))`。
   - `ExerciseLibraryScreen` 与 `ExerciseDetailScreen` 对自定义动作通过 `mediaOf(customExercise)` + `localCustomMediaUri` 传入 `customUri`，确保列表行和详情头部缩略图立即可见。
4. **更新 `mobile-rn/App.tsx` 的 `onCustom` 与 `ExerciseLibraryScreenProps.onCustom`**：
   - 保持 `onCustom: (exercise: CustomExercise, create: boolean, photoUpload?: PhotoUpload) => void`（`photoUpload` 为可选参数，兼容现有调用方 `PlanEditorScreen` 等）。
   - 在 `App.tsx` 的 `onCustom` 中，提交 `gym.commit([{ kind: 'custom', exercise, create }])` 后，若 `connection` 存在且传入了 `photoUpload`，通过 `gym.change` 将其按 `hash` 去重追加到 `data.photoUploads`，交由 `useGym.ts` 既有的 `uploadPendingPhotos` 自动随同步上传至 `/api/media/{hash}`。
5. **保存后的导航闭环**：
   - 若本次新建来自 AI 检索末尾入口：保存成功后调用 `exitAi()` 退出 AI 检索状态，并立即打开 `setDetail({ id: createdId, custom: true })`，用户可在详情页立即核对图片和描述并点底部的「选择这个动作」/「选择此动作替换」。

### 3.4 R4：界面交互四项优化

#### 3.4.1 去掉检索结果页顶部重复输入框

- 在 `listHeader` 中将 `<SearchField testID="library-search" ... />` 包裹于 `{!ai && !aiNeedsConfig ? (...) : null}` 条件内。
- 当处于 AI 检索态（`ai !== null`）时，顶部只保留页面 `Header` 与 `renderAiSummary()`（显示当前检索描述、模型来源和右上角退出按钮 `ai-exit`），不再展示被禁用的顶部搜索框。

#### 3.4.2 底部追问输入框键盘顶起与位置固定

- 将 `renderFollowUp()` 从 `FlatList` 的 `ListFooterComponent` 移出，改为位于 `FlatList` 下方的独立固定底栏（仅当 `ai !== null` 时渲染）。
- 在 `ExerciseLibraryScreen` 的 `library` 视图内，使用容器包裹 `FlatList` 与底部固定追问栏：
  - 使用 `<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>`，同时考虑：
    - 在 Android 36 edge-to-edge 模式下，`TabBar` 位于 Tab 页底部而 `Panel Modal`（训练加动作/替换、计划加动作）占满全屏。
    - 为避免部分 Android 机型上 `<Modal>` 内 `KeyboardAvoidingView` 测量偏差导致仍被遮挡，在 `ExerciseLibraryScreen` 中可结合 `Keyboard` 事件监听（`keyboardDidShow` / `keyboardDidHide`）动态验证或在需要时为 `KeyboardAvoidingView` 提供稳定的布局空间（通过 `useSafeAreaInsets().bottom` 仅在键盘收起时补充安全区底边距，键盘弹出时不额外留白）。
    - 在 `aiFollowUp` 文本框 `onFocus` 时如列表存在内容且未滚到底部，不干扰输入焦点，确保底栏稳固贴合软键盘上沿。
- `FlatList` 的 `ListFooterComponent` 在 `ai` 模式下设为 `null`（不再承载输入框）；正常库模式保留「显示更多」分页按钮。

#### 3.4.3 间距与视觉层次优化

1. **AI 摘要卡片与列表间距**：
   - `renderAiSummary()` 外层容器增加 `marginBottom: theme.space.md`（12px），避免摘要卡片紧贴第一条候选卡片。
   - `listHeader` 中 `renderAiSummary()` 顶部与 `Header` 保持清晰呼吸感（`Header` 自带 `marginBottom: theme.layout.headerBottom` = 18px）。
2. **底部固定追问栏（`renderFollowUp`）**：
   - 独立容器：`backgroundColor: theme.colors.bgEl`，`borderTopWidth: StyleSheet.hairlineWidth`，`borderTopColor: theme.colors.sep`，`paddingHorizontal: theme.layout.pagePadding`，`paddingTop: theme.space.sm`，`paddingBottom: keyboardVisible ? theme.space.sm : Math.max(theme.space.sm, insets.bottom)`，`gap: theme.space.sm`。
   - 图片预览条与输入行、输入行与提示文案之间统一 `gap: theme.space.sm`；照片预览缩略图、提示文字与移除按钮之间保持 `gap: theme.space.sm` 且内边距紧凑整齐。
   - 输入行内相机按钮、输入框、发送/取消按钮之间使用 `gap: theme.space.sm`（原为 `theme.space.xs` 过紧）。
3. **AI 启动弹层（`ai-launch-sheet`）**：
   - 内容用 `<View style={{ gap: theme.space.md, paddingBottom: theme.space.sm }}>` 统一包住 `TextField`、拍照/相册按钮行、照片预览区、提示文案、Fixture 选择区与错误提示，去除零散的 `marginTop` 拼接导致的不均匀间距。

#### 3.4.4 动作库点击行进详情并移除 info 图标按钮

- 在 `ExerciseLibraryScreen.tsx` 的 `rowView(item: Row)` 中：
  1. **删除 `name="info"` 详情按钮**（`testID="library-detail-..."`）。
  2. **统一点击正文进详情**：无论 `replacing` 为 `true` 还是 `false`，内置动作与自定义动作的 `ListRow` 均使用：
     ```tsx
     accessibilityLabel={`查看详情 ${name}`}
     onPressBody={() => setDetail({ id: exercise.id, custom: item.kind === 'custom' })}
     ```
     在 `ListRow` 中，`onPressBody` 覆盖 `leading`（`MediaThumb` 缩略图）及中间标题、副标题区域，与 `trailing` 右侧操作按钮兄弟隔离，点击缩略图及任何非 icon 区域都会进入 `ExerciseDetailScreen`。
  3. **统一右侧操作图标**：
     - 收藏星标：`star` / `starFill`（保持不变）。
     - 若 `replacing` 为 `true`：`plus`（选择替换动作）。
     - 若 `replacing` 为 `false`：
       - 自定义动作：`pencil`（编辑） + `plus`（选择动作 `pickCustom(item.exercise)`）。
       - 内置动作：`plus`（选择动作 `pickCatalogue(item.exercise)`）。
     - 注：此修改统一了动作库 Tab、计划加动作、训练中加动作和替换动作 4 个入口的交互心智，且满足原有 `submitPick` / `onPick` 能力。

---

## 4. 涉及文件清单

| 文件 | 变更说明 |
| --- | --- |
| `mobile-rn/src/agent/ai-search-matcher.ts` | 新增 `AI_SEARCH_DISPLAY_LIMIT = 10`、`expandAiSearchMatch` 与 `matchAiSearch(..., options?)` 10 项扩展逻辑 |
| `mobile-rn/src/exerciseMedia.ts` | 新增 `localCustomMediaUri`、`saveCustomExerciseImage`；`useExerciseMedia` 优先读取工作区私有目录本地文件 |
| `mobile-rn/src/design/patterns/MediaThumb.tsx` | 新增可选 `customUri?: string | null` 支持自定义动作图片缩略图 |
| `mobile-rn/src/screens/ExerciseDetailScreen.tsx` | 头部 `MediaThumb` 支持传入 `customUri` |
| `mobile-rn/src/screens/ExerciseLibraryScreen.tsx` | R1 必填描述校验、R2 使用 10 项结果、R3 末尾新建动作及升级表单（名称/描述/部位/器械/图片带入与落盘）、R4 隐藏顶部输入框/底部固定追问栏+键盘顶起/间距规范/移除 info 图标并统一 `onPressBody` 进详情 |
| `mobile-rn/App.tsx` | `onCustom` 支持接收可选 `PhotoUpload` 并写入 `photoUploads` 队列 |
| `mobile-rn/src/screens/PlanEditorScreen.tsx` | 核对 `onCustom` 类型兼容 |
| `mobile-rn/scripts/ai-search-expand.test.mjs` | 新增纯函数单元测试，覆盖 R2 10 项补齐、去重、顺序保留、空候选不强填等场景 |
