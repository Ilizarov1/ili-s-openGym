import { useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, FlatList, Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Card, Button, Field, styles } from './src/ui';
import { RestTimer, resolveRestSeconds } from './src/restTimer';
import { useGym } from './src/useGym';
import { readLocal } from './src/storage';
import { advanceRotation, recommendedRoutines, type ProfileChange } from './src/profileChanges';
import { ExercisePicker } from './src/ExercisePicker';
import { PlanEditor, ScheduleEditor } from './src/PlanEditor';
import { HistoryEditor } from './src/HistoryEditor';
import { exportBackup, pickBackup, restoreBackup, snapshotOf } from './src/backups';
import { enableRestNotifications, useRestNotification } from './src/restNotifications';
import { changeSuperset, exerciseUnits, nextSupersetSet, supersetRestSeconds } from './src/supersets';
import {
  addExercise, addWorkSet, backupExerciseIds, exerciseMode, exerciseName, finishWorkout, localDate, MAX_WORK_SETS, removeSet,
  startWorkout, swapExercise, unitOf, updateSet, validSet, validWorkoutDay, workoutKey,
  type CustomExercise, type Draft, type LoggedSet, type Profile, type QueuedWorkout, type Routine, type Unit, type Workout,
} from './src/training';
import { isWarmupRow } from '../frontend/src/lib/workout-model';
import { supersetMeta } from '../frontend/src/lib/superset-meta';

const tabs = ['训练', '历史', '服务器'] as const;
type Tab = typeof tabs[number];
type Panel = { kind: 'plan'; routine?: Routine } | { kind: 'schedule' } |
  { kind: 'history'; workout: Workout; unit: Unit } | { kind: 'exercise'; replaceIndex?: number };

