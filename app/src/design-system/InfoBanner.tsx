import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { colors, radii, spacing } from './theme';

export type InfoBannerProps = {
  message: string;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Tinted note with a leading info glyph ("Please don't swipe the app closed…"). */
export function InfoBanner({ message, icon = 'info', style, testID }: InfoBannerProps) {
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={message}
      style={[
        {
          flexDirection: 'row',
          gap: spacing[12],
          paddingVertical: spacing[14],
          paddingHorizontal: spacing[16],
          backgroundColor: colors.tint,
          borderRadius: radii.banner,
        },
        style,
      ]}
    >
      <Icon name={icon} size={22} color="primaryPressed" />
      <Text variant="bodySmall" style={{ flex: 1 }}>
        {message}
      </Text>
    </View>
  );
}
