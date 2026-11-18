/** Metro stub for `@capacitor/local-notifications`; RN uses expo-notifications. */
export const LocalNotifications = {
  checkPermissions: async () => ({ display: 'denied' }),
  requestPermissions: async () => ({ display: 'denied' }),
  schedule: async () => ({ notifications: [] }),
  cancel: async () => undefined,
  getPending: async () => ({ notifications: [] }),
  addListener: async () => ({ remove: async () => undefined }),
  registerActionTypes: async () => undefined,
};
