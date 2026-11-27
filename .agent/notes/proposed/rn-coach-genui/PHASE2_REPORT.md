# `rn-coach-genui` Phase 2 — native GenUI renderer report

- 日期：2026-11-27
- 范围：`mobile-rn/src/coach/`（仅新增文件，未改动 `App.tsx`、`src/screens/*`、`src/design/*`、`src/training.ts`、`src/profileChanges.ts`、`api/*`）
- 依据：[`DESIGN.md`](./DESIGN.md) §3.2 / §3.3、[`EXECUTION.md`](./EXECUTION.md) Phase 2、[`docs/RN_UI_DESIGN_SYSTEM.md`](../../../../docs/RN_UI_DESIGN_SYSTEM.md)

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `mobile-rn/src/coach/StreamStepsBar.tsx` | 流式阶段条 + `search_catalogue` 检索态 + 脉动指示 + ≥44dp「停止」 |
| `mobile-rn/src/coach/ProposalActionNode.tsx` | `proposal_action` 勾选、diff、`add-routine` 预览、应用/已采纳/撤销提示 |
| `mobile-rn/src/coach/DataVisualNodes.tsx` | `ExerciseTrendNode`、`MuscleLoadNode`、`KpiStripNode`、`ComparisonTableNode`、`AlternativesNode`、`QuickFormNode` |
| `mobile-rn/src/coach/GenUIBriefing.tsx` | `prose` / `callout` / `fallback_notice` / 旧 `checklist`、节点调度、`pendingNode` 骨架 |
| `mobile-rn/src/coach/index.ts` | Phase 3 公共导出入口 |

## 2. 导出接口（Phase 3 `CoachChatScreen.tsx` 直接使用）

```ts
// StreamStepsBar.tsx
export type CoachStreamStep = { stepName: string; label?: string; done?: boolean };
export type StreamStepsBarProps = {
  steps?: readonly CoachStreamStep[];
  activeTool?: string | null;        // 'search_catalogue' 时显示检索态
  toolQuery?: string | null;         // 可选：检索词角标
  streaming?: boolean;               // 默认 true；false 且无工具时隐藏
  onStop?: () => void;
  style?: StyleProp<ViewStyle>;
};
export function StreamStepsBar(props: StreamStepsBarProps): ReactElement | null;

// ProposalActionNode.tsx
export type ProposalActionNodeProps = {
  node: CoachProposalActionNode;
  profile: Profile;
  applying?: boolean;                // 正在写入（按钮 loading）
  onApply: (changes: CoachProposalChange[], node: CoachProposalActionNode) => void;
  style?: StyleProp<ViewStyle>;
};
export function ProposalActionNode(props: ProposalActionNodeProps): ReactElement;

// DataVisualNodes.tsx
export type ExerciseTrendNodeProps = { node: CoachExerciseTrendNode; profile: Profile; style?: StyleProp<ViewStyle> };
export type MuscleLoadNodeProps   = { node: CoachMuscleLoadNode; profile: Profile; style?: StyleProp<ViewStyle> };
export type KpiStripNodeProps     = { node: CoachKpiStripNode; profile: Profile; style?: StyleProp<ViewStyle> };
export type ComparisonTableNodeProps = { node: CoachComparisonTableNode; profile: Profile; style?: StyleProp<ViewStyle> };

export type AlternativesNodeProps = {
  node: CoachExerciseAlternativesNode;
  profile: Profile;
  server?: string | null;            // 配对服务器地址，用于动作静态图
  onApplyAlternative?: (item: CoachAlternativeItem, node: CoachExerciseAlternativesNode) => void;
  style?: StyleProp<ViewStyle>;
};

export type CoachFormSubmission = {
  formId: string;
  title: string;
  values: Record<string, string | number | string[]>;
  summaryText: string;
};
export type QuickFormNodeProps = {
  node: CoachQuickFormNode;
  onSubmitForm: (submission: CoachFormSubmission, node: CoachQuickFormNode) => void;
  style?: StyleProp<ViewStyle>;
};

export function ExerciseTrendNode(props: ExerciseTrendNodeProps): ReactElement;
export function MuscleLoadNode(props: MuscleLoadNodeProps): ReactElement;
export function KpiStripNode(props: KpiStripNodeProps): ReactElement | null;
export function ComparisonTableNode(props: ComparisonTableNodeProps): ReactElement | null;
export function AlternativesNode(props: AlternativesNodeProps): ReactElement;
export function QuickFormNode(props: QuickFormNodeProps): ReactElement;

// GenUIBriefing.tsx
export type CoachPendingNode = { nodeType?: string; type?: string };
export type GenUIBriefingProps = {
  nodes: readonly CoachGenUINode[];
  pendingNode?: CoachPendingNode | null;
  streaming?: boolean;
  profile: Profile;
  server?: string | null;
  applyingProposalId?: string | null;
  onApplyProposal: (changes: CoachProposalChange[], node: CoachProposalActionNode) => void;
  onSubmitForm: (submission: CoachFormSubmission, node: CoachQuickFormNode) => void;
  onApplyAlternative?: (item: CoachAlternativeItem, node: CoachExerciseAlternativesNode) => void;
  messageId?: string;
  style?: StyleProp<ViewStyle>;
};
export function GenUIBriefing(props: GenUIBriefingProps): ReactElement;
export function GenUINodePending(props: { type?: string }): ReactElement;

// index.ts 统一导出以上组件与全部 Props 类型。
```

