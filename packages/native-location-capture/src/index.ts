/**
 * @findmyperson/native-location-capture: the one interface for background location capture.
 *
 * The Kotlin module, the Swift module and the in-memory fake all implement `LocationCapture`.
 * It is defined in src/specs/NativeLocationCapture.ts, which is also what React Native's codegen
 * reads. This entry exports the interface and its constants and loads no native code:
 *
 *   @findmyperson/native-location-capture          types and constants (this file)
 *   @findmyperson/native-location-capture/fake     createFakeLocationCapture, for tests
 *   @findmyperson/native-location-capture/native   the real module; needs the native code linked
 *
 * See README.md.
 */
export const packageName = '@findmyperson/native-location-capture';

export * from './constants';

export type {
  Accuracy,
  CaptureConfig,
  CaptureMode,
  CaptureStatus,
  CaptureTier,
  DeviceConditions,
  DiagnosticEntry,
  HealthFlag,
  PermissionState,
  PermissionStep,
  SampleWrittenEvent,
  SettingsTarget,
  Spec as LocationCapture,
} from './specs/NativeLocationCapture';
