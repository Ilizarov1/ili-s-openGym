// The AI Coach conversation, native counterpart of `frontend/src/views/CoachChat.jsx`.
//
// Every turn is one AG-UI stream (`POST /api/agent/coach/stream`): the live slot is filled from
// RUN_STARTED / STEP_* / TOOL_CALL_* / CUSTOM(genui.*) events, and RUN_FINISHED lands it in the
// synced `coach.chat` list as a `genui` message so a reload re-hydrates the same cards against
// the same local data. The screen never touches `fetch`, `server` or `storage` directly: the
// stream lives in `src/agent/coach-stream.ts` and every write goes through `commit()` into
// `src/profileChanges.ts`, which is also what syncs the thread to the Web client.
//
// A per-run generation counter (`chatGenRef`) plus an `AbortController` makes "New conversation"
// and leaving the screen discard late events from an older run (L-010): streamed text can never
// resurrect a cleared thread or leak into the new one.

import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { randomUUID } from 'expo-crypto';
import {
  ActionSheet,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Header,
  IconButton,
  Screen,
  Text,
  TextField,
  useTheme,
} from '../design';
import type { ActionItem } from '../design';
import { GenUIBriefing, StreamStepsBar } from '../coach';
import type { CoachFormSubmission, CoachPendingNode, CoachStreamStep } from '../coach';
import { isCoachStreamError, streamCoachGenUI } from '../agent/coach-stream';
import type {
  CoachGenUINode as WireGenUINode,
  CoachStreamEvent,
  CoachStreamResult,
} from '../agent/coach-stream';
import {
  MAX_GENUI_TURNS,
  applyCoachProposal,
  buildGenUIHistory,
  canRevertCoach,
  countGenUITurns,
  pruneClearedChat,
  resolveExerciseName,
} from '../agent/coach-bridge';
import type { CoachApplyMeta, CoachHistoryTurn } from '../agent/coach-bridge';
import { localDate } from '../training';
import type {
  CoachAlternativeItem,
  CoachChatMessage,
  CoachExerciseAlternativesNode,
  CoachGenUINode,
  CoachProposalActionNode,
  CoachProposalChange,
  CoachProseTone,
  CoachQuickFormNode,
  Profile,
} from '../training';
import type { Connection } from '../server';
import type { ProfileChange } from '../profileChanges';

export type CoachChatScreenProps = {
  profile: Profile;
  connection: Connection | null;
  commit: (changes: ProfileChange[]) => boolean;
  onBack: () => void;
  onOpenPair: () => void;
  onOpenAgent: () => void;
};

/** Node types the briefing renderer knows; anything else is dropped instead of crashing it. */
const NODE_TYPES: ReadonlySet<string> = new Set([
  'prose',
  'kpi_strip',
  'exercise_trend',
  'muscle_load',
  'comparison_table',
  'callout',
  'exercise_alternatives',
  'quick_form',
  'proposal_action',
  'fallback_notice',
  'checklist',
]);

const MAX_DRAFT = 1000;

const LIMIT_TEXT = `这轮对话已经用满 ${MAX_GENUI_TURNS} 轮。开始新对话后可以继续问。`;

const WELCOME_TEXT = '你好，我是你的 AI 教练。我会结合你记录的训练分析问题、调整计划；任何改动都要你确认后才会生效。';

/* ------------------------------ live accumulator ----------------------------- */

type Accumulator = {
  steps: CoachStreamStep[];
  activeTool: string | null;
  /** A tool that already returned during this run, kept so its status stays readable. */
  completedTool: string | null;
  toolQuery: string | null;
  text: string;
  nodes: CoachGenUINode[];
  blocks: CoachGenUINode[];
  pendingNode: CoachPendingNode | null;
  error: string | null;
};

type LiveSnapshot = Accumulator & { active: boolean };

type FailedTurn = {
  text: string;
  formSubmission?: Record<string, unknown>;
  history: CoachHistoryTurn[];
};

type TurnInput = {
  text: string;
  formSubmission?: Record<string, unknown>;
  /** History captured before this turn's user line was appended; retries reuse it. */
  history?: CoachHistoryTurn[];
  /** `false` when the user line is already persisted (retry). */
  appendUser: boolean;
};