function AppScreen() {
  const gym = useGym();
  const [tab, setTab] = useState<Tab>('训练');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [historyExercise, setHistoryExercise] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const connection = gym.workspace?.connection;
  const currentDraft = gym.workspace?.data.draft;
  const restAlertError = useRestNotification(gym.workspace ? gym.workspace.data.restAlerts === true : undefined, currentDraft?.rest?.endsAt);

  useEffect(() => {
    if (connection) {
      setAddress(connection.server);
      setCode('');
      setReconnecting(false);
    }
    setSelected(null);
    setHistoryExercise(null);
    setPanel(null);
  }, [connection]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab === '历史' && historyExercise) { setHistoryExercise(null); return true; }
      if (selected) { setSelected(null); return true; }
      if (tab !== '训练') { setTab('训练'); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [historyExercise, selected, tab]);

  if (!gym.workspace) return <SafeAreaView style={[styles.screen, styles.content]}>
    <Text style={styles.brand}>openGym RN</Text>
    <Text style={gym.notice ? styles.error : styles.muted}>{gym.notice || '正在读取本机数据…'}</Text>
  </SafeAreaView>;

  const { profile, draft, queue, workoutDeletes } = gym.workspace.data;
  const disabled = gym.operation !== null || dataBusy;
  const closePanel = () => setPanel(null);
  const openWorkout = (next: Draft) => gym.change(data => ({ ...data, draft: next }));
  const onCustom = (exercise: CustomExercise, create: boolean) => { gym.commit([{ kind: 'custom', exercise, create }]); };
  const startFree = (backfill = false) => {
    const next = startWorkout({ id: '', name: backfill ? '补录训练' : '自由训练', ex: [] }, profile, queue);
    if (openWorkout(backfill ? { ...next, backfillDay: localDate(Date.now()) } : next)) {
      setTab('训练');
      setPanel({ kind: 'exercise' });
    }
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
    if (saved) setTab('历史');
  };

  const removeRoutine = (routine: Routine) => Alert.alert('删除计划？', `将移除「${routine.name}」及对应的排程。`, [
    { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => gym.commit([{ kind: 'deleteRoutine', key: routine.id }]) },
  ]);

  const performDataAction = async (work: () => Promise<void>) => {
    setDataBusy(true);
    try { await work(); }
    catch (error) { Alert.alert('操作失败', error instanceof Error ? error.message : '请重试。'); }
    finally { setDataBusy(false); }
  };
  const confirmRestore = (source: Profile, fromPractice = false) => Alert.alert(fromPractice ? '合并本机练习？' : '恢复训练备份？',
    `将合并 ${source.workouts?.length ?? 0} 条训练和 ${source.routines?.length ?? 0} 套计划，保留现有记录。`, [
      { text: '取消', style: 'cancel' }, { text: '合并', onPress: () => {
        if (gym.change(data => restoreBackup(data, source, !!connection))) Alert.alert('已合并', connection ? '待同步到当前账号。' : '已保存到本机。');
      } },
    ]);

  const remote = (profile.workouts ?? []).filter(workout => workout && !workoutDeletes?.[workoutKey(workout)]);
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
        if (saved) setSelected(null);
      } },
    ]);
  };
  const remoteIds = new Set(remote.map(workoutKey));
  const history = [
    ...remote.map(workout => ({ workout, unit: unitOf(profile), pending: false })),
    ...queue.filter(item => !remoteIds.has(item.workout.id)).map(item => ({ ...item, pending: true })),
  ].sort((a, b) => b.workout.start - a.workout.start);
  const recommended = recommendedRoutines({ ...profile, workouts: history.map(item => item.workout) });

  return <SafeAreaView style={styles.screen}>
    <StatusBar style="light" />
    <View style={[styles.header, styles.row, styles.between]}>
      <Text style={styles.brand}>openGym RN</Text>
      <Text style={styles.muted} numberOfLines={1}>{connection ? connection.user.name : '本机练习'}</Text>
    </View>
    {gym.notice || restAlertError ? <Text accessibilityLiveRegion="polite" style={[styles.error, styles.status]}>{gym.notice || restAlertError}</Text> : null}

    {tab === '训练' && (draft
      ? <WorkoutScreen profile={profile} draft={draft} queue={queue} onChange={openWorkout} onFinish={saveWorkout}
          onPick={replaceIndex => setPanel({ kind: 'exercise', replaceIndex })}
          onDiscard={() => Alert.alert('放弃这次训练？', '本次已输入的组数会清除。', [
            { text: '继续训练', style: 'cancel' },
            { text: '放弃', style: 'destructive', onPress: () => gym.change(data => ({ ...data, draft: null })) },
          ])} />
      : <ScrollView style={styles.grow} contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.heading}>训练计划</Text>
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <Button label="新建计划" secondary onPress={() => setPanel({ kind: 'plan' })} />
            <Button label="训练排程" secondary onPress={() => setPanel({ kind: 'schedule' })} />
            <Button label="自由训练" secondary onPress={() => startFree()} />
          </View>
          {recommended.length > 0 && <Card>
            <Text style={styles.title}>今日训练</Text>
            {recommended.filter(routine => routine.ex?.length).map(routine => <Button key={routine.id}
              label={`开始今日训练 · ${routine.name}`} onPress={() => openWorkout(startWorkout(routine, profile, queue))} />)}
          </Card>}
          {(profile.routines ?? []).filter(Boolean).map(routine => {
            const exercises = (routine.ex ?? []).filter(Boolean);
            return <Card key={routine.id}>
              <Text style={styles.title}>{routine.name}</Text>
              <Text style={styles.muted}>{exercises.map(ex => exerciseName(profile, ex.id)).join(' · ') || '暂无动作'}</Text>
              <Button label="开始训练" disabled={exercises.length === 0}
                onPress={() => openWorkout(startWorkout(routine, profile, queue))} />
              <View style={[styles.row, { flexWrap: 'wrap' }]}>
                <Button label="编辑计划" secondary onPress={() => setPanel({ kind: 'plan', routine })} />
                <Button label="删除计划" secondary onPress={() => removeRoutine(routine)} />
              </View>
            </Card>;
          })}
          {!profile.routines?.length && <Text style={styles.muted}>
            暂无训练计划。
          </Text>}
        </ScrollView>)}

    {tab === '历史' && (historyExercise ? <ScrollView style={styles.grow} contentContainerStyle={styles.content}>
      <Button label="返回训练历史" secondary onPress={() => setHistoryExercise(null)} />
      <Text accessibilityRole="header" style={styles.heading}>{exerciseName(profile, historyExercise)}</Text>
      {history.map(({ workout, unit }) => {
        const entries = (workout.entries ?? []).filter(entry => entry?.id === historyExercise);
        if (!entries.length) return null;
        return <Card key={workoutKey(workout)}>
          <Text style={styles.title}>{workout.d} · {workout.name || '训练'}</Text>
          {entries.map((entry, index) => <Text key={index} style={styles.muted}>
            {(entry.sets ?? []).filter(set => set?.done)
              .map(set => `${isWarmupRow(set) ? '热身 ' : ''}${describeSet(set, unit)}`).join(' · ')}
          </Text>)}
        </Card>;
      })}
    </ScrollView> : <FlatList style={styles.grow} contentContainerStyle={styles.content} data={history}
      ListHeaderComponent={<View style={styles.stack}>
        <Text accessibilityRole="header" style={styles.heading}>训练历史</Text>
        <Button label="补录训练" secondary disabled={!!draft} onPress={() => startFree(true)} />
      </View>}
      ListEmptyComponent={<Text style={styles.muted}>完成第一次训练后，记录会出现在这里。</Text>}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      keyExtractor={({ workout }) => workoutKey(workout)}
      renderItem={({ item: { workout, unit, pending } }) => {
        const key = workoutKey(workout);
        return <Card>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: selected === key }}
            onPress={() => setSelected(selected === key ? null : key)} style={styles.stack}>
            <Text style={styles.title}>{workout.name || '训练'}</Text>
            <Text style={styles.muted}>{workout.d} · {workout.entries?.length ?? 0} 个动作{pending ? ' · 待同步' : ''}</Text>
          </Pressable>
          {selected === key && <WorkoutDetails workout={workout} profile={profile} unit={unit} onExercise={setHistoryExercise} />}
          {selected === key && <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <Button label="编辑训练" secondary onPress={() => setPanel({ kind: 'history', workout, unit })} />
            <Button label="删除训练" secondary onPress={() => deleteWorkout(workout)} />
          </View>}
        </Card>;
      }}
    />)}

    {tab === '服务器' && <ScrollView style={styles.grow} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>服务器</Text>
      {connection && <Card>
        <Text style={styles.title}>{connection.user.name}</Text>
        <Text style={styles.muted}>{connection.server}</Text>
        <Text style={styles.muted}>{gym.pending} 条待同步{gym.lastSync ? ' · 上次同步 ' + new Date(gym.lastSync).toLocaleTimeString() : ''}</Text>
        <Button label={gym.operation === 'sync' ? '正在同步…' : '立即同步'} disabled={disabled} onPress={() => void gym.sync()} />
        <Button label={reconnecting ? '收起配对' : '重新配对'} secondary disabled={disabled} onPress={() => setReconnecting(!reconnecting)} />
        <Button label="断开连接" secondary disabled={disabled} onPress={() => Alert.alert('断开服务器？',
          '本机保留该账号的数据，重新配对同一账号后可以继续同步。', [
            { text: '取消', style: 'cancel' },
            { text: '断开', style: 'destructive', onPress: () => void gym.disconnect() },
          ])} />
      </Card>}
      {(!connection || reconnecting) && <Card>
        <Text style={styles.title}>配对自托管实例</Text>
        <Text style={styles.muted}>在已登录的网页端，从账号设置生成移动端配对码。</Text>
        <Field label="服务器地址" value={address} onChangeText={setAddress} autoCapitalize="none"
          autoCorrect={false} keyboardType="url" placeholder="https://gym.example.com" />
        {address.trim().toLowerCase().startsWith('http://') && <Text style={styles.error}>当前使用局域网 HTTP，配对码和连接令牌将以明文传输。</Text>}
        <Field label="配对码" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} />
        <Button label={gym.operation === 'pair' ? '正在配对…' : '连接服务器'} disabled={disabled || !address.trim() || !code.trim()}
          onPress={() => void gym.connect(address, code)} />
      </Card>}
      <Card>
        <Text style={styles.title}>训练备份</Text>
        <Button label="导出备份" secondary disabled={disabled} onPress={() => void performDataAction(() => exportBackup(gym.workspace!.data))} />
        <Button label="恢复备份" secondary disabled={disabled} onPress={() => void performDataAction(async () => {
          const backup = await pickBackup();
          if (backup) confirmRestore(backup);
        })} />
        {connection && <Button label="合并本机练习" secondary disabled={disabled}
          onPress={() => void performDataAction(async () => confirmRestore(snapshotOf(readLocal(null)), true))} />}
      </Card>
      <Card>
        <Text style={styles.title}>组间到点通知</Text>
        <Button label={gym.workspace.data.restAlerts ? '关闭休息通知' : '开启休息通知'} secondary disabled={dataBusy} onPress={() => {
          if (gym.workspace!.data.restAlerts) { gym.change(data => ({ ...data, restAlerts: false })); return; }
          void performDataAction(async () => {
            if (await enableRestNotifications()) gym.change(data => ({ ...data, restAlerts: true }));
            else Alert.alert('需要通知权限', '请在 Android 设置中允许 openGym 发送通知。', [
              { text: '关闭', style: 'cancel' }, { text: '打开设置', onPress: () => void Linking.openSettings() },
            ]);
          });
        }} />
        {gym.workspace.data.restAlerts && <Button label="闹钟与提醒设置" secondary
          onPress={() => void Linking.sendIntent('android.settings.REQUEST_SCHEDULE_EXACT_ALARM').catch(() => Linking.openSettings())} />}
      </Card>
    </ScrollView>}

    <View accessibilityRole="tablist" style={styles.tabs}>
      {tabs.map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }}
        onPress={() => { setSelected(null); setHistoryExercise(null); setTab(item); }} style={[styles.tab, tab === item && styles.selectedTab]}>
        <Text style={[styles.text, tab === item && styles.selectedLabel]}>{item}</Text>
      </Pressable>)}
    </View>
    {panel && <Modal visible onRequestClose={closePanel}>
      <SafeAreaView style={styles.screen}>
        {panel.kind === 'plan' && <PlanEditor profile={profile} routine={panel.routine} onClose={closePanel} onCustom={onCustom}
          onSave={routine => {
            const original = panel.routine;
            const change: ProfileChange = original ? { kind: 'routine', create: false, routine: {
              id: routine.id,
              ...(routine.name !== original.name ? { name: routine.name } : {}),
              ...(JSON.stringify(routine.ex) !== JSON.stringify(original.ex) ? { ex: routine.ex } : {}),
            } } : { kind: 'routine', create: true, routine };
            if (gym.commit([change])) closePanel();
          }} />}
        {panel.kind === 'schedule' && <ScheduleEditor profile={profile} onClose={closePanel}
          onSave={value => { if (gym.commit([value])) closePanel(); }} />}
        {panel.kind === 'history' && <HistoryEditor profile={profile} workout={panel.workout} unit={panel.unit} onClose={closePanel}
          onSave={patch => { if (gym.commit([{ kind: 'workout', key: workoutKey(panel.workout), unit: panel.unit, patch }])) closePanel(); }} />}
        {panel.kind === 'exercise' && draft && <ExercisePicker profile={profile} onSave={onCustom} onClose={closePanel}
          onPick={target => {
            const previous = panel.replaceIndex == null ? undefined : draft.exercises[panel.replaceIndex]?.target;
            const sameMode = previous && exerciseMode(previous, profile) === exerciseMode(target, profile);
            const next = sameMode ? {
              ...target, sets: previous.sets, reps: previous.reps, sec: previous.sec, min: previous.min,
              restSec: previous.restSec, restOff: previous.restOff,
            } : target;
            if (openWorkout(addExercise(draft, next, profile, queue, panel.replaceIndex))) closePanel();
          }} />}
      </SafeAreaView>
    </Modal>}
  </SafeAreaView>;
}

