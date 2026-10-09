import type { CapturePlatform, PermissionState } from '@findmyperson/native-location-capture';
import {
  createFakeLocationCapture,
  type FakeLocationCapture,
} from '@findmyperson/native-location-capture/fake';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, test, vi } from 'vitest';
import { appStateLog } from '../../design-system/__tests__/stubs/react-native';
import { DataStoreProvider, type DataStore } from '../../store';
import { CaptureProvider } from '../CaptureContext';
import { PermissionFlowScreen } from '../PermissionFlowScreen';
import { PERMISSION_STAGES, permissionStage, remedies, type PermissionStage } from '../stages';

vi.mock(
  'react-native-safe-area-context',
  async () => await import('../../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The one stored fact this screen uses: whether iOS's one-time Always request was used. */
function fakeStore(used = false) {
  const state = { used };
  const dataStore = {
    getAlwaysPromptUsed: async () => state.used,
    markAlwaysPromptUsed: async () => void (state.used = true),
  } as unknown as DataStore;
  return { state, dataStore };
}

async function mount(
  capture: FakeLocationCapture,
  platform: CapturePlatform,
  onClose = vi.fn(),
  store = fakeStore(),
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CaptureProvider capture={capture}>
        <DataStoreProvider dataStore={store.dataStore}>
          <PermissionFlowScreen platform={platform} onClose={onClose} />
        </DataStoreProvider>
      </CaptureProvider>,
    );
  });
  return { renderer, onClose };
}

const text = (node: ReactTestInstance): string =>
  node
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children.join(''))
    .join(' ');

const stageOf = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll(
      (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('permission-stage-'),
    )
    .map((n) => (n.props.testID as string).replace('permission-stage-', ''))[0];

const press = async (renderer: ReactTestRenderer, label: string) => {
  const target = renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!target) throw new Error(`nothing pressable labelled "${label}"`);
  await act(async () => {
    (target.props.onPress as () => void)();
  });
};

const hasButton = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  ).length > 0;

const fake = (platform: CapturePlatform, permission: PermissionState = 'undetermined') =>
  createFakeLocationCapture({ platform, permission });

describe('Android flow', () => {
  test('disclosure comes first, names location and background use, and no prompt shows before Continue', async () => {
    const capture = fake('android');
    const { renderer } = await mount(capture, 'android');
    expect(stageOf(renderer)).toBe('disclosure');
    const copy = text(renderer.root);
    expect(copy).toMatch(/location/i);
    expect(copy).toMatch(/background/i);
    expect(capture.controls.shownPermissionPrompts()).toEqual([]);
    await press(renderer, 'Continue');
    expect(capture.controls.shownPermissionPrompts()).toEqual(['foreground']);
  });

  test('foreground grant leads to the education screen, then settings hand-off for background', async () => {
    const capture = fake('android');
    const { renderer } = await mount(capture, 'android');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('upgrade');
    expect(text(renderer.root)).toMatch(/all the time/i);
    await press(renderer, 'Open settings');
    expect(capture.controls.shownPermissionPrompts()).toEqual(['foreground', 'background']);
    expect(stageOf(renderer)).toBe('complete');
    expect(renderer.root.findAll((n) => n.props.testID === 'permission-remedies')).toHaveLength(0);
  });

  test('background not granted keeps the user on the upgrade screen with a hint', async () => {
    const capture = fake('android');
    capture.controls.answerPermission('background', 'foreground_only');
    const { renderer } = await mount(capture, 'android');
    await press(renderer, 'Continue');
    await press(renderer, 'Open settings');
    expect(stageOf(renderer)).toBe('upgrade');
    expect(text(renderer.root)).toMatch(/still/i);
  });

  test('declining the upgrade lands on limited, which can go back to the upgrade', async () => {
    const capture = fake('android', 'foreground_only');
    const { renderer } = await mount(capture, 'android');
    await press(renderer, 'Keep while-using only');
    expect(stageOf(renderer)).toBe('limited');
    await press(renderer, 'Allow all the time');
    expect(stageOf(renderer)).toBe('upgrade');
  });

  test('Not now on the disclosure explains the consequence and can be reviewed again', async () => {
    const capture = fake('android');
    const { renderer, onClose } = await mount(capture, 'android');
    await press(renderer, 'Not now');
    expect(stageOf(renderer)).toBe('skipped');
    expect(capture.controls.shownPermissionPrompts()).toEqual([]);
    expect(text(renderer.root)).toMatch(/without location/i);
    await press(renderer, 'Review again');
    expect(stageOf(renderer)).toBe('disclosure');
    await press(renderer, 'Not now');
    await press(renderer, 'Continue without location');
    expect(onClose).toHaveBeenCalled();
  });

  test('denying the prompt reaches denied, which opens app settings and has a way out', async () => {
    const capture = fake('android');
    capture.controls.answerPermission('foreground', 'denied');
    const { renderer, onClose } = await mount(capture, 'android');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('denied');
    await press(renderer, 'Open settings');
    expect(capture.controls.openedSettings()).toEqual(['app']);
    await press(renderer, 'Continue without location');
    expect(onClose).toHaveBeenCalled();
  });

  test('coming back from settings with a changed permission updates the stage', async () => {
    const capture = fake('android', 'denied');
    const { renderer } = await mount(capture, 'android');
    expect(stageOf(renderer)).toBe('denied');
    capture.controls.setPermission('always');
    await act(async () => {
      for (const listener of appStateLog.listeners) listener('active');
    });
    expect(stageOf(renderer)).toBe('complete');
  });

  test('restricted explains and offers a way forward', async () => {
    const { renderer, onClose } = await mount(fake('android', 'restricted'), 'android');
    expect(stageOf(renderer)).toBe('restricted');
    expect(text(renderer.root)).toMatch(/report a missing person/i);
    await press(renderer, 'Continue without location');
    expect(onClose).toHaveBeenCalled();
  });

  test('device remedies show only for the raised flags and open the right settings page', async () => {
    const capture = fake('android', 'always');
    capture.controls.setCondition('battery_optimisation_active', true);
    capture.controls.setCondition('hibernation_not_exempt', true);
    capture.controls.setCondition('oem_restriction_suspected', true);
    const { renderer } = await mount(capture, 'android');
    expect(stageOf(renderer)).toBe('complete');
    await press(renderer, 'Open battery settings');
    await press(renderer, 'Open app settings');
    await press(renderer, 'Open autostart settings');
    expect(capture.controls.openedSettings()).toEqual(['battery', 'hibernation', 'battery']);
  });

  test('a fully granted, healthy phone sees no remedies', async () => {
    const { renderer } = await mount(fake('android', 'always'), 'android');
    expect(text(renderer.root)).toMatch(/nothing else is needed/i);
    expect(renderer.root.findAll((n) => n.props.testID === 'permission-remedies')).toHaveLength(0);
  });

  test('remedies also appear beside the upgrade when while-using only', async () => {
    const capture = fake('android', 'foreground_only');
    capture.controls.setCondition('precise_location_off', true);
    const { renderer } = await mount(capture, 'android');
    expect(
      renderer.root.findAll((n) => n.props.testID === 'remedy-precise_location_off').length,
    ).toBeGreaterThan(0);
  });
});

