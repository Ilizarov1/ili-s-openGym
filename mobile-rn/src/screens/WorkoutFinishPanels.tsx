// The two prompts around ending a live workout: the finish panel (nothing logged,
// finished early, or every set done) and the "whole workout done" prompt raised the
// first time the last unfinished set is ticked. Both only report the choice.

import { View } from 'react-native';
import { Button, Sheet, Text, useTheme } from '../design';

export type WorkoutFinishPanelProps = {
  visible: boolean;
  done: number;
  total: number;
  onSave: () => void;
  onDiscard: () => void;
  onContinue: () => void;
};

export function WorkoutFinishPanel({ visible, done, total, onSave, onDiscard, onContinue }: WorkoutFinishPanelProps) {
  const theme = useTheme();
  const remaining = Math.max(0, total - done);
  const title = done === 0 ? '尚未记组' : remaining > 0 ? '提前结束？' : '结束训练？';
  const message = done === 0
    ? '还没有勾选任何组。仍要结束并保存为空记录吗？'
    : remaining > 0 ? `还有 ${remaining} 组未完成。现在结束并保存已完成的组吗？`
      : '全部组已完成。结束并保存这次训练吗？';
  return (
    <Sheet
      footer={
        <View style={{ gap: theme.space.sm }}>
          <Button onPress={onSave} testID="finish-save" variant="primary">结束并保存</Button>
          <Button onPress={onContinue} variant="secondary">继续训练</Button>
          <Button onPress={onDiscard} variant="ghost">放弃训练</Button>
        </View>
      }
      onClose={onContinue}
      testID="finish-panel"
      title={title}
      visible={visible}
    >
      <Text tone="secondary" variant="body">{message}</Text>
    </Sheet>
  );
}

export type WorkoutCompletePromptProps = {
  visible: boolean;
  onSave: () => void;
  onContinue: () => void;
};

export function WorkoutCompletePrompt({ visible, onSave, onContinue }: WorkoutCompletePromptProps) {
  const theme = useTheme();
  return (
    <Sheet
      footer={
        <View style={{ gap: theme.space.sm }}>
          <Button icon="flag" onPress={onSave} testID="complete-save" variant="primary">结束并保存</Button>
          <Button onPress={onContinue} variant="secondary">继续训练</Button>
        </View>
      }
      onClose={onContinue}
      testID="workout-complete-prompt"
      title="全部完成！"
      visible={visible}
    >
      <Text tone="secondary" variant="body">
        所有动作都已完成。可以结束保存，也可以继续添加动作。
      </Text>
    </Sheet>
  );
}
