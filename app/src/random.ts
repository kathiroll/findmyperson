/**
 * The entrypoint installs react-native-get-random-values before loading app code. Its native
 * module uses SecRandomCopyBytes on iOS and SecureRandom on Android. Refuse the library's
 * legacy remote-debugging fallback rather than creating identities or cover secrets with it.
 * Native wiring is checked by the app build; runtime behavior still requires a phone.
 */
export function platformRandomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 65_536) {
    throw new RangeError('secure random byte length must be an integer from 0 to 65536');
  }
  const runtime = globalThis as {
    __DEV__?: boolean;
    RN$Bridgeless?: boolean;
    nativeCallSyncHook?: unknown;
    crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
  };
  if (
    runtime.__DEV__ === true &&
    runtime.RN$Bridgeless !== true &&
    typeof runtime.nativeCallSyncHook === 'undefined'
  ) {
    throw new Error('secure randomness is unavailable in legacy remote debugging');
  }
  const source = runtime.crypto;
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('no secure random source on this platform');
  }
  const bytes = new Uint8Array(length);
  const result = source.getRandomValues(bytes);
  if (!(result instanceof Uint8Array) || result !== bytes || result.byteLength !== length) {
    throw new Error('secure random source returned an invalid byte array');
  }
  return result;
}
