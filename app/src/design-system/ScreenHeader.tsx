import { View } from 'react-native';
import { IconButton } from './IconButton';
import { Icon } from './Icon';
import { Text } from './Text';
import { sizes, spacing } from './theme';

type BrandProps = {
  variant: 'brand';
  /** Opens the hamburger menu. Omit on screens that have no menu. */
  onMenuPress?: () => void;
  onBlue?: boolean;
};

type BackProps = {
  variant: 'back';
  title: string;
  onBackPress: () => void;
  backLabel?: string;
  /** Right-aligned caption such as "Step 2 of 2". */
  trailing?: string;
};

type CloseProps = {
  variant: 'close';
  title: string;
  onClosePress: () => void;
};

export type ScreenHeaderProps = (BrandProps | BackProps | CloseProps) & { testID?: string };

/**
 * `brand`: logo + wordmark with the hamburger on the right (home screens).
 * `back`: back arrow, title and step caption (report flow).
 * `close`: close button and title (bystander match).
 */
export function ScreenHeader(props: ScreenHeaderProps) {
  if (props.variant === 'brand') {
    const tone = props.onBlue ? 'white' : 'primary';
    return (
      <View
        testID={props.testID}
        accessibilityRole="header"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: spacing[12],
          paddingBottom: spacing[8],
          paddingLeft: sizes.gutter,
          paddingRight: spacing[16],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[10] }}>
          <Icon name="logo" size={22} color={tone} />
          <Text variant="brand" color={props.onBlue ? 'white' : 'ink'}>
            findmyperson
          </Text>
        </View>
        {props.onMenuPress ? (
          <IconButton
            icon="menu"
            accessibilityLabel="Open menu"
            color={props.onBlue ? 'white' : 'ink'}
            onPress={props.onMenuPress}
          />
        ) : null}
      </View>
    );
  }

  const leading =
    props.variant === 'back' ? (
      <IconButton
        icon="back"
        accessibilityLabel={props.backLabel ?? 'Back'}
        onPress={props.onBackPress}
      />
    ) : (
      <IconButton icon="close" accessibilityLabel="Close" onPress={props.onClosePress} />
    );

  return (
    <View
      testID={props.testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing[4],
        paddingTop: spacing[12],
        paddingLeft: spacing[12],
        paddingRight: sizes.gutter,
      }}
    >
      {leading}
      <Text variant="itemTitle" accessibilityRole="header" style={{ flexGrow: 1, flexShrink: 1 }}>
        {props.title}
      </Text>
      {props.variant === 'back' && props.trailing ? (
        <Text variant="caption" color="muted">
          {props.trailing}
        </Text>
      ) : null}
    </View>
  );
}
