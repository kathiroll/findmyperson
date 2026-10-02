import { useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { Text } from './Text';
import { colors, radii, sizes, spacing, typography } from './theme';

export type FieldProps = Omit<
  TextInputProps,
  'style' | 'accessibilityLabel' | 'placeholderTextColor'
> & {
  label: string;
  /** Shows the "Required" marker beside the label. */
  required?: boolean;
  hint?: string;
  error?: string;
  /** Visible lines for multiline fields. */
  rows?: number;
};

/** Label + text input. The label is also the input's accessible name. */
export function Field({
  label,
  required = false,
  hint,
  error,
  rows,
  multiline,
  onFocus,
  onBlur,
  ...rest
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  const isMultiline = multiline ?? rows !== undefined;
  const lineHeight = 16 * 1.45;
  const height = isMultiline ? Math.round((rows ?? 4) * lineHeight + 26) : sizes.field;
  const borderColor = error ? colors.danger : focused ? colors.primary : colors.borderStrong;

  return (
    <View style={{ gap: spacing[8] }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}
      >
        <Text variant="label">{label}</Text>
        {required ? (
          <Text variant="caption" color="muted">
            Required
          </Text>
        ) : null}
      </View>
      {/* 3px focus ring: an outer border that only shows while focused. */}
      <View
        style={{
          margin: -3,
          padding: 3,
          borderRadius: radii.field + 3,
          borderWidth: 0,
          backgroundColor: focused ? colors.focusRing : 'transparent',
        }}
      >
        <TextInput
          {...rest}
          multiline={isMultiline}
          accessibilityLabel={required ? `${label}, required` : label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={colors.placeholder}
          textAlignVertical={isMultiline ? 'top' : 'center'}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            typography.input,
            {
              height,
              color: colors.ink,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor,
              borderRadius: radii.field,
              paddingHorizontal: spacing[16],
              paddingVertical: isMultiline ? 13 : 0,
            },
          ]}
        />
      </View>
      {error ? (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export type OptionRowProps = {
  label: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
};

/** One choice in a radio group (the deactivate-reason list). */
export function OptionRow({ label, selected, onSelect, disabled = false }: OptionRowProps) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onSelect}
      style={{
        minHeight: sizes.option,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing[14],
        paddingHorizontal: spacing[16],
        backgroundColor: colors.surface,
        borderRadius: radii.option,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.primary : colors.borderStrong,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: selected ? colors.primary : colors.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          <View
            style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }}
          />
        ) : null}
      </View>
      <Text variant="input" style={{ flex: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}
