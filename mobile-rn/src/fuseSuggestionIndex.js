import Fuse from 'fuse.js';

/**
 * Build the "you may be looking for" index over the current filter pool.
 * `ignoreLocation` lets a query match inside a longer name ("高位下啦" against
 * "绳索单臂高位下拉") instead of only at the start; 0.4 was calibrated against
 * the catalogue's Chinese names and the sample typo in 05_FUSE_SUGGESTIONS.md.
 *
 * @param {import('./librarySearch').LibraryExercise[]} pool
 * @returns {import('./librarySearch').SuggestionIndex}
 */
export function createFuseSuggestionIndex(pool) {
  const fuse = new Fuse(pool, {
    keys: [
      { name: 'name', weight: 0.75 },
      { name: 'aliases', weight: 0.25 },
    ],
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.4,
    minMatchCharLength: 2,
  });

  return {
    search(query, limit) {
      return fuse.search(query, { limit }).map(hit => hit.item);
    },
  };
}
