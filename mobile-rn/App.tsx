import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, Linking, Modal, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { randomUUID } from 'expo-crypto';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TabBar, Text, ThemeProvider, useTheme, useThemeController, type TabItem } from './src/design';
import { DesignGallery } from './src/design/gallery/DesignGallery';
import {
  BodyDataScreen, DayOverrideSheet, ExerciseLibraryScreen, HistoryEditorScreen, HistoryImportScreen, HomeScreen,
  PlanEditorScreen, PlanScreen, PlanShareScreen, ProgressScreen, QrPairScreen, ReminderSettingsScreen,
  ScheduleEditorScreen, SettingsScreen, StartScreen, StatsScreen, WorkoutScreen, WorkoutSummarySheet,
  AgentScreen, AgentProfileScreen, CoachChatScreen,
} from './src/screens';
import { RestTimer } from './src/restTimer';
import { workoutSummary, type WorkoutSummary } from './src/progress';
import { useGym } from './src/useGym';
import { readLocal, workspaceScope, type PhotoUpload } from './src/storage';
import { activeRunIds, recoverAgentRuns } from './src/agent';
import { advanceRotation, applyChanges, prepareChanges, recommendedRoutines } from './src/profileChanges';
import { exportBackup, pickBackup, restoreBackup, snapshotOf } from './src/backups';
import { enableRestNotifications, useRestNotification } from './src/restNotifications';
import {
  historyImportChanges, historyImportQueue, historyImportRecheck, type HistoryImportResult,
} from './src/sharing/historyImport';
import {
  normalizeReminderTime, openExactAlarmSettings, syncTrainingReminders,
  useTrainingReminderNavigation, useTrainingReminderSync,
} from './src/reminders';
import {
  DEFAULT_REST_PAUSE_SEC,
  addExercise, effortOf, exerciseMode, finishWorkout, inProfileUnit, localDate, mergeHistoryEntries, startSession, startWorkout, unitOf, workoutKey,
  type CustomExercise, type Draft, type Profile, type Routine, type RoutineExercise, type Unit, type Workout,
} from './src/training';

const tabs: [TabItem, TabItem, TabItem, TabItem] = [
  { key: 'home', label: '首页', icon: 'house' },
  { key: 'plan', label: '计划', icon: 'calendar' },
  { key: 'stats', label: '统计', icon: 'chart' },
  { key: 'library', label: '动作库', icon: 'dumbbell' },
];

type Tab = 'home' | 'plan' | 'stats' | 'library';
type Panel =
  | { kind: 'plan'; routineId?: string }
  | { kind: 'schedule' }
  | { kind: 'history'; workout: Workout; unit: Unit }
  | { kind: 'settings' }
  | { kind: 'library'; replaceIndex?: number }
  | { kind: 'body' }
  | { kind: 'progress' }
  | { kind: 'historyImport' }
  | { kind: 'qrPair' }
  | { kind: 'planShare'; mode?: 'export' | 'import' }
  | { kind: 'reminder' }
  | { kind: 'agent' }
  | { kind: 'agentProfile' }
  | { kind: 'coach' }
  | { kind: 'start' }
  | { kind: 'dayOverride' }
  | { kind: 'design' };

function showOperationError(error: unknown) {
  Alert.alert('操作失败', error instanceof Error ? error.message : '请重试。');
}

