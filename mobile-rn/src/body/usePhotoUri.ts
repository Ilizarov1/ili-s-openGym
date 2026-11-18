import { useEffect, useState } from 'react';
import type { Connection } from '../server';
import type { MediaRefLike } from '../training';
import { localPhotoUriFor, resolvePhotoUri } from './photos';

export type PhotoUriState = { uri: string | null; loading: boolean; failed: boolean };

/**
 * Resolves a progress photo for display: local verified file first, then the authenticated
 * `/api/media/{hash}` fallback. The hook never hands the previous workspace's URI to a new
 * photo; state is reset when the ref or connection changes.
 */
export function usePhotoUri(ref: MediaRefLike | null | undefined, connection: Connection | null): PhotoUriState {
  const key = ref ? `${ref.hash}|${ref.mime ?? ''}|${ref.size ?? ''}` : '';
  const scope = connection ? `${connection.server}|${connection.user.id}|${connection.token}` : 'practice';
  const [state, setState] = useState<PhotoUriState & { key: string }>(() => ({
    key: `${scope}\u0000${key}`,
    uri: ref ? localPhotoUriFor(ref, connection) : null,
    loading: !!ref,
    failed: false,
  }));

  useEffect(() => {
    let active = true;
    const current = `${scope}\u0000${key}`;
    if (!ref) {
      setState({ key: current, uri: null, loading: false, failed: false });
      return () => { active = false; };
    }
    const local = localPhotoUriFor(ref, connection);
    if (local) {
      setState({ key: current, uri: local, loading: false, failed: false });
      return () => { active = false; };
    }
    setState({ key: current, uri: null, loading: true, failed: false });
    resolvePhotoUri(ref, connection).then(uri => {
      if (active) setState({ key: current, uri, loading: false, failed: uri == null });
    }).catch(() => {
      if (active) setState({ key: current, uri: null, loading: false, failed: true });
    });
    return () => { active = false; };
  }, [connection, key, ref, scope]);

  const current = `${scope}\u0000${key}`;
  return state.key === current ? state : { uri: null, loading: !!ref, failed: false };
}