function describeSet(set: LoggedSet, unit: string) {
  if (set.r != null) return `${set.w ?? 0} ${unit} × ${set.r}`;
  if (set.sec != null) return `${set.sec} 秒${set.w != null ? ` · ${set.w} ${unit}` : ''}`;
  return set.min != null ? `${set.min} 分钟${set.speed != null ? ` · 速度 ${set.speed}` : ''}` : '已完成';
}

function WorkoutDetails({ workout, profile, unit, onExercise }: {
  workout: Workout; profile: Profile; unit: Unit; onExercise: (id: string) => void;
}) {
  const entries = (workout.entries ?? []).filter(Boolean);
  const units = exerciseUnits(entries.map(entry => ({ sg: entry.sg ?? entry.target?.sg })));
  return <>{units.map(indices => {
    const name = indices.length > 1 ? supersetMeta(entries, indices, { onTarget: true }).name : '';
    return <View key={indices[0]} style={styles.stack}>
      {indices.length > 1 && <Text style={styles.title}>{name ? `超级组 · ${name}` : '超级组'}</Text>}
      {indices.map(index => {
        const entry = entries[index];
        return <View key={index} style={styles.stack}>
          <Text style={styles.text}>{exerciseName(profile, entry.id)}</Text>
          <Text style={styles.muted}>{(entry.sets ?? []).filter(set => set?.done)
            .map(set => `${isWarmupRow(set) ? '热身 ' : ''}${describeSet(set, unit)}`).join(' · ')}</Text>
          <Button label="查看动作历史" secondary onPress={() => onExercise(entry.id)} />
        </View>;
      })}
    </View>;
  })}</>;
}

