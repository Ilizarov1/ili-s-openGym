/** Metro stub for `@capacitor/app`; RN uses its own AppState lifecycle. */
const listener = async () => ({ remove: async () => undefined });

export const App = {
  addListener: listener,
  getState: async () => ({ isActive: true }),
  getInfo: async () => ({ id: 'dev.opengym.rn', name: 'openGym RN', version: '' }),
  minimizeApp: async () => undefined,
  exitApp: async () => undefined,
};
