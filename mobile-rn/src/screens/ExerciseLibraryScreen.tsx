import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { isFav } from '../../../frontend/src/lib/favourites.js';
import { logExerciseSearchMedia, safeExerciseSearchError } from '../../../api/agent-runtime/exercise-search-diagnostics.js';
import type { ExerciseSearchMediaMetrics } from '../../../api/agent-runtime/exercise-search-diagnostics.js';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Header,
  IconButton,
  IconTile,
  ListRow,
  MediaThumb,
  Screen,
  SearchField,
  SectionHeader,
  Sheet,
  Text,
  TextField,
  useTheme,
} from '../design';
import {
  BODY_PARTS,
  CATALOGUE_COUNT,
  EQUIPMENT_OPTIONS,
  SEARCH_LIMIT,
  TARGET_MUSCLES,
  bodyPartName,
  catalogueExercise,
  equipmentName,
  targetMuscleName,
} from '../catalogue';
import { createFuseSuggestionIndex } from '../fuseSuggestionIndex';
import { createLibrarySearch } from '../librarySearch';
import type { LibraryExercise } from '../librarySearch';
import type { Connection } from '../server';
import type { LocalState } from '../storage';
import type { CustomExercise, Profile, RoutineExercise } from '../training';
import {
  AiSearchController,
  aiErrorMessage,
  clearAiRunReference,
  createLocalRuntime,
  createServerAgent,
  exerciseOf,
  latestAiRunReference,
  matchAiSearch,
  normalizeAiImage,
  structuredOf,
} from '../agent';
import type {
  AgentAiImageInput, AgentAiImageRow, AgentLaunch, AgentProfileSummary, AgentRunRow, AiClarificationChip,
  AiRunRecovery, AiSearchFallback, AiSearchItem,
} from '../agent';
import type { AiTurnDiagnostics, AiTurnEnd } from '../agent/ai-search';
import { ExerciseDetailScreen } from './ExerciseDetailScreen';

export type ExerciseLibraryScreenProps = {
  profile: Profile;
  server: string | null;
  connection?: Connection | null;
  onPick: (exercise: RoutineExercise) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onFavorite: (id: string, favourite: boolean) => void;
  /** Shown as a back button when the library is used as a full-screen picker. */
  onBack?: () => void;
  /** Rows open details and only the plus or detail button replaces the workout exercise. */
  replacing?: boolean;
  /** Lets the host close the detail layer before the picker itself. */
  registerClose?: (close: (() => void) | null) => void;
  /** Opens AgentProfileScreen when no model configuration is available. */
  onOpenAgentProfiles?: () => void;
};

type FixtureCase = 'candidates' | 'fallback-only' | 'error';

type AiSnapshot = {
  query: string;
  bodyPart: string | null;
  equipment: string | null;
  targetMuscle: string | null;
  oneLimb: boolean;
  favouritesOnly: boolean;
};

type AiView = {
  controller: AiSearchController;
  status: 'running' | 'ready' | 'error';
  latestText: string;
  latestImage: AgentAiImageRow | null;
  items: AiSearchItem[];
  fallback: AiSearchFallback | null;
  clarifications: AiClarificationChip[];
  error: { code?: string; message: string } | null;
  fallbackOpen: boolean;
  cancelled: boolean;
  summary: AgentProfileSummary;
  fixtureCase: FixtureCase;
  previous: {
    latestText: string;
    latestImage: AgentAiImageRow | null;
    items: AiSearchItem[];
    fallback: AiSearchFallback | null;
    clarifications: AiClarificationChip[];
  } | null;
};

function errorCodeOf(failure: unknown): { code?: string; message: string } {
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = String((failure as { code?: unknown }).code || '');
    return {
      ...(code ? { code } : {}),
      message: failure instanceof Error ? failure.message : '检索失败，请重试。',
    };
  }
  return { message: failure instanceof Error ? failure.message : '检索失败，请重试。' };
}

/** One `media` stage event for an image pick; the caller measures the elapsed time. */
function logAiMedia(mediaAttemptId: string, metrics: ExerciseSearchMediaMetrics): void {
  logExerciseSearchMedia({
    mediaAttemptId,
    source: 'rn',
    enabled: process.env.EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS === '1',
    metrics,
  });
}

/** The client's own end event for a terminal run its poll observed. */
function runEndOf(run: AgentRunRow): AiTurnEnd {
  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'interrupted') {
    return { status: run.status, phase: 'poll' };
  }
  return { status: 'failed', phase: 'poll', errorCode: safeExerciseSearchError(run.error?.code) };
}

function levelText(level: AiSearchItem['level']): string {
  if (level === 'high') return '高';
  if (level === 'medium') return '中';
  return '低';
}

type CatalogueExercise = {
  id: string;
  name: string;
  bodyPart: string;
  equipment: string;
  cardio: boolean;
};

type Row =
  | { kind: 'custom'; exercise: CustomExercise }
  | { kind: 'catalogue'; exercise: CatalogueExercise };

function rowOf(item: LibraryExercise): Row | null {
  if (item.custom) {
    return item.customExercise ? { kind: 'custom', exercise: item.customExercise } : null;
  }
  return {
    kind: 'catalogue',
    exercise: {
      id: item.id,
      name: item.name,
      bodyPart: item.bodyPart,
      equipment: item.equipment,
      cardio: item.cardio,
    },
  };
}

function subtitleOf(bodyPart?: string, equipment?: string) {
  const parts: string[] = [];
  if (bodyPart) parts.push(bodyPartName(bodyPart));
  if (equipment) parts.push(equipmentName(equipment));
  return parts.length > 0 ? parts.join(' · ') : '自建动作';
}

function customName(exercise: CustomExercise) {
  return exercise.n ?? exercise.name ?? exercise.id;
}

