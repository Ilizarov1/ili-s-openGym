# RN 已有页面设计系统重构方案

本文是 `mobile-rn` 现有页面按五 Tab 信息架构重构的方案。设计系统本体见 [RN_UI_DESIGN_SYSTEM.md](RN_UI_DESIGN_SYSTEM.md)，设计系统实施记录见 [RN_UI_EXECUTION.md](RN_UI_EXECUTION.md)。

## 1. 已确认决策

1. **直接采用五 Tab**：首页 / 计划 / 统计 / 动作库 + 中央开始按钮。
2. **训练页组输入使用 `Stepper`**，同时保留手动输入。
3. **动作选择使用全屏页面**，不改成底部 Sheet。
4. **保存/删除反馈先继续使用原生 `Alert`**，不引入 Toast。
5. 服务器内容移到首页右上角齿轮打开的设置页。
6. 保留现有训练、同步、备份、SQLite 和 API 逻辑，不改数据格式。

## 2. 目标信息架构

```
TabBar（4 个侧 Tab + 中央开始）
  首页    home       house
  计划    plan       calendar
  开始    action     play（中央 52px 圆钮）
  统计    stats      chart
  动作库  library    dumbbell
```

- 首页：问候、日期、周条、今日训练、本周进度、最近训练、设置齿轮。
- 计划：`日程 / 训练计划` 分段；计划增删改、排程、今日推荐入口。
- 开始：不是页面，是动作。有草稿恢复；有今日推荐直接开始；没有则弹出选择 Sheet。
- 统计：现有训练历史 + 基础统计（次数、总训练量、本周完成度）+ 按动作历史；未实现的 P2 模块不显示，不放假数据。
- 动作库：全屏搜索、部位筛选、器械筛选、自定义动作、动作缩略图；点动作可加入当前训练或开始自由训练。
- 设置：从首页齿轮进入的全屏面板，包含服务器配对、同步、断开、备份、恢复、合并本机练习、休息通知和开发入口。
- 进行中训练：全屏，不显示 TabBar；顶部完成/菜单，底部休息 dock。

## 3. 现有页面映射

| 现有 | 新位置 |
| --- | --- |
| 训练 Tab 的计划列表 | 计划 Tab |
| 训练 Tab 的今日推荐 | 首页今日训练卡 + 计划 Tab |
| 训练 Tab 的自由训练 | 中央开始 Sheet + 计划/动作库入口 |
| 训练 Tab 的进行中训练 | 全屏 `WorkoutScreen`，隐藏 TabBar |
| 历史 Tab | 统计 Tab（列表 + 基础统计） |
| 历史编辑/删除/动作历史 | 统计 Tab 内的详情和操作菜单 |
| 服务器 Tab | 设置面板（首页齿轮） |
| 动作选择 Modal | 动作库 Tab（全屏）；计划/训练中作为全屏选择器复用 |
| 组间休息 Card | 训练页底部 dock |
| `ui.tsx` 的 Button/Card/Field | 设计系统组件，最后删除 `ui.tsx` |

## 4. 设计系统补齐

在开始页面重构前新增：

### 4.1 TextField

`design/components/TextField.tsx`

```tsx
type TextFieldProps = TextInputProps & {
  label: string;
  error?: string;
  helper?: string;
  containerStyle?: StyleProp<ViewStyle>;
};
```

- 标签 `Text footnote secondary`。
- 输入高 46、背景 `surface2`、圆角 12、17/400。
- 默认 `accessibilityLabel = label`，保持 ADB 脚本定位。
- 用于服务器地址、配对码、计划名、组数/次数/重量、补录日期。

### 4.2 SwitchRow

`design/components/SwitchRow.tsx`

```tsx
type SwitchRowProps = {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
};
```

- `ListRow` + RN `Switch`；开启 accent，关闭 surface3。
- `accessibilityRole="switch"`、`accessibilityState={{ checked: value }}`。

### 4.3 Stepper

`design/components/Stepper.tsx`

