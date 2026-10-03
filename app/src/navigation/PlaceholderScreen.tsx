import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Card,
  ScreenHeader,
  Text,
  colors,
  sizes,
  spacing,
  type ScreenHeaderProps,
} from '../design-system';

export type PlaceholderScreenProps = {
  header: ScreenHeaderProps;
  title: string;
  /** What the later screen task will build here. */
  description: string;
  /** Temporary links to the screens reachable from this one. */
  children?: ReactNode;
  testID: string;
};

/**
 * Stand-in body shared by every route until its real screen lands. Later screen tasks replace
 * the screen component in `screens.tsx`; this file is then deleted once nothing uses it.
 */
export function PlaceholderScreen({
  header,
  title,
  description,
  children,
  testID,
}: PlaceholderScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader {...header} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[24],
          paddingBottom: spacing[24] + insets.bottom,
          gap: spacing[20],
        }}
      >
        <Text variant="title">{title}</Text>
        <Card variant="outlined">
          <Text variant="body" color="muted">
            {description}
          </Text>
        </Card>
        {children}
      </ScrollView>
    </View>
  );
}
