/**
 * The ordered narrative briefing behind one `kind: 'genui'` Coach message.
 *
 * v2 messages carry `nodes[]`: prose, primitives and action/data cards in the exact order the
 * model wrote them. Legacy threads still carry `checklist` blocks, rendered read-only and
 * numbered, matching Web v2.1. Data cards get their numbers hydrated by `DataVisualNodes`; the
 * single writing node is delegated to `ProposalActionNode`.
 */

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Card, Icon, Text, useTheme } from '../design';
import type { Theme } from '../design';
import {
  AlternativesNode,
  ComparisonTableNode,
  ExerciseTrendNode,
  KpiStripNode,
  MuscleLoadNode,
  QuickFormNode,
} from './DataVisualNodes';
import type { CoachFormSubmission } from './DataVisualNodes';
import { ProposalActionNode } from './ProposalActionNode';
import type {
  CoachAlternativeItem,
  CoachCalloutNode,
  CoachExerciseAlternativesNode,
  CoachFallbackNoticeNode,
  CoachGenUINode,
  CoachLegacyChecklistNode,
  CoachProposalActionNode,
  CoachProposalChange,
  CoachProseNode,
  CoachQuickFormNode,
  Profile,
} from '../training';

/** The `genui.node_pending` payload: either spelling may arrive on the wire. */
export type CoachPendingNode = {
  nodeType?: string;
  type?: string;
};

export type GenUIBriefingProps = {
  nodes: readonly CoachGenUINode[];
  /** A node the server announced but has not committed yet; shows a type-shaped skeleton. */
  pendingNode?: CoachPendingNode | null;
  /** `true` while the answer streams; an empty briefing with no pending node shows a skeleton. */
  streaming?: boolean;
  profile: Profile;
  /** Paired server base URL for alternative thumbnails. */
  server?: string | null;
  /** Id of the proposal currently being applied, so its button shows a spinner. */
  applyingProposalId?: string | null;
  onApplyProposal: (changes: CoachProposalChange[], node: CoachProposalActionNode) => void;
  onSubmitForm: (submission: CoachFormSubmission, node: CoachQuickFormNode) => void;
  onApplyAlternative?: (item: CoachAlternativeItem, node: CoachExerciseAlternativesNode) => void;
  messageId?: string;
  style?: StyleProp<ViewStyle>;
};