```tsx
type StepperProps = {
  value: string;
  onChangeText: (value: string) => void;
  step: number;
  min?: number;
  max?: number;
  precision?: number;
  keyboardType?: 'decimal-pad' | 'number-pad';
  unit?: string;
  disabled?: boolean;
  accessibilityLabel: string;
};
```

- 左减右加，中间可编辑；输入过程保留原始字符串，只有加减按钮 parse/format。
- 重量 2.5、次数 1、秒 5、分钟 1。
- 不改变 `validSet` 的校验语义。

### 4.4 ActionSheet

`design/patterns/ActionSheet.tsx`

```tsx
type ActionItem = {
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'accent';
  onPress: () => void;
};

<ActionSheet visible title items onClose />
```

- 使用 `Sheet` + `ListRow`。
- 先关闭再执行动作。
- 用于计划行、统计行、训练动作菜单、放弃训练。

### 4.5 Gallery

在 `DesignGallery` 增加 TextField、SwitchRow、Stepper、ActionSheet 示例，并保留五栏 TabBar 预览。

## 5. Shell 与导航

### 5.1 App.tsx

`App.tsx` 只保留：

- `useGym`、连接状态、`profile`/`draft`/`queue`。
- 当前 Tab、面板、开始 Sheet、设置面板。
- 页面回调。
- 背包数据派生：`history`、`recommended`。

结构：

```tsx
<ThemeProvider>
  <SafeAreaProvider>
    {draft
      ? <WorkoutScreen ... />
      : <View flex:1>
          {tab === 'home' && <HomeScreen ... />}
          {tab === 'plan' && <PlanScreen ... />}
          {tab === 'stats' && <StatsScreen ... />}
          {tab === 'library' && <ExerciseLibraryScreen ... />}
          <TabBar tabs={...} active={tab} onSelect={setTab} onStart={openStart} />
        </View>}
    <PanelModal />
    <StartSheet />
  </SafeAreaProvider>
</ThemeProvider>
```

### 5.2 中央开始

- 有草稿：`WorkoutScreen` 已经显示，中央按钮无额外动作。
- 今日推荐恰好 1 个：直接 `startWorkout`。
- 多个推荐或没有推荐：打开 `StartSheet`：
  - 今日推荐计划行。
  - 全部计划行。
  - 自由训练行。
  - 补录训练行。
- `StartSheet` 使用 `Sheet` + `ListRow`/`Button`。

### 5.3 设置面板

- `HomeScreen` 右上角 `IconButton name="gear"` 打开 `Panel` kind `settings`。
- 设置面板是 `Screen` + `Header compact title="设置" onBack`。
- 服务器、配对、备份、通知、开发入口全部在这里。

### 5.4 页面标题

- Home：`Header title={connection ? `你好，${user.name}` : '你好'}` subtitle 日期 + 右侧齿轮。
- Plan：`Header title="计划" subtitle="你的每周安排"`。
- Stats：`Header title="统计" subtitle="训练记录与进步"`。
- Library：`Header title="动作库" subtitle="5632 个动画动作 + N 个自建"`。
- Settings：`Header compact title="设置"`。
- Workout：`Header compact title={draft.name}` + 完成按钮 + 菜单。

## 6. 页面规格

### 6.1 首页 Home

布局：

1. `Header`：问候 + 日期 + 齿轮。
2. 周条：
   - 周一至周日，显示日号、计划点、今日高亮。
   - 计划点来源：`profile.week`；轮换模式显示 rotation 下一项。
   - 点击某天打开 `ScheduleEditor`（可选）或只展示，不新增功能。
3. 本周进度：
   - `Text` "本周还剩 x/y 次" + `ProgressBar`。
   - 计划数取 `profile.week` 中计划条目总数；完成数取本周 `workouts`。
4. 今日训练卡：
   - 有推荐：`Card` + `IconTile` + 计划名 + 动作数 + `MiniBodyMap` + `Button size="sm"` 开始。
   - 多个推荐：逐行 `ListRow` 或一个卡片内多个开始按钮。
   - 无推荐：`EmptyState` 图标 `calendar`，操作“打开计划”/“自由训练”。
5. 最近训练：
   - `SectionHeader` + 最多 3 条 `ListRow`，点击跳转统计（通过 callback）。
