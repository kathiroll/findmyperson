import type { FetchTransport } from '@findmyperson/shared';

/**
 * The bundle fetcher's transport over the platform's `fetch`: one GET per call to the CDN the
 * shard compiler publishes to. `runFetchCycle` of @findmyperson/shared decides what is asked
 * for; this only puts it on the wire.
 *
 * A request carries nothing about the device: no cookie, no credentials, no header of ours
 * except If-None-Match. Whatever else the platform adds (User-Agent) is the same on every phone.
 *
 * NOT VERIFIED ON A DEVICE, AND IT MATTERS: every request must reach the CDN. Bundles are served
 * `immutable`, and an HTTP client with a cache (the default URLSession on iOS has one) may answer
 * a repeat request itself. The fetcher's padding is repeat requests, so a cache in the way makes
 * the request count depend on what the phone holds, which is what padding is there to hide. No
 * native project is checked in to test against. Whoever wires this into one must confirm, from
 * the CDN's side, that a cycle arrives as 1 + FETCH_SHARD_REQUESTS_PER_CYCLE requests, and turn
 * the client's cache off for this origin if it does not. The `cache` option of `fetch` is not
 * the fix: React Native's `fetch` implements it by adding a query parameter, which would defeat
 * the CDN's own cache.
 */
export interface HttpTransportOptions {
  /** The CDN origin, https only, with no path: "https://cdn.example". */
  origin: string;
  /** Default: the global `fetch`. */
  fetch?: HttpFetch;
  /** A request with no complete answer after this long is abandoned. Default 30 seconds. */
  timeoutMs?: number;
}

/** The part of `fetch` this transport uses. */
export type HttpFetch = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    credentials: 'omit';
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export const HTTP_TRANSPORT_TIMEOUT_MS = 30_000;

/** A CDN origin: https, a host, and nothing after it. */
export const CDN_ORIGIN_PATTERN = /^https:\/\/[^/?#]+$/;

export function createHttpTransport(options: HttpTransportOptions): FetchTransport {
  if (!CDN_ORIGIN_PATTERN.test(options.origin)) {
    throw new RangeError('the CDN origin must be https://host with no path');
  }
  const { origin } = options;
  const send = options.fetch ?? (globalThis.fetch as HttpFetch);
  const timeoutMs = options.timeoutMs ?? HTTP_TRANSPORT_TIMEOUT_MS;
  return {
    async get({ path, ifNoneMatch }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await send(`${origin}${path}`, {
          method: 'GET',
          headers: ifNoneMatch === undefined ? {} : { 'If-None-Match': ifNoneMatch },
          credentials: 'omit',
          signal: controller.signal,
        });
        // Read to the end inside the timeout: a body cut short must not pass for a whole one.
        const body = response.status === 200 ? await response.text() : null;
        return { status: response.status, body, etag: response.headers.get('ETag') };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
