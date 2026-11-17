import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { alpha } from '../color';
import { palette } from '../tokens';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';

export type IconTileProps = {
  name: IconName;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'accent' | 'soft' | 'orange' | 'blue' | 'neutral';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function IconTile({ name, size = 'md', tone = 'accent', style, testID }: IconTileProps) {
  const theme = useTheme();

  const boxSize =
    size === 'sm' ? theme.sizes.tileSm : size === 'lg' ? theme.sizes.tileLg : theme.sizes.tileMd;
  const iconSize = size === 'sm' ? 18 : size === 'lg' ? 22 : 20;
  const borderRadius = size === 'sm' ? theme.radius.xs : size === 'lg' ? 11 : 10;

  const background =
    tone === 'accent'
      ? theme.colors.accent
      : tone === 'soft'
        ? theme.colors.accentSoft
        : tone === 'orange'
          ? alpha(theme.colors.warning, 0.16)
          : tone === 'blue'
            ? alpha(palette.blue, 0.16)
            : theme.colors.surface2;
  const iconColor =
    tone === 'accent'
      ? theme.colors.onAccent
      : tone === 'soft'
        ? theme.colors.accentInk
        : tone === 'orange'
          ? theme.colors.warning
          : tone === 'blue'
            ? palette.blue
            : theme.colors.label2;

  return (
    <View
      accessible={false}
      style={[
        {
          width: boxSize,
          height: boxSize,
          borderRadius,
          backgroundColor: background,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
      testID={testID}
    >
      <Icon color={iconColor} name={name} size={iconSize} />
    </View>
  );
}