function emptyAccumulator(): Accumulator {
  return {
    steps: [],
    activeTool: null,
    completedTool: null,
    toolQuery: null,
    text: '',
    nodes: [],
    blocks: [],
    pendingNode: null,
    error: null,
  };
}

function snapshotOf(acc: Accumulator): LiveSnapshot {
  return {
    ...acc,
    steps: [...acc.steps],
    nodes: [...acc.nodes],
    blocks: [...acc.blocks],
    active: true,
  };
}

/** One wire node as the briefing renderer's discriminated union; unknown shapes are dropped. */
function normalizeNode(raw: unknown, index: number): CoachGenUINode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (!NODE_TYPES.has(type)) return null;
  const id = typeof record.id === 'string' && record.id ? record.id : `node_${index + 1}`;
  // The server validates node payloads before they reach the wire (coach-genui schema), so the
  // screen only re-checks the discriminant + id and then reads it through the union.
  return { ...record, id, type } as unknown as CoachGenUINode;
}

function normalizeNodes(raw: readonly WireGenUINode[] | null | undefined, offset = 0): CoachGenUINode[] {
  const out: CoachGenUINode[] = [];
  (Array.isArray(raw) ? raw : []).forEach((node, index) => {
    const normalized = normalizeNode(node, offset + index);
    if (normalized) out.push(normalized);
  });
  return out;
}

function upsertNode(list: CoachGenUINode[], node: CoachGenUINode, replace: boolean): CoachGenUINode[] {
  const at = list.findIndex(item => item.id === node.id);
  if (at < 0) return [...list, node];
  return list.map((item, index) => {
    if (index !== at) return item;
    return (replace ? node : { ...item, ...node }) as CoachGenUINode;
  });
}

function proseTone(raw: unknown): CoachProseTone | undefined {
  return raw === 'lead' || raw === 'closing' || raw === 'normal' ? raw : undefined;
}

/** Append a `genui.prose_delta` fragment to its prose node, creating the node on first text. */
function appendProse(
  list: CoachGenUINode[],
  id: string,
  delta: string,
  tone: CoachProseTone | undefined,
): CoachGenUINode[] {
  const at = list.findIndex(item => item.id === id);
  if (at >= 0) {
    const current = list[at];
    if (current.type !== 'prose') return list;
    return list.map((item, index) => (index === at ? { ...current, text: current.text + delta } : item));
  }
  return [...list, { id, type: 'prose', text: delta, ...(tone ? { tone } : {}) }];
}

function setProseText(list: CoachGenUINode[], id: string, text: string): CoachGenUINode[] {
  const at = list.findIndex(item => item.id === id);
  if (at >= 0) {
    const current = list[at];
    if (current.type !== 'prose') return list;
    return list.map((item, index) => (index === at ? { ...current, text } : item));
  }
  return [{ id, type: 'prose', text }, ...list];
}

/* --------------------------------- messages --------------------------------- */

function userMessage(text: string, at: number, formSubmission?: Record<string, unknown>): CoachChatMessage {
  return {
    id: randomUUID(),
    role: 'user',
    kind: 'text',
    at,
    text,
    ...(formSubmission ? { formSubmission } : {}),
  };
}

function coachMessage(nodes: readonly CoachGenUINode[], text: string, at: number): CoachChatMessage {
  // `genui` messages always carry at least one node: a text-only answer is one prose node, which
  // is also how `frontend/src/components/CoachGenUI.jsx` normalizes legacy `{ text, blocks }`.
  const list = nodes.length
    ? [...nodes]
    : [{ id: 'prose_0', type: 'prose' as const, text }];
  return {
    id: randomUUID(),
    role: 'coach',
    kind: 'genui',
    at,
    text,
    nodes: list,
  };
}

/* ---------------------------------- styles ---------------------------------- */

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  userBubble: {
    alignSelf: 'flex-end',
  },
  coachBubble: {
    alignSelf: 'flex-start',
  },
  messageList: {
    flexGrow: 1,
  },
});

/* ---------------------------------- screen ---------------------------------- */