export function ExerciseLibraryScreen({
  profile,
  server,
  connection = null,
  onPick,
  onCustom,
  onFavorite,
  onBack,
  replacing = false,
  registerClose,
  onOpenAgentProfiles,
}: ExerciseLibraryScreenProps) {
  const theme = useTheme();
  const submittedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [bodyPart, setBodyPart] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<string | null>(null);
  const [targetMuscle, setTargetMuscle] = useState<string | null>(null);
  const [oneLimb, setOneLimb] = useState(false);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [limit, setLimit] = useState(SEARCH_LIMIT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editing, setEditing] = useState<CustomExercise | null>(null);
  const [customNameValue, setCustomNameValue] = useState('');
  const [detail, setDetail] = useState<{ id: string; custom: boolean } | null>(null);

  // AI recognition state. The launch panel, the active session and the
  // follow-up composer are separate so a running follow-up never resets the
  // summary card or the previous candidates.
  const [ai, setAi] = useState<AiView | null>(null);
  const [aiNeedsConfig, setAiNeedsConfig] = useState(false);
  const [aiRecovery, setAiRecovery] = useState<AiRunRecovery | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [aiLaunch, setAiLaunch] = useState<AgentLaunch | null>(null);
  const [aiFixtureCase, setAiFixtureCase] = useState<FixtureCase>('candidates');
  const [aiSheetText, setAiSheetText] = useState('');
  const [aiDraftImage, setAiDraftImage] = useState<AgentAiImageInput | null>(null);
  const [aiImageNotice, setAiImageNotice] = useState('');
  const [aiSheetError, setAiSheetError] = useState<{ code?: string; message: string } | null>(null);
  const [aiPickerBusy, setAiPickerBusy] = useState(false);
  const [aiFollowUpText, setAiFollowUpText] = useState('');
  const [aiFollowUpImage, setAiFollowUpImage] = useState<AgentAiImageInput | null>(null);
  const [aiFollowUpSheet, setAiFollowUpSheet] = useState(false);
  const [aiFollowUpError, setAiFollowUpError] = useState<{ code?: string; message: string } | null>(null);
  const aiSnapshotRef = useRef<AiSnapshot | null>(null);
  const aiRef = useRef<AiView | null>(null);
  const aiSeqRef = useRef(0);
  const aiPollAbortRef = useRef<AbortController | null>(null);
  // The latest pick's media attempt association lives in screen memory only:
  // the submit event joins the media log through it, and it never reaches
  // SQLite or the image rows.
  const aiSheetMediaRef = useRef<{ imageId: string; attemptId: string } | null>(null);
  const aiFollowUpMediaRef = useRef<{ imageId: string; attemptId: string } | null>(null);
  aiRef.current = ai;

  const term = query.trim();
  const favouriteCount = Array.isArray(profile.favEx) ? profile.favEx.length : 0;
  const workspaceKey = connection ? `${connection.server}|${connection.user.id}` : 'practice';
  const agentData = useMemo<LocalState>(() => ({ profile, draft: null, queue: [] }), [profile]);
  const localAgent = useMemo(() => createLocalRuntime(connection, agentData), [connection, agentData]);
  const serverAgent = useMemo(() => (connection ? createServerAgent(connection) : null), [connection]);
  const agentRemote = useMemo(
    () => (serverAgent
      ? { profiles: () => serverAgent.profiles(), status: () => serverAgent.status() }
      : null),
    [serverAgent],
  );

  // A new search, filter or workspace starts the visible selection fresh; media
  // from the previous account/server must never stay on screen.
  useEffect(() => {
    setLimit(SEARCH_LIMIT);
    setDetail(null);
  }, [query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly]);

  useEffect(() => {
    aiSeqRef.current += 1;
    aiPollAbortRef.current?.abort();
    aiPollAbortRef.current = null;
    const leaving = aiRef.current;
    if (leaving) leaving.controller.dispose().catch(() => undefined);
    setAi(null);
    setAiNeedsConfig(false);
    setAiSheetOpen(false);
    setAiLaunch(null);
    setAiFixtureCase('candidates');
    setAiSheetText('');
    setAiDraftImage(null);
    setAiImageNotice('');
    setAiSheetError(null);
    setAiFollowUpText('');
    setAiFollowUpImage(null);
    setAiFollowUpSheet(false);
    aiSnapshotRef.current = null;
    aiSheetMediaRef.current = null;
    aiFollowUpMediaRef.current = null;
    setDetail(null);
    setFiltersOpen(false);
    setEditing(null);
    setCustomNameValue('');
    setQuery('');
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  }, [workspaceKey]);

  useEffect(() => {
    try {
      const reference = latestAiRunReference(connection);
      setAiRecovery(reference?.needsAttention ? reference : null);
    } catch {
      setAiRecovery(null);
    }
  }, [connection, workspaceKey]);

  useEffect(() => () => {
    aiSeqRef.current += 1;
    aiPollAbortRef.current?.abort();
    const leaving = aiRef.current;
    if (leaving) leaving.controller.dispose().catch(() => undefined);
  }, []);

  // The picker sits in an app-level Modal, whose back handling must close the
  // detail layer first instead of dismissing the whole picker.
  useEffect(() => {
    if (!registerClose || !replacing || !detail) return;
    registerClose(() => setDetail(null));
    return () => registerClose(null);
  }, [detail, registerClose, replacing]);

  const librarySearch = useMemo(
    () => createLibrarySearch(profile, createFuseSuggestionIndex),
    [profile],
  );
  const result = useMemo(
    () => librarySearch.search(query, {
      bodyPart,
      equipment,
      targetMuscle,
      oneLimb,
      favouritesOnly,
    }, limit),
    [librarySearch, query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly, limit],
  );

  const rows = useMemo<Row[]>(
    () => result.items.map(rowOf).filter((row): row is Row => row !== null),
    [result.items],
  );
  const suggestionRows = useMemo<Row[]>(
    () => result.suggestions.map(rowOf).filter((row): row is Row => row !== null),
    [result.suggestions],
  );

  function resolveLaunchFor(
    requireImage: boolean,
    prefer?: { location: 'local' | 'server'; profileId?: string },
  ): Promise<AgentLaunch> {
    return localAgent.config.resolveLaunch(localAgent.scope, {
      connection,
      remote: agentRemote,
      requireImage,
      ...(prefer ? { prefer } : {}),
    });
  }

  function resetAiSheetDraft(): void {
    setAiDraftImage(null);
    setAiSheetText('');
    setAiImageNotice('');
    setAiSheetError(null);
  }

  async function openAiSheet(): Promise<void> {
    setAiImageNotice('');
    setAiSheetError(null);
    const current = aiRef.current;
    if (current) {
      // Re-opening ✨ cancels the running turn, keeps the previous candidates
      // and lets the user submit a new request in the same search session.
      aiSeqRef.current += 1;
      aiPollAbortRef.current?.abort();
      aiPollAbortRef.current = null;
      current.controller.cancelQuietly();
      setAi(view => {
        if (!view) return view;
        const before = view.previous;
        return {
          ...view,
          status: 'ready',
          cancelled: true,
          error: null,
          latestText: before?.latestText ?? view.latestText,
          latestImage: before?.latestImage ?? view.latestImage,
          items: before?.items ?? view.items,
          fallback: before?.fallback ?? view.fallback,
          clarifications: before?.clarifications ?? view.clarifications,
          previous: null,
        };
      });
      setAiSheetText(current.latestText);
      setAiLaunch(current.controller.launch);
      setAiFixtureCase(current.fixtureCase);
      setAiDraftImage(null);
      setAiSheetOpen(true);
      return;
    }
    setAiPickerBusy(true);
    try {
      const launch = await resolveLaunchFor(false);
      setAiLaunch(launch);
      setAiNeedsConfig(false);
      setAiSheetOpen(true);
    } catch {
      setAiNeedsConfig(true);
      setAiSheetOpen(false);
    } finally {
      setAiPickerBusy(false);
    }
  }

  /** The media attempt id of the latest pick that produced this image, if any. */
  function mediaAttemptOf(image: { id: string }): string | undefined {
    const sheet = aiSheetMediaRef.current;
    if (sheet && sheet.imageId === image.id) return sheet.attemptId;
    const followUp = aiFollowUpMediaRef.current;
    if (followUp && followUp.imageId === image.id) return followUp.attemptId;
    return undefined;
  }

  async function pickAiImage(source: 'camera' | 'library', target: 'sheet' | 'followup'): Promise<void> {
    if (target === 'sheet') setAiSheetError(null);
    else setAiFollowUpError(null);
    setAiPickerBusy(true);
    // One fresh attempt id per selection; the media event logs on its own trace
    // and the later submit event joins the two through this id.
    const mediaAttemptId = `media_${randomUUID()}`;
    const startedAt = Date.now();
    let mediaEnded = false;
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          mediaEnded = true;
          logAiMedia(mediaAttemptId, {
            status: 'failed',
            errorCode: 'permission_denied',
            elapsedMs: Date.now() - startedAt,
          });
          throw new Error('没有相机权限，请在系统设置中允许。');
        }
      }
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1, exif: true })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1, exif: true });
      if (result.canceled) {
        mediaEnded = true;
        logAiMedia(mediaAttemptId, { status: 'cancelled', elapsedMs: Date.now() - startedAt });
        return;
      }
      const asset = result.assets?.[0];
      if (!asset) throw new Error('没有读取到所选照片，请重试。');
      const image = await normalizeAiImage(asset, summary => {
        mediaEnded = true;
        logAiMedia(mediaAttemptId, {
          status: 'ready',
          ...(summary.inputBytes != null ? { inputBytes: summary.inputBytes } : {}),
          outputBytes: summary.outputBytes,
          outputWidth: summary.outputWidth,
          outputHeight: summary.outputHeight,
          attempts: summary.attempts,
          rotationApplied: summary.rotationApplied,
          elapsedMs: Date.now() - startedAt,
        });
      });
      if (target === 'sheet') {
        aiSheetMediaRef.current = { imageId: image.id, attemptId: mediaAttemptId };
        setAiImageNotice(aiDraftImage ? '已用新照片替换上一张。' : '已选择 1 张照片。');
        setAiDraftImage(image);
      } else {
        aiFollowUpMediaRef.current = { imageId: image.id, attemptId: mediaAttemptId };
        setAiFollowUpImage(image);
        setAiFollowUpSheet(false);
      }
    } catch (failure) {
      if (!mediaEnded) {
        logAiMedia(mediaAttemptId, {
          status: 'failed',
          errorCode: safeExerciseSearchError(errorCodeOf(failure).code),
          elapsedMs: Date.now() - startedAt,
        });
      }
      const error = errorCodeOf(failure);
      const message = aiErrorMessage(error.code, error.message);
      if (target === 'sheet') setAiSheetError({ ...error, message });
      else setAiFollowUpError({ ...error, message });
    } finally {
      setAiPickerBusy(false);
    }
  }

  async function runAiTurn(
    controller: AiSearchController,
    text: string,
    image?: AgentAiImageInput,
    fixtureCase?: FixtureCase,
    mediaAttemptId?: string,
  ): Promise<void> {
    const seq = aiSeqRef.current + 1;
    aiSeqRef.current = seq;
    aiPollAbortRef.current?.abort();
    const abort = new AbortController();
    aiPollAbortRef.current = abort;
    const current = aiRef.current;
    const previous = current
      ? {
        latestText: current.latestText,
        latestImage: current.latestImage,
        items: current.items,
        fallback: current.fallback,
        clarifications: current.clarifications,
      }
      : null;
    const trimmed = text.trim();
    setAi(view => {
      const base: AiView = view ?? {
        controller,
        status: 'running',
        latestText: '',
        latestImage: null,
        items: [],
        fallback: null,
        clarifications: [],
        error: null,
        fallbackOpen: false,
        cancelled: false,
        summary: controller.summary,
        fixtureCase: fixtureCase ?? 'candidates',
        previous: null,
      };
      return {
        ...base,
        controller,
        summary: controller.summary,
        status: 'running',
        error: null,
        cancelled: false,
        latestText: trimmed || base.latestText,
        fixtureCase: fixtureCase ?? base.fixtureCase,
        previous,
      };
    });
    // The completion, poll and late callbacks below record through the
    // diagnostics object this run started with, never through whatever run
    // happens to be current when they fire.
    let diagnostics: AiTurnDiagnostics | undefined;
    try {
      const started = await controller.startTurn({
        hintText: trimmed,
        ...(image ? { image } : {}),
        ...(fixtureCase ? { fixtureCase } : {}),
        ...(mediaAttemptId ? { mediaAttemptId } : {}),
      });
      diagnostics = started.diagnostics;
      if (aiSeqRef.current !== seq) {
        // A late start still ends its own trace: every path that invalidates
        // the sequence also cancels or disposes the run this turn started.
        diagnostics?.end({ status: 'cancelled', phase: 'submit' });
        return;
      }
      const latestImage = started.images[0] ?? null;
      setAi(view => (view ? { ...view, latestImage: latestImage ?? view.latestImage, summary: controller.summary } : view));
      const final = await controller.poll(started.run.runId, undefined, abort.signal);
      if (aiSeqRef.current !== seq) {
        // A late terminal result still ends its own trace; the newer turn owns the UI.
        diagnostics?.end(runEndOf(final));
        return;
      }
      if (final.status === 'completed') {
        const structured = structuredOf(final);
        if (structured == null) throw new Error('the model returned no structured result');
        const matched = matchAiSearch(
          librarySearch,
          structured,
          trimmed,
          diagnostics ? { emit: diagnostics.emit } : undefined,
        );
        diagnostics?.end({ status: 'completed', phase: 'match' });
        setAi(view => (view ? {
          ...view,
          status: 'ready',
          items: matched.items,
          fallback: matched.fallback,
          clarifications: matched.clarifications ?? [],
          error: null,
          cancelled: false,
          latestText: trimmed || view.latestText,
          latestImage: latestImage ?? view.latestImage,
          summary: controller.summary,
          previous: null,
        } : view));
        setAiFollowUpText(value => (value.trim() === trimmed ? '' : value));
        setAiFollowUpImage(null);
        setAiFollowUpError(null);
      } else if (final.status === 'cancelled') {
        diagnostics?.end({ status: 'cancelled', phase: 'poll' });
        setAi(view => {
          if (!view) return view;
          const before = view.previous;
          return {
            ...view,
            status: 'ready',
            error: null,
            cancelled: true,
            latestText: before?.latestText ?? view.latestText,
            latestImage: before?.latestImage ?? view.latestImage,
            items: before?.items ?? view.items,
            fallback: before?.fallback ?? view.fallback,
            clarifications: before?.clarifications ?? view.clarifications,
            previous: null,
          };
        });
      } else {
        const error = final.error ?? { code: 'model_unavailable', message: '检索失败，请重试。' };
        diagnostics?.end(runEndOf(final));
        setAi(view => (view ? {
          ...view,
          status: 'error',
          error,
          latestText: trimmed || view.latestText,
          latestImage: latestImage ?? view.latestImage,
          previous: null,
        } : view));
      }
    } catch (failure) {
      const error = errorCodeOf(failure);
      // A rejection still ends the trace of the run it belongs to: an aborted
      // signal (or a cancelled run) is a client-side cancel, the rest a failure.
      diagnostics?.end(
        abort.signal.aborted || error.code === 'run_cancelled'
          ? { status: 'cancelled', phase: 'poll' }
          : { status: 'failed', phase: 'poll', errorCode: safeExerciseSearchError(error.code) },
      );
      if (aiSeqRef.current !== seq) return;
      setAi(view => (view ? {
        ...view,
        status: 'error',
        error,
        latestText: trimmed || view.latestText,
        previous: null,
      } : view));
    } finally {
      if (aiSeqRef.current === seq) aiPollAbortRef.current = null;
    }
  }

  async function submitAiSheet(): Promise<void> {
    const text = aiSheetText.trim();
    if (!text && !aiDraftImage) return;
    setAiPickerBusy(true);
    setAiSheetError(null);
    setAiRecovery(null);
    try {
      const current = aiRef.current;
      if (current) {
        const launch = await resolveLaunchFor(!!aiDraftImage, {
          location: current.controller.location,
          profileId: current.controller.profile.id,
        });
        current.controller.retarget(launch);
        setAiSheetOpen(false);
        resetAiSheetDraft();
        await runAiTurn(
          current.controller,
          text,
          aiDraftImage ?? undefined,
          aiFixtureCase,
          aiDraftImage ? mediaAttemptOf(aiDraftImage) : undefined,
        );
        return;
      }
      const launch = await resolveLaunchFor(!!aiDraftImage);
      if (aiRecovery) await dismissAiRecovery();
      if (aiSnapshotRef.current === null) {
        aiSnapshotRef.current = { query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly };
      }
      const controller = new AiSearchController({
        connection,
        runtime: localAgent,
        server: serverAgent,
        launch,
      });
      setAiLaunch(launch);
      setAiNeedsConfig(false);
      setAiRecovery(null);
      setAiSheetOpen(false);
      resetAiSheetDraft();
      setQuery('');
      clearFilterChips();
      setFiltersOpen(false);
      await runAiTurn(
        controller,
        text,
        aiDraftImage ?? undefined,
        aiFixtureCase,
        aiDraftImage ? mediaAttemptOf(aiDraftImage) : undefined,
      );
    } catch (failure) {
      const error = errorCodeOf(failure);
      setAiSheetError({ ...error, message: aiErrorMessage(error.code, error.message) });
    } finally {
      setAiPickerBusy(false);
    }
  }

  function cancelAiTurn(): void {
    const current = aiRef.current;
    if (!current || current.status !== 'running') return;
    aiSeqRef.current += 1;
    aiPollAbortRef.current?.abort();
    aiPollAbortRef.current = null;
    current.controller.cancelQuietly();
    setAi(view => {
      if (!view) return view;
      const before = view.previous;
      return {
        ...view,
        status: 'ready',
        error: null,
        cancelled: true,
        latestText: before?.latestText ?? view.latestText,
        latestImage: before?.latestImage ?? view.latestImage,
        items: before?.items ?? view.items,
        fallback: before?.fallback ?? view.fallback,
        clarifications: before?.clarifications ?? view.clarifications,
        previous: null,
      };
    });
  }

  function retryAi(): void {
    const current = aiRef.current;
    if (!current || current.status === 'running' || !current.controller.canContinue) return;
    runAiTurn(current.controller, current.latestText, undefined, current.fixtureCase).catch(() => undefined);
  }

  function sendAiFollowUpText(text: string, image?: AgentAiImageInput, mediaAttemptId?: string): void {
    const current = aiRef.current;
    if (!current || current.status === 'running') return;
    if (!current.controller.canContinue) {
      setAi(view => (view ? { ...view, status: 'error', error: { code: 'turn_limit', message: 'follow-up limit' } } : view));
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && !image) return;
    runAiTurn(
      current.controller,
      trimmed,
      image,
      current.fixtureCase,
      mediaAttemptId,
    ).catch(() => undefined);
  }

  function sendAiFollowUp(): void {
    sendAiFollowUpText(
      aiFollowUpText,
      aiFollowUpImage ?? undefined,
      aiFollowUpImage ? mediaAttemptOf(aiFollowUpImage) : undefined,
    );
  }

  function exitAi(): void {
    aiSeqRef.current += 1;
    aiPollAbortRef.current?.abort();
    aiPollAbortRef.current = null;
    const current = aiRef.current;
    if (current) current.controller.dispose().catch(() => undefined);
    const snapshot = aiSnapshotRef.current;
    aiSnapshotRef.current = null;
    aiSheetMediaRef.current = null;
    aiFollowUpMediaRef.current = null;
    setAi(null);
    setAiRecovery(null);
    setAiFollowUpText('');
    setAiFollowUpImage(null);
    setAiFollowUpError(null);
    setAiFollowUpSheet(false);
    setAiSheetOpen(false);
    setAiLaunch(null);
    aiSheetReset();
    if (snapshot) {
      setQuery(snapshot.query);
      setBodyPart(snapshot.bodyPart);
      setEquipment(snapshot.equipment);
      setTargetMuscle(snapshot.targetMuscle);
      setOneLimb(snapshot.oneLimb);
      setFavouritesOnly(snapshot.favouritesOnly);
    }
  }

  function aiSheetReset(): void {
    setAiSheetText('');
    setAiDraftImage(null);
    setAiImageNotice('');
    setAiSheetError(null);
  }

  async function restartOnServer(): Promise<void> {
    const current = aiRef.current;
    const text = aiSheetText.trim() || aiFollowUpText.trim() || current?.latestText || '';
    const image = aiDraftImage ?? aiFollowUpImage ?? current?.latestImage ?? undefined;
    setAiPickerBusy(true);
    setAiSheetError(null);
    setAiRecovery(null);
    try {
      const launch = await resolveLaunchFor(true, { location: 'server' });
      if (aiSnapshotRef.current === null) {
        aiSnapshotRef.current = { query, bodyPart, equipment, targetMuscle, oneLimb, favouritesOnly };
      }
      aiSeqRef.current += 1;
      aiPollAbortRef.current?.abort();
      aiPollAbortRef.current = null;
      if (current) await current.controller.dispose();
      setAi(null);
      setAiFollowUpText('');
      setAiFollowUpImage(null);
      setAiFollowUpError(null);
      const controller = new AiSearchController({
        connection,
        runtime: localAgent,
        server: serverAgent,
        launch,
      });
      setAiLaunch(launch);
      setAiSheetOpen(false);
      setAiFollowUpSheet(false);
      aiSheetReset();
      // A retry builds a new trace but reuses the attempt id when the same
      // image is re-referenced.
      await runAiTurn(controller, text, image, aiFixtureCase, image ? mediaAttemptOf(image) : undefined);
    } catch (failure) {
      const error = errorCodeOf(failure);
      setAiSheetError({ ...error, message: aiErrorMessage(error.code, error.message) });
      setAiSheetOpen(true);
    } finally {
      setAiPickerBusy(false);
    }
  }

  function applyAiFallback(dimension: 'bodyPart' | 'equipment', value: string): void {
    aiSeqRef.current += 1;
    aiPollAbortRef.current?.abort();
    aiPollAbortRef.current = null;
    const current = aiRef.current;
    if (current) current.controller.dispose().catch(() => undefined);
    aiSnapshotRef.current = null;
    setAi(null);
    setAiRecovery(null);
    setAiFollowUpText('');
    setAiFollowUpImage(null);
    setAiFollowUpError(null);
    setAiSheetOpen(false);
    setQuery('');
    clearFilterChips();
    if (dimension === 'bodyPart') setBodyPart(value);
    else setEquipment(value);
    setDetail(null);
  }

  async function dismissAiRecovery(): Promise<void> {
    const reference = aiRecovery;
    setAiRecovery(null);
    try {
      if (reference?.needsAttention && reference.location === 'server' && serverAgent) {
        await serverAgent.cancelRun(reference.runId);
        if (reference.sessionId) await serverAgent.deleteSession(reference.sessionId);
      } else if (reference?.needsAttention && reference.run) {
        localAgent.cancel(reference.runId);
        if (reference.sessionId) localAgent.deleteSession(reference.sessionId);
      }
    } catch {
      // The old run may already be terminal; dismissing the notice still wins.
    }
    clearAiRunReference(connection, reference ? { runId: reference.runId } : undefined);
  }

  const narrowed = term !== '' || bodyPart !== null || equipment !== null
    || targetMuscle !== null || oneLimb || favouritesOnly;
  const activeFilters = (bodyPart ? 1 : 0) + (equipment ? 1 : 0)
    + (targetMuscle ? 1 : 0) + (oneLimb ? 1 : 0) + (favouritesOnly ? 1 : 0);
  const total = result.total;
  const subtitle = `${CATALOGUE_COUNT} 个动画动作 + ${(profile.customEx ?? []).filter(Boolean).length} 个自建`;
  const noFavourites = favouritesOnly && favouriteCount === 0;

  const clearFilters = () => {
    setQuery('');
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  };

  // The filter sheet clears the chips only; the search text lives outside it.
  const clearFilterChips = () => {
    setBodyPart(null);
    setEquipment(null);
    setTargetMuscle(null);
    setOneLimb(false);
    setFavouritesOnly(false);
  };

  const pickCatalogue = (exercise: CatalogueExercise) => {
    onPick({ id: exercise.id, mode: exercise.cardio ? 'cardio' : 'reps' });
  };

  const pickCustom = (exercise: CustomExercise) => {
    onPick({ id: exercise.id, mode: exercise.bp === 'cardio' ? 'cardio' : 'reps' });
  };

  // The row plus and the detail button share one submission per picker session.
  const submitPick = (id: string, custom: boolean) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const customExercise = custom
      ? (profile.customEx ?? []).find(exercise => exercise?.id === id)
      : undefined;
    const cardio = custom ? customExercise?.bp === 'cardio' : catalogueExercise(id)?.bp === 'cardio';
    onPick({ id, mode: cardio ? 'cardio' : 'reps' });
  };

  const startEdit = (exercise?: CustomExercise) => {
    setEditing(exercise ?? { id: '', bp: 'full body', eq: 'other' });
    setCustomNameValue(exercise ? customName(exercise) : '');
  };

  const closeEdit = () => {
    setEditing(null);
    setCustomNameValue('');
  };

  const saveCustom = () => {
    if (!editing) return;
    const name = customNameValue.trim();
    if (!name) return;
    onCustom({ ...editing, id: editing.id || `custom-${randomUUID()}`, n: name }, !editing.id);
    closeEdit();
  };

  function rowView(item: Row) {
    const exercise = item.exercise;
    const name = item.kind === 'custom' ? customName(item.exercise) : item.exercise.name;
    const favourite = isFav(profile, exercise.id) as boolean;
    const actions = (
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
        <IconButton
          accessibilityLabel={favourite ? `取消收藏 ${name}` : `收藏 ${name}`}
          name={favourite ? 'starFill' : 'star'}
          onPress={() => onFavorite(exercise.id, !favourite)}
          size="sm"
          testID={`library-fav-${exercise.id}`}
          tone={favourite ? 'accent' : 'neutral'}
        />
        {replacing ? (
          <IconButton
            accessibilityLabel={`选择替换动作 ${name}`}
            name="plus"
            onPress={() => submitPick(exercise.id, item.kind === 'custom')}
            size="sm"
          />
        ) : (
          <>
            <IconButton
              accessibilityLabel={`查看详情 ${name}`}
              name="info"
              onPress={() => setDetail({ id: exercise.id, custom: item.kind === 'custom' })}
              size="sm"
              testID={`library-detail-${exercise.id}`}
            />
            {item.kind === 'custom' ? (
              <IconButton
                accessibilityLabel={`编辑 ${name}`}
                name="pencil"
                onPress={() => startEdit(item.exercise)}
                size="sm"
              />
            ) : (
              <IconButton
                accessibilityLabel={`选择 ${name}`}
                name="plus"
                onPress={() => pickCatalogue(item.exercise)}
                size="sm"
              />
            )}
          </>
        )}
      </View>
    );

    if (item.kind === 'custom') {
      const custom = item.exercise;
      return (
        <Card padded={false}>
          <ListRow
            {...(replacing
              ? {
                accessibilityLabel: `查看详情 ${name}`,
                onPressBody: () => setDetail({ id: custom.id, custom: true }),
              }
              : {
                accessibilityLabel: `选择 ${name}`,
                onPress: () => pickCustom(custom),
              })}
            leading={<MediaThumb exerciseId={custom.id} server={null} size={44} radius={theme.radius.lg} />}
            subtitle={subtitleOf(custom.bp, custom.eq)}
            testID={`library-ex-${custom.id}`}
            title={name}
            trailing={actions}
          />
        </Card>
      );
    }

    const builtin = item.exercise;
    return (
      <Card padded={false}>
        <ListRow
          {...(replacing
            ? {
              accessibilityLabel: `查看详情 ${name}`,
              onPressBody: () => setDetail({ id: builtin.id, custom: false }),
            }
            : {
              accessibilityLabel: `选择 ${name}`,
              onPress: () => pickCatalogue(builtin),
            })}
          leading={<MediaThumb exerciseId={builtin.id} server={server} size={44} radius={theme.radius.lg} />}
          subtitle={subtitleOf(builtin.bodyPart, builtin.equipment)}
          testID={`library-ex-${builtin.id}`}
          title={name}
          trailing={actions}
        />
      </Card>
    );
  }

  function aiStatusText(view: AiView): string {
    if (view.status === 'running') return 'AI 正在检索…';
    if (view.status === 'error') return '检索失败';
    if (view.cancelled) return '已取消';
    return '检索完成';
  }

  function renderAiCandidate(item: AiSearchItem) {
    const exercise = exerciseOf(librarySearch, item);
    if (!exercise) return null;
    return (
      <Card key={`ai-${item.exerciseId}`} padded={false}>
        <ListRow
          accessibilityLabel={`查看 ${item.name} 详情`}
          leading={(
            <MediaThumb
              exerciseId={exercise.id}
              radius={theme.radius.lg}
              server={exercise.custom ? null : server}
              size={44}
            />
          )}
          onPress={() => setDetail({ id: exercise.id, custom: exercise.custom })}
          subtitle={item.rationale}
          testID={`ai-candidate-${exercise.id}`}
          title={item.name}
          trailing={(
            <Badge tone={item.level === 'high' ? 'accent' : item.level === 'medium' ? 'orange' : 'neutral'}>
              {levelText(item.level)}
            </Badge>
          )}
        />
      </Card>
    );
  }

  function renderAiFallback() {
    if (!ai?.fallback) return null;
    const show = ai.items.length === 0 || ai.fallbackOpen;
    if (!show) return null;
    const bodyParts = ai.fallback.bodyParts ?? [];
    const equipmentValues = ai.fallback.equipment ?? [];
    return (
      <View style={{ gap: theme.space.sm }}>
        <SectionHeader title="按建议筛选" />
        <Card>
          <Text tone="secondary" variant="subhead">
            {ai.fallback.understanding}
          </Text>
          {bodyParts.length || equipmentValues.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.md }}>
              {bodyParts.map(value => (
                <Chip key={`ai-bp-${value}`} onPress={() => applyAiFallback('bodyPart', value)} tone="neutral">
                  {bodyPartName(value)}
                </Chip>
              ))}
              {equipmentValues.map(value => (
                <Chip key={`ai-eq-${value}`} onPress={() => applyAiFallback('equipment', value)} tone="neutral">
                  {equipmentName(value)}
                </Chip>
              ))}
            </View>
          ) : null}
        </Card>
      </View>
    );
  }

  function renderAiError() {
    if (!ai?.error) return null;
    const capability = ai.error.code === 'profile_capability_missing';
    return (
      <Card>
        <Text tone="danger" variant="subhead">
          {aiErrorMessage(ai.error.code, ai.error.message)}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.md }}>
          <Button
            disabled={ai.status === 'running' || !ai.controller.canContinue}
            onPress={retryAi}
            size="sm"
            variant="secondary"
          >
            重试
          </Button>
          <Button onPress={() => { openAiSheet().catch(() => undefined); }} size="sm" variant="secondary">
            修改输入
          </Button>
          {capability && connection ? (
            <Button onPress={() => { restartOnServer().catch(() => undefined); }} size="sm" variant="tinted">
              在服务端重新发起
            </Button>
          ) : null}
        </View>
      </Card>
    );
  }

  function renderAiContent() {
    if (!ai) return null;
    return (
      <View style={{ gap: theme.space.sm }}>
        {ai.status === 'running' ? (
          <View style={{ alignItems: 'center', paddingVertical: theme.space.lg }}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">
              AI 正在理解描述并匹配动作库…
            </Text>
          </View>
        ) : null}
        {ai.items.map(renderAiCandidate)}
        {ai.status === 'ready' && ai.controller.canContinue && ai.clarifications.length > 0 ? (
          <View style={{ gap: theme.space.sm }} testID="ai-clarification-chips">
            <Text tone="secondary" variant="footnote">
              快速补充方向：
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              {ai.clarifications.map(chip => (
                <Chip
                  key={chip.label}
                  onPress={() => sendAiFollowUpText(chip.prompt)}
                  tone="neutral"
                >
                  {chip.label}
                </Chip>
              ))}
            </View>
          </View>
        ) : null}
        {ai.items.length > 0 && ai.fallback && !ai.fallbackOpen ? (
          <Button onPress={() => setAi(view => (view ? { ...view, fallbackOpen: true } : view))} variant="ghost">
            都不对？继续追问，或看看建议筛选
          </Button>
        ) : null}
        {renderAiFallback()}
        {renderAiError()}
        {ai.status === 'ready' && ai.items.length === 0 && !ai.error ? (
          <Text align="center" tone="secondary" variant="footnote">
            {ai.cancelled ? '这次检索已取消。' : '没有匹配到动作。'}
          </Text>
        ) : null}
      </View>
    );
  }

  function aiSummaryFootnote(view: AiView) {
    return (
      <Text tone="tertiary" variant="caption2">
        {`${aiStatusText(view)} · 经 ${view.summary.label} 检索`}
      </Text>
    );
  }

  function renderAiSummary() {
    if (!ai) return null;
    return (
      <Card>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
          {ai.latestImage ? (
            <Image
              contentFit="cover"
              source={{ uri: ai.latestImage.dataUrl }}
              style={{ width: 44, height: 44, borderRadius: theme.radius.lg }}
            />
          ) : null}
          <View style={{ flex: 1, gap: theme.space.xxs }}>
            <Text numberOfLines={2} variant="subhead">
              {ai.latestText || '图片检索'}
            </Text>
            {aiSummaryFootnote(ai)}
          </View>
          <IconButton
            accessibilityLabel="退出 AI 检索"
            name="xmark"
            onPress={exitAi}
            testID="ai-exit"
          />
        </View>
      </Card>
    );
  }

  function renderFollowUp() {
    if (!ai) return null;
    const running = ai.status === 'running';
    const limitReached = !ai.controller.canContinue;
    const canSend = !running && !limitReached && (aiFollowUpText.trim().length > 0 || !!aiFollowUpImage);
    return (
      <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
        {aiFollowUpImage ? (
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            <Image
              contentFit="cover"
              source={{ uri: aiFollowUpImage.dataUrl }}
              style={{ width: 44, height: 44, borderRadius: theme.radius.lg }}
            />
            <Text tone="secondary" variant="footnote">
              发送后随本轮一起提交
            </Text>
            <IconButton
              accessibilityLabel="移除追问图片"
              name="xmark"
              onPress={() => {
                setAiFollowUpImage(null);
                aiFollowUpMediaRef.current = null;
              }}
              size="sm"
            />
          </View>
        ) : null}
        {aiFollowUpError ? (
          <Text tone="danger" variant="footnote">
            {aiErrorMessage(aiFollowUpError.code, aiFollowUpError.message)}
          </Text>
        ) : null}
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
          <IconButton
            accessibilityLabel="拍照或从相册选择"
            disabled={running || limitReached}
            name="camera"
            onPress={() => {
              setAiFollowUpError(null);
              setAiFollowUpSheet(true);
            }}
          />
          <View style={{ flex: 1 }}>
            <SearchField
              editable={!running && !limitReached}
              onChangeText={setAiFollowUpText}
              placeholder="继续描述或追问…"
              testID="ai-follow-up"
              value={aiFollowUpText}
            />
          </View>
          {running ? (
            <>
              <ActivityIndicator color={theme.colors.accent} size="small" />
              <IconButton
                accessibilityLabel="取消本轮检索"
                name="xmark"
                onPress={cancelAiTurn}
                tone="danger"
              />
            </>
          ) : (
            <IconButton
              accessibilityLabel="发送追问"
              disabled={!canSend}
              name="arrowUp"
              onPress={sendAiFollowUp}
              tone="accent"
            />
          )}
        </View>
        <Text tone="secondary" variant="caption">
          {limitReached
            ? '已达到追问上限，请退出后重新发起。'
            : `还可追问 ${Math.max(0, 6 - ai.controller.submittedRuns)} 轮`}
        </Text>
      </View>
    );
  }

  function renderConfigEmpty() {
    return (
      <EmptyState
        icon="sparkles"
        text="先在 Agent 配置中添加一个可用的模型，再回来使用 AI 检索。"
        title="还没有可用的模型配置"
        testID="ai-config-empty"
      >
        {onOpenAgentProfiles ? (
          <Button onPress={onOpenAgentProfiles} variant="primary">
            去配置
          </Button>
        ) : (
          <Text align="center" tone="secondary" variant="footnote">
            请从“设置 → Agent 配置”创建模型配置。
          </Text>
        )}
        <Button onPress={() => setAiNeedsConfig(false)} variant="secondary">
          返回动作库
        </Button>
      </EmptyState>
    );
  }

  function renderRecovery() {
    if (!aiRecovery || ai) return null;
    return (
      <Card>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
          <IconTile name="sparkles" size="md" tone="soft" />
          <View style={{ flex: 1 }}>
            <Text variant="subhead">上次检索未完成</Text>
            <Text tone="secondary" variant="footnote">
              重新发起一次 AI 检索即可继续。
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.md }}>
          <Button onPress={() => {
            dismissAiRecovery()
              .then(() => openAiSheet())
              .catch(() => undefined);
          }} size="sm" variant="primary">
            重新发起
          </Button>
          <Button onPress={() => { dismissAiRecovery().catch(() => undefined); }} size="sm" variant="secondary">
            忽略
          </Button>
        </View>
      </Card>
    );
  }

  const listHeader = (
    <View>
      <Header
        onBack={onBack}
        title="动作库"
        subtitle={subtitle}
        right={ai || aiNeedsConfig ? undefined : (
          <IconButton
            accessibilityLabel={activeFilters > 0 ? `筛选（已选 ${activeFilters} 项）` : '筛选'}
            name="funnel"
            onPress={() => setFiltersOpen(true)}
            tone={activeFilters > 0 ? 'accent' : 'neutral'}
          />
        )}
      />

      <SearchField
        editable={!ai}
        onChangeText={setQuery}
        onAiPress={() => { openAiSheet().catch(() => undefined); }}
        placeholder={ai ? 'AI 检索中，文字输入已禁用' : '搜索动作'}
        resultCount={!ai && !aiNeedsConfig && narrowed ? total : undefined}
        testID="library-search"
        value={query}
      />

      {ai ? renderAiSummary() : null}
      {!ai && aiRecovery ? <View style={{ marginTop: theme.space.md }}>{renderRecovery()}</View> : null}

      {!ai && !aiNeedsConfig ? (
        <ScrollView
          contentContainerStyle={{ gap: theme.space.sm, paddingRight: theme.space.lg }}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: theme.space.md, marginBottom: theme.space.md }}
        >
          <Chip
            onPress={() => setBodyPart(null)}
            selected={bodyPart === null}
            tone="neutral"
          >
            全部
          </Chip>
          <Chip
            icon={favouritesOnly ? 'starFill' : 'star'}
            onPress={() => setFavouritesOnly(value => !value)}
            selected={favouritesOnly}
            testID="library-favourites-only"
            tone="neutral"
          >
            仅收藏
          </Chip>
          {BODY_PARTS.map(part => (
            <Chip
              key={part}
              onPress={() => setBodyPart(bodyPart === part ? null : part)}
              selected={bodyPart === part}
              tone="neutral"
            >
              {bodyPartName(part)}
            </Chip>
          ))}
          {equipment ? (
            <Chip icon="xmark" onPress={() => setEquipment(null)} selected tone="neutral">
              {equipmentName(equipment)}
            </Chip>
          ) : null}
          {targetMuscle ? (
            <Chip
              icon="xmark"
              onPress={() => setTargetMuscle(null)}
              selected
              testID="library-target-active"
              tone="neutral"
            >
              {targetMuscleName(targetMuscle)}
            </Chip>
          ) : null}
          {oneLimb ? (
            <Chip
              icon="xmark"
              onPress={() => setOneLimb(false)}
              selected
              testID="library-one-limb-active"
              tone="neutral"
            >
              仅单侧
            </Chip>
          ) : null}
        </ScrollView>
      ) : null}

      {!ai && !aiNeedsConfig ? (
        <Card padded={false}>
          <ListRow
            chevron
            leading={<IconTile name="plusCircle" size="md" tone="soft" />}
            onPress={() => startEdit()}
            subtitle="名称 + 部位，稍后还能改"
            testID="library-custom"
            title="创建自定义动作"
          />
        </Card>
      ) : null}
    </View>
  );

  if (detail && !replacing) {
    const customExercise = detail.custom
      ? (profile.customEx ?? []).find(exercise => exercise?.id === detail.id)
      : undefined;
    const cardio = detail.custom
      ? customExercise?.bp === 'cardio'
      : catalogueExercise(detail.id)?.bp === 'cardio';
    return (
      <ExerciseDetailScreen
        key={`${detail.custom ? 'custom' : 'catalogue'}-${detail.id}`}
        connection={connection}
        custom={detail.custom}
        exerciseId={detail.id}
        onBack={() => setDetail(null)}
        onFavorite={onFavorite}
        onPick={() => {
          onPick({ id: detail.id, mode: cardio ? 'cardio' : 'reps' });
          setDetail(null);
        }}
        profile={profile}
        server={server}
      />
    );
  }

  const library = (
    <Screen scroll={false} testID="library-screen">
      <FlatList
        contentContainerStyle={{ padding: theme.layout.pagePadding, paddingBottom: theme.layout.listBottomPadding }}
        data={ai || aiNeedsConfig ? [] : rows}
        initialNumToRender={12}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => `${item.kind}-${item.exercise.id}`}
        ListEmptyComponent={
          aiNeedsConfig ? renderConfigEmpty() : ai ? renderAiContent() : (
            <View>
              <EmptyState
                icon={noFavourites ? 'star' : 'magnifier'}
                text={noFavourites
                  ? '点动作右侧的星标收藏动作，之后可以在这里快速找到。'
                  : '换个关键词，或者清除筛选后再试。'}
                title={noFavourites ? '还没有收藏的动作' : '没有匹配的动作'}
              >
                {narrowed ? (
                  <Button onPress={clearFilters} variant="secondary">
                    清除筛选
                  </Button>
                ) : null}
              </EmptyState>
              {suggestionRows.length > 0 ? (
                <View style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
                  <SectionHeader title="你可能在找" />
                  {suggestionRows.map(row => (
                    <View key={`${row.kind}-${row.exercise.id}`}>{rowView(row)}</View>
                  ))}
                </View>
              ) : null}
            </View>
          )
        }
        ListFooterComponent={ai ? renderFollowUp() : (aiNeedsConfig ? null : result.items.length < result.total ? (
          <Button
            onPress={() => setLimit(value => value + SEARCH_LIMIT)}
            variant="secondary"
          >
            显示更多
          </Button>
        ) : null)}
        ListHeaderComponent={listHeader}
        renderItem={({ item }) => rowView(item)}
        style={{ flex: 1 }}
        windowSize={7}
      />

      <Sheet
        footer={(
          <Button onPress={() => setFiltersOpen(false)} variant="primary">
            完成
          </Button>
        )}
        onClose={() => setFiltersOpen(false)}
        testID="library-filters"
        title="筛选"
        visible={filtersOpen}
      >
        <View style={{ gap: theme.space.lg }}>
          <View>
            <SectionHeader
              action={favouritesOnly ? (
                <Button onPress={() => setFavouritesOnly(false)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="收藏"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip
                icon={favouritesOnly ? 'starFill' : 'star'}
                onPress={() => setFavouritesOnly(value => !value)}
                selected={favouritesOnly}
                size="sm"
                testID="library-filters-favourites"
                tone="neutral"
              >
                仅收藏
              </Chip>
            </View>
          </View>

          <View>
            <SectionHeader
              action={bodyPart ? (
                <Button onPress={() => setBodyPart(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="部位"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setBodyPart(null)} selected={bodyPart === null} size="sm" tone="neutral">
                全部
              </Chip>
              {BODY_PARTS.map(part => (
                <Chip
                  key={part}
                  onPress={() => setBodyPart(bodyPart === part ? null : part)}
                  selected={bodyPart === part}
                  size="sm"
                  tone="neutral"
                >
                  {bodyPartName(part)}
                </Chip>
              ))}
            </View>
          </View>

          <View>
            <SectionHeader
              action={targetMuscle ? (
                <Button onPress={() => setTargetMuscle(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="目标肌群"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setTargetMuscle(null)} selected={targetMuscle === null} size="sm" tone="neutral">
                全部
              </Chip>
              {TARGET_MUSCLES.map(value => (
                <Chip
                  key={value}
                  onPress={() => setTargetMuscle(targetMuscle === value ? null : value)}
                  selected={targetMuscle === value}
                  size="sm"
                  testID={`library-filters-target-${value}`}
                  tone="neutral"
                >
                  {targetMuscleName(value)}
                </Chip>
              ))}
            </View>
          </View>

          <View>
            <SectionHeader
              action={oneLimb ? (
                <Button onPress={() => setOneLimb(false)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="单侧"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip
                onPress={() => setOneLimb(value => !value)}
                selected={oneLimb}
                size="sm"
                testID="library-filters-one-limb"
                tone="neutral"
              >
                仅单侧
              </Chip>
            </View>
          </View>

          <View>
            <SectionHeader
              action={equipment ? (
                <Button onPress={() => setEquipment(null)} size="xs" variant="ghost">
                  清除
                </Button>
              ) : undefined}
              title="器械"
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setEquipment(null)} selected={equipment === null} size="sm" tone="neutral">
                全部
              </Chip>
              {EQUIPMENT_OPTIONS.map(value => (
                <Chip
                  key={value}
                  onPress={() => setEquipment(equipment === value ? null : value)}
                  selected={equipment === value}
                  size="sm"
                  tone="neutral"
                >
                  {equipmentName(value)}
                </Chip>
              ))}
            </View>
          </View>

          {activeFilters > 0 ? (
            <Button onPress={clearFilterChips} variant="ghost">
              清除筛选
            </Button>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        footer={(
          <View style={{ gap: theme.space.sm }}>
            <Button disabled={!customNameValue.trim()} onPress={saveCustom} variant="primary">
              保存
            </Button>
            <Button onPress={closeEdit} variant="secondary">
              取消
            </Button>
          </View>
        )}
        onClose={closeEdit}
        testID="library-custom-sheet"
        title={editing?.id ? '编辑自定义动作' : '新建自定义动作'}
        visible={editing !== null}
      >
        <TextField
          autoFocus
          label="动作名称"
          maxLength={80}
          onChangeText={setCustomNameValue}
          placeholder="例如：杠铃深蹲"
          value={customNameValue}
        />
        <View style={{ height: theme.space.md }} />
      </Sheet>

      <Sheet
        footer={(
          <View style={{ gap: theme.space.sm }}>
            <Button
              disabled={aiPickerBusy || (!aiSheetText.trim() && !aiDraftImage)}
              loading={aiPickerBusy}
              onPress={() => { submitAiSheet().catch(() => undefined); }}
              testID="ai-submit"
              variant="primary"
            >
              AI 检索
            </Button>
            <Text align="center" tone="secondary" variant="footnote">
              使用 AI 模型识别，需联网
            </Text>
          </View>
        )}
        onClose={() => setAiSheetOpen(false)}
        testID="ai-launch-sheet"
        title="AI 检索动作"
        visible={aiSheetOpen}
      >
        <TextField
          autoCapitalize="sentences"
          label="描述"
          maxLength={500}
          multiline
          onChangeText={setAiSheetText}
          placeholder="描述想找的动作或器械，可加上你的条件（如：肩膀不适、只有哑铃）"
          testID="ai-hint"
          value={aiSheetText}
        />
        <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.md }}>
          <View style={{ flex: 1 }}>
            <Button
              disabled={aiPickerBusy}
              fullWidth
              icon="camera"
              onPress={() => { pickAiImage('camera', 'sheet').catch(() => undefined); }}
              variant="secondary"
            >
              拍照
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button
              disabled={aiPickerBusy}
              fullWidth
              icon="image"
              onPress={() => { pickAiImage('library', 'sheet').catch(() => undefined); }}
              variant="secondary"
            >
              从相册选择
            </Button>
          </View>
        </View>
        {aiDraftImage ? (
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.md }}>
            <Image
              contentFit="cover"
              source={{ uri: aiDraftImage.dataUrl }}
              style={{ width: 56, height: 56, borderRadius: theme.radius.lg }}
            />
            <Text style={{ flex: 1 }} tone="secondary" variant="footnote">
              已选 1 张图片
            </Text>
            <IconButton
              accessibilityLabel="移除已选图片"
              name="xmark"
              onPress={() => {
                setAiDraftImage(null);
                setAiImageNotice('');
                aiSheetMediaRef.current = null;
              }}
            />
          </View>
        ) : null}
        {aiImageNotice ? (
          <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">
            {aiImageNotice}
          </Text>
        ) : null}
        {aiLaunch?.profile.provider === 'fixture' ? (
          <View style={{ marginTop: theme.space.md, gap: theme.space.xs }}>
            <Text tone="secondary" variant="footnote">
              Fixture 用例
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
              <Chip onPress={() => setAiFixtureCase('candidates')} selected={aiFixtureCase === 'candidates'} size="sm" tone="neutral">
                候选
              </Chip>
              <Chip onPress={() => setAiFixtureCase('fallback-only')} selected={aiFixtureCase === 'fallback-only'} size="sm" tone="neutral">
                仅兜底
              </Chip>
              <Chip onPress={() => setAiFixtureCase('error')} selected={aiFixtureCase === 'error'} size="sm" tone="neutral">
                错误
              </Chip>
            </View>
          </View>
        ) : null}
        {aiSheetError ? (
          <View style={{ marginTop: theme.space.md, gap: theme.space.sm }}>
            <Text tone="danger" variant="footnote">
              {aiErrorMessage(aiSheetError.code, aiSheetError.message)}
            </Text>
            {aiSheetError.code === 'profile_capability_missing' && connection ? (
              <Button onPress={() => { restartOnServer().catch(() => undefined); }} size="sm" variant="tinted">
                在服务端重新发起
              </Button>
            ) : null}
          </View>
        ) : null}
      </Sheet>

      <Sheet
        footer={(
          <Button onPress={() => setAiFollowUpSheet(false)} variant="secondary">
            取消
          </Button>
        )}
        onClose={() => setAiFollowUpSheet(false)}
        testID="ai-follow-up-sheet"
        title="添加图片"
        visible={aiFollowUpSheet}
      >
        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              disabled={aiPickerBusy}
              fullWidth
              icon="camera"
              onPress={() => { pickAiImage('camera', 'followup').catch(() => undefined); }}
              variant="secondary"
            >
              拍照
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button
              disabled={aiPickerBusy}
              fullWidth
              icon="image"
              onPress={() => { pickAiImage('library', 'followup').catch(() => undefined); }}
              variant="secondary"
            >
              从相册选择
            </Button>
          </View>
        </View>
        <Text style={{ marginTop: theme.space.md }} tone="secondary" variant="footnote">
          单张图片，选第二张会替换。图片和文字可以一起发送。
        </Text>
        {aiFollowUpError ? (
          <Text style={{ marginTop: theme.space.sm }} tone="danger" variant="footnote">
            {aiErrorMessage(aiFollowUpError.code, aiFollowUpError.message)}
          </Text>
        ) : null}
      </Sheet>
    </Screen>
  );

  if (!replacing) return library;

  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityElementsHidden={detail !== null}
        importantForAccessibility={detail ? 'no-hide-descendants' : 'auto'}
        pointerEvents={detail ? 'none' : 'auto'}
        style={{ flex: 1 }}
      >
        {library}
      </View>
      {detail ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]}>
          <ExerciseDetailScreen
            key={`${detail.custom ? 'custom' : 'catalogue'}-${detail.id}`}
            connection={connection}
            custom={detail.custom}
            exerciseId={detail.id}
            onBack={() => setDetail(null)}
            onFavorite={onFavorite}
            onPick={() => {
              submitPick(detail.id, detail.custom);
              setDetail(null);
            }}
            pickLabel="选择此动作替换"
            profile={profile}
            server={server}
          />
        </View>
      ) : null}
    </View>
  );
}