## 3. 行为与设计要点

- **纯本地水合**：`ExerciseTrendNode` 的指标/周期切换与 `MuscleLoadNode` 的 `72h/7d/28d` 切换均调用 `coach-bridge` 的 `hydrateCoachTrend` / `hydrateCoachMuscleLoad`，不发网络请求；`KpiStripNode` 走 `hydrateCoachKpi`。
- **动作名与处方**：所有动作名经 `resolveExerciseName(exId, profile)`（覆盖 `xunji-ex-*` 自定义动作）；处方列 `flexShrink: 0` + `fontVariant: ['tabular-nums']`，名称列 `flex: 1 / minWidth: 0`，360dp 不溢出。
- **提案**：`status === 'stale'` 的条目灰显且不可勾选；默认勾选全部可用项；`node.applied` 为真时锁定为「已采纳」并显示「可在右上角菜单撤销上次更改」；`onApply` 只收到勾选项。
- **`add-routine` 预览**：周几胶囊 + 全量动作处方（`formatRx` 与 Web 一致：有氧分钟/配速、时间动作 `sets×sec秒`、力量 `sets×reps` 或区间）。
- **触控**：勾选整行 44dp；停止/替换按钮与快捷表单 Chip 均以 `theme.sizes.touch` 为最小高度；`Segmented` 自带 32dp + hitSlop 6 = 44dp。
- **主题**：全部颜色/间距/圆角/字号来自 `useTheme()` 的语义 Token，零裸色值、零裸字号；Light/Dark 均可用。
- **KPI 偏差说明**：`StatTile` 没有趋势 `Badge` 插槽，且其数值 `Text` 无法启用 `tabular-nums`；因此 KPI 卡片用 Token 化的自定义单元格复刻 `StatTile` 的排版，同时满足「趋势 Badge + 等宽数字」硬性要求。
- **旧消息兼容**：`checklist` 渲染为只读编号文本（无交互复选框）；`prose tone='lead'` 使用 `headline` 变体（同字号、字重更强）。

## 4. 验证结果

| 命令 | 结果 |
|---|---|
| `cd mobile-rn; npm.cmd run lint` | 0 errors；仅 `PlanScreen.tsx` / `StatsScreen.tsx` 两条既有 `react/no-array-index-key` warning |
| `npm.cmd run lint:rules` | 7/7 通过 |
| `npm.cmd run typecheck` | 通过（0 错误） |
| `npm.cmd run design:check` | `design:check OK (127 upstream icons, 127 RN icons)` |
| `node --test scripts/coach-stream.test.mjs scripts/coach-profile-changes.test.mjs` | 25/25 通过 |
| `cd mobile-rn; npm.cmd run check` | 全绿（上述四步串联，0 errors） |

## 5. 留给 Phase 3 的接线

1. `onApplyProposal` → `applyCoachProposal(profile, changes, { messageId, nodeId: node.id, intentId, acceptedIds })` 后经 `commit()` 持久化/同步。
2. `onSubmitForm` → 用 `formSubmission: submission` 发起下一轮流式请求；历史消息里把该提交持久化到 `CoachChatMessage.formSubmission`。
3. `onApplyAlternative` → 复用 Web `swap_choice` 的提交形态 `{ formId: 'swap_choice', values: { exId, forExId, routineId } }`。
4. `StreamStepsBar` 传 `streaming`、`activeTool`（`TOOL_CALL_START/RESULT`）与 `onStop`；`GenUIBriefing` 传 `pendingNode`（`genui.node_pending`）与 `applyingProposalId`。
5. 真机/模拟器视觉验收（GIF）属于 Phase 4，本次未执行。