describe('iOS flow', () => {
  test('purpose, When-In-Use prompt, then the Always upgrade', async () => {
    const capture = fake('ios');
    const { renderer } = await mount(capture, 'ios');
    expect(stageOf(renderer)).toBe('purpose');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('upgrade');
    await press(renderer, 'Allow Always');
    expect(capture.controls.shownPermissionPrompts()).toEqual(['foreground', 'background']);
    expect(stageOf(renderer)).toBe('complete');
  });

  const GUIDE_ORDER = ['Privacy & Security', 'Location Services', 'findmyperson', 'Always'];
  const inOrder = (copy: string, parts: string[]) => {
    let from = 0;
    for (const part of parts) {
      const at = copy.indexOf(part, from);
      expect(at, `"${part}" after position ${from}`).toBeGreaterThanOrEqual(from);
      from = at + part.length;
    }
  };

  test('after iOS declines the one Always prompt, a written Settings guide replaces the dead button', async () => {
    const capture = fake('ios');
    capture.controls.answerPermission('background', 'foreground_only');
    const store = fakeStore();
    const { renderer } = await mount(capture, 'ios', vi.fn(), store);
    await press(renderer, 'Continue');
    expect(hasButton(renderer, 'Allow Always')).toBe(true);
    expect(renderer.root.findAll((n) => n.props.testID === 'settings-guide')).toHaveLength(0);
    await press(renderer, 'Allow Always');
    expect(hasButton(renderer, 'Allow Always')).toBe(false);
    const copy = text(renderer.root);
    expect(copy).toContain('Turn on Always in Settings');
    expect(copy).not.toMatch(/did not change the setting/);
    inOrder(copy, GUIDE_ORDER);
    await press(renderer, 'Open Settings');
    expect(capture.controls.openedSettings()).toEqual(['app']);
    expect(capture.controls.shownPermissionPrompts()).toEqual(['foreground', 'background']);
    expect(store.state.used).toBe(true);
  });

  test('the guide is remembered across visits and restarts, with no press', async () => {
    const capture = fake('ios', 'foreground_only');
    const store = fakeStore();
    capture.controls.answerPermission('background', 'foreground_only');
    const first = await mount(capture, 'ios', vi.fn(), store);
    await press(first.renderer, 'Allow Always');
    await act(async () => first.renderer.unmount());

    const again = await mount(capture, 'ios', vi.fn(), store);
    expect(stageOf(again.renderer)).toBe('upgrade');
    expect(hasButton(again.renderer, 'Allow Always')).toBe(false);
    inOrder(text(again.renderer.root), GUIDE_ORDER);
    expect(capture.controls.shownPermissionPrompts()).toEqual(['background']);
  });

  test('a stored flag alone (new process) shows the guide', async () => {
    const { renderer } = await mount(
      fake('ios', 'foreground_only'),
      'ios',
      vi.fn(),
      fakeStore(true),
    );
    expect(hasButton(renderer, 'Allow Always')).toBe(false);
    inOrder(text(renderer.root), GUIDE_ORDER);
  });

  test('returning from Settings with Always moves on by itself and the guide goes', async () => {
    const capture = fake('ios', 'foreground_only');
    const { renderer } = await mount(capture, 'ios', vi.fn(), fakeStore(true));
    expect(
      renderer.root.findAll((n) => n.props.testID === 'settings-guide').length,
    ).toBeGreaterThan(0);
    capture.controls.setPermission('always');
    await act(async () => {
      for (const listener of appStateLog.listeners) listener('active');
    });
    expect(stageOf(renderer)).toBe('complete');
    expect(renderer.root.findAll((n) => n.props.testID === 'settings-guide')).toHaveLength(0);
  });

  test('limited on iOS shows the guide only once the prompt is used', async () => {
    const unused = await mount(fake('ios', 'foreground_only'), 'ios');
    await press(unused.renderer, 'Keep while-using only');
    expect(stageOf(unused.renderer)).toBe('limited');
    expect(hasButton(unused.renderer, 'Allow all the time')).toBe(true);

    const used = await mount(fake('ios', 'foreground_only'), 'ios', vi.fn(), fakeStore(true));
    await press(used.renderer, 'Keep while-using only');
    expect(stageOf(used.renderer)).toBe('limited');
    expect(hasButton(used.renderer, 'Allow all the time')).toBe(false);
    inOrder(text(used.renderer.root), GUIDE_ORDER);
  });

  test('iOS denied shows the guide ending in While Using the App or Always, not the Android wording', async () => {
    const capture = fake('ios', 'denied');
    const { renderer } = await mount(capture, 'ios');
    expect(stageOf(renderer)).toBe('denied');
    const copy = text(renderer.root);
    inOrder(copy, GUIDE_ORDER);
    expect(copy).toContain('Choose While Using the App or Always.');
    expect(copy).not.toMatch(/then Apps/);
    await press(renderer, 'Open Settings');
    expect(capture.controls.openedSettings()).toEqual(['app']);
  });

  test('iOS denied and restricted are rendered, and battery pages are not offered', async () => {
    const denied = await mount(fake('ios', 'denied'), 'ios');
    expect(stageOf(denied.renderer)).toBe('denied');
    const restricted = await mount(fake('ios', 'restricted'), 'ios');
    expect(stageOf(restricted.renderer)).toBe('restricted');
    const capture = fake('ios', 'always');
    capture.controls.setCondition('low_power_mode', true);
    capture.controls.setCondition('background_refresh_off', true);
    const { renderer } = await mount(capture, 'ios');
    expect(text(renderer.root)).toMatch(/Low Power Mode/);
    expect(text(renderer.root)).toMatch(/Background App Refresh/);
    expect(text(renderer.root)).not.toMatch(/autostart/i);
  });
});

