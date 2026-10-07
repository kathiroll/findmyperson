import { afterEach, describe, expect, test, vi } from 'vitest';
import { deviceRandom } from './fetch/random';
import { platformRandomBytes } from './random';

afterEach(() => vi.unstubAllGlobals());

function installBytes(value: number) {
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(value));
  vi.stubGlobal('crypto', { getRandomValues });
  return getRandomValues;
}

describe('native secure randomness adapter', () => {
  test('fills the requested bytes through the configured source', () => {
    const source = installBytes(42);
    expect(platformRandomBytes(16)).toEqual(new Uint8Array(16).fill(42));
    expect(source).toHaveBeenCalledTimes(1);
  });

  test.each([-1, 0.5, NaN, Infinity, 65_537])('rejects invalid length %s', (length) => {
    const source = installBytes(0);
    expect(() => platformRandomBytes(length)).toThrow(RangeError);
    expect(source).not.toHaveBeenCalled();
  });

  test.each([undefined, {}, { getRandomValues: 1 }])('refuses absent source %s', (source) => {
    vi.stubGlobal('crypto', source);
    expect(() => platformRandomBytes(16)).toThrow('no secure random source');
    expect(() => deviceRandom()).toThrow('no secure random source');
  });

  test('refuses an invalid result rather than minting an identity from it', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => new Uint8Array(1) });
    expect(() => platformRandomBytes(16)).toThrow('invalid byte array');
  });

  test('propagates native entropy failure', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('native entropy unavailable');
      },
    });
    expect(() => platformRandomBytes(16)).toThrow('native entropy unavailable');
  });

  test('refuses legacy remote debugging but accepts bridgeless device execution', () => {
    const source = installBytes(1);
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('nativeCallSyncHook', undefined);
    vi.stubGlobal('RN$Bridgeless', false);
    expect(() => platformRandomBytes(16)).toThrow('legacy remote debugging');
    expect(source).not.toHaveBeenCalled();
    vi.stubGlobal('RN$Bridgeless', true);
    expect(platformRandomBytes(16)).toHaveLength(16);
  });

  test('cover draws cover the [0, 1) endpoints without rounding up to one', () => {
    installBytes(0);
    expect(deviceRandom()).toBe(0);
    installBytes(255);
    expect(deviceRandom()).toBe(1 - 1 / 9_007_199_254_740_992);
  });
});
