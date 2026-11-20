import { EXALIAS } from '../../frontend/src/lib/exercises-data.js';
import { CATALOGUE_CLIPS, CATALOGUE_STILL } from './catalogueMedia.generated';

export * from './catalogueData';

/** A bundled 180 px still, or null when this build did not include it. */
export function catalogueStill(id) {
  return CATALOGUE_STILL[EXALIAS[id] ?? id] ?? null;
}

/** A bundled 180 px animation staged under Android assets, or null. */
export function catalogueClip(id) {
  const path = CATALOGUE_CLIPS[EXALIAS[id] ?? id];
  return path ? `asset:///${path}` : null;
}