describe('every stage is reachable through the module API', () => {
  const reached = new Set<PermissionStage>();

  test.each([
    ['android', 'undetermined', 'disclosure'],
    ['ios', 'undetermined', 'purpose'],
    ['android', 'foreground_only', 'upgrade'],
    ['ios', 'foreground_only', 'upgrade'],
    ['android', 'always', 'complete'],
    ['ios', 'denied', 'denied'],
    ['android', 'restricted', 'restricted'],
  ] as const)('%s with permission %s renders %s', async (platform, permission, expected) => {
    const capture = fake(platform);
    capture.controls.setPermission(permission);
    const status = await capture.getStatus();
    expect(permissionStage(status, platform, false)).toBe(expected);
    const { renderer } = await mount(capture, platform);
    expect(stageOf(renderer)).toBe(expected);
    reached.add(expected);
  });

  test('limited is reached by declining the upgrade', async () => {
    const { renderer } = await mount(fake('android', 'foreground_only'), 'android');
    await press(renderer, 'Keep while-using only');
    reached.add(stageOf(renderer) as PermissionStage);
  });

  test('all stages were covered', () => {
    expect([...reached].sort()).toEqual([...PERMISSION_STAGES].sort());
  });
});

describe('remedies', () => {
  test('none without a location permission, and none for flags that have no fix', () => {
    expect(remedies({ permission: 'denied', health: ['battery_optimisation_active'] })).toEqual([]);
    expect(
      remedies({ permission: 'always', health: ['store_unusable', 'service_not_running'] }),
    ).toEqual([]);
  });
});