function WorkoutScreen({ profile, draft, queue, onChange, onFinish, onDiscard, onPick }: {
  profile: Profile; draft: Draft; queue: QueuedWorkout[]; onChange: (draft: Draft) => boolean; onFinish: () => void; onDiscard: () => void;
  onPick: (replaceIndex?: number) => void;
}) {
  const list = useRef<ScrollView>(null);
  const positions = useRef(new Map<number, number>());
  const targets = draft.exercises.map(exercise => exercise.target);
  const units = exerciseUnits(targets);
  const groups = units.flatMap(unit => {
    const nextSet = unit.length > 1 ? nextSupersetSet(draft, unit) : undefined;
    return unit.map(() => ({ unit, nextSet }));
  });
  const done = draft.exercises.reduce((total, exercise) => total + exercise.sets.filter(set => set.at !== null).length, 0);
  const restTimer = <RestTimer endsAt={draft.rest?.endsAt ?? null} onCancel={() => onChange({ ...draft, rest: null })} />;
  const workout = <ScrollView ref={list} style={styles.grow} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.heading}>{draft.name}</Text>
    {draft.backfillDay != null && <Card>
      <Field label="补录名称" value={draft.name} onChangeText={name => onChange({ ...draft, name })} maxLength={80} />
      <Field label="补录日期" value={draft.backfillDay} onChangeText={backfillDay => onChange({ ...draft, backfillDay })} placeholder="YYYY-MM-DD" maxLength={10} />
    </Card>}
    <Text style={styles.muted}>已完成 {done} 组</Text>
    {draft.exercises.map((exercise, exerciseIndex) => {
      const name = exerciseName(profile, exercise.target.id);
      const { unit, nextSet } = groups[exerciseIndex];
      const grouped = unit.length > 1;
      const groupName = grouped && unit[0] === exerciseIndex ? supersetMeta(targets, unit).name : '';
      const affected = grouped ? unit : [...(groups[exerciseIndex - 1]?.unit ?? []), exerciseIndex];
      const canGroup = affected.every(index => draft.exercises[index].sets.every(set => set.at === null));
      return <View key={exerciseIndex} onLayout={event => positions.current.set(exerciseIndex, event.nativeEvent.layout.y)}>
        <Card>
          {grouped && unit[0] === exerciseIndex && <Text style={styles.title}>{groupName ? `超级组 · ${groupName}` : '超级组'}</Text>}
          <Text style={styles.title}>{name}</Text>
          {nextSet?.exerciseIndex === exerciseIndex && <Text style={styles.muted}>
            {nextSet.round === null ? `下一组 · ${name}热身` : `第 ${nextSet.round + 1} 轮 · 下一组 ${name}`}
          </Text>}
          {backupExerciseIds(exercise.target, profile)
            .map(id => <Button key={id} label={`替换为 ${exerciseName(profile, id)}`} secondary
              disabled={exercise.sets.some(set => set.at !== null)}
              onPress={() => onChange(swapExercise(draft, exerciseIndex, id, profile, queue))} />)}
          {exercise.target.side && <Text style={styles.muted}>次数填写双侧合计。</Text>}
          {exercise.sets.map((set, setIndex) => {
            const complete = set.at !== null;
            const mode = exercise.target.mode;
            const weightLabel = mode === 'cardio' ? '速度' : '重量';
            const amountLabel = mode === 'cardio' ? '分钟' : mode === 'time' ? '秒' : '次数';
            const valid = validSet(set, mode);
            const available = valid && (!grouped || complete ||
              (nextSet?.exerciseIndex === exerciseIndex && nextSet.setIndex === setIndex));
            const number = exercise.sets.slice(0, setIndex + 1).filter(row => !!row.warmup === !!set.warmup).length;
            const label = set.warmup ? `热身第 ${number} 组` : `第 ${number} 组`;
            const controlLabel = grouped ? `${name} ${label}` : label;
            const controlsRest = draft.rest?.exerciseIndex === exerciseIndex && draft.rest.setIndex === setIndex;
            const editSet = (changes: { weight?: string; reps?: string }) => {
              const edited = updateSet(draft, exerciseIndex, setIndex, { ...changes, at: null });
              onChange(controlsRest ? { ...edited, rest: null } : edited);
            };
            const toggleSet = () => {
              const at = complete ? null : Date.now();
              const next = updateSet(draft, exerciseIndex, setIndex, { at });
              if (at === null) {
                onChange(controlsRest ? { ...next, rest: null } : next);
                return;
              }
              const hasRemainingSets = next.exercises.some(entry => entry.sets.some(row => row.at === null));
              const round = nextSet?.round;
              const seconds = hasRemainingSets && draft.backfillDay == null
                ? round != null && grouped
                  ? supersetRestSeconds(next, unit, round, resolveRestSeconds(undefined, profile.restSec))
                  : resolveRestSeconds(exercise.target, profile.restSec)
                : 0;
              const rest = seconds > 0 ? { endsAt: at + seconds * 1000, exerciseIndex, setIndex } : null;
              if (onChange({ ...next, rest }) && grouped) {
                const upcoming = nextSupersetSet(next, unit);
                if (upcoming && upcoming.exerciseIndex !== exerciseIndex) requestAnimationFrame(() => {
                  const y = positions.current.get(upcoming.exerciseIndex);
                  if (y != null) list.current?.scrollTo({ y, animated: true });
                });
              }
            };
            return <View key={set.key ?? String(setIndex)} style={styles.row}>
              <Text style={styles.muted}>{set.warmup ? `热身 ${number}` : number}</Text>
              <Field label={mode === 'cardio' ? weightLabel : draft.unit} accessibilityLabel={`${controlLabel}${weightLabel}`} value={set.weight} keyboardType="decimal-pad"
                onChangeText={weight => editSet({ weight })} />
              <Field label={amountLabel} accessibilityLabel={`${controlLabel}${amountLabel}`} value={set.reps} keyboardType={mode === 'cardio' ? 'decimal-pad' : 'number-pad'}
                onChangeText={reps => editSet({ reps })} />
              <Pressable accessibilityRole="checkbox" accessibilityLabel={`${controlLabel}完成`}
                accessibilityState={{ checked: complete, disabled: !available }} disabled={!available}
                onPress={toggleSet}
                style={[styles.button, styles.secondary, complete && styles.done, !available && styles.disabled]}>
                <Text style={[styles.buttonLabel, complete && styles.primaryLabel]}>{complete ? '✓' : '记组'}</Text>
              </Pressable>
              {!complete && <Pressable accessibilityRole="button" accessibilityLabel={`删除${controlLabel}`}
                onPress={() => onChange(removeSet(draft, exerciseIndex, setIndex))} style={[styles.button, styles.secondary]}>
                <Text style={styles.buttonLabel}>×</Text>
              </Pressable>}
            </View>;
          })}
          <Button label="添加正式组" secondary disabled={exercise.sets.filter(set => !set.warmup).length >= MAX_WORK_SETS}
            onPress={() => onChange(addWorkSet(draft, exerciseIndex))} />
          <Button label="搜索替换动作" secondary disabled={exercise.sets.some(set => set.at !== null)}
            onPress={() => onPick(exerciseIndex)} />
          {(grouped || exerciseIndex > 0) && <Button label={grouped ? '移出超级组' : '与上一动作组成超级组'} secondary disabled={!canGroup}
            onPress={() => {
              const updated = changeSuperset(targets, exerciseIndex, grouped);
              onChange({ ...draft, exercises: draft.exercises.map((entry, index) => ({ ...entry, target: updated[index] })) });
            }} />}
        </Card>
      </View>;
    })}
    <Button label="添加动作" secondary onPress={() => onPick()} />
    <Button label="完成训练" disabled={done === 0 || (draft.backfillDay != null && (!draft.name.trim() || !validWorkoutDay(draft.backfillDay)))} onPress={onFinish} />
    <Button label="放弃训练" secondary onPress={onDiscard} />
  </ScrollView>;
  return <>{workout}{restTimer}</>;
}

export default function App() {
  return <SafeAreaProvider><AppScreen /></SafeAreaProvider>;
}
