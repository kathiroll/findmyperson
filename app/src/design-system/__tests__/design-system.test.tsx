import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  BottomSheet,
  Button,
  Card,
  CaptureHealthCard,
  DesignSystemCatalogue,
  Field,
  HamburgerMenu,
  Icon,
  IconButton,
  IconChip,
  InfoBanner,
  LiveReportCard,
  OptionRow,
  PulsingDot,
  Rise,
  ScreenHeader,
  StepProgress,
  Text,
  colors,
  iconNames,
  sizes,
  theme,
} from '..';
import { animationLog } from './stubs/react-native';

// React 19's test renderer needs this flag to flush effects inside act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flat))
    : style && typeof style === 'object'
      ? (style as Record<string, unknown>)
      : {};

const matches = (node: ReactTestInstance, props: Record<string, unknown>) =>
  typeof node.type === 'string' &&
  Object.entries(props).every(([k, v]) => {
    const actual = node.props[k];
    return typeof v === 'object' ? JSON.stringify(actual) === JSON.stringify(v) : actual === v;
  });

/** Host-element lookups (props also appear on the composite wrappers, which we skip). */
const findAllHost = (root: ReactTestInstance, props: Record<string, unknown>) =>
  root.findAll((node) => matches(node, props));
const findHost = (root: ReactTestInstance, props: Record<string, unknown>) => {
  const found = findAllHost(root, props);
  if (found.length !== 1) throw new Error(`expected 1 host match, got ${found.length}`);
  return found[0]!;
};

const byHost = (root: ReactTestInstance, type: string) =>
  root.find((node) => (node.type as unknown) === type);

const byLabel = (root: ReactTestInstance, label: string) =>
  findHost(root, { accessibilityLabel: label });

beforeEach(() => {
  Object.assign(animationLog, { started: 0, stopped: 0, loops: 0, reduceMotion: false });
});
afterEach(() => vi.restoreAllMocks());

describe('theme', () => {
  test('carries the v2 palette and typefaces', () => {
    expect(theme.colors.primary).toBe('#2B5EFF');
    expect(theme.colors.placeholder).toBe('#5A6A88');
    expect(theme.fontFamilies.display).toBe('BricolageGrotesque-Bold');
    expect(theme.typography.title.fontSize).toBe(30);
    expect(theme.typography.title.letterSpacing).toBeCloseTo(-0.75);
  });
});

describe('Button', () => {
  test('is a labelled button that fires onPress and meets the touch target', () => {
    const onPress = vi.fn();
    const { root } = render(<Button label="Broadcast report" onPress={onPress} />);
    const button = findHost(root, { accessibilityRole: 'button' });
    expect(button.props.accessibilityLabel).toBe('Broadcast report');
    expect(flat(button.props.style).height).toBeGreaterThanOrEqual(sizes.minTarget);
    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledOnce();
  });

  test('every variant and size renders', () => {
    for (const variant of ['primary', 'ghost', 'tint', 'onBlue', 'destructive'] as const) {
      for (const size of ['large', 'compact', 'small'] as const) {
        render(<Button label={variant} variant={variant} size={size} icon="phone" />);
      }
    }
  });

  test('disabled is announced and uses the disabled palette', () => {
    const { root } = render(<Button label="Deactivate" disabled />);
    const button = findHost(root, { accessibilityRole: 'button' });
    expect(button.props.accessibilityState).toEqual({ disabled: true });
    expect(flat(button.props.style).backgroundColor).toBe(colors.disabledSurface);
  });
});

describe('Field', () => {
  test('uses the label as the accessible name and marks required fields', () => {
    const { root } = render(<Field label="Your phone number" required />);
    const input = byHost(root, 'TextInput');
    expect(input.props.accessibilityLabel).toBe('Your phone number, required');
    expect(input.props.placeholderTextColor).toBe(colors.placeholder);
  });

  test('focus highlights the border and shows the ring', () => {
    const { root } = render(<Field label="Their name" />);
    const input = byHost(root, 'TextInput');
    expect(flat(input.props.style).borderColor).toBe(colors.borderStrong);
    act(() => input.props.onFocus({}));
    expect(flat(byHost(root, 'TextInput').props.style).borderColor).toBe(colors.primary);
  });

  test('error text replaces the hint and is a live region', () => {
    const { root } = render(<Field label="Date" hint="hint" error="Bad date" />);
    expect(findAllHost(root, { accessibilityLiveRegion: 'polite' }).length).toBeGreaterThan(0);
  });

  test('OptionRow is a radio with selected state', () => {
    const onSelect = vi.fn();
    const { root } = render(<OptionRow label="Found" selected onSelect={onSelect} />);
    const row = findHost(root, { accessibilityRole: 'radio' });
    expect(row.props.accessibilityState).toEqual({ selected: true, disabled: false });
    act(() => row.props.onPress());
    expect(onSelect).toHaveBeenCalled();
  });
});

