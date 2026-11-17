import { useEffect, useState } from 'react';
import { Alert, BackHandler, Linking, Modal, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TabBar, Text, ThemeProvider, useTheme, useThemeController, type TabItem } from './src/design';
import { DesignGallery } from './src/design/gallery/DesignGallery';
import {
  ExerciseLibraryScreen, HistoryEditorScreen, HomeScreen, PlanEditorScreen, PlanScreen,
  ScheduleEditorScreen, SettingsScreen, StartSheet, StatsScreen, WorkoutScreen,
} from './src/screens';
import { useGym } from './src/useGym';
import { readLocal } from './src/storage';
import { advanceRotation, recommendedRoutines, type ProfileChange } from './src/profileChanges';
import { exportBackup, pickBackup, restoreBackup, snapshotOf } from './src/backups';
import { enableRestNotifications, useRestNotification } from './src/restNotifications';
import {
  addExercise, exerciseMode, finishWorkout, localDate, startWorkout, unitOf, workoutKey,
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
  | { kind: 'plan'; routine?: Routine }
  | { kind: 'schedule' }
  | { kind: 'history'; workout: Workout; unit: Unit }
  | { kind: 'settings' }
  | { kind: 'library'; replaceIndex?: number }
  | { kind: 'design' };

function AppScreen() {
  const gym = useGym();
  const theme = useTheme();
  const themeController = useThemeController();
  const [tab, setTab] = useState<Tab>('home');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [e2e, setE2e] = useState(false);
  const [startRequest, setStartRequest] = useState<{ routine?: string } | null>(null);
  const connection = gym.workspace?.connection;
  const currentDraft = gym.workspace?.data.draft;
  const restAlertError = useRestNotification(
    gym.workspace ? gym.workspace.data.restAlerts === true : undefined,
    currentDraft?.rest?.endsAt,
  );

  const closePanel = () => {
    if (panel?.kind === 'design') {
      themeController.setMode('dark');
      themeController.setAccent('green');
    }
    setPanel(null);
  };

  useEffect(() => {
    if (connection) setPanel(null);
    setStartOpen(false);
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
      if (route === 'start-sheet') { setStartOpen(true); return; }
      if (route === 'start' || route === 'workout') { setStartRequest({ routine: params.routine }); return; }
      if (route === 'home' || route === 'plan' || route === 'stats' || route === 'library') {
        setPanel(null);
        setTab(route);
      }
    };
    void Linking.getInitialURL().then(apply).catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => apply(event.url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel) { closePanel(); return true; }
      if (currentDraft) {
        Alert.alert('训练进行中', '完成或放弃训练后再离开。', [
          { text: '继续训练', style: 'cancel' },
          { text: '放弃训练', style: 'destructive', onPress: () => gym.change(data => ({ ...data, draft: null })) },
        ]);
        return true;
      }
      if (tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [currentDraft, panel, tab]);

  // A deep link can open a tab/panel or ask for a workout. This must stay
  // above the workspace loading return so the hook order never changes.
  useEffect(() => {
    if (!startRequest || !gym.workspace) return;
    const request = startRequest;
    setStartRequest(null);
    if (gym.workspace.data.draft) return;
    const { profile, queue } = gym.workspace.data;
    const routine = request.routine ? (profile.routines ?? []).find(item => item.id === request.routine) : undefined;
    const next = routine
      ? startWorkout(routine, profile, queue)
      : startWorkout({ id: '', name: '自由训练', ex: [] }, profile, queue);
    gym.change(data => ({ ...data, draft: next }));
  }, [gym.workspace, startRequest]);

  if (!gym.workspace) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.bg, padding: 24, justifyContent: 'center' }}>
      <StatusBar style="light" />
      <Text variant="title3">openGym RN</Text>
      <Text tone="secondary" style={{ marginTop: 8 }}>{gym.notice || '正在读取本机数据…'}</Text>
    </View>;
  }

  const { profile, draft, queue, workoutDeletes } = gym.workspace.data;
  const disabled = gym.operation !== null || dataBusy;
  const openWorkout = (next: Draft) => gym.change(data => ({ ...data, draft: next }));

  const performDataAction = async (work: () => Promise<void>) => {
    setDataBusy(true);
    try { await work(); }
    catch (error) { Alert.alert('操作失败', error instanceof Error ? error.message : '请重试。'); }
    finally { setDataBusy(false); }
  };

  const saveWorkout = () => {
    if (!draft) return;
    const record = finishWorkout(draft);
    if (!record) return;
    const saved = gym.change(data => connection ? {
      ...data, draft: null, queue: [...data.queue, record],
    } : {
      ...data, draft: null, profile: advanceRotation({ ...data.profile, workouts: [...(data.profile.workouts ?? []), record.workout] }, Date.now()),
    });
    if (saved) setTab('stats');
  };

  const startRoutine = (routine: Routine) => {
    setStartOpen(false);
    openWorkout(startWorkout(routine, profile, queue));
  };

  const startFree = (backfill = false) => {
    const base = startWorkout({ id: '', name: backfill ? '补录训练' : '自由训练', ex: [] }, profile, queue);
    setStartOpen(false);
    openWorkout(backfill ? { ...base, backfillDay: localDate(Date.now()) } : base);
  };

  const openStart = () => {
    if (draft) return;
    if (recommended.length === 1) startRoutine(recommended[0]);
    else setStartOpen(true);
  };

  const onCustom = (exercise: CustomExercise, create: boolean) => {
    gym.commit([{ kind: 'custom', exercise, create }]);
  };

  const pickForWorkout = (target: RoutineExercise, replaceIndex?: number) => {
    if (!draft) return;
    const previous = replaceIndex == null ? undefined : draft.exercises[replaceIndex]?.target;
    const sameMode = previous && exerciseMode(previous, profile) === exerciseMode(target, profile);
    const next = sameMode ? {
      ...target, sets: previous.sets, reps: previous.reps, sec: previous.sec, min: previous.min,
      restSec: previous.restSec, restOff: previous.restOff,
    } : target;
    openWorkout(addExercise(draft, next, profile, queue, replaceIndex));
  };

  const startWithExercise = (target: RoutineExercise) => {
    openWorkout(startWorkout({ id: '', name: '自由训练', ex: [target] }, profile, queue));
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
    if (gym.workspace!.data.restAlerts) {
      gym.change(data => ({ ...data, restAlerts: false }));
      return;
    }
    void performDataAction(async () => {
      if (await enableRestNotifications()) gym.change(data => ({ ...data, restAlerts: true }));
      else Alert.alert('需要通知权限', '请在 Android 设置中允许 openGym 发送通知。', [
        { text: '关闭', style: 'cancel' },
        { text: '打开设置', onPress: () => void Linking.openSettings() },
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
    {draft ? <WorkoutScreen
      profile={profile}
      draft={draft}
      queue={queue}
      e2e={e2e}
      onChange={openWorkout}
      onFinish={saveWorkout}
      onDiscard={() => Alert.alert('放弃这次训练？', '本次已输入的组数会清除。', [
        { text: '继续训练', style: 'cancel' },
        { text: '放弃', style: 'destructive', onPress: () => gym.change(data => ({ ...data, draft: null })) },
      ])}
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
        onStartFree={() => startFree()}
        onOpenStats={() => setTab('stats')}
        onOpenPlan={() => setTab('plan')}
      />}
      {tab === 'plan' && <PlanScreen
        profile={profile}
        connection={connection ?? null}
        onCreate={() => setPanel({ kind: 'plan' })}
        onEdit={routine => setPanel({ kind: 'plan', routine })}
        onDelete={removeRoutine}
        onStart={startRoutine}
        onSchedule={() => setPanel({ kind: 'schedule' })}
      />}
      {tab === 'stats' && <StatsScreen
        profile={profile}
        history={history}
        onEdit={(workout, unit) => setPanel({ kind: 'history', workout, unit })}
        onDelete={deleteWorkout}
        onBackfill={() => startFree(true)}
      />}
      {tab === 'library' && <ExerciseLibraryScreen
        profile={profile}
        server={connection?.server ?? null}
        onPick={startWithExercise}
        onCustom={onCustom}
      />}
      <TabBar tabs={tabs} active={tab} onSelect={key => setTab(key as Tab)} onStart={openStart} />
    </View>}

    {panel && <Modal visible onRequestClose={closePanel}>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        {panel.kind === 'plan' && <PlanEditorScreen
          profile={profile}
          routine={panel.routine}
          server={connection?.server ?? null}
          onCustom={onCustom}
          onClose={closePanel}
          onSave={routine => {
            const original = panel.routine;
            const change: ProfileChange = original ? {
              kind: 'routine', create: false, routine: {
                id: routine.id,
                ...(routine.name !== original.name ? { name: routine.name } : {}),
                ...(JSON.stringify(routine.ex) !== JSON.stringify(original.ex) ? { ex: routine.ex } : {}),
              },
            } : { kind: 'routine', create: true, routine };
            if (gym.commit([change])) closePanel();
          }}
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
          onSave={patch => { if (gym.commit([{ kind: 'workout', key: workoutKey(panel.workout), unit: panel.unit, patch }])) closePanel(); }}
        />}
        {panel.kind === 'settings' && <SettingsScreen
          connection={connection ?? null}
          pending={gym.pending}
          lastSync={gym.lastSync}
          operation={gym.operation}
          restAlerts={gym.workspace.data.restAlerts === true}
          onClose={closePanel}
          onConnect={(address, code) => { void gym.connect(address, code); }}
          onSync={() => void gym.sync()}
          onDisconnect={() => void gym.disconnect()}
          onExport={() => void performDataAction(() => exportBackup(gym.workspace!.data))}
          onRestore={() => void performDataAction(async () => {
            const backup = await pickBackup();
            if (backup) confirmRestore(backup);
          })}
          onMergePractice={() => void performDataAction(async () => confirmRestore(snapshotOf(readLocal(null)), true))}
          onToggleRestAlerts={toggleRestAlerts}
          onOpenAlarmSettings={() => void Linking.sendIntent('android.settings.REQUEST_SCHEDULE_EXACT_ALARM').catch(() => Linking.openSettings())}
          onOpenGallery={() => setPanel({ kind: 'design' })}
          notice={gym.notice}
          restAlertError={restAlertError}
          busy={dataBusy}
        />}
        {panel.kind === 'library' && <ExerciseLibraryScreen
          profile={profile}
          server={connection?.server ?? null}
          onCustom={onCustom}
          onBack={closePanel}
          onPick={target => { pickForWorkout(target, panel.replaceIndex); closePanel(); }}
        />}
        {panel.kind === 'design' && <DesignGallery onClose={closePanel} />}
      </View>
    </Modal>}

    <StartSheet
      visible={startOpen}
      recommended={recommended}
      routines={profile.routines ?? []}
      onStartRoutine={startRoutine}
      onStartFree={() => startFree()}
      onBackfill={() => startFree(true)}
      onClose={() => setStartOpen(false)}
    />
  </>;
}

export default function App() {
  return <ThemeProvider mode="dark" accent="green">
    <SafeAreaProvider><AppScreen /></SafeAreaProvider>
  </ThemeProvider>;
}
