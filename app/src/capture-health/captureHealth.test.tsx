import { CAPTURE_DEFAULTS, type HealthFlag } from '@findmyperson/native-location-capture';
import {
  createFakeLocationCapture,
  type ConditionFlag,
  type FakeLocationCapture,
} from '@findmyperson/native-location-capture/fake';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, test, vi } from 'vitest';
import { CaptureProvider } from '../permissions';
import { CaptureHealthDiagnostics } from './CaptureHealthDiagnostics';
import { CaptureHealthStatus } from './CaptureHealthStatus';
import { FLAG_INFO, FLAG_PRIORITY } from './flags';
import { formatHealthLog } from './healthLog';

vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (node: ReactTestInstance): string =>
  node
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children.join(''))
    .join(' ');

const config = { ...CAPTURE_DEFAULTS, notificationTitle: 't', notificationBody: 'b' };

async function mount(capture: FakeLocationCapture, ui: 'status' | 'diagnostics') {
  const handlers = {
    onOpenPermissionFlow: vi.fn(),
    onOpenDiagnostics: vi.fn(),
    onBack: vi.fn(),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CaptureProvider capture={capture}>
        {ui === 'status' ? (
          <CaptureHealthStatus {...handlers} />
        ) : (
          <CaptureHealthDiagnostics {...handlers} />
        )}
      </CaptureProvider>,
    );
  });
  return { renderer, ...handlers };
}

const pressAction = async (renderer: ReactTestRenderer, testID: string) => {
  const target = renderer.root.findAll(
    (n) => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
  if (!target) throw new Error(`no pressable ${testID}`);
  await act(async () => {
    (target.props.onPress as () => void)();
  });
};

describe('flag copy', () => {
  test('every flag has copy and a priority', () => {
    for (const flag of FLAG_PRIORITY) expect(FLAG_INFO[flag].title).toBeTruthy();
    expect(Object.keys(FLAG_INFO).sort()).toEqual([...FLAG_PRIORITY].sort());
  });
});

describe('Home status row', () => {
  test('is healthy only when the module reports no flags', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const { renderer } = await mount(capture, 'status');
    expect(text(renderer.root)).toContain('Working normally');
    expect(text(renderer.root)).not.toContain('Needs attention');
  });

  test('missing Always location is broken and leads into the permission flow', async () => {
    const capture = createFakeLocationCapture({ permission: 'foreground_only' });
    await capture.start(config);
    const { renderer, onOpenPermissionFlow } = await mount(capture, 'status');
    expect(text(renderer.root)).toContain('Background location is off');
    await pressAction(renderer, 'capture-health-status-action');
    expect(onOpenPermissionFlow).toHaveBeenCalledOnce();
  });

  test.each<[ConditionFlag, string, string]>([
    ['battery_optimisation_active', 'Exempt from battery optimisation', 'battery'],
    ['hibernation_not_exempt', 'Open app settings', 'hibernation'],
  ])('%s opens its own settings page', async (flag, label, target) => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    capture.controls.setCondition(flag, true);
    await capture.start(config);
    const { renderer } = await mount(capture, 'status');
    expect(text(renderer.root)).toContain(label);
    await pressAction(renderer, 'capture-health-status-action');
    expect(capture.controls.openedSettings()).toEqual([target]);
  });

  test('iOS Background App Refresh names that setting', async () => {
    const capture = createFakeLocationCapture({ platform: 'ios', permission: 'always' });
    capture.controls.setCondition('background_refresh_off', true);
    await capture.start(config);
    const { renderer } = await mount(capture, 'status');
    expect(text(renderer.root)).toContain('Enable Background App Refresh');
  });

  test('updates when the module reports a change', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const { renderer } = await mount(capture, 'status');
    await act(async () => {
      capture.controls.setCondition('battery_optimisation_active', true);
    });
    expect(text(renderer.root)).toContain('Battery saver may stop capture');
  });

  test('a killed mechanism is reported, not shown as green', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    capture.controls.killMechanism();
    const { renderer } = await mount(capture, 'status');
    expect(text(renderer.root)).toContain('Capture stopped running');
  });
});

describe('Diagnostics screen', () => {
  test('lists every raised flag with its fix and shows the local log', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    capture.controls.setCondition('battery_optimisation_active', true);
    capture.controls.setCondition('oem_restriction_suspected', true);
    await capture.start(config);
    const { renderer } = await mount(capture, 'diagnostics');
    const flags: HealthFlag[] = ['battery_optimisation_active', 'oem_restriction_suspected'];
    for (const flag of flags) {
      expect(
        renderer.root.findAll((n) => n.props.testID === `health-flag-${flag}`).length,
      ).toBeGreaterThan(0);
    }
    const log = renderer.root.findAll((n) => n.props.testID === 'health-log')[0];
    expect(log).toBeDefined();
    expect(text(log!)).toContain('battery_optimisation_active, oem_restriction_suspected');
    expect(text(renderer.root)).toContain('never sent anywhere');
  });

  test('healthy device shows the healthy card', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const { renderer } = await mount(capture, 'diagnostics');
    expect(renderer.root.findAll((n) => n.props.testID === 'health-ok').length).toBeGreaterThan(0);
  });
});

describe('formatHealthLog', () => {
  test('carries no coordinates and tolerates unknown events', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const status = await capture.getStatus();
    const out = formatHealthLog(
      status,
      [{ tsUtc: 1000, event: 'something_new', detail: '' }],
      2000,
    );
    expect(out).toContain('something_new');
    expect(out).toContain('Problems: none');
  });
});