6. 无连接时显示“本机练习”Badge。

数据：使用现有 `profile`、`recommended`、`history`、`queue`；不新增数据字段。周进度为展示计算，不写入 profile。

验收：

- 五 Tab 首页可见，齿轮打开设置。
- 周条今日高亮、计划点、本周进度正确。
- 今日推荐开始训练、自由训练可用。
- 无数据时显示 EmptyState，不显示假挑战/体重/连续卡。

### 6.2 计划 Plan

布局：

1. `Header title="计划" subtitle="你的每周安排"`。
2. `Segmented`：日程 / 训练计划。
3. 训练计划：
   - 操作行：`Button tinted icon="plus"` 新训练日；`Button secondary icon="calendar"` 训练排程。
   - 计划行：`Card padded=false` + `ListRow`，leading `IconTile`，title，subtitle `N 个动作`，trailing `MiniBodyMap` + chevron。
   - 点击行编辑；`IconButton more` 打开 `ActionSheet`：开始训练、编辑、删除。
4. 日程：
   - 周一至周日行，显示计划名或“休息”。
   - 显示轮换模式序列；点击行可打开排程编辑。
   - `Button primary` 编辑排程。
5. 空状态：没有计划时 `EmptyState` + 新建计划。

验收：

- 日程/训练计划切换正常。
- 新建、编辑、删除、开始计划正常。
- 计划行没有三个全宽按钮。
- 排程编辑保存后日程页立即更新。

### 6.3 统计 Stats

布局：

1. `Header title="统计" subtitle="训练记录与进步"`。
2. 概览卡片：
   - `StatTile` 训练次数、本周训练、总训练量；单位用 profile.unit。
   - 本周完成度 `ProgressBar`。
   - 只显示已有数据，不显示轮空挑战/体重/RPE。
3. `SectionHeader` 最近训练 + 补录按钮。
4. 训练列表：
   - `Card padded=false` + `ListRow`：title 训练名，subtitle `日期 · N 个动作`，trailing 待同步 Badge + chevron。
   - 展开详情：动作名、组摘要、查看动作历史；编辑/删除通过 `ActionSheet`。
5. 动作历史子页：
   - `Header compact onBack`；每个训练一张 `Card`；热身 Badge；无记录 EmptyState。
6. 空状态：无训练时 EmptyState。

数据：沿用 `history` 合并（远程 + queue）、`workoutKey`、`deleteWorkout`、`HistoryEditor`；数量/训练量从 workout 数据计算，优先用 `workout.vol`，否则用组数据估算；热身是否计入训练量沿用 `profile.volumeWarmups`。

验收：

- 展开、动作历史、编辑、删除、补录、待同步标记正常。
- 概览数字与历史记录一致。
- 不显示未实现的数据模块。

### 6.4 动作库 Library

布局：

1. `Header title="动作库"`，副标题 `5632 个动画动作 + N 个自建`，右侧筛选按钮。
2. `SearchField`。
3. 横向 chips：全部 + 部位（胸、背、腿、肩、手臂、有氧、全身…）。
4. 筛选 `Sheet`：部位、器械两组 chips + 底部“完成”。
5. 自定义动作行：`ListRow` 创建自己的动作。
6. 动作列表：
   - `Card padded=false` + `ListRow`。
   - leading `MediaThumb`，title 动作名，subtitle `部位 · 器械`。
   - trailing `IconButton plus`；整行或加号选择动作。
   - 无服务器时 MediaThumb 显示中性占位。
7. 自定义动作编辑：`Sheet` + `TextField` 名称 + 保存/取消。
8. 空结果：`EmptyState` 或“没有匹配的动作”。

数据：

