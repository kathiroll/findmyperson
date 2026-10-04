/**
 * The network, as the bundle fetcher sees it. This package opens no connection: the app supplies
 * a transport over its HTTP client (app/src/fetch/httpTransport.ts) and tests supply a fake CDN.
 *
 * A transport MUST put every request on the wire. A client that answers one from a local HTTP
 * cache makes the device's request count depend on what it has cached, which is the signal the
 * padding exists to remove (fetch/cycle.ts). Bundles are served `immutable`, so a default cache
 * would do exactly that.
 */
export interface FetchRequest {
  /** Path from the CDN origin, with its leading slash: SHARD_INDEX_PATH or a shardBundlePath. */
  path: string;
  /** Sent as `If-None-Match` when present. */
  ifNoneMatch?: string;
}

export interface FetchResponse {
  /** The HTTP status. Only 200 and 304 mean anything to the fetcher. */
  status: number;
  /** The whole response body as text, for a 200. Null otherwise. */
  body: string | null;
  /** The `ETag` response header exactly as sent, quotes included, or null if there was none. */
  etag: string | null;
}

export interface FetchTransport {
  /**
   * One GET. Resolves with whatever the server answered, whatever the status, once the body has
   * been read to its end; rejects only when no answer was had (no network, a timeout).
   */
  get(request: FetchRequest): Promise<FetchResponse>;
}

/** What the device says about its connection. The fetcher only asks whether data costs money. */
export interface NetworkConditions {
  /** The active connection is metered: mobile data, or a hotspot the OS marks as limited. */
  metered: boolean;
}
