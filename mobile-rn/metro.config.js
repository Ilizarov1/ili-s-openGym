const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../frontend/src'),
  path.resolve(__dirname, '../api/agent-runtime'),
  path.resolve(__dirname, '../catalogue/media'),
];

// Pure Web helpers shared with the RN client still mention Capacitor plugins in
// dynamic imports. Metro resolves every dynamic import up front, so point them at
// inert shims; the RN code never calls these branches.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@capacitor/core': path.resolve(__dirname, 'shims/capacitor-core.js'),
  '@capacitor/app': path.resolve(__dirname, 'shims/capacitor-app.js'),
  '@capacitor/filesystem': path.resolve(__dirname, 'shims/capacitor-filesystem.js'),
  '@capacitor/local-notifications': path.resolve(__dirname, 'shims/capacitor-local-notifications.js'),
  '@capacitor/share': path.resolve(__dirname, 'shims/capacitor-share.js'),
};
module.exports = config;