- 扩展 `src/catalogue.js`：`searchCatalogue(query, bodyPart?, equipment?)` 返回 `{id,name,bodyPart,equipment,cardio}`；导出 `BODY_PARTS`、`EQUIPMENT`、`BODY_PART_NAMES`、`EQUIPMENT_NAMES`、`CATALOGUE_COUNT`。
- `bodyPart` 使用 `EXDB` 的 `bp`；部位中文映射：back 背部、cardio 有氧、chest 胸部、full body 全身、lower arms 前臂、lower legs 小腿、neck 颈部、shoulders 肩部、upper arms 手臂、upper legs 大腿、waist 腰腹。
- 器械中文映射至少覆盖：body weight 自重、barbell 杠铃、dumbbell 哑铃、cable 绳索、machine 器械、band 弹力带、kettlebell 壶铃等；未知值原样显示。
- 选择动作：如果当前有 draft，加入训练并进入 Workout；否则以该动作开始自由训练。由 App 处理。

验收：

- 搜索、部位 chips、筛选 Sheet、清除筛选正常。
- 自定义动作创建/改名正常。
- 选择动作后能进入训练。
- 缩略图在配对服务器下加载，无服务器显示占位。

### 6.5 设置 Settings

布局：

1. `Header compact title="设置" onBack`。
2. 账号/连接卡：用户名、服务器地址、连接状态 Badge、待同步、上次同步。
3. 操作：立即同步、重新配对、断开连接。
4. 配对表单：`TextField` 服务器地址、HTTP 警告、`TextField` 配对码、连接按钮。
5. 备份：`Card padded=false` + `ListRow` 导出备份、恢复备份、合并本机练习。
6. 通知：`SwitchRow` 开启休息通知；开启后显示“闹钟与提醒设置”行。
7. 开发：`ListRow` 设计系统预览（仅 `__DEV__`）。

数据：沿用 `pair`、`synchronize`、`disconnect`、`exportBackup`、`pickBackup`、`restoreBackup`、`enableRestNotifications`、`readLocal(null)`。不改令牌存储和同步。

验收：配对/重新配对/同步/断开/备份/恢复/合并/通知开关全部可用；地址 HTTP 警告显示；开发入口可用。

### 6.6 进行中训练 Workout

布局：

1. `Header compact title={draft.name}`；右侧显示 elapsed 时间 + `Button size="sm" variant="primary"` 完成；更多菜单（放弃训练）。
2. 动作卡：
   - 行头：`IconTile` 或动作名 + `IconButton more`。
   - 超级组组头/轮转提示。
   - 组行：组号、`Stepper` 重量、`Stepper` 次数/秒/分钟、完成 checkbox、删除。
   - 底部：添加正式组、搜索替换动作、移出/组成超级组。
3. 添加动作：`Button secondary icon="plus"` 打开全屏动作库选择器。
4. 补录：顶部 Card 名称/日期 TextField。
5. 休息 dock：`RestTimer` 固定在底部，显示剩余时间和取消；不遮挡内容。
6. 完成/放弃：完成校验同现有 `finishWorkout`；放弃使用 `ActionSheet` + Alert 确认。

保留：热身、上次重量预填、增删组、超级组轮转、组内/轮末休息、替换动作、补录、重开恢复。

验收：`-FeatureChecks -SupersetChecks` 通过；手动回归记组、热身、超级组、替换、补录、休息、完成、放弃。

### 6.7 编辑面板

- `PlanEditorScreen`：`Screen` + `Header compact`；名称 `TextField`；动作卡展开编辑（模式 `Segmented`、组数/次数/重量 `TextField`、超级组、删除）；添加动作打开全屏动作库；保存/取消。
- `ScheduleEditorScreen`：`Screen` + `Header`；`Segmented` 每周/轮换；星期 `Chip`/`ListRow`；计划 `ListRow` + check；保存。
- `HistoryEditorScreen`：`Screen` + `Header`；名称/日期 `TextField`；组数据 `TextField`；保存/取消。
- 动作库作为全屏选择器复用 `ExerciseLibraryScreen`，带 `onBack`；计划编辑器导入它或由 App 打开 panel。

## 7. 文件与接口

新增：

```text
mobile-rn/src/screens/
  HomeScreen.tsx
  PlanScreen.tsx
  StatsScreen.tsx
  ExerciseLibraryScreen.tsx
  SettingsScreen.tsx
  WorkoutScreen.tsx
  PlanEditorScreen.tsx
  ScheduleEditorScreen.tsx
  HistoryEditorScreen.tsx
  StartSheet.tsx

mobile-rn/src/design/components/
  TextField.tsx
  SwitchRow.tsx
  Stepper.tsx

mobile-rn/src/design/patterns/
  ActionSheet.tsx
```

