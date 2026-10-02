import { View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { colors, radii } from './theme';
import type { ColorName } from './theme';

export type IconChipProps = {
  icon: IconName;
  /** Chip edge in px: 64 for report cards, 72 for the bystander match card. */
  size?: 48 | 64 | 72;
  iconColor?: ColorName;
  /** Set when the chip stands in for content (e.g. "Photo placeholder"); otherwise it is hidden from screen readers. */
  accessibilityLabel?: string;
  testID?: string;
};

/** Tinted rounded square holding a glyph: photo placeholders, list leaders. */
export function IconChip({
  icon,
  size = 64,
  iconColor = 'muted',
  accessibilityLabel,
  testID,
}: IconChipProps) {
  return (
    <View
      testID={testID}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel !== undefined ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel !== undefined ? 'yes' : 'no-hide-descendants'}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size === 72 ? radii.photo : radii.iconChip,
        backgroundColor: colors.tint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.44)} color={iconColor} strokeWidth={1.8} />
    </View>
  );
}
