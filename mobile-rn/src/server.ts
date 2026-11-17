import { inProfileUnit, unitOf, workoutKey, type Profile, type QueuedWorkout } from './training';
import { advanceRotation, applyChanges, type PendingChange } from './profileChanges';

export type Connection = { server: string; token: string; user: { id: string; name: string } };
type ServerState = { state: Profile | null; rev: number };

class RequestError extends Error {
  constructor(readonly status: number) {
    super(`服务器返回 HTTP ${status}`);
  }
}

function lanHost(host: string) {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  const [first, second] = parts;
  return parts.every(part => part <= 255) && (
    first === 10 || first === 127 || (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

export function normalizeServer(address: string) {
  const text = address.trim();
  const input = text.includes('://') ? text : `https://${text}`;
  const match = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(\/[a-z0-9._~/-]*)?$/i.exec(input);
  if (!match) throw new Error('请输入服务器地址，例如 https://gym.example.com。');
  const [, scheme, rawHost, port, path = ''] = match;
  const protocol = scheme.toLowerCase();
  const host = rawHost.toLowerCase();
  if ((port && (Number(port) < 1 || Number(port) > 65535)) || path.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('服务器地址的端口或路径无效。');
  }
  if (protocol === 'http' && !lanHost(host)) throw new Error('HTTP 仅适用于局域网地址，请使用 HTTPS。');
  const portSuffix = port && Number(port) !== (protocol === 'https' ? 443 : 80) ? `:${Number(port)}` : '';
  return `${protocol}://${host}${portSuffix}${path.replace(/\/+$/, '')}`;
}

async function request<T>(server: string, path: string, method: string, token?: string, data?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${server}${path}`, {
      method, headers, signal: controller.signal,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) throw new RequestError(response.status);
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('服务器返回了网页，请检查 openGym 地址。');
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请检查服务器地址和网络。');
    if (error instanceof TypeError) throw new Error('无法连接服务器，请检查网络。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pair(server: string, code: string): Promise<Connection> {
  try {
    const result = await request<Omit<Connection, 'server'>>(server, '/api/pair/redeem', 'POST', undefined, { code: code.trim() });
    if (!result?.token || !result.user?.id) throw new Error('服务器未返回有效的配对信息。');
    return { ...result, server };
  } catch (error) {
    if (error instanceof RequestError && error.status === 400) throw new Error('配对码无效或已过期，请在网页端重新生成。');
    throw error;
  }
}

export async function synchronize(connection: Connection, queue: QueuedWorkout[], deletes: Record<string, number> = {}, changes: PendingChange[] = []) {
  const { server, token } = connection;
  const acknowledged = queue.map(item => item.workout.id);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const snapshot = await request<ServerState>(server, '/api/data', 'GET', token);
      if (!Number.isSafeInteger(snapshot?.rev) || snapshot.rev < 0 || !('state' in snapshot) ||
          (snapshot.state !== null && (typeof snapshot.state !== 'object' || Array.isArray(snapshot.state))) ||
          (snapshot.state?.workouts != null && !Array.isArray(snapshot.state.workouts))) {
        throw new Error('服务器返回了无法识别的训练数据。');
      }
      const profile: Profile = snapshot.state ?? { unit: 'kg', routines: [], workouts: [] };
      const deleted = { ...profile.deleted?.workouts };
      let changed = false;
      const currentWorkouts = (profile.workouts ?? []).filter(Boolean);
      const byKey = new Map(currentWorkouts.map(workout => [workoutKey(workout), workout]));
      for (const [key, at] of Object.entries(deletes)) {
        const target = byKey.get(key);
        const deletion = target ? Math.max(at, target._ts ?? 0, target.end ?? 0) : at;
        if (deletion <= (deleted[key] ?? 0)) continue;
        deleted[key] = deletion;
        changed = true;
      }
      const workouts = currentWorkouts.filter(workout =>
        (!deleted[workoutKey(workout)] || deleted[workoutKey(workout)] <
          (Number(workout._ts) || Number(workout.end) || Number(workout.start) || 0)));
      const existing = new Set(workouts.map(workoutKey));
      const added = queue.filter(({ workout }) => !existing.has(workout.id) &&
        (workout._ts ?? workout.end) > Math.max(deleted[workout.id] ?? 0, profile.resetAt ?? 0));
      const next = applyChanges({
        ...profile,
        ...(changed ? { deleted: { ...profile.deleted, workouts: deleted } } : {}),
        workouts: [...workouts, ...added.map(item => inProfileUnit(item, unitOf(profile)))].sort((a, b) => a.start - b.start),
      }, changes);
      if (!changed && added.length === 0 && (!changes.length || JSON.stringify(next) === JSON.stringify({ ...profile, workouts }))) {
        return { profile: next, acknowledged };
      }
      const outgoing = added.length ? advanceRotation(next, Date.now()) : next;
      const response = await request<{ ok: boolean; rev: number }>(server, '/api/data', 'PUT', token, {
        state: outgoing, baseRev: snapshot.rev, ...(profile._wid ? { baseWid: profile._wid } : {}),
      });
      if (!response?.ok || !Number.isSafeInteger(response.rev)) throw new Error('服务器未确认保存，下次同步会重新核对。');
      return { profile: outgoing, acknowledged };
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) continue;
      if (error instanceof RequestError && error.status === 401) throw new Error('配对已失效，请重新连接同一个账号。');
      throw error;
    }
  }
  throw new Error('其他设备正在更新，稍后重试同步。');
}
