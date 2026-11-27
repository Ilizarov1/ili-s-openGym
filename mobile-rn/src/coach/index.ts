/**
 * Public surface of the native Coach GenUI renderer, consumed by
 * `src/screens/CoachChatScreen.tsx` (Phase 3).
 */

export { StreamStepsBar } from './StreamStepsBar';
export type { CoachStreamStep, StreamStepsBarProps } from './StreamStepsBar';

export { ProposalActionNode } from './ProposalActionNode';
export type { ProposalActionNodeProps } from './ProposalActionNode';

export {
  AlternativesNode,
  ComparisonTableNode,
  ExerciseTrendNode,
  KpiStripNode,
  MuscleLoadNode,
  QuickFormNode,
} from './DataVisualNodes';
export type {
  AlternativesNodeProps,
  CoachFormSubmission,
  ComparisonTableNodeProps,
  ExerciseTrendNodeProps,
  KpiStripNodeProps,
  MuscleLoadNodeProps,
  QuickFormNodeProps,
} from './DataVisualNodes';

export { GenUIBriefing, GenUINodePending } from './GenUIBriefing';
export type { CoachPendingNode, GenUIBriefingProps } from './GenUIBriefing';
