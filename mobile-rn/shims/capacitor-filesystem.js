/** Metro stub for `@capacitor/filesystem`; RN files use expo-file-system. */
export const Directory = {
  Data: 'DATA',
  Documents: 'DOCUMENTS',
  Cache: 'CACHE',
  External: 'EXTERNAL',
  ExternalStorage: 'EXTERNAL_STORAGE',
};

export const Encoding = { UTF8: 'utf8' };

export const Filesystem = {
  writeFile: async () => ({ uri: '' }),
  readFile: async () => ({ data: '' }),
  deleteFile: async () => undefined,
  mkdir: async () => undefined,
  stat: async () => ({ size: 0, mtime: 0 }),
  readdir: async () => ({ files: [] }),
};
