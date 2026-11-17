const { defineConfig, globalIgnores } = require('eslint/config');
const expo = require('eslint-config-expo/flat');
const openGym = require('./scripts/eslint-rules.cjs');

const appFiles = ['App.tsx', 'index.ts', 'src/**/*.{js,jsx,ts,tsx}'];
const screenFiles = ['src/screens/**/*.{js,jsx,ts,tsx}'];
const nativeImports = [
  { name: 'react-dom', message: 'Use React Native components in the app.' },
  {
    name: 'react-native',
    importNames: ['SafeAreaView'],
    message: 'Use Screen or react-native-safe-area-context for safe areas.',
  },
];
const nativePatterns = [
  {
    regex: '^react-native/(?:Libraries|src)(?:/|$)',
    message: 'Import React Native APIs from the public react-native entry point.',
  },
  {
    regex: '^(?:@capacitor(?:-community)?/|react-dom/)',
    message: 'Use the corresponding Expo or React Native API.',
  },
  {
    regex: '(?:^|/)frontend/src/(?:(?:components|views)(?:/|$)|(?:App|main|sheets)(?:\\.[^/]+)?$)',
    message: 'Use RN screens and design components. Shared training logic and catalogue data are allowed.',
  },
  {
    regex: '^(?:\\.\\.?/)+(?:src/)?ui(?:\\.[^/]+)?$',
    message: 'Use components from src/design.',
  },
];

module.exports = defineConfig([
  globalIgnores(['.expo/', 'android/', 'ios/', 'dist/', 'web-build/']),
  expo,
  {
    files: appFiles,
    plugins: { 'open-gym': openGym },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': ['error', { paths: nativeImports, patterns: nativePatterns }],
    },
  },
  {
    files: ['App.tsx', 'index.ts', 'src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    files: ['App.tsx', 'src/**/*.{jsx,tsx}'],
    rules: {
      'open-gym/no-raw-text': 'error',
      'open-gym/require-checkbox-state': 'error',
      'react/jsx-no-leaked-render': ['error', { validStrategies: ['ternary', 'coerce'] }],
    },
  },
  {
    files: appFiles,
    ignores: ['src/design/**'],
    rules: { 'open-gym/use-design-tokens': 'error' },
  },
  {
    files: screenFiles,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          ...nativeImports,
          {
            name: 'react-native',
            importNames: ['Text', 'TextInput', 'Pressable', 'Button', 'Switch', 'TouchableOpacity',
              'TouchableHighlight', 'TouchableWithoutFeedback', 'TouchableNativeFeedback'],
            message: 'Use the corresponding component from src/design.',
          },
          { name: 'expo-sqlite', message: 'Use the storage layer for SQLite access.' },
          { name: 'expo-secure-store', message: 'Use the storage layer for credentials.' },
        ],
        patterns: [
          ...nativePatterns,
          {
            regex: '^\\.\\.(?:/\\.\\.)*/(?:server|storage)(?:\\.[^/]+)?$',
            allowTypeImports: true,
            message: 'Use screen props or useGym to work with server and storage data.',
          },
        ],
      }],
      'no-restricted-globals': ['error', {
        globals: [{ name: 'fetch', message: 'Use the server module for network requests.' }],
        checkGlobalObject: true,
      }],
      'react/no-array-index-key': 'warn',
    },
  },
]);
