/**
 * Header filtering for the Node gateway.
 *
 * Headers are allowlisted in both directions. An allowlist rather than a denylist means a
 * header the gateway has never considered is dropped by default, which is the safer
 * failure: a forgotten `cookie` or `authorization` forwarded upstream is a security
 * problem, while a forgotten benign header is a cosmetic one.
 *
 * Hop-by-hop headers are removed in accordance with RFC 9110 §7.6.1. Forwarding
 * `connection`, `transfer-encoding` or `content-length` across a proxy boundary corrupts
 * framing, and for a streamed response it truncates the stream.
 */

/** Hop-by-hop headers, which apply to a single connection and must never be forwarded. */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Length is recomputed by the runtime for the body it actually sends.
  "content-length",
]);

/** Request headers forwarded from the browser to the backend. */
const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "accept-language",
  // Correlation identifiers, so one browser interaction can be traced through the
  // gateway into a backend run.
  "x-request-id",
  "traceparent",
  "tracestate",
];

/** Response headers returned from the backend to the browser. */
const FORWARDED_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "cache-control",
  "x-request-id",
  "x-trace-id",
  "retry-after",
  "traceparent",
];

/**
 * Build the header set sent upstream to the backend.
 *
 * Nothing the browser sends is forwarded unless it appears in the allowlist. In
 * particular `cookie`, `authorization`, `host` and `origin` are dropped: the backend
 * contract defines no authentication, and forwarding credentials to a service that does
 * not expect them is how they end up in the wrong log.
 *
 * @param incoming - Headers of the browser request.
 * @param overrides - Values the caller sets explicitly, such as `accept` for a stream.
 *   These take precedence over anything forwarded.
 */
export function buildBackendHeaders(
  incoming: Headers,
  overrides: Readonly<Record<string, string>> = {},
): Headers {
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null && !HOP_BY_HOP_HEADERS.has(name)) {
      headers.set(name, value);
    }
  }

  for (const [name, value] of Object.entries(overrides)) {
    headers.set(name, value);
  }

  return headers;
}

/**
 * Build the header set returned to the browser.
 *
 * `cache-control: no-store` is forced on every proxied response. Conversation history and
 * run output are per-request state, and an intermediary caching either would show one user
 * another user's turn.
 */
export function buildClientHeaders(upstream: Headers): Headers {
  const headers = new Headers();

  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null && !HOP_BY_HOP_HEADERS.has(name)) {
      headers.set(name, value);
    }
  }

  headers.set("cache-control", "no-store");
  return headers;
}

/**
 * Build the header set for a streamed response.
 *
 * Beyond the ordinary response headers this disables proxy buffering. Without
 * `x-accel-buffering: no` an intermediary may hold the stream until it completes, which
 * turns an incremental answer into a single delayed block and defeats the entire
 * streaming interaction.
 */
export function buildStreamingClientHeaders(upstream: Headers): Headers {
  const headers = buildClientHeaders(upstream);
  headers.set("content-type", upstream.get("content-type") ?? "text/event-stream");
  headers.set("cache-control", "no-store, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set("connection", "keep-alive");
  return headers;
}

/** Test seam exposing the allowlists so a test can prove a header is not forwarded. */
export const __headerPolicy = {
  HOP_BY_HOP_HEADERS,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
} as const;
