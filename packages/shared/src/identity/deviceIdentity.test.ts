import { describe, expect, test } from 'vitest';
import { isUuidV4, uuidV4FromBytes } from '../uuid';
import {
  createInMemoryDeviceIdentity,
  createStubDeviceAuthenticator,
  formatDeviceAuthorization,
  isDeviceId,
  parseDeviceAuthorization,
  type DeviceIdentity,
} from './deviceIdentity';

/** Hands out 0x00.., 0x10.., 0x20.. on successive calls, so ids are predictable. */
function countingBytes(): (length: number) => Uint8Array {
  let call = 0;
  return (length) => {
    const base = call++ * 16;
    return Uint8Array.from({ length }, (_, i) => (base + i) & 0xff);
  };
}

describe('uuidV4FromBytes', () => {
  test('sets the version and variant bits and nothing else', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(uuidV4FromBytes(bytes)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(uuidV4FromBytes(new Uint8Array(16).fill(0xff))).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
  });

  test('always produces a valid version 4 UUID', () => {
    for (let seed = 0; seed < 256; seed++) {
      const bytes = Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 17) & 0xff);
      expect(isUuidV4(uuidV4FromBytes(bytes))).toBe(true);
    }
  });

  test('does not modify its input and insists on 16 bytes', () => {
    const bytes = new Uint8Array(16);
    uuidV4FromBytes(bytes);
    expect([...bytes]).toEqual(new Array(16).fill(0));
    expect(() => uuidV4FromBytes(new Uint8Array(15))).toThrow(RangeError);
  });
});

describe('in-memory device identity (stub)', () => {
  test('mints an id on first use and keeps it', async () => {
    const identity = createInMemoryDeviceIdentity({ randomBytes: countingBytes() });
    const id = await identity.getDeviceId();
    expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(await identity.getDeviceId()).toBe(id);
    expect(isDeviceId(id)).toBe(true);
  });

  test('concurrent first calls agree on one id', async () => {
    const identity = createInMemoryDeviceIdentity({ randomBytes: countingBytes() });
    const ids = await Promise.all([identity.getDeviceId(), identity.getDeviceId()]);
    expect(ids[0]).toBe(ids[1]);
  });

  test('reset forgets the id; the next use mints a different one', async () => {
    const identity = createInMemoryDeviceIdentity({ randomBytes: countingBytes() });
    const before = await identity.getDeviceId();
    await identity.reset();
    const after = await identity.getDeviceId();
    expect(after).not.toBe(before);
    expect(isDeviceId(after)).toBe(true);
  });

  test('authHeaders carries the id in the stub scheme', async () => {
    const identity = createInMemoryDeviceIdentity({ randomBytes: countingBytes() });
    expect(await identity.authHeaders()).toEqual({
      Authorization: 'FMP-Device 00010203-0405-4607-8809-0a0b0c0d0e0f',
    });
  });
});

describe('stub device authenticator', () => {
  const authenticator = createStubDeviceAuthenticator();
  const id = '00010203-0405-4607-8809-0a0b0c0d0e0f';

  test('a request made with DeviceIdentity.authHeaders authenticates as that device', async () => {
    // The point of the seam: a caller that only knows the two interfaces works end to end.
    const identity: DeviceIdentity = createInMemoryDeviceIdentity({ randomBytes: countingBytes() });
    const device = await authenticator.authenticate(await identity.authHeaders());
    expect(device).toEqual({ device_id: await identity.getDeviceId() });
  });

  test('finds the header whatever its case, as HTTP servers lowercase names', async () => {
    const value = formatDeviceAuthorization(id);
    expect(await authenticator.authenticate({ authorization: value })).toEqual({ device_id: id });
    expect(await authenticator.authenticate({ AUTHORIZATION: value })).toEqual({ device_id: id });
  });

  test.each<[string, Record<string, string | string[] | undefined>]>([
    ['no header', {}],
    ['an undefined header', { authorization: undefined }],
    ['another scheme', { authorization: `Bearer ${id}` }],
    ['an id that is not a UUID', { authorization: 'FMP-Device 1234' }],
    ['an uppercase id', { authorization: `FMP-Device ${id.toUpperCase()}` }],
    ['trailing words', { authorization: `FMP-Device ${id} extra` }],
    ['a repeated header', { authorization: [`FMP-Device ${id}`, `FMP-Device ${id}`] }],
  ])('treats %s as anonymous', async (_label, headers) => {
    expect(await authenticator.authenticate(headers)).toBeNull();
  });
});

describe('authorization format', () => {
  test('format and parse are inverses', () => {
    const id = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34';
    expect(parseDeviceAuthorization(formatDeviceAuthorization(id))).toBe(id);
    expect(parseDeviceAuthorization(undefined)).toBeNull();
    expect(parseDeviceAuthorization('')).toBeNull();
  });
});
