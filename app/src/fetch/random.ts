import { platformRandomBytes } from '../random';

/**
 * The bundle fetcher's random source (`FetchCycleInput.random`): uniform in [0, 1). It picks
 * the device's cover secret, once per store, and the order of each cycle's requests.
 *
 * Uses 53 uniformly selected cryptographic bits and fails closed if the native source is
 * unavailable. No Math.random fallback for the cover secret or request ordering.
 */
export function deviceRandom(): number {
  const bytes = platformRandomBytes(8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  // 21 bits and 32 bits: every double in [0, 1) with a 53-bit mantissa, each equally likely.
  return ((high >>> 11) * 4_294_967_296 + low) / 9_007_199_254_740_992;
}