修改：

- `App.tsx`：五 Tab shell、开始 Sheet、设置面板、页面回调。
- `src/design/components/index.ts`、`patterns/index.ts`、`design/index.ts`：导出新组件。
- `src/design/gallery/DesignGallery.tsx`：新增组件示例。
- `src/catalogue.js`：部位/器械/中文名/筛选搜索。
- `src/restTimer.tsx`：dock 样式。
- `src/ui.tsx`：最后删除。

禁止修改：

- `training.ts`、`profileChanges.ts`、`server.ts`、`storage.ts`、`backups.ts`、`restNotifications.ts`、`supersets.ts`、`useGym.ts`。
- `frontend/`、`api/`、`catalogue/`。

### 7.1 关键 Props

```ts
type HomeScreenProps = {
  profile: Profile;
  connection: Connection | null;
  history: Array<{ workout: Workout; unit: Unit; pending: boolean }>;
  recommended: Routine[];
  pending: number;
  onSettings: () => void;
  onStartRoutine: (routine: Routine) => void;
  onStartFree: () => void;
  onOpenStats: () => void;
  onOpenPlan: () => void;
};

type PlanScreenProps = {
  profile: Profile;
  connection: Connection | null;
  onCreate: () => void;
  onEdit: (routine: Routine) => void;
  onDelete: (routine: Routine) => void;
  onStart: (routine: Routine) => void;
  onSchedule: () => void;
};

type StatsScreenProps = {
  profile: Profile;
  history: Array<{ workout: Workout; unit: Unit; pending: boolean }>;
  onEdit: (workout: Workout, unit: Unit) => void;
  onDelete: (workout: Workout) => void;
  onBackfill: () => void;
};

type ExerciseLibraryScreenProps = {
  profile: Profile;
  server: string | null;
  onPick: (exercise: RoutineExercise) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onBack?: () => void; // 作为选择器时显示返回
};

type SettingsScreenProps = {
  connection: Connection | null;
  pending: number;
  lastSync: number | null;
  operation: 'pair' | 'sync' | 'disconnect' | null;
  restAlerts: boolean;
  onClose: () => void;
  onConnect: (address: string, code: string) => void;
  onSync: () => void;
  onDisconnect: () => void;
  onExport: () => void;
  onRestore: () => void;
  onMergePractice: () => void;
  onToggleRestAlerts: () => void;
  onOpenAlarmSettings: () => void;
  onOpenGallery: () => void;
};

type WorkoutScreenProps = {
  profile: Profile;
  draft: Draft;
  queue: QueuedWorkout[];
  onChange: (draft: Draft) => boolean;
  onFinish: () => void;
  onDiscard: () => void;
  onPick: (replaceIndex?: number) => void;
};
```

`StartSheet` 由 App 控制 visible，接收 `recommended`、`routines`、`onStartRoutine`、`onStartFree`、`onBackfill`、`onClose`。

## 8. 实施阶段

### 阶段 0：设计系统补齐

- 新增 TextField、SwitchRow、Stepper、ActionSheet。
- 更新 Gallery。
- `typecheck`、`design:check`、画廊脚本通过。

### 阶段 1：Shell + Home + Plan

- 五 Tab shell、中央开始、StartSheet。
- HomeScreen、PlanScreen。
- 服务器入口移到设置面板（先放空壳，阶段 2 填内容）。
- 验收五 Tab、Home 周条/今日卡、Plan 分段/计划行/排程。

### 阶段 2：Stats + Settings

- StatsScreen（历史列表 + 基础统计 + 动作历史）。
- SettingsScreen（服务器、备份、通知、开发入口）。
- 验收统计编辑/删除/补录/待同步；设置配对/同步/备份/通知。

### 阶段 3：Library

- 扩展 catalogue 筛选。
- ExerciseLibraryScreen 全屏 Tab。
- 自定义动作、筛选 Sheet、MediaThumb。
- 选择动作加入训练/开始自由训练。
- 验收搜索、筛选、创建、选择、占位图。