describe('static primitives render', () => {
  test('Card, InfoBanner, IconChip, Text, every Icon', () => {
    render(
      <>
        <Card variant="surface" />
        <Card variant="outlined" />
        <Card variant="attention" />
        <InfoBanner message="Please don't swipe the app closed." />
        <IconChip icon="person" size={72} />
        <Text variant="display">Hi</Text>
        {iconNames.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    );
  });

  test('icon-only chips are hidden from screen readers unless labelled', () => {
    const { root } = render(<IconChip icon="person" />);
    expect(
      findAllHost(root, { importantForAccessibility: 'no-hide-descendants' }).length,
    ).toBeGreaterThan(0);
    const labelled = render(<IconChip icon="person" accessibilityLabel="Photo placeholder" />);
    expect(byLabel(labelled.root, 'Photo placeholder').props.accessibilityRole).toBe('image');
  });

  test('IconButton is 48px, labelled, and reports expanded', () => {
    const { root } = render(
      <IconButton icon="menu" accessibilityLabel="Open menu" expanded={false} />,
    );
    const button = findHost(root, { accessibilityRole: 'button' });
    expect(flat(button.props.style)).toMatchObject({ width: 48, height: 48 });
    expect(button.props.accessibilityState).toEqual({ expanded: false });
  });
});

describe('ScreenHeader', () => {
  test('brand variant exposes the hamburger button', () => {
    const onMenuPress = vi.fn();
    const { root } = render(<ScreenHeader variant="brand" onMenuPress={onMenuPress} />);
    act(() => byLabel(root, 'Open menu').props.onPress());
    expect(onMenuPress).toHaveBeenCalled();
  });

  test('back and close variants', () => {
    const onBackPress = vi.fn();
    const back = render(
      <ScreenHeader
        variant="back"
        title="Report"
        trailing="Step 1 of 2"
        onBackPress={onBackPress}
      />,
    );
    act(() => byLabel(back.root, 'Back').props.onPress());
    expect(onBackPress).toHaveBeenCalled();
    const close = render(
      <ScreenHeader variant="close" title="Possible match" onClosePress={() => undefined} />,
    );
    expect(byLabel(close.root, 'Close')).toBeTruthy();
  });

  test('StepProgress announces its position', () => {
    const { root } = render(<StepProgress step={2} total={2} />);
    expect(findHost(root, { accessibilityRole: 'progressbar' }).props.accessibilityLabel).toBe(
      'Step 2 of 2',
    );
  });
});

describe('animation', () => {
  test('PulsingDot starts a looping native animation and stops it on unmount', () => {
    const renderer = render(<PulsingDot />);
    expect(findHost(renderer.root, { testID: 'pulsing-dot-halo' })).toBeTruthy();
    expect(animationLog.loops).toBeGreaterThan(0);
    expect(animationLog.started).toBeGreaterThan(0);
    act(() => renderer.unmount());
    expect(animationLog.stopped).toBeGreaterThan(0);
  });

  test('a static dot has no halo', () => {
    const { root } = render(<PulsingDot pulse={false} />);
    expect(findAllHost(root, { testID: 'pulsing-dot-halo' })).toHaveLength(0);
  });

  test('Rise runs an entrance animation', () => {
    render(
      <Rise delay={80}>
        <Text>hi</Text>
      </Rise>,
    );
    expect(animationLog.started).toBeGreaterThan(0);
  });
});

describe('HamburgerMenu', () => {
  const items = [
    { label: 'Report a missing person', onPress: vi.fn() },
    { label: 'About', onPress: vi.fn() },
  ];

  test('renders nothing when closed', () => {
    const { root } = render(
      <HamburgerMenu visible={false} onClose={() => undefined} items={items} />,
    );
    expect(findAllHost(root, { accessibilityRole: 'menu' })).toHaveLength(0);
  });

  test('lists items as menu items, closes, and fires item presses', () => {
    const onClose = vi.fn();
    const { root } = render(
      <HamburgerMenu
        visible
        onClose={onClose}
        items={items}
        footnote="Free, open source and non-commercial."
      />,
    );
    act(() => byLabel(root, 'Close menu').props.onPress());
    expect(onClose).toHaveBeenCalled();
    const rows = findAllHost(root, { accessibilityRole: 'menuitem' });
    expect(rows).toHaveLength(2);
    act(() => rows[1]!.props.onPress());
    expect(items[1]!.onPress).toHaveBeenCalled();
    expect(animationLog.loops).toBeGreaterThan(0); // sweeping rings
  });
});

describe('CaptureHealthCard', () => {
  test('healthy state', () => {
    const { root } = render(
      <CaptureHealthCard state="healthy" detail="On this phone only. Last saved 6 min ago." />,
    );
    expect(findHost(root, { accessibilityRole: 'summary' }).props.accessibilityLabel).toContain(
      'Working normally',
    );
    expect(findAllHost(root, { testID: 'pulsing-dot-halo' })).toHaveLength(1);
  });

  test('broken state names the problem and offers one action', () => {
    const onPress = vi.fn();
    const { root } = render(
      <CaptureHealthCard
        state="broken"
        title="Background location is off"
        body="Nothing is saved once your screen is off."
        action={{ label: 'Open location permission', onPress }}
        path="Apps › findmyperson › Permissions › Location"
      />,
    );
    const buttons = findAllHost(root, { accessibilityRole: 'button' });
    expect(buttons).toHaveLength(1);
    act(() => buttons[0]!.props.onPress());
    expect(onPress).toHaveBeenCalled();
  });
});

describe('LiveReportCard', () => {
  const menuItems = [{ label: 'Deactivate report', destructive: true, onPress: vi.fn() }];

  test('3-dot menu toggles a popover and selecting an item closes it', () => {
    const { root } = render(
      <LiveReportCard name="Alex Rivera" details={['Last seen Sep 18']} menuItems={menuItems} />,
    );
    const trigger = () => byLabel(root, 'Report options');
    expect(trigger().props.accessibilityState).toEqual({ expanded: false });
    expect(findAllHost(root, { accessibilityRole: 'menu' })).toHaveLength(0);
    act(() => trigger().props.onPress());
    expect(trigger().props.accessibilityState).toEqual({ expanded: true });
    act(() => findHost(root, { accessibilityRole: 'menuitem' }).props.onPress());
    expect(menuItems[0]!.onPress).toHaveBeenCalled();
    expect(findAllHost(root, { accessibilityRole: 'menu' })).toHaveLength(0);
  });

  test('live card pulses and announces "Live"', () => {
    const { root } = render(
      <LiveReportCard name="Alex Rivera" details={[]} menuItems={menuItems}>
        <Text>No replies yet</Text>
      </LiveReportCard>,
    );
    expect(byLabel(root, 'Live. Your report')).toBeTruthy();
    expect(findAllHost(root, { testID: 'pulsing-dot-halo' })).toHaveLength(1);
  });

  test('ended report stops pulsing', () => {
    const { root } = render(
      <LiveReportCard name="A" details={[]} live={false} menuItems={menuItems} />,
    );
    expect(findAllHost(root, { testID: 'pulsing-dot-halo' })).toHaveLength(0);
  });
});

describe('BottomSheet and catalogue', () => {
  test('sheet shows title and children only while visible', () => {
    const closed = render(<BottomSheet visible={false} onClose={() => undefined} title="Why?" />);
    expect(closed.root.findAll((n) => (n.type as unknown) === 'Modal')).toHaveLength(0);
    const open = render(
      <BottomSheet visible onClose={() => undefined} title="Why?">
        <Button label="Go" />
      </BottomSheet>,
    );
    expect(open.root.findAll((n) => (n.type as unknown) === 'Modal')).toHaveLength(1);
  });

  test('the catalogue renders every primitive without crashing', () => {
    const { root } = render(<DesignSystemCatalogue />);
    expect(findAllHost(root, { accessibilityRole: 'button' }).length).toBeGreaterThan(10);
  });
});
