import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { normalizeServer, pair, synchronize, type Connection } from './server';
import { readConnection, readLocal, saveConnection, saveLocal, type LocalState } from './storage';
import { applyChanges, prepareChanges, type ProfileChange } from './profileChanges';
import { pendingPhotoCount, uploadPendingPhotos } from './body';

type Workspace = { connection: Connection | null; data: LocalState };
type Operation = 'pair' | 'sync' | 'disconnect';

function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function useGym() {
  const current = useRef<Workspace | null>(null);
  const active = useRef<Operation | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [notice, setNotice] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);

  const show = useCallback((next: Workspace) => {
    current.current = next;
    setWorkspace(next);
  }, []);

  useEffect(() => {
    let mounted = true;
    async function initialize() {
      const connection = await readConnection();
      if (mounted) show({ connection, data: readLocal(connection) });
    }
    initialize().catch(() => {
      if (mounted) setNotice('本机数据读取失败，请关闭后重开应用。');
    });
    return () => { mounted = false; };
  }, [show]);

  const change = useCallback((update: (data: LocalState) => LocalState) => {
    const previous = current.current;
    if (!previous) return false;
    try {
      const data = update(previous.data);
      saveLocal(previous.connection, data);
      show({ ...previous, data });
      return true;
    } catch {
      setNotice('本机保存失败，请检查可用存储空间。');
      return false;
    }
  }, [show]);

  function commit(values: ProfileChange[]) {
    const changes = prepareChanges(values);
    return change(data => ({
      ...data,
      profile: applyChanges(data.profile, changes),
      queue: values.some(value => value.kind === 'workout') ? data.queue.map(item => {
        const updated = applyChanges({ unit: item.unit, workouts: [item.workout] }, changes).workouts?.[0];
        return updated ? { ...item, workout: { ...updated, id: item.workout.id } } : item;
      }) : data.queue,
      changes: current.current?.connection ? [...(data.changes ?? []), ...changes] : data.changes,
    }));
  }

  const run = useCallback(async (kind: Operation, work: () => Promise<void>) => {
    if (active.current) return;
    active.current = kind;
    setOperation(kind);
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice(message(error));
    } finally {
      active.current = null;
      setOperation(null);
    }
  }, []);

  const sync = useCallback(async () => {
    const before = current.current;
    if (!before?.connection) return;
    const { connection } = before;
    await run('sync', async () => {
      // Photo bytes have to reach the instance before the state that references them.
      // The queue is retried on every sync; references are never added here twice.
      const photoResult = await uploadPendingPhotos(connection, current.current?.data ?? before.data);
      if (photoResult.uploaded || photoResult.failed) {
        const latest = current.current ?? before;
        const uploadedData: LocalState = {
          ...latest.data,
          // A confirmed upload never needs retrying: keep only the bytes that still
          // have to reach this instance, so the queue cannot grow for the app's life.
          photoUploads: photoResult.uploads.filter(item => !item.uploadedAt),
        };
        saveLocal(connection, uploadedData);
        show({ connection, data: uploadedData });
      }
      const base = current.current ?? before;
      const { profile, acknowledged } = await synchronize(connection, base.data.queue, base.data.workoutDeletes, base.data.changes);
      const latest = current.current!;
      const done = new Set(acknowledged);
      const sentChanges = new Set(base.data.changes?.map(item => item.id));
      const changes = latest.data.changes?.filter(item => !sentChanges.has(item.id));
      const workoutDeletes = Object.fromEntries(Object.entries(latest.data.workoutDeletes ?? {}).filter(
        ([key, at]) => at !== base.data.workoutDeletes?.[key],
      ));
      const data: LocalState = {
        ...latest.data,
        profile: changes?.length ? applyChanges(profile, changes) : profile,
        changes,
        workoutDeletes,
        queue: latest.data.queue.filter(item => !done.has(item.workout.id)),
      };
      saveLocal(connection, data);
      show({ connection, data });
      setLastSync(Date.now());
    });
  }, [run, show]);

  const syncInBackground = useCallback(() => {
    sync().catch(error => setNotice(message(error)));
  }, [sync]);

  const connection = workspace?.connection;
  const pending = (workspace?.data.queue.length ?? 0) + Object.keys(workspace?.data.workoutDeletes ?? {}).length + (workspace?.data.changes?.length ?? 0) + (workspace ? pendingPhotoCount(workspace.data) : 0);
  useEffect(() => {
    if (!connection) return;
    syncInBackground();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') syncInBackground(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') syncInBackground(); }, 30000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [connection, syncInBackground]);

  useEffect(() => {
    if (pending > 0) syncInBackground();
  }, [pending, syncInBackground]);

  function connect(address: string, code: string) {
    return run('pair', async () => {
      const next = await pair(normalizeServer(address), code);
      const data = readLocal(next);
      await saveConnection(next);
      setLastSync(null);
      show({ connection: next, data });
    });
  }

  function disconnect() {
    return run('disconnect', async () => {
      const data = readLocal(null);
      await saveConnection(null);
      setLastSync(null);
      show({ connection: null, data });
    });
  }

  return { workspace, operation, notice, lastSync, pending, change, commit, connect, disconnect, sync };
}
