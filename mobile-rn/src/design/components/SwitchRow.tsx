import { Switch } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { ListRow } from './ListRow';

export type SwitchRowProps = {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
};

/**
 * A settings row: ListRow text with the native switch as the control. The row
 * itself is not pressable so the switch keeps its own touch target and the
 * screen reader announces a switch, not a button.
 */
export function SwitchRow({ title, subtitle, value, onValueChange, disabled = false }: SwitchRowProps) {
  const theme = useTheme();

  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      trailing={
        <Switch
          accessibilityLabel={title}
          accessibilityRole="switch"
          accessibilityState={{ checked: value, disabled }}
          disabled={disabled}
          ios_backgroundColor={theme.colors.surface3}
          onValueChange={onValueChange}
          trackColor={{ false: theme.colors.surface3, true: theme.colors.accent }}
          value={value}
        />
      }
    />
  );
}