### 阶段 4：Workout + RestTimer

- 抽取 WorkoutScreen，Stepper 组行、Header 完成、ActionSheet、休息 dock。
- 保留热身、增删组、超级组、替换、补录、恢复。
- 验收 `-FeatureChecks -SupersetChecks`。

### 阶段 5：编辑面板

- PlanEditorScreen、ScheduleEditorScreen、HistoryEditorScreen。
- 计划编辑内嵌全屏动作库。
- 验收保存/取消/校验/同步。

### 阶段 6：清理与回归

- 删除 `ui.tsx`、旧 `PlanEditor.tsx`、`HistoryEditor.tsx`、`ExercisePicker.tsx` 中不再使用的文件。
- 全量 typecheck、design:check、Gallery、android-regression。
- 更新 `docs/RN_MIGRATION_STATUS.md` 和 `docs/RN_UI_EXECUTION.md`。

## 9. 验收目标

### 9.1 视觉目标

- 五 Tab：首页 / 计划 / 统计 / 动作库 + 中央开始。
- 页面标题 30/700，副标题 15/400 secondary。
- 背景纯黑，卡片 surface #1c1c1e、14 圆角、无边框、16 内边距。
- 主色 #30d158；按钮层级正确；没有每张卡三个全宽按钮。
- 列表行有图标块、副标题、chevron/Badge；动作库有缩略图/占位。
- 训练页休息 dock；组行紧凑。

### 9.2 功能目标

- 计划：新建、编辑、删除、排程、今日推荐、开始。
- 训练：记组、热身、增删组、超级组、替换、补录、休息、完成、放弃、重开恢复。
- 统计：列表、展开、动作历史、编辑、删除、补录、待同步。
- 动作库：搜索、部位/器械筛选、自定义、选择动作。
- 设置：配对、重新配对、同步、断开、备份、恢复、合并、通知、开发入口。
- 同步/删除/去重/409 重试行为不变。

### 9.3 自动检查

```powershell
cd mobile-rn
npm.cmd run typecheck
npm.cmd run design:check
```

```powershell
.\mobile-rn\scripts\design-gallery-verify.ps1 -Serial emulator-5556
```

```powershell
.\mobile-rn\scripts\android-regression.ps1 `
  -Apk .\mobile-rn\dist\openGym-RN-0.1.4.apk `
  -Serial emulator-5556 `
  -ResetAppData `
  -FeatureChecks `
  -P1Checks `
  -SupersetChecks
```

### 9.4 手动/截图

保存到 `mobile-rn/dist/ui/`：

- `home.png`
- `plan-schedule.png` / `plan-routines.png`
- `stats.png`
- `library.png` / `library-filter.png`
- `settings.png`
- `workout.png`
- `start-sheet.png`
- `rest-dock.png`

与原始截图并排检查 Home、Plan、Stats、Library、Filter Sheet；Stats 未实现的 P2 模块不显示。

## 10. 风险

| 风险 | 对策 |
| --- | --- |
| 五 Tab 改变现有入口 | 保留旧功能到新位置；`android-regression.ps1` 同步更新按钮文案 |
| 中央开始误覆盖草稿 | 有 draft 时只恢复，不重新开始 |
| 设置面板改动同步逻辑 | SettingsScreen 只调用现有回调，不改 `useGym`/`server.ts` |
| Stepper 输入不自由 | 输入保留原始字符串，加减才格式化 |
| 动作库成为新功能范围 | 只做搜索/部位/器械筛选和选择；不做动作动画/收藏/PR |
| 统计页无数据功能 | 只显示已有数据，不放假模块 |
| 页面拆分导致状态重复 | 状态和 gym 操作保留在 App；screens 只接收 props |
| 旧 `ui.tsx` 残留 | 阶段 6 删除并 typecheck |

## 11. 子 Agent 分工

