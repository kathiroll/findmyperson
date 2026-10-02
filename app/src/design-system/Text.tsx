import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { colors, typography, type ColorName, type TypographyVariant } from './theme';

export type TextProps = RNTextProps & {
  variant?: TypographyVariant;
  color?: ColorName;
  align?: 'left' | 'center' | 'right';
};

/** All copy goes through this so type and colour stay on the tokens. Font scaling stays on. */
export function Text({ variant = 'body', color = 'ink', align, style, ...rest }: TextProps) {
  return (
    <RNText
      {...rest}
      style={[
        typography[variant],
        { color: colors[color] },
        align ? { textAlign: align } : null,
        style,
      ]}
    />
  );
}
