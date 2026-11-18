import * as SecureStore from 'expo-secure-store';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import type { Connection } from './server';
import type { PendingChange } from './profileChanges';
import { practiceProfile, type Draft, type MediaRefLike, type Profile, type QueuedWorkout } from './training';

/** A progress photo whose bytes still have to reach the paired instance. */
export type PhotoUpload = {
  hash: string;
  ref: MediaRefLike;
  /** The local day the photo was filed under; kept so a retry can describe it. */
  d: string;
  /** The verified file in the app's private photo folder. */
  fileUri: string;
  createdAt: number;
  /** Set once `PUT /api/media/{hash}` has been acknowledged. */
  uploadedAt?: number;
  /** The last upload failure, shown as the retry reason. */
  error?: string;
};

export type LocalState = {
  profile: Profile;
  draft: Draft | null;
  queue: QueuedWorkout[];
  workoutDeletes?: Record<string, number>;
  changes?: PendingChange[];
  restAlerts?: boolean;
  /** Per-device workout reminder preference; never synced. */
  reminder?: { on?: boolean; time?: string };
  /** Progress photos waiting for their bytes to be uploaded; local to this workspace. */
  photoUploads?: PhotoUpload[];
};

const connectionKey = 'openGymConnection';
let db: SQLiteDatabase | undefined;

function database() {
  if (!db) {
    const opened = openDatabaseSync('opengym-rn.db');
    opened.execSync('CREATE TABLE IF NOT EXISTS workspace (scope TEXT PRIMARY KEY, state TEXT NOT NULL)');
    db = opened;
  }
  return db;
}

function scopeOf(connection: Connection | null) {
  return connection ? `${connection.server}|${connection.user.id}` : 'practice';
}

export function readLocal(connection: Connection | null): LocalState {
  const row = database().getFirstSync<{ state: string }>('SELECT state FROM workspace WHERE scope = ?', scopeOf(connection));
  return row ? JSON.parse(row.state) as LocalState : {
    profile: connection ? { routines: [], workouts: [] } : practiceProfile,
    draft: null,
    queue: [],
  };
}

export function saveLocal(connection: Connection | null, state: LocalState) {
  database().runSync('INSERT OR REPLACE INTO workspace (scope, state) VALUES (?, ?)', scopeOf(connection), JSON.stringify(state));
}

export async function readConnection() {
  const raw = await SecureStore.getItemAsync(connectionKey);
  return raw ? JSON.parse(raw) as Connection : null;
}

export function saveConnection(connection: Connection | null) {
  return connection
    ? SecureStore.setItemAsync(connectionKey, JSON.stringify(connection))
    : SecureStore.deleteItemAsync(connectionKey);
}