- **Agent A（design gaps）**：TextField、SwitchRow、Stepper、ActionSheet、Gallery、indexes；不碰 screens/App。
- **Agent B（Home + Plan + StartSheet）**：HomeScreen、PlanScreen、StartSheet；按 Props 实现，不碰 App/design。
- **Agent C（Stats + Settings）**：StatsScreen、SettingsScreen；按 Props 实现，不碰 App/design。
- **Agent D（Library）**：catalogue.js、ExerciseLibraryScreen；按 Props 实现。
- **Agent E（Workout）**：WorkoutScreen、restTimer.tsx；保留训练逻辑，使用 Stepper/ActionSheet。
- **Agent F（Editors）**：PlanEditorScreen、ScheduleEditorScreen、HistoryEditorScreen；动作库选择器通过 prop/import 使用。
- **主 Agent**：App.tsx 五 Tab shell、回调接线、面板、删除旧文件、构建和模拟器验收。

所有子 Agent 必须：

- 先读本文件和 `docs/RN_UI_DESIGN_SYSTEM.md`。
- 只修改自己名下的文件。
- 不运行 npm install/Gradle/模拟器。
- 不修改数据/同步逻辑。
- 完成后报告文件、接口偏差、未完成项。

## 12. 待确认

已由用户确认：

- 五个 Tab。
- 使用 Stepper。
- 动作库全屏。
- 反馈先 Alert。

本方案按此执行。

## 13. 实现结果（2026-11-17）

已完成：

- 五 Tab：首页 / 计划 / 统计 / 动作库 + 中央开始。
- `HomeScreen`、`PlanScreen`、`StatsScreen`、`ExerciseLibraryScreen`、`SettingsScreen`、`WorkoutScreen`、三个编辑器和 `StartSheet`。
- `TextField`、`SwitchRow`、`Stepper`、`ActionSheet` 已加入设计系统并展示在 Gallery。
- 旧 `ui.tsx`、`PlanEditor.tsx`、`HistoryEditor.tsx`、`ExercisePicker.tsx` 已删除。
- 计划、训练、统计、动作库、设置和编辑器的截图已保存到 `mobile-rn/dist/ui/`。
- 新增 `five-tab-smoke.ps1`，验证五 Tab、首页、设置、计划、计划编辑、统计、动作库、筛选 Sheet 和开始 Sheet；已通过。
- 新增 `ui-capture.ps1`、`ui-fixture.ps1` 和 `make-ui-fixture.mjs`：深链直达各页面，固定 fixture 数据，一次截图并生成 contact sheet。
- 训练页支持 `opengym://workout?routine=<id>`，`e2e=1` 冻结用时和休息倒计时，便于 `uiautomator dump` 和截图断言。
- `design-gallery-verify.ps1` 已更新为从首页齿轮进入设置再打开设计系统预览；已通过。
- `npm run typecheck`、`npm run design:check` 通过。
- 手动验证：计划训练记组、休息 dock、完成训练、统计记录、计划编辑、历史编辑、动作库选择动作、超级组组合。
- Release APK 0.1.6 已构建并在 `emulator-5564` 上通过 `five-tab-smoke.ps1`：`mobile-rn/dist/openGym-RN-0.1.6-five-tab.apk`，versionCode 7，SHA-256 `A03A936B6C4197CD3BC308AEE89D3A45BC0588C3A28F7F61A124BE9F3F341DEF`，包含 arm64-v8a 和 x86_64，Debug 证书签名，约 258 MB。本版在 0.1.5 的进度、身体数据、历史导入、计划分享、二维码配对和训练提醒基础上，补全全部 5,632 个动作的 30,709 条中文步骤；原有 1,324 组翻译保持不变。动作库 `0001` 详情已确认中文步骤显示。

已知限制：

- 训练页普通模式的 `useElapsed` 每秒更新，`uiautomator dump` 可能无法获得 idle；视觉和控件树断言使用 `e2e=1` 深链冻结计时器。旧 `android-regression.ps1` 仍需按五 Tab 标签和菜单重新适配后才能重跑。
- 统计页只显示已有数据；P2 进度、体重/围度/照片通过统计页“进度与身体”入口打开，历史导入和配对扫码在设置页，计划分享在计划页。
- Design Gallery 只在 Debug 构建的“设置 → 开发”中可见；Release 包不显示该入口。

