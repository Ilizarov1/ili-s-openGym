/**
 * Metro stub for `@capacitor/core`.
 *
 * The RN client imports pure Web helpers such as `frontend/src/lib/plan-share.js`.
 * Their module graph still names Capacitor plugins in dynamic imports; Metro resolves
 * every dynamic import up front, so the native-only packages must exist even though
 * the RN screens never execute those branches.
 */
export const Capacitor = {
  getPlatform: () => 'web',
  isNativePlatform: () => false,
  isPluginAvailable: () => false,
  convertFileSrc: value => value,
};

export const registerPlugin = (name, implementation) => implementation ?? {};
export const SystemBars = { setStyle: async () => undefined };
