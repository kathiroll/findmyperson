import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { colors, radii, spacing } from './theme';

export type CardVariant = 'surface' | 'outlined' | 'attention';

export type CardProps = ViewProps & {
  /**
   * `surface`: white card with a hairline border (report card, lists).
   * `outlined`: transparent status pill (capture healthy).
   * `attention`: white card with an amber border (capture needs fixing).
   */
  variant?: CardVariant;
  style?: StyleProp<ViewStyle>;
};

const variants: Record<CardVariant, ViewStyle> = {
  surface: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing[20],
    gap: spacing[16],
  },
  outlined: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.statusPill,
    paddingVertical: spacing[14],
    paddingHorizontal: spacing[18],
  },
  attention: {
    backgroundColor: colors.surface,
    borderColor: colors.warningBorder,
    borderWidth: 1.5,
    borderRadius: radii.card,
    padding: spacing[20],
    gap: spacing[16],
  },
};

export function Card({ variant = 'surface', style, ...rest }: CardProps) {
  return <View {...rest} style={[variants[variant], style]} />;
}
