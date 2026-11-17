import { View } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { Card } from '../components/Card';
import { Divider } from '../components/Divider';
import { ListRow } from '../components/ListRow';
import { Sheet } from '../components/Sheet';

export type ActionItem = {
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'accent';
  onPress: () => void;
};

export type ActionSheetProps = {
  visible: boolean;
  title?: string;
  items: ActionItem[];
  onClose: () => void;
};

/**
 * Bottom-sheet action menu built from Sheet and ListRow. The sheet closes before
 * the chosen action runs so a follow-up Alert or panel never stacks on top of a
 * visible sheet.
 */
export function ActionSheet({ visible, title, items, onClose }: ActionSheetProps) {
  const theme = useTheme();

  const iconColor = (tone: ActionItem['tone']): string => {
    if (tone === 'danger') return theme.colors.danger;
    if (tone === 'accent') return theme.colors.accentInk;
    return theme.colors.label;
  };

  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <Card padded={false}>
        {items.map((item, index) => (
          <View key={`${item.label}-${index}`}>
            {index > 0 ? <Divider inset={theme.layout.listRowPaddingX} /> : null}
            <ListRow
              accessibilityLabel={item.label}
              leading={
                item.icon ? (
                  <Icon color={iconColor(item.tone)} name={item.icon} size={20} />
                ) : undefined
              }
              onPress={() => {
                onClose();
                item.onPress();
              }}
              title={item.label}
              titleTone={item.tone === 'danger' ? 'danger' : item.tone === 'accent' ? 'accent' : 'label'}
            />
          </View>
        ))}
      </Card>
    </Sheet>
  );
}
