import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { colors, radii, sizes, type ColorName } from './theme';

export type IconButtonProps = {
  icon: IconName;
  /** Required: an icon-only control has no visible text for a screen reader. */
  accessibilityLabel: string;
  onPress?: () => void;
  /** 48 for header controls, 44 for in-card controls like the 3-dot menu. */
  size?: 44 | 48;
  color?: ColorName;
  /** Press highlight; use `primaryPressed` on blue surfaces. */
  pressedColor?: string;
  iconSize?: number;
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Square, rounded, icon-only tap target (menu, back, close, 3-dot). */
export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = sizes.iconButton,
  color = 'ink',
  pressedColor = colors.tint,
  iconSize = 24,
  expanded,
  style,
  testID,
}: IconButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size === 44 ? 14 : radii.iconButton,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? pressedColor : 'transparent',
        },
        style,
      ]}
    >
      <Icon name={icon} size={iconSize} color={color} />
    </Pressable>
  );
}