const styles = StyleSheet.create({
  card: {
    marginBottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  numeric: {
    fontVariant: ['tabular-nums'],
  },
});

/* ------------------------------- primitives -------------------------------- */

function ProseNode({ node }: { node: CoachProseNode }) {
  const lead = node.tone === 'lead';
  return (
    <Text
      tone={node.tone === 'closing' ? 'secondary' : 'label'}
      variant={lead ? 'headline' : 'body'}
    >
      {node.text}
    </Text>
  );
}

function CalloutNode({ node }: { node: CoachCalloutNode }) {
  const theme = useTheme();
  const accent = node.variant === 'warning' ? theme.colors.warning : theme.colors.accent;
  return (
    <Card
      style={[
        styles.card,
        {
          flexDirection: 'row',
          alignItems: 'stretch',
          gap: theme.space.md,
        },
      ]}
    >
      <View
        style={{
          width: theme.space.xs,
          borderRadius: theme.radius.pill,
          backgroundColor: accent,
        }}
      />
      <View style={[styles.grow, { gap: theme.space.xxs }]}>
        {node.title ? <Text variant="headline">{node.title}</Text> : null}
        <Text tone="secondary" variant="subhead">
          {node.text}
        </Text>
      </View>
    </Card>
  );
}

function FallbackNoticeNode({ node }: { node: CoachFallbackNoticeNode }) {
  const theme = useTheme();
  return (
    <Card style={[styles.card, { backgroundColor: theme.colors.surface2 }]}>
      <View style={[styles.row, { alignItems: 'flex-start', gap: theme.space.sm }]}>
        <Icon color={theme.colors.label2} name="info" size={theme.sizes.buttonIcon} />
        <Text style={styles.grow} tone="secondary" variant="footnote">
          {node.text}
        </Text>
      </View>
    </Card>
  );
}

/** Pre-v2 checklists are read-only history: numbered text, never interactive checkboxes. */
function LegacyChecklistNode({ node }: { node: CoachLegacyChecklistNode }) {
  const theme = useTheme();
  const items = node.items.filter(item => item && item.label);
  if (items.length === 0) return null;

  return (
    <Card style={styles.card}>
      {node.title ? <Text variant="headline">{node.title}</Text> : null}
      {items.map((item, index) => (
        <View
          key={item.id}
          style={[styles.row, { alignItems: 'flex-start', gap: theme.space.sm }]}
        >
          <Text
            style={[styles.numeric, { minWidth: theme.space.lg }]}
            tone="secondary"
            variant="subhead"
          >
            {`${index + 1}.`}
          </Text>
          <View style={[styles.grow, { gap: theme.space.xxs }]}>
            <Text variant="body">{item.label}</Text>
            {item.detail ? (
              <Text tone="secondary" variant="footnote">
                {item.detail}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

/* -------------------------------- skeletons -------------------------------- */

function SkeletonBar({
  height,
  width,
}: {
  height: number;
  width?: `${number}%`;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        height,
        width,
        borderRadius: theme.radius.sm,
        backgroundColor: theme.colors.surface2,
      }}
    />
  );
}

function GenUINodePendingBody({ type, theme }: { type: string; theme: Theme }) {
  if (type === 'kpi_strip') {
    return (
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <SkeletonBar height={theme.sizes.touch} width="30%" />
        <SkeletonBar height={theme.sizes.touch} width="30%" />
        <SkeletonBar height={theme.sizes.touch} width="30%" />
      </View>
    );
  }
  if (type === 'exercise_trend' || type === 'muscle_load') {
    return (
      <View style={{ gap: theme.space.sm }}>
        <SkeletonBar height={theme.space.xl} width="42%" />
        <SkeletonBar height={theme.sizes.touch * 2} />
      </View>
    );
  }
  if (type === 'comparison_table' || type === 'checklist') {
    return (
      <View style={{ gap: theme.space.sm }}>
        <SkeletonBar height={theme.space.xl} width="38%" />
        <SkeletonBar height={theme.space.md} width="72%" />
        <SkeletonBar height={theme.space.md} width="72%" />
        <SkeletonBar height={theme.space.md} width="54%" />
      </View>
    );
  }
  if (type === 'callout') {
    return <SkeletonBar height={theme.space.xl} width="64%" />;
  }
  return <SkeletonBar height={theme.space.xl} width="80%" />;
}

/** The placeholder shape of a node that is still composing. */
export function GenUINodePending({ type = 'prose' }: { type?: string }) {
  const theme = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Card style={styles.card}>
        <SkeletonBar height={theme.space.md} width="28%" />
        <GenUINodePendingBody theme={theme} type={type} />
      </Card>
    </View>
  );
}

/* --------------------------------- briefing -------------------------------- */

export function GenUIBriefing({
  nodes,
  pendingNode = null,
  streaming = false,
  profile,
  server = null,
  applyingProposalId = null,
  onApplyProposal,
  onSubmitForm,
  onApplyAlternative,
  messageId,
  style,
}: GenUIBriefingProps) {
  const theme = useTheme();
  const pendingType = pendingNode ? pendingNode.nodeType ?? pendingNode.type ?? 'prose' : 'prose';
  const showPending = pendingNode !== null || (streaming && nodes.length === 0);

  const renderNode = (node: CoachGenUINode): ReactNode => {
    switch (node.type) {
      case 'prose':
        return <ProseNode node={node} />;
      case 'kpi_strip':
        return <KpiStripNode node={node} profile={profile} />;
      case 'exercise_trend':
        return <ExerciseTrendNode node={node} profile={profile} />;
      case 'muscle_load':
        return <MuscleLoadNode node={node} profile={profile} />;
      case 'comparison_table':
        return <ComparisonTableNode node={node} profile={profile} />;
      case 'callout':
        return <CalloutNode node={node} />;
      case 'exercise_alternatives':
        return (
          <AlternativesNode
            node={node}
            onApplyAlternative={onApplyAlternative}
            profile={profile}
            server={server}
          />
        );
      case 'quick_form':
        return <QuickFormNode node={node} onSubmitForm={onSubmitForm} />;
      case 'proposal_action':
        return (
          <ProposalActionNode
            applying={applyingProposalId === node.id}
            node={node}
            onApply={onApplyProposal}
            profile={profile}
          />
        );
      case 'fallback_notice':
        return <FallbackNoticeNode node={node} />;
      case 'checklist':
        return <LegacyChecklistNode node={node} />;
      default:
        return null;
    }
  };

  return (
    <View
      style={[{ gap: theme.space.md }, style]}
      testID={messageId ? `coach-briefing-${messageId}` : undefined}
    >
      {nodes.map(node => (
        <Fragment key={node.id}>{renderNode(node)}</Fragment>
      ))}
      {showPending ? <GenUINodePending type={pendingType} /> : null}
    </View>
  );
}
