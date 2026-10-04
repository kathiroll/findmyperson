/**
 * The bundle fetcher's random source (`FetchCycleInput.random`): uniform in [0, 1). It picks
 * the device's cover secret, once per store, and the order of each cycle's requests.
 *
 * It is the platform's cryptographic source where the engine has one, 53 bits a draw. Where it
 * has none it is Math.random, which is not a cryptographic generator. The CDN operator, whom
 * the padding is there for, sees only the order of requests and which shards a device follows,
 * never a number drawn here. NOT VERIFIED ON A DEVICE which of the two a real build gets:
 * Hermes is not known to supply `crypto.getRandomValues` by itself, and installing a polyfill
 * for it would settle it in favour of the first.
 */
export function deviceRandom(): number {
  const source = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array } }
  ).crypto;
  if (typeof source?.getRandomValues !== 'function') {
    return Math.random();
  }
  const [high = 0, low = 0] = source.getRandomValues(new Uint32Array(2));
  // 21 bits and 32 bits: every double in [0, 1) with a 53-bit mantissa, each equally likely.
  return ((high >>> 11) * 4_294_967_296 + low) / 9_007_199_254_740_992;
}