export function CoachChatScreen({
  profile,
  connection,
  commit,
  onBack,
  onOpenPair,
  onOpenAgent,
}: CoachChatScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bodyRef = useRef<View | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const mountedRef = useRef(true);
  const chatGenRef = useRef(0);
  const ctlRef = useRef<AbortController | null>(null);
  const liveRef = useRef<Accumulator | null>(null);
  const runningRef = useRef(false);
  const applyingRef = useRef(false);
  const draftRef = useRef('');

  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [routineMenu, setRoutineMenu] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<FailedTurn | null>(null);
  const [errorText, setErrorText] = useState('');
  const [limitHit, setLimitHit] = useState(false);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [submittedForms, setSubmittedForms] = useState<ReadonlySet<string>>(() => new Set());
  const [appliedProposals, setAppliedProposals] = useState<ReadonlySet<string>>(() => new Set());
  // Mirrors `appliedProposals` for callbacks that run with an older render's closure (persist).
  const appliedRef = useRef<ReadonlySet<string>>(new Set());

  const clearedAt = Number(profile.coach?.chatClearedAt) || 0;
  const chat = pruneClearedChat(profile.coach?.chat, clearedAt);
  const userTurns = countGenUITurns(profile.coach?.chat, clearedAt);
  const turnLimitReached = userTurns >= MAX_GENUI_TURNS || limitHit;
  const routines = (profile.routines ?? []).filter(Boolean);
  const lang = typeof profile.lang === 'string' && profile.lang ? profile.lang : 'zh';
  const lastWorkout = (profile.workouts ?? [])
    .filter(Boolean)
    .reduce<{ start: number; name?: string } | null>((latest, workout) => {
      if (!latest || (Number(workout.start) || 0) >= latest.start) {
        return { start: Number(workout.start) || 0, ...(workout.name ? { name: workout.name } : {}) };
      }
      return latest;
    }, null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the screen invalidates the run: late events must not write into the thread.
      chatGenRef.current += 1;
      ctlRef.current?.abort();
      ctlRef.current = null;
      liveRef.current = null;
    };
  }, []);

  // Android edge-to-edge does not always resize the window for the keyboard; measuring the
  // overlap keeps the composer (and its one TextField) visible without remounting it.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, event => {
      if (Platform.OS !== 'android') return;
      const screenY = event?.endCoordinates?.screenY;
      const height = event?.endCoordinates?.height ?? 0;
      bodyRef.current?.measure((_x, _y, _w, h, _px, pageY) => {
        if (!Number.isFinite(h) || h <= 0) return;
        const bottom = pageY + h;
        const keyboardTop = typeof screenY === 'number' && screenY > 0 ? screenY : bottom - height;
        setKeyboardOverlap(Math.max(0, Math.round(bottom - keyboardTop)));
      });
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardOverlap(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const appendMessage = (message: CoachChatMessage): boolean => commit([{ kind: 'coachChatAppend', message }]);

  // `coachChatAppend` drops anything at or below the clear watermark, so a device clock behind
  // the synced `chatClearedAt` (server or Web-set) must still produce a newer instant (L-010).
  const nextStamp = () => Math.max(Date.now(), clearedAt + 1);

  const publish = (gen: number) => {
    if (chatGenRef.current !== gen || !mountedRef.current) return;
    const acc = liveRef.current;
    if (!acc) return;
    setLive(snapshotOf(acc));
  };

  // The generation guard is the caller's job: this only writes a message the user can see.
  const persistAssistant = (nodes: CoachGenUINode[], text: string) => {
    if (!nodes.length && !text.trim()) return;
    // A proposal accepted while it was still streaming never reached `messageId + nodeId`
    // marking, so carry the accepted node ids into the persisted message here.
    const applied = appliedRef.current;
    const marked = nodes.map(node => (
      node.type === 'proposal_action' && applied.has(node.id)
        ? { ...node, applied: true } as CoachGenUINode
        : node
    ));
    if (!appendMessage(coachMessage(marked, text, nextStamp()))) {
      setNotice('本机保存失败，这条回复没有写入。请检查可用存储空间。');
    }
  };

  const finishRun = (ctl: AbortController) => {
    if (ctlRef.current === ctl) ctlRef.current = null;
    runningRef.current = false;
    liveRef.current = null;
    if (mountedRef.current) setLive(null);
  };

  const friendlyError = (error: unknown): string => {
    if (!isCoachStreamError(error)) return '教练暂时不可用，请稍后重试。';
    if (error.code === 'unauthorized') return '配对已失效，请在设置里重新扫码配对。';
    if (error.code === 'turn_limit' || error.status === 429) return LIMIT_TEXT;
    if (error.code === 'network') return '网络连接失败，请检查网络后重试。';
    if (error.code === 'genui_unavailable' || error.status === 404 || error.status === 503) {
      return '服务器的 AI 教练未开启或流式服务不可用，请稍后重试。';
    }
    return '教练这次没有成功回答，请重试。';
  };

  /** The finished nodes, preferring the RUN_FINISHED payload over the live accumulation. */
  const finalNodesOf = (result: CoachStreamResult, acc: Accumulator): CoachGenUINode[] => {
    const fromResult = normalizeNodes(result.nodes);
    if (fromResult.length) return fromResult;
    if (acc.nodes.length) return acc.nodes;
    return normalizeNodes(result.blocks);
  };

  const runTurn = async ({ text, formSubmission, history, appendUser }: TurnInput) => {
    if (!connection) {
      setErrorText('还没有配对服务器，AI 教练需要连接你的服务器后才能使用。');
      return;
    }
    if (runningRef.current) return;
    if (appendUser && turnLimitReached) return;

    const gen = chatGenRef.current;
    const priorHistory = history ?? buildGenUIHistory(chat, clearedAt);
    if (appendUser && !appendMessage(userMessage(text, nextStamp(), formSubmission))) {
      setNotice('本机保存失败，这条消息没有写入。请检查可用存储空间。');
      return;
    }

    runningRef.current = true;
    setFailure(null);
    setErrorText('');
    setNotice('');
    setLimitHit(false);
    const acc = emptyAccumulator();
    liveRef.current = acc;
    const ctl = new AbortController();
    ctlRef.current = ctl;

    const onEvent = (event: CoachStreamEvent) => {
      if (chatGenRef.current !== gen) return;
      switch (event.type) {
        case 'RUN_STARTED':
          if (draftRef.current === text && mountedRef.current) {
            draftRef.current = '';
            setDraft('');
          }
          break;
        case 'STEP_STARTED': {
          const stepName = typeof event.stepName === 'string' && event.stepName ? event.stepName : 'step';
          const step: CoachStreamStep = {
            stepName,
            label: typeof event.label === 'string' && event.label ? event.label : stepName,
            done: false,
          };
          const at = acc.steps.findIndex(item => item.stepName === stepName);
          acc.steps = at >= 0
            ? acc.steps.map((item, index) => (index === at ? step : item))
            : [...acc.steps, step];
          break;
        }
        case 'STEP_FINISHED': {
          const stepName = typeof event.stepName === 'string' ? event.stepName : '';
          acc.steps = acc.steps.map(step => (step.stepName === stepName ? { ...step, done: true } : step));
          break;
        }
        case 'TOOL_CALL_START': {
          acc.activeTool = typeof event.toolCallName === 'string' && event.toolCallName
            ? event.toolCallName
            : 'tool';
          acc.completedTool = null;
          const args = event.args;
          acc.toolQuery = args && typeof args.query === 'string' && args.query ? args.query : null;
          break;
        }
        case 'TOOL_CALL_RESULT':
          // A local catalogue lookup returns in the same millisecond as its start, so clearing
          // here would never paint the status. Keep the finished call on the bar for this run.
          if (acc.activeTool === 'search_catalogue') acc.completedTool = acc.activeTool;
          acc.activeTool = null;
          break;
        case 'TEXT_MESSAGE_CONTENT': {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          acc.text += delta;
          acc.nodes = setProseText(acc.nodes, 'prose_0', acc.text);
          break;
        }
        case 'CUSTOM': {
          const name = typeof event.name === 'string' ? event.name : '';
          const value = event.value ?? {};
          if (name === 'genui.prose_delta') {
            const nodeId = typeof value.nodeId === 'string' && value.nodeId ? value.nodeId : 'prose_0';
            const delta = typeof value.delta === 'string' ? value.delta : '';
            acc.nodes = appendProse(acc.nodes, nodeId, delta, proseTone(value.tone));
          } else if (name === 'genui.node_pending') {
            acc.pendingNode = {
              nodeType: typeof value.nodeType === 'string' && value.nodeType ? value.nodeType : 'prose',
            };
          } else if (name === 'genui.node_commit') {
            const node = normalizeNode(value.node, acc.nodes.length);
            if (node) {
              acc.nodes = upsertNode(acc.nodes, node, true);
              acc.blocks = upsertNode(acc.blocks, node, true);
              acc.pendingNode = null;
            }
          } else if (name === 'genui.node_drop') {
            acc.pendingNode = null;
          } else if (name === 'genui.block_upsert') {
            const node = normalizeNode(value.block, acc.nodes.length);
            if (node) {
              acc.blocks = upsertNode(acc.blocks, node, false);
              acc.nodes = upsertNode(acc.nodes, node, false);
            }
          }
          break;
        }
        case 'RUN_ERROR':
          acc.error = typeof event.message === 'string' && event.message
            ? event.message
            : '服务器在回答过程中出错了。';
          break;
        default:
          break;
      }
      publish(gen);
    };

    try {
      const result = await streamCoachGenUI({
        connection: { server: connection.server, token: connection.token },
        text,
        ...(formSubmission ? { formSubmission } : {}),
        history: priorHistory,
        plan: { routines: profile.routines ?? [], week: profile.week ?? {} },
        lang,
        today: localDate(Date.now()),
        signal: ctl.signal,
        onEvent,
      });
      if (chatGenRef.current !== gen) return;
      const nodes = finalNodesOf(result, acc);
      const answer = String(result.text || acc.text || '');
      persistAssistant(nodes, answer);
    } catch (error) {
      if (chatGenRef.current !== gen) return;
      const aborted = ctl.signal.aborted
        || (isCoachStreamError(error) && error.code === 'aborted')
        || (error instanceof Error && error.name === 'AbortError');
      if (aborted) {
        // A user stop keeps whatever already arrived, exactly like the Web composer.
        persistAssistant(acc.nodes, acc.text);
        return;
      }
      if (isCoachStreamError(error) && (error.code === 'turn_limit' || error.status === 429)) {
        setLimitHit(true);
        return;
      }
      const partial = acc.nodes.length > 0 || acc.text.trim() !== '';
      if (partial) persistAssistant(acc.nodes, acc.text);
      setErrorText(friendlyError(error));
      // The composer keeps its draft (cleared only on RUN_STARTED), and 重试 replays this turn
      // with the history captured before the user line, so nothing is counted twice.
      setFailure({ text, ...(formSubmission ? { formSubmission } : {}), history: priorHistory });
    } finally {
      finishRun(ctl);
    }
  };

  const startSend = (text: string, formSubmission?: Record<string, unknown>) => {
    const message = text.trim();
    if (!message || runningRef.current || turnLimitReached) return;
    runTurn({ text: message, ...(formSubmission ? { formSubmission } : {}), appendUser: true })
      .catch(() => undefined);
  };

  const retry = () => {
    if (!failure || runningRef.current) return;
    runTurn({
      text: failure.text,
      ...(failure.formSubmission ? { formSubmission: failure.formSubmission } : {}),
      history: failure.history,
      appendUser: false,
    }).catch(() => undefined);
  };

  const stopStream = () => {
    ctlRef.current?.abort();
  };

  const startNewChat = () => {
    chatGenRef.current += 1;
    ctlRef.current?.abort();
    ctlRef.current = null;
    liveRef.current = null;
    runningRef.current = false;
    setLive(null);
    setFailure(null);
    setErrorText('');
    setNotice('');
    setLimitHit(false);
    setSubmittedForms(new Set());
    setAppliedProposals(new Set());
    appliedRef.current = new Set();
    draftRef.current = '';
    setDraft('');
    commit([{ kind: 'coachChatClear', at: Date.now() }]);
  };

  const revertLastChanges = () => {
    if (!canRevertCoach(profile)) {
      setNotice('没有可以撤销的教练更改。');
      return;
    }
    if (!commit([{ kind: 'coachRevertLast', at: Date.now() }])) {
      setNotice('撤销失败，本机保存出错。');
      return;
    }
    setNotice('已撤销教练上次的更改。');
    appendMessage({
      id: randomUUID(),
      role: 'coach',
      kind: 'reverted',
      at: nextStamp(),
      text: '已撤销教练上次的更改，计划恢复到改动之前。',
    });
  };

  const applyProposal = (
    changes: CoachProposalChange[],
    node: CoachProposalActionNode,
    messageId: string,
  ) => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplyingId(node.id);
    const meta: CoachApplyMeta = {
      proposalId: node.id,
      messageId,
      nodeId: node.id,
      label: node.title,
      ...(node.summary ? { summary: node.summary } : {}),
    };
    const preview = applyCoachProposal(profile, changes, meta);
    if (preview.applied > 0) {
      const saved = commit([{ kind: 'coachApplyProposal', changes, meta }]);
      if (saved) {
        const next = new Set(appliedRef.current).add(node.id);
        appliedRef.current = next;
        setAppliedProposals(next);
        setNotice(`已应用 ${preview.applied} 项更改，可在右上角菜单撤销。`);
      } else {
        setNotice('本机保存失败，请检查可用存储空间后重试。');
      }
    } else {
      setNotice('这些更改已经过期或与当前计划不符，无法应用。');
    }
    applyingRef.current = false;
    setApplyingId(null);
  };

  const applyAlternative = (
    item: CoachAlternativeItem,
    node: CoachExerciseAlternativesNode,
    messageId: string,
  ) => {
    const routineId = node.routineId ?? item.routineId;
    const forExId = node.forExId;
    if (!routineId || !forExId) {
      setNotice('这条替换建议缺少目标动作，暂时无法自动应用。');
      return;
    }
    if (applyingRef.current) return;
    applyingRef.current = true;
    const change: CoachProposalChange = {
      id: `alt_${node.id}_${item.exId}`,
      type: 'swap-exercise',
      target: { routineId, exId: forExId },
      after: { id: item.exId },
      ...(item.reason ? { why: item.reason } : {}),
    };
    const summary = `把「${resolveExerciseName(forExId, profile)}」替换为「${resolveExerciseName(item.exId, profile)}」`;
    const meta: CoachApplyMeta = {
      proposalId: node.id,
      messageId,
      nodeId: node.id,
      label: summary,
      summary,
    };
    const preview = applyCoachProposal(profile, [change], meta);
    if (preview.applied > 0) {
      const saved = commit([{ kind: 'coachApplyProposal', changes: [change], meta }]);
      setNotice(saved ? `${summary}，可在右上角菜单撤销。` : '本机保存失败，请稍后重试。');
    } else {
      setNotice('这条替换已经无法应用，计划可能已经变化。');
    }
    applyingRef.current = false;
  };

  const submitForm = (submission: CoachFormSubmission, node: CoachQuickFormNode, messageId: string) => {
    if (turnLimitReached || runningRef.current) return;
    const key = `${messageId}:${node.id}`;
    setSubmittedForms(previous => new Set(previous).add(key));
    startSend(submission.summaryText, { formId: submission.formId, values: submission.values });
  };

  const improveRoutine = (name?: string) => {
    const line = name
      ? `只针对「${name}」这套计划给我改进建议：动作选择、顺序、组数次数、渐进方式，其他计划先不动。`
      : '帮我改进现有的训练计划。';
    startSend(line);
  };

  const openImprove = () => {
    if (routines.length > 1) {
      setRoutineMenu(true);
      return;
    }
    improveRoutine(routines[0]?.name);
  };

  const markState = (nodes: readonly CoachGenUINode[], messageId: string): CoachGenUINode[] =>
    nodes.map(node => {
      if (node.type === 'quick_form' && submittedForms.has(`${messageId}:${node.id}`)) {
        return { ...node, submitted: true } as CoachGenUINode;
      }
      if (node.type === 'proposal_action' && appliedProposals.has(node.id)) {
        return { ...node, applied: true } as CoachGenUINode;
      }
      return node;
    });

  const menuItems: ActionItem[] = [
    { label: '新对话', icon: 'plusCircle', onPress: startNewChat },
    ...(canRevertCoach(profile)
      ? [{ label: '撤销教练上次的更改', icon: 'reset' as const, onPress: revertLastChanges }]
      : []),
    { label: 'Agent 设置', icon: 'gear', onPress: onOpenAgent },
  ];

  const routineItems: ActionItem[] = routines.map(routine => ({
    label: routine.name,
    icon: 'wrench',
    onPress: () => improveRoutine(routine.name),
  }));

  const header = (
    <Header
      onBack={onBack}
      right={(
        <IconButton
          accessibilityLabel="更多操作"
          name="more"
          onPress={() => setMenuOpen(true)}
          testID="coach-menu"
        />
      )}
      subtitle={live ? '正在回答…' : turnLimitReached ? '本轮对话已达上限' : '随时为你分析训练'}
      title="AI 教练"
    />
  );

  if (!connection) {
    return (
      <Screen scroll={false} testID="coach-chat-screen">
        <View style={[styles.fill, { padding: theme.layout.pagePadding }]}>
          {header}
          <EmptyState
            icon="sparkles"
            text="AI 教练需要连接你的自托管服务器，才能读取训练记录并同步对话。"
            title="先完成配对"
          >
            <Button onPress={onOpenPair} variant="primary">
              去扫码配对
            </Button>
            <Button onPress={onOpenAgent} variant="secondary">
              Agent 设置
            </Button>
          </EmptyState>
        </View>
        <ActionSheet items={menuItems} onClose={() => setMenuOpen(false)} title="AI 教练" visible={menuOpen} />
      </Screen>
    );
  }

  const bottomSpace = Platform.OS === 'android' && keyboardOverlap > 0
    ? keyboardOverlap
    : Math.max(insets.bottom, theme.space.sm);

  return (
    <Screen edges={['top', 'left', 'right']} scroll={false} testID="coach-chat-screen">
      <View ref={bodyRef} style={styles.fill}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.fill}
        >
          <View style={{ paddingHorizontal: theme.layout.pagePadding }}>{header}</View>

          <ScrollView
            contentContainerStyle={[styles.messageList, {
              paddingHorizontal: theme.layout.pagePadding,
              paddingBottom: theme.space.lg,
              gap: theme.layout.cardGap,
            }]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            ref={scrollRef}
            style={styles.fill}
          >
            <Card style={[styles.coachBubble, { maxWidth: '92%', marginBottom: 0 }]}>
              <Text tone="secondary" variant="subhead">
                {WELCOME_TEXT}
              </Text>
            </Card>

            {chat.map(message => {
              if (message.role === 'user') {
                return (
                  <Card
                    key={message.id}
                    style={[styles.userBubble, {
                      maxWidth: '88%',
                      marginBottom: 0,
                      backgroundColor: theme.colors.accentSoft,
                    }]}
                  >
                    <Text variant="body">{message.text ?? ''}</Text>
                  </Card>
                );
              }
              const stored = message.nodes ?? message.blocks ?? [];
              const nodes: CoachGenUINode[] = stored.length
                ? stored
                : message.text
                  ? [{ id: 'prose_0', type: 'prose', text: message.text }]
                  : [];
              if (message.kind === 'genui' || nodes.length > 0) {
                return (
                  <GenUIBriefing
                    applyingProposalId={applyingId}
                    key={message.id}
                    messageId={message.id}
                    nodes={markState(nodes, message.id)}
                    onApplyAlternative={(item, node) => applyAlternative(item, node, message.id)}
                    onApplyProposal={(changes, node) => applyProposal(changes, node, message.id)}
                    onSubmitForm={(submission, node) => submitForm(submission, node, message.id)}
                    profile={profile}
                    server={connection?.server ?? null}
                  />
                );
              }
              return (
                <Card key={message.id} style={[styles.coachBubble, { maxWidth: '92%', marginBottom: 0 }]}>
                  <Text tone={message.kind === 'error' ? 'danger' : 'label'} variant="body">
                    {message.text ?? ''}
                  </Text>
                </Card>
              );
            })}

            {live ? (
              <View style={{ gap: theme.space.md }}>
                <StreamStepsBar
                  activeTool={live.activeTool}
                  completedTool={live.completedTool}
                  onStop={stopStream}
                  steps={live.steps}
                  streaming={live.active}
                  toolQuery={live.toolQuery}
                />
                {live.nodes.length > 0 || live.pendingNode ? (
                  <GenUIBriefing
                    applyingProposalId={applyingId}
                    messageId="live"
                    nodes={markState(live.nodes, 'live')}
                    onApplyAlternative={(item, node) => applyAlternative(item, node, 'live')}
                    onApplyProposal={(changes, node) => applyProposal(changes, node, 'live')}
                    onSubmitForm={(submission, node) => submitForm(submission, node, 'live')}
                    pendingNode={live.pendingNode}
                    profile={profile}
                    server={connection?.server ?? null}
                    streaming={live.active}
                  />
                ) : null}
                {live.error ? (
                  <Card style={[styles.coachBubble, { maxWidth: '92%', marginBottom: 0 }]}>
                    <Text tone="danger" variant="subhead">
                      {live.error}
                    </Text>
                  </Card>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          <View
            style={[{
              backgroundColor: theme.colors.bg,
              borderTopColor: theme.colors.sep,
              borderTopWidth: theme.sizes.hairline,
              paddingTop: theme.space.sm,
              paddingBottom: bottomSpace,
              gap: theme.space.sm,
            }]}
          >
            {notice ? (
              <View style={{ paddingHorizontal: theme.layout.pagePadding }}>
                <Card style={{ backgroundColor: theme.colors.surface2, marginBottom: 0 }}>
                  <Text tone="secondary" variant="footnote">
                    {notice}
                  </Text>
                </Card>
              </View>
            ) : null}

            {errorText ? (
              <View style={{ paddingHorizontal: theme.layout.pagePadding }}>
                <Card style={{ backgroundColor: theme.colors.surface2, marginBottom: 0 }}>
                  <Text tone="danger" variant="footnote">
                    {errorText}
                  </Text>
                  {failure ? (
                    <Button onPress={retry} size="sm" variant="secondary">
                      重试
                    </Button>
                  ) : null}
                </Card>
              </View>
            ) : null}

            {turnLimitReached ? (
              <View style={{ paddingHorizontal: theme.layout.pagePadding }}>
                <Card style={{ backgroundColor: theme.colors.surface2, marginBottom: 0 }}>
                  <View style={[styles.row, { gap: theme.space.sm }]}>
                    <Badge tone="orange">已达上限</Badge>
                    <Text style={styles.grow} tone="secondary" variant="footnote">
                      {LIMIT_TEXT}
                    </Text>
                  </View>
                  <Button onPress={startNewChat} variant="primary">
                    开始新对话
                  </Button>
                </Card>
              </View>
            ) : null}

            <ScrollView
              contentContainerStyle={{ gap: theme.space.sm, paddingHorizontal: theme.layout.pagePadding }}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
            >
              <Chip icon="sparkles" onPress={() => startSend('帮我看看最近的训练，告诉我会改什么。')}>
                检查我的训练
              </Chip>
              <Chip
                icon="checkCircle"
                onPress={() => startSend(lastWorkout?.name
                  ? `我上次的「${lastWorkout.name}」训练怎么样？`
                  : '我上次训练怎么样？')}
              >
                上次训练
              </Chip>
              {routines.length > 0 ? (
                <Chip icon="wrench" onPress={openImprove}>
                  改进一个计划
                </Chip>
              ) : null}
              {userTurns > 0 && !turnLimitReached ? (
                <Chip icon="plusCircle" onPress={startNewChat}>
                  新对话
                </Chip>
              ) : null}
            </ScrollView>

            <View style={[styles.row, {
              alignItems: 'flex-end',
              gap: theme.space.sm,
              paddingHorizontal: theme.layout.pagePadding,
            }]}
            >
              <TextField
                containerStyle={styles.grow}
                hideLabel
                key="coach-composer-input"
                label="消息"
                maxLength={MAX_DRAFT}
                onChangeText={value => {
                  draftRef.current = value;
                  setDraft(value);
                }}
                onSubmitEditing={() => startSend(draft)}
                placeholder={runningRef.current ? '教练正在回答…' : '给教练发消息…'}
                returnKeyType="send"
                testID="coach-composer"
                value={draft}
              />
              <Button
                accessibilityLabel="发送"
                disabled={!draft.trim() || turnLimitReached || live !== null}
                icon="arrowUp"
                onPress={() => startSend(draft)}
                size="md"
                style={{ alignSelf: 'flex-end', minHeight: theme.sizes.touch }}
                testID="coach-send"
                variant="primary"
              >
                发送
              </Button>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>

      <ActionSheet items={menuItems} onClose={() => setMenuOpen(false)} title="AI 教练" visible={menuOpen} />
      <ActionSheet
        items={routineItems}
        onClose={() => setRoutineMenu(false)}
        title="改进哪套计划？"
        visible={routineMenu}
      />
    </Screen>
  );
}
