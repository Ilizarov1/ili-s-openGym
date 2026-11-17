const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ESLint } = require('eslint');

const eslint = new ESLint({ cwd: path.resolve(__dirname, '..') });

async function lint(code, filePath = 'src/screens/LintExample.jsx') {
  const [result] = await eslint.lintText(code, { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages.filter(message => message.severity === 2).map(message => message.ruleId);
}

test('wrapper components can render text and numeric children', async () => {
  assert.deepEqual(await lint(`
    import { View } from 'react-native';
    import { Badge, Button, Chip, Text } from '../design';
    export const Example = () => <View>
      <Badge>Active</Badge><Button>Save</Button><Chip>All</Chip><Text>{0}</Text>
    </View>;
  `), []);
});

test('literal, template, and conditional children outside Text report errors', async () => {
  assert.deepEqual(await lint(`
    import { View } from 'react-native';
    export const Example = ({ flag }) => <View>Save{\`Workout\`}{flag ? 0 : null}</View>;
  `), Array(3).fill('open-gym/no-raw-text'));
});

test('style checking covers sheets, named theme factories, and JSX style arrays', async () => {
  assert.deepEqual(await lint(`
    import { StyleSheet as NativeStyleSheet, View } from 'react-native';
    import { useThemedStyles as useStyles } from '../design';
    const spacing = 8;
    const base = NativeStyleSheet.create({ root: { gap: spacing } });
    function buildStyles() { return { root: { borderRadius: 4 } }; }
    export function Example() {
      const themed = useStyles(buildStyles);
      return <View style={[base.root, themed.root, { backgroundColor: 'red' }]} />;
    }
  `), Array(3).fill('open-gym/use-design-tokens'));
});

test('theme values, layout primitives, and spacing resets are permitted', async () => {
  assert.deepEqual(await lint(`
    import { View } from 'react-native';
    import { useTheme } from '../design';
    export function Example() {
      const theme = useTheme();
      return <View style={{ padding: theme.space.sm, width: '100%', flex: 1, gap: 0 }} />;
    }
  `), []);
});

test('checkboxes must have a checked accessibility state', async () => {
  assert.deepEqual(await lint(`
    import { PressableScale } from '../design';
    export const Example = () => <>
      <PressableScale accessibilityRole="checkbox" />
      <PressableScale accessibilityRole={'checkbox'} accessibilityState={{ disabled: true }} />
      <PressableScale accessibilityRole="checkbox" accessibilityState={undefined} />
      <PressableScale accessibilityRole="checkbox" accessibilityState={{ checked: false }} />
    </>;
  `), Array(3).fill('open-gym/require-checkbox-state'));
});

test('a potentially numeric JSX condition cannot render its value', async () => {
  assert.deepEqual(await lint(`
    import { View } from 'react-native';
    export const Example = ({ sets }) => <View>{sets.length && <View />}</View>;
  `), ['react/jsx-no-leaked-render']);
});

test('screen import restrictions also preserve the app runtime restrictions', async () => {
  assert.deepEqual(await lint(`
    import { readFile } from 'node:fs';
    export { Text, SafeAreaView } from 'react-native';
    export { readFile };
    export { default as Icon } from '../../../frontend/src/components/Icon.jsx';
  `), [
    'import/no-nodejs-modules',
    'no-restricted-imports',
    'no-restricted-imports',
    'no-restricted-imports',
  ]);
});