function AppScreen() {
  const gym = useGym();
  const { change, workspace } = gym;
  const theme = useTheme();
  const { setMode, setAccent } = useThemeController();
  const [tab, setTab] = useState<Tab>('home');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [e2e, setE2e] = useState(false);
  const [startRequest, setStartRequest] = useState<{ routine?: string } | null>(null);
  // The live workout is its own screen, shown only while `workoutOpen`. A draft can
  // exist with the tabs on screen: that is a collapsed workout and its rest dock.
  const [workoutOpen, setWorkoutOpen] = useState(true);
  const [summary, setSummary] = useState<{ workout: Workout; summary: WorkoutSummary; unit: Unit } | null>(null);
  const savingRef = useRef(false);
  const savedDraftId = useRef<string | null>(null);
  const planClose = useRef<(() => void) | null>(null);
  const libraryClose = useRef<(() => void) | null>(null);
  const connection = workspace?.connection;
  const currentDraft = workspace?.data.draft;
  // A foreground agent run cannot survive a process restart. Mark the previous
  // scope's leftovers interrupted as soon as the workspace is known.
  const recoveredScope = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const scope = workspaceScope(workspace.connection);
    if (recoveredScope.current === scope) return;
    recoveredScope.current = scope;
    // Runs this process is still executing are left alone: only leftovers
    // from a previous process are marked interrupted.
    try { recoverAgentRuns(workspace.connection, activeRunIds()); } catch { /* a storage failure must not block boot */ }
  }, [workspace]);
  const restAlertError = useRestNotification(
    workspace ? workspace.data.restAlerts === true : undefined,
    currentDraft?.rest?.endsAt,
  );

  // Training reminders are device-local, so they are resolved before the workspace
  // loading return: hook order must not change while the database opens.
  const reminderProfile = workspace?.data.profile;
  const reminderPreference = workspace?.data.reminder;
  const reminderEnabled = reminderPreference?.on === true;
  const reminderTime = normalizeReminderTime(reminderPreference?.time);
  const reminderWorkspace = connection ? `${connection.server}|${connection.user.id}` : 'practice';
  const reminderCompletedDays = workspace?.data.queue.flatMap(item => item.workout.d ? [item.workout.d] : []) ?? [];
  const reminderSync = useTrainingReminderSync(reminderProfile, {
    enabled: reminderEnabled,
    time: reminderTime,
    workspace: reminderWorkspace,
    completedDays: reminderCompletedDays,
  });
  useTrainingReminderNavigation(() => {
    setPanel(null);
    setWorkoutOpen(false);
    setTab('plan');
  });

  const closePanel = useCallback(() => {
    if (panel?.kind === 'design') {
      setMode('dark');
      setAccent('green');
    }
    setPanel(null);
  }, [panel?.kind, setMode, setAccent]);

  // The plan editor owns unsaved input, so every request to leave the plan panel
  // (hardware back, Modal request-close, its own back button) goes through it.
  const requestClosePanel = useCallback(() => {
    if (panel?.kind === 'plan' && planClose.current) {
      planClose.current();
      return;
    }
    if (panel?.kind === 'library' && libraryClose.current) {
      libraryClose.current();
      return;
    }
    closePanel();
  }, [closePanel, panel?.kind]);

  const registerPlanClose = useCallback((close: () => void) => {
    planClose.current = close;
    return () => {
      if (planClose.current === close) planClose.current = null;
    };
  }, []);

  const registerLibraryClose = useCallback((close: (() => void) | null) => {
    libraryClose.current = close;
  }, []);

  const onMissingPlan = useCallback(() => {
    setPanel(null);
    Alert.alert('计划已不存在', '这套计划已在本机或同步中删除，无法继续编辑。');
  }, []);

  useEffect(() => {
    if (connection) setPanel(null);
  }, [connection]);

  useEffect(() => {
    const apply = (url: string | null) => {
      if (!url) return;
      const normalized = url.replace(/^opengym:\/\//i, '');
      const [rawRoute, rawQuery = ''] = normalized.split('?');
      const route = rawRoute.replace(/\/+$/, '').toLowerCase();
      const params = Object.fromEntries(rawQuery.split('&').filter(Boolean).map(part => {
        const [key, value = ''] = part.split('=');
        return [key, decodeURIComponent(value)];
      }));
      if (params.e2e === '1') setE2e(true);
      if (route === 'settings') { setPanel({ kind: 'settings' }); return; }
      if (route === 'gallery') { setPanel({ kind: 'design' }); return; }
      if (route === 'progress') { setPanel({ kind: 'progress' }); return; }
      if (route === 'body') { setPanel({ kind: 'body' }); return; }
      if (route === 'reminder') { setPanel({ kind: 'reminder' }); return; }
      if (route === 'agent') { setPanel({ kind: 'agent' }); return; }
      if (route === 'coach') { setPanel({ kind: 'coach' }); return; }
      if (route === 'agent-profile') { setPanel({ kind: 'agentProfile' }); return; }
      if (route === 'history-import') { setPanel({ kind: 'historyImport' }); return; }
      if (route === 'plan-share') { setPanel({ kind: 'planShare', mode: params.mode === 'import' ? 'import' : 'export' }); return; }
      if (route === 'pair') { setPanel({ kind: 'qrPair' }); return; }
      if (route === 'start-sheet') { setPanel({ kind: 'start' }); return; }
      if (route === 'start' || route === 'workout') { setStartRequest({ routine: params.routine }); return; }
      if (route === 'home' || route === 'plan' || route === 'stats' || route === 'library') {
        setPanel(null);
        setWorkoutOpen(false);
        setTab(route);
      }
    };
    void Linking.getInitialURL().then(apply).catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => apply(event.url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel) { requestClosePanel(); return true; }
      // A live workout collapses to the tabs; a backfill keeps its own way out.
      if (currentDraft && workoutOpen) {
        if (currentDraft.backfillDay != null) {
          Alert.alert('补录进行中', '保存或放弃这次补录后再离开。', [
            { text: '继续补录', style: 'cancel' },
            { text: '放弃补录', style: 'destructive', onPress: () => change(data => ({ ...data, draft: null })) },
          ]);
        } else {
          setWorkoutOpen(false);
          setTab('home');
        }
        return true;
      }
      if (tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [change, currentDraft, panel, requestClosePanel, tab, workoutOpen]);

  // A deep link can open a tab/panel or ask for a workout. This must stay
  // above the workspace loading return so the hook order never changes.
  useEffect(() => {
    if (!startRequest || !workspace) return;
    const request = startRequest;
    setStartRequest(null);
    // An unfinished draft always wins over a new start request: the entry point
    // resumes what is already running instead of overwriting it.
    if (workspace.data.draft) {
      setWorkoutOpen(true);
      return;
    }
    const { profile, queue } = workspace.data;
    const routine = request.routine ? (profile.routines ?? []).find(item => item.id === request.routine) : undefined;
    const next = routine
      ? startSession([routine], profile, queue)
      : startSession([], profile, queue, '自由训练');
    if (change(data => ({ ...data, draft: next }))) setWorkoutOpen(true);
  }, [change, startRequest, workspace]);

  if (!workspace) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.bg, padding: theme.layout.loadingPadding, justifyContent: 'center' }}>
      <StatusBar style="light" />
      <Text variant="title3">openGym RN</Text>
      <Text tone="secondary" style={{ marginTop: theme.space.sm }}>{gym.notice || '正在读取本机数据…'}</Text>
    </View>;
  }

  const { profile, draft, queue, workoutDeletes } = workspace.data;
  const openWorkout = (next: Draft) => {
    const saved = gym.change(data => ({ ...data, draft: next }));
    if (saved) setWorkoutOpen(true);
    return saved;
  };

  const performDataAction = (work: () => Promise<void>) => {
    setDataBusy(true);
    Promise.resolve().then(work).catch(showOperationError).finally(() => setDataBusy(false));
  };

  const changeReminder = (patch: { on?: boolean; time?: string }) =>
    gym.change(data => ({ ...data, reminder: { ...data.reminder, ...patch } }));

  const toggleReminder = (on: boolean) => {
    if (!changeReminder({ on })) return;
    syncTrainingReminders(profile, {
      enabled: on,
      time: reminderTime,
      interactive: on,
      workspace: reminderWorkspace,
      completedDays: reminderCompletedDays,
    }).catch(showOperationError);
  };

  const applyHistoryImport = (result: HistoryImportResult) => {
    const existing = history.map(item => item.workout);
    const recheck = historyImportRecheck(result, existing);
    if (recheck.workouts.length === 0) {
      closePanel();
      Alert.alert('没有可导入的训练', '文件里的训练日期都已有记录，本次没有新增。');
      return;
    }
    if (!connection) {
      gym.change(data => {
        const known = new Set((data.profile.customEx ?? []).map(item => item?.id));
        return {
          ...data,
          profile: {
            ...data.profile,
            customEx: [...(data.profile.customEx ?? []), ...recheck.newExercises.filter(item => !known.has(item.id))],
            workouts: [...(data.profile.workouts ?? []), ...recheck.workouts],
          },
        };
      });
    } else {
      const changes = prepareChanges(historyImportChanges(result, recheck.workouts));
      const queued = historyImportQueue(result, Date.now(), existing);
      gym.change(data => ({
        ...data,
        profile: applyChanges(data.profile, changes),
        changes: [...(data.changes ?? []), ...changes],
        queue: [
          ...data.queue,
          ...queued.filter(item => !data.queue.some(queuedItem => queuedItem.workout.id === item.workout.id)),
        ],
      }));
    }
    closePanel();
    Alert.alert(
      '已导入',
      `新增 ${recheck.workouts.length} 场训练${recheck.skipped ? `，跳过 ${recheck.skipped} 场` : ''}。`,
    );
  };

  const saveWorkout = () => {
    if (!draft || savingRef.current || savedDraftId.current === draft.id) return;
    savingRef.current = true;
    try {
      const record = finishWorkout(draft);
      if (!record) return;
      // PRs are judged against the history saved before this session; the record's
      // own id is not in it yet. Weight PRs are persisted on the workout, the 1RM
      // list is summary-only, exactly like the Web client.
      const unit = unitOf(profile);
      const prior = history.map(item => inProfileUnit({
        workout: { ...item.workout, id: item.workout.id ?? workoutKey(item.workout) },
        unit: item.unit,
      }, unit));
      const result = workoutSummary(profile, record.workout, prior);
      record.workout.prs = result.weightPrs;
      const saved = gym.change(data => {
        // A second confirm from the same render, or a stale callback, must not
        // append the same id twice or clear a newer draft.
        if (data.draft?.id !== draft.id) return data;
        return connection ? {
          ...data, draft: null, queue: [...data.queue, record],
        } : {
          ...data, draft: null, profile: advanceRotation({ ...data.profile, workouts: [...(data.profile.workouts ?? []), record.workout] }, Date.now()),
        };
      });
      if (!saved) {
        Alert.alert('保存失败', '本机写入失败，训练和休息状态仍保留，请检查可用存储空间后重试。');
        return;
      }
      savedDraftId.current = draft.id;
      setWorkoutOpen(false);
      if (draft.backfillDay != null) {
        // The backfill save flow stays as it was: no live summary.
        setTab('stats');
        return;
      }
      setSummary({ workout: record.workout, summary: result, unit: record.unit });
    } finally {
      savingRef.current = false;
    }
  };

  const discardWorkout = () => {
    Alert.alert('放弃这次训练？', '本次已输入的组数会清除。', [
      { text: '继续训练', style: 'cancel' },
      { text: '放弃', style: 'destructive', onPress: () => {
        if (gym.change(data => ({ ...data, draft: null }))) {
          setWorkoutOpen(false);
          setTab('home');
        }
      } },
    ]);
  };

  const startRoutine = (routine: Routine) => {
    if (draft) { setPanel(null); setWorkoutOpen(true); return; }
    setPanel(null);
    openWorkout(startWorkout(routine, profile, queue));
  };

  const startToday = () => {
    if (draft) { setPanel(null); setWorkoutOpen(true); return; }
    if (!recommended.some(routine => (routine.ex ?? []).some(Boolean))) return;
    setPanel(null);
    openWorkout(startSession(recommended, profile, queue));
  };

  const startFree = (backfill = false) => {
    if (draft) { setPanel(null); setWorkoutOpen(true); return; }
    const base = startSession([], profile, queue, backfill ? '补录训练' : '自由训练');
    setPanel(null);
    openWorkout(backfill ? { ...base, backfillDay: localDate(Date.now()) } : base);
  };

  // The centre button: resume a draft, merge today's whole list when it has work,
  // otherwise open the independent chooser (the Web TabBar's rule).
  const openStart = () => {
    if (draft) { setWorkoutOpen(true); return; }
    if (recommended.some(routine => (routine.ex ?? []).some(Boolean))) startToday();
    else setPanel({ kind: 'start' });
  };

  const setDayPlan = (id: string | null) => {
    if (gym.commit([{ kind: 'dayPlan', day: localDate(Date.now()), id }])) setPanel(null);
  };

  const startWithExercise = (target: RoutineExercise) => {
    if (draft) { setWorkoutOpen(true); return; }
    openWorkout(startWorkout({ id: '', name: '自由训练', ex: [target] }, profile, queue));
  };

  const onCustom = (exercise: CustomExercise, create: boolean, photoUpload?: PhotoUpload) => {
    if (!gym.commit([{ kind: 'custom', exercise, create }])) return;
    if (connection && photoUpload) {
      gym.change(data => {
        const existing = data.photoUploads ?? [];
        if (existing.some(item => item.hash === photoUpload.hash)) return data;
        return { ...data, photoUploads: [...existing, photoUpload] };
      });
    }
  };

  const onFavorite = (id: string, favourite: boolean) => {
    gym.commit([{ kind: 'favorite', id, fav: favourite }]);
  };

  // A new routine is written before its editor opens: the editor always works on a saved id,
  // and a storage failure leaves the user on the list instead of an editor that cannot save.
  const createRoutine = () => {
    const routine: Routine = { id: randomUUID(), name: '新计划', ex: [] };
    if (gym.commit([{ kind: 'routine', create: true, routine }])) {
      setPanel({ kind: 'plan', routineId: routine.id });
      return;
    }
    Alert.alert('无法新建计划', '本机保存失败，请检查可用存储空间后重试。');
  };

  const pickForWorkout = (target: RoutineExercise, replaceIndex?: number) => {
    if (!draft) return;
    const previous = replaceIndex == null ? undefined : draft.exercises[replaceIndex]?.target;
    const sameMode = previous && exerciseMode(previous, profile) === exerciseMode(target, profile);
    const next = sameMode ? {
      ...target, sets: previous.sets, reps: previous.reps, sec: previous.sec, min: previous.min,
      restSec: previous.restSec, restOff: previous.restOff, intensifier: previous.intensifier,
    } : target;
    openWorkout(addExercise(draft, next, profile, queue, replaceIndex));
  };

  const removeRoutine = (routine: Routine) => {
    Alert.alert('删除计划？', `将移除「${routine.name}」及对应的排程。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => gym.commit([{ kind: 'deleteRoutine', key: routine.id }]) },
    ]);
  };

  const deleteWorkout = (workout: Workout) => {
    const key = workoutKey(workout);
    Alert.alert('删除这次训练？', connection ? '删除会同步到服务器。' : '训练记录会从本机移除。', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        const saved = gym.change(data => ({
          ...data,
          profile: { ...data.profile, workouts: (data.profile.workouts ?? []).filter(item => !item || workoutKey(item) !== key) },
          queue: data.queue.filter(item => workoutKey(item.workout) !== key),
          workoutDeletes: connection ? { ...data.workoutDeletes, [key]: Math.max(Date.now(), workout._ts ?? 0, workout.end || 0) } : data.workoutDeletes,
        }));
        if (saved) closePanel();
      } },
    ]);
  };

  const confirmRestore = (source: Profile, fromPractice = false) => {
    Alert.alert(fromPractice ? '合并本机练习？' : '恢复训练备份？',
      `将合并 ${source.workouts?.length ?? 0} 条训练和 ${source.routines?.length ?? 0} 套计划，保留现有记录。`, [
        { text: '取消', style: 'cancel' },
        { text: '合并', onPress: () => {
          if (gym.change(data => restoreBackup(data, source, !!connection))) {
            Alert.alert('已合并', connection ? '待同步到当前账号。' : '已保存到本机。');
          }
        } },
      ]);
  };

  const toggleRestAlerts = () => {
    if (workspace.data.restAlerts) {
      gym.change(data => ({ ...data, restAlerts: false }));
      return;
    }
    performDataAction(async () => {
      if (await enableRestNotifications()) gym.change(data => ({ ...data, restAlerts: true }));
      else Alert.alert('需要通知权限', '请在 Android 设置中允许 openGym 发送通知。', [
        { text: '关闭', style: 'cancel' },
        { text: '打开设置', onPress: () => { Linking.openSettings().catch(showOperationError); } },
      ]);
    });
  };

  const remote = (profile.workouts ?? []).filter(workout => workout && !workoutDeletes?.[workoutKey(workout)]);
  const remoteIds = new Set(remote.map(workoutKey));
  const history = [
    ...remote.map(workout => ({ workout, unit: unitOf(profile), pending: false })),
    ...queue.filter(item => !remoteIds.has(item.workout.id)).map(item => ({ ...item, pending: true })),
  ].sort((a, b) => b.workout.start - a.workout.start);
  const recommended = recommendedRoutines({ ...profile, workouts: history.map(item => item.workout) });

  return <>
    <StatusBar style="light" />
    {draft && workoutOpen ? <WorkoutScreen
      profile={profile}
      draft={draft}
      queue={queue}
      e2e={e2e}
      onChange={openWorkout}
      onCollapse={() => { setWorkoutOpen(false); setTab('home'); }}
      onDiscard={discardWorkout}
      onFinish={saveWorkout}
      onPick={replaceIndex => setPanel({ kind: 'library', replaceIndex })}
    /> : <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      {tab === 'home' && <HomeScreen
        profile={profile}
        connection={connection ?? null}
        history={history}
        recommended={recommended}
        pending={gym.pending}
        onSettings={() => setPanel({ kind: 'settings' })}
        onStartRoutine={startRoutine}
        onStartToday={startToday}
        onOpenDayOverride={() => setPanel({ kind: 'dayOverride' })}
        onChooseWorkout={() => {
          if (draft) setWorkoutOpen(true);
          else setPanel({ kind: 'start' });
        }}
        onStartFree={() => startFree()}
        onOpenStats={() => setTab('stats')}
        onOpenPlan={() => setTab('plan')}
        onOpenCoach={() => setPanel({ kind: 'coach' })}
      />}
      {tab === 'plan' && <PlanScreen
        profile={profile}
        connection={connection ?? null}
        onCreate={createRoutine}
        onEdit={routine => setPanel({ kind: 'plan', routineId: routine.id })}
        onDelete={removeRoutine}
        onStart={startRoutine}
        onSchedule={() => setPanel({ kind: 'schedule' })}
        onShare={() => setPanel({ kind: 'planShare', mode: 'export' })}
        onImport={() => setPanel({ kind: 'planShare', mode: 'import' })}
        onOpenCoach={() => setPanel({ kind: 'coach' })}
      />}
      {tab === 'stats' && <StatsScreen
        profile={profile}
        history={history}
        onEdit={(workout, unit) => setPanel({ kind: 'history', workout, unit })}
        onDelete={deleteWorkout}
        onBackfill={() => startFree(true)}
        onOpenBody={() => setPanel({ kind: 'body' })}
        onOpenProgress={() => setPanel({ kind: 'progress' })}
      />}
      {tab === 'library' && <ExerciseLibraryScreen
        connection={connection ?? null}
        profile={profile}
        server={connection?.server ?? null}
        onFavorite={onFavorite}
        onPick={startWithExercise}
        onCustom={onCustom}
        onOpenAgentProfiles={() => setPanel({ kind: 'agentProfile' })}
      />}
      {draft ? (
        <RestTimer
          onChange={rest => gym.change(data => data.draft ? { ...data, draft: { ...data.draft, rest } } : data)}
          rest={draft.rest}
        />
      ) : null}
      <TabBar
        active={tab}
        onSelect={key => setTab(key as Tab)}
        onStart={openStart}
        running={Boolean(draft)}
        runningLabel={draft?.backfillDay ? '补录' : '继续'}
        runningStart={draft && draft.backfillDay == null ? draft.start : undefined}
        tabs={tabs}
      />
    </View>}

    {panel ? <Modal visible onRequestClose={requestClosePanel}>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        {panel.kind === 'plan' && <PlanEditorScreen
          key={panel.routineId ?? 'missing-plan'}
          profile={profile}
          routineId={panel.routineId}
          server={connection?.server ?? null}
          connection={connection ?? null}
          onCommit={changes => gym.commit(changes)}
          onMissing={onMissingPlan}
          onCustom={onCustom}
          onFavorite={onFavorite}
          onClose={closePanel}
          registerClose={registerPlanClose}
        />}
        {panel.kind === 'start' && <StartScreen
          onClose={closePanel}
          onStartFree={() => startFree()}
          onStartRoutine={startRoutine}
          onStartToday={startToday}
          routines={profile.routines ?? []}
          today={recommended}
        />}
        {panel.kind === 'dayOverride' && <DayOverrideSheet
          current={recommended.map(routine => routine.id)}
          onClose={closePanel}
          onPick={setDayPlan}
          override={profile.dayPlan?.[localDate(Date.now())]}
          routines={profile.routines ?? []}
        />}
        {panel.kind === 'schedule' && <ScheduleEditorScreen
          profile={profile}
          onClose={closePanel}
          onSave={value => { if (gym.commit([value])) closePanel(); }}
        />}
        {panel.kind === 'history' && <HistoryEditorScreen
          profile={profile}
          workout={panel.workout}
          unit={panel.unit}
          onClose={closePanel}
          onSave={change => {
            const key = workoutKey(panel.workout);
            const remote = (profile.workouts ?? []).find(workout => workout && workoutKey(workout) === key);
            const queued = queue.find(item => item.workout.id === key)?.workout;
            const latest = remote ?? queued;
            if (!latest) {
              Alert.alert('无法保存修改', '这次训练已在其他设备删除，请重新打开历史记录。');
              return;
            }
            const merged = mergeHistoryEntries(
              (latest.entries ?? []).filter(Boolean),
              change.base,
              change.entries,
              profile.volumeWarmups === true,
              profile.volumeBodyweight === true ? latest.bw ?? 0 : 0,
            );
            if (!merged) {
              Alert.alert('无法保存修改', '这次训练已在其他设备更改，请重新打开历史记录后再修改。');
              return;
            }
            if (gym.commit([{
              kind: 'workout', key, unit: panel.unit,
              patch: { ...change.patch, entries: merged.entries, vol: merged.vol },
            }])) closePanel();
          }}
        />}
        {panel.kind === 'settings' && <SettingsScreen
          connection={connection ?? null}
          pending={gym.pending}
          lastSync={gym.lastSync}
          operation={gym.operation}
          restAlerts={workspace.data.restAlerts === true}
          effort={effortOf(profile)}
          restPauseSec={profile.restPauseSec ?? DEFAULT_REST_PAUSE_SEC}
          workoutView={profile.workoutView}
          foldDone={profile.foldDone === true}
          skipDone={profile.skipDone === true}
          onClose={closePanel}
          onConnect={(address, code) => { gym.connect(address, code).catch(showOperationError); }}
          onSync={() => { gym.sync().catch(showOperationError); }}
          onDisconnect={() => { gym.disconnect().catch(showOperationError); }}
          onExport={() => performDataAction(() => exportBackup(workspace.data))}
          onRestore={() => performDataAction(async () => {
            const backup = await pickBackup();
            if (backup) confirmRestore(backup);
          })}
          onMergePractice={() => performDataAction(async () => confirmRestore(snapshotOf(readLocal(null)), true))}
          onToggleRestAlerts={toggleRestAlerts}
          onChangeEffort={effort => gym.commit([{ kind: 'effort', effort }])}
          onChangeRestPauseSec={restPauseSec => gym.commit([{ kind: 'settings', values: { restPauseSec } }])}
          onChangeSettings={values => gym.commit([{ kind: 'settings', values }])}
          onOpenAlarmSettings={() => {
            Linking.sendIntent('android.settings.REQUEST_SCHEDULE_EXACT_ALARM')
              .catch(() => Linking.openSettings())
              .catch(showOperationError);
          }}
          onOpenGallery={() => setPanel({ kind: 'design' })}
          reminderOn={reminderEnabled}
          reminderTime={reminderTime}
          onOpenReminders={() => setPanel({ kind: 'reminder' })}
          onOpenHistoryImport={() => setPanel({ kind: 'historyImport' })}
          onScanPairingQr={() => setPanel({ kind: 'qrPair' })}
          onOpenAgent={() => setPanel({ kind: 'agent' })}
          notice={gym.notice}
          restAlertError={restAlertError}
          busy={dataBusy}
        />}
        {panel.kind === 'library' && <ExerciseLibraryScreen
          connection={connection ?? null}
          profile={profile}
          server={connection?.server ?? null}
          onCustom={onCustom}
          onFavorite={onFavorite}
          onBack={closePanel}
          onPick={target => { pickForWorkout(target, panel.replaceIndex); closePanel(); }}
          onOpenAgentProfiles={() => setPanel({ kind: 'agentProfile' })}
          registerClose={registerLibraryClose}
          replacing={panel.replaceIndex != null}
        />}
        {panel.kind === 'design' && <DesignGallery onClose={closePanel} />}
        {panel.kind === 'body' && <BodyDataScreen
          connection={connection ?? null}
          history={history}
          onClose={closePanel}
          onCommit={changes => { gym.commit(changes); }}
          onChangeLocal={gym.change}
          photoUploads={workspace.data.photoUploads ?? []}
          profile={profile}
        />}
        {panel.kind === 'progress' && <ProgressScreen
          history={history}
          onClose={closePanel}
          onOpenWorkout={(workout, unit) => setPanel({ kind: 'history', workout, unit })}
          profile={profile}
        />}
        {panel.kind === 'historyImport' && <HistoryImportScreen
          connection={connection ?? null}
          onClose={closePanel}
          onImport={applyHistoryImport}
          profile={snapshotOf(workspace.data)}
        />}
        {panel.kind === 'qrPair' && <QrPairScreen
          busy={gym.operation === 'pair'}
          error={gym.notice}
          onClose={closePanel}
          onConfirm={(address, code) => { gym.connect(address, code).catch(showOperationError); }}
        />}
        {panel.kind === 'planShare' && <PlanShareScreen
          initialMode={panel.mode}
          onChange={changes => { if (gym.commit(changes)) closePanel(); }}
          onClose={closePanel}
          profile={profile}
        />}
        {panel.kind === 'agent' && <AgentScreen
          connection={connection ?? null}
          data={workspace.data}
          onClose={closePanel}
          onOpenProfiles={() => setPanel({ kind: 'agentProfile' })}
        />}
        {panel.kind === 'agentProfile' && <AgentProfileScreen
          connection={connection ?? null}
          data={workspace.data}
          onClose={closePanel}
        />}
        {panel.kind === 'coach' && <CoachChatScreen
          commit={changes => gym.commit(changes)}
          connection={connection ?? null}
          onBack={closePanel}
          onOpenAgent={() => setPanel({ kind: 'agent' })}
          onOpenPair={() => setPanel({ kind: 'qrPair' })}
          profile={profile}
        />}
        {panel.kind === 'reminder' && <ReminderSettingsScreen
          busy={reminderSync.syncing}
          enabled={reminderEnabled}
          error={reminderSync.result?.error}
          exactAlarm={reminderSync.result?.exactAlarm ?? 'unknown'}
          next={reminderSync.next}
          onChangeTime={time => { changeReminder({ time }); }}
          onClose={closePanel}
          onOpenAlarmSettings={() => { openExactAlarmSettings().catch(showOperationError); }}
          onRequestPermission={() => { reminderSync.refresh(true).catch(showOperationError); }}
          onToggle={toggleReminder}
          permission={reminderSync.result?.permission ?? 'undetermined'}
          time={reminderTime}
        />}
      </View>
    </Modal> : null}

    {summary ? <WorkoutSummarySheet
      onClose={() => { setSummary(null); setWorkoutOpen(false); setTab('home'); }}
      profile={profile}
      summary={summary.summary}
      unit={summary.unit}
      workout={summary.workout}
    /> : null}
  </>;
}

export default function App() {
  return <ThemeProvider mode="dark" accent="green">
    <SafeAreaProvider><AppScreen /></SafeAreaProvider>
  </ThemeProvider>;
}
