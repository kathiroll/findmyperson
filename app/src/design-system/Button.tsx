import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { colors, motion, pill, sizes, spacing, type ColorName } from './theme';

export type ButtonVariant = 'primary' | 'ghost' | 'tint' | 'onBlue' | 'destructive';
export type ButtonSize = 'large' | 'compact' | 'small';

type Palette = { background: string; pressed: string; label: ColorName };

const palettes: Record<ButtonVariant, Palette> = {
  primary: { background: colors.primary, pressed: colors.primaryPressed, label: 'white' },
  /** The mockups' "quiet" button: white fill, ink label. */
  ghost: { background: colors.surface, pressed: colors.tint, label: 'ink' },
  tint: { background: colors.tint, pressed: colors.tintPressed, label: 'primaryPressed' },
  /** White button for use on the blue brand surfaces. */
  onBlue: { background: colors.white, pressed: colors.tint, label: 'primaryPressed' },
  destructive: { background: colors.danger, pressed: colors.dangerPressed, label: 'white' },
};

const heights: Record<ButtonSize, number> = {
  large: sizes.buttonLarge,
  compact: sizes.buttonCompact,
  small: sizes.buttonSmall,
};

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  icon?: IconName;
  /** Trailing glyph, e.g. `arrow` on forward actions. */
  trailingIcon?: IconName;
  /** Defaults to `label`; set when the visible text alone is ambiguous. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Stretch to the container width (default) or hug the content. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'large',
  disabled = false,
  icon,
  trailingIcon,
  accessibilityLabel,
  accessibilityHint,
  fullWidth = true,
  style,
  testID,
}: ButtonProps) {
  const palette = palettes[variant];
  const height = heights[size];
  const labelColor: ColorName = disabled ? 'disabledText' : palette.label;
  const iconSize = size === 'large' ? 20 : 16;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          minHeight: sizes.minTarget,
          borderRadius: pill(height),
          backgroundColor: disabled
            ? colors.disabledSurface
            : pressed
              ? palette.pressed
              : palette.background,
          paddingHorizontal: size === 'large' ? spacing[24] : spacing[16],
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          transform: [{ scale: pressed && !disabled ? motion.pressScale : 1 }],
        },
        style,
      ]}
    >
      <View style={styles.content}>
        {icon ? <Icon name={icon} size={iconSize} color={labelColor} strokeWidth={2.2} /> : null}
        <Text variant={size === 'large' ? 'button' : 'buttonSmall'} color={labelColor}>
          {label}
        </Text>
        {trailingIcon ? (
          <Icon name={trailingIcon} size={iconSize} color={labelColor} strokeWidth={2.2} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[8],
  },
});
