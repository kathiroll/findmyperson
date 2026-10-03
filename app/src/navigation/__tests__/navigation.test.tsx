import { getStateFromPath, type NavigationContainerRef } from '@react-navigation/native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Linking } from 'react-native';
import { createFakeLocationCapture } from '@findmyperson/native-location-capture/fake';
import { AppNavigator } from '../AppNavigator';
import {
  linking,
  linkingPrefix,
  matchNotificationUrl,
  reportNotificationUrl,
  type RootStackParamList,
} from '../routes';

vi.mock('@react-navigation/native-stack', async () => await import('./stubs'));
vi.mock('@react-navigation/bottom-tabs', async () => await import('./stubs'));
vi.mock('react-native-safe-area-context', async () => await import('./stubs'));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ref = NavigationContainerRef<RootStackParamList>;

async function mount(initialUrl: string | null = null) {
  (Linking as unknown as { initialUrl: string | null }).initialUrl = initialUrl;
  const ref = { current: null as Ref | null };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AppNavigator navigationRef={ref} capture={createFakeLocationCapture()} />);
  });
  return { ref, renderer };
}

// testID is forwarded through wrappers, so the same id can match several nodes.
const screens = (renderer: ReactTestRenderer) => [
  ...new Set(
    renderer.root
      .findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('screen-'))
      .map((n) => n.props.testID as string),
  ),
];

const press = async (root: ReactTestInstance, label: string) => {
  const target = root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!target) throw new Error(`nothing pressable labelled "${label}"`);
  await act(async () => {
    (target.props.onPress as () => void)();
  });
};

const currentRoute = (ref: { current: Ref | null }) => ref.current!.getCurrentRoute();

beforeEach(() => {
  (Linking as unknown as { initialUrl: string | null }).initialUrl = null;
});

describe('navigation shell', () => {
  test('starts on onboarding, which continues to the Home tab', async () => {
    const { ref, renderer } = await mount();
    expect(screens(renderer)).toEqual(['screen-Onboarding']);
    await press(renderer.root, 'Continue');
    expect(screens(renderer)).toEqual(['screen-Home']);
    expect(currentRoute(ref)?.name).toBe('Home');
  });

  test('every screen renders with a header when navigated to', async () => {
    const { ref, renderer } = await mount();
    const targets: [() => void, string][] = [
      [() => ref.current!.navigate('Onboarding'), 'Onboarding'],
      [() => ref.current!.navigate('Main', { screen: 'Home' }), 'Home'],
      [() => ref.current!.navigate('Main', { screen: 'History' }), 'History'],
      [() => ref.current!.navigate('Main', { screen: 'Settings' }), 'Settings'],
      [() => ref.current!.navigate('CaptureHealth'), 'CaptureHealth'],
      [() => ref.current!.navigate('PermissionFlow'), 'PermissionFlow'],
      [() => ref.current!.navigate('ReportForm'), 'ReportForm'],
      [() => ref.current!.navigate('LiveReport', { reportId: 'r1' }), 'LiveReport'],
      [() => ref.current!.navigate('Bystander', { matchId: 'm1' }), 'Bystander'],
    ];
    for (const [go, name] of targets) {
      await act(async () => go());
      expect(screens(renderer)).toEqual([`screen-${name}`]);
      expect(
        renderer.root.findAll((n) => n.props.accessibilityRole === 'header').length,
      ).toBeGreaterThan(0);
    }
  });

  test('the tab bar has exactly Home, History and Settings and switches between them', async () => {
    const { renderer } = await mount();
    await press(renderer.root, 'Continue');
    const tabs = renderer.root.findAll(
      (n) => (n.type as unknown) === 'Pressable' && n.props.accessibilityRole === 'tab',
    );
    expect(tabs.map((t) => t.props.accessibilityLabel)).toEqual(['Home', 'History', 'Settings']);
    await press(renderer.root, 'History');
    expect(screens(renderer)).toEqual(['screen-History']);
    await press(renderer.root, 'Settings');
    expect(screens(renderer)).toEqual(['screen-Settings']);
  });

  test('flows from Home reach the report form, capture health, live report and bystander', async () => {
    const { ref, renderer } = await mount();
    await press(renderer.root, 'Continue');

    await press(renderer.root, 'Report a missing person');
    expect(screens(renderer)).toEqual(['screen-ReportForm']);
    await press(renderer.root, 'Back');
    expect(screens(renderer)).toEqual(['screen-Home']);

    await press(renderer.root, 'Capture health');
    expect(currentRoute(ref)?.name).toBe('CaptureHealth');
    await press(renderer.root, 'Back');

    await press(renderer.root, 'My live report');
    expect(currentRoute(ref)?.name).toBe('LiveReport');
    await press(renderer.root, 'Back');

    await press(renderer.root, 'Preview a match');
    expect(currentRoute(ref)?.name).toBe('Bystander');
    await press(renderer.root, 'Close');
    expect(screens(renderer)).toEqual(['screen-Home']);
  });
});

describe('deep links', () => {
  test('a match notification URL opens the bystander screen with its match id', async () => {
    const { ref, renderer } = await mount(matchNotificationUrl('abc 123'));
    expect(screens(renderer)).toEqual(['screen-Bystander']);
    expect(currentRoute(ref)?.params).toEqual({ matchId: 'abc 123' });
  });

  test('a reply notification URL opens the live report with its report id', async () => {
    const { ref, renderer } = await mount(reportNotificationUrl('r-9'));
    expect(screens(renderer)).toEqual(['screen-LiveReport']);
    expect(currentRoute(ref)?.params).toEqual({ reportId: 'r-9' });
  });

  test('every route has a link that resolves back to its own name', () => {
    const resolve = (path: string) => getStateFromPath(path, linking.config)?.routes[0];
    expect(resolve('welcome')?.name).toBe('Onboarding');
    expect(resolve('new-report')?.name).toBe('ReportForm');
    expect(resolve('capture-health')?.name).toBe('CaptureHealth');
    expect(resolve('permissions')?.name).toBe('PermissionFlow');
    expect(resolve('report/r1')).toMatchObject({ name: 'LiveReport', params: { reportId: 'r1' } });
    expect(resolve('match/m1')).toMatchObject({ name: 'Bystander', params: { matchId: 'm1' } });
    for (const tab of ['home', 'history', 'settings']) {
      expect(resolve(tab)?.name).toBe('Main');
    }
    expect(matchNotificationUrl('m1').startsWith(linkingPrefix)).toBe(true);
  });
});
