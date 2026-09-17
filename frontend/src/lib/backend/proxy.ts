/**
 * The Node gateway.
 *
 * Every browser request reaches the Python backend through this module and nowhere else.
 * It exists for three reasons: the backend URL stays server-side, the browser makes only
 * same-origin requests so CORS never enters the picture, and transport policy — header
 * filtering, cancellation, caching — is applied in one place rather than at each call site.
 *
 * What this module does *not* do is as important as what it does. It performs no domain
 * transformation. A request body goes upstream byte for byte and a response body comes back
 * byte for byte. There is no engineering logic, no agent logic, no session persistence and
 * no interpretation of what any of it means.
 *
 * This module is server-only. It reads `BACKEND_BASE_URL`, which must never reach the
 * browser bundle, and the import guard below makes an accidental client import fail loudly
 * at build time rather than silently shipping the value.
 */

import "server-only";

import {
  buildBackendHeaders,
  buildClientHeaders,
  buildStreamingClientHeaders,
} from "@/lib/backend/headers";
import { assertSessionId } from "@/lib/session/ids";

/**
 * Backend paths this gateway is willing to call.
 *
 * The allowlist is the point. A generic `/api/proxy?url=…` would let any caller reach any
 * host the server can reach; here, the set of reachable upstream paths is fixed by this
 * function and a session identifier that has already been validated.
 */
export const BACKEND_ROUTES = {
  health: () => "/healthz",
  readiness: () => "/readyz",
  canvasCatalog: (offset: number) => `/v1/canvas/drawings?offset=${offset}&limit=100`,
  canvasSource: (kind: "graph" | "image" | "fusion", path: string) =>
    `/v1/canvas/${kind}/${encodeURIComponent(path)}`,
  responses: (sessionId: string) =>
    `/v1/sessions/${encodeURIComponent(sessionId)}/responses`,
  responsesStream: (sessionId: string) =>
    `/v1/sessions/${encodeURIComponent(sessionId)}/responses/stream`,
  items: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/items`,
  session: (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}`,
} as const;

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve the backend base URL from server configuration.
 *
 * In production a missing value is a startup error: defaulting to localhost there would
 * produce a service that looks healthy and answers nothing. In development the default
 * matches the backend's own default so `npm run dev` works with no configuration at all.
 *
 * @throws {Error} in production when `BACKEND_BASE_URL` is unset or unparseable.
 */
export function resolveBackendBaseUrl(): URL {
  const configured = process.env.BACKEND_BASE_URL?.trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "BACKEND_BASE_URL is not configured. Set it to the P&ID backend origin, " +
          "for example http://127.0.0.1:8000.",
      );
    }
    return new URL(DEFAULT_BACKEND_BASE_URL);
  }

  try {
    return new URL(configured);
  } catch {
    throw new Error(`BACKEND_BASE_URL is not a valid URL: ${configured}`);
  }
}

/** Connection timeout for non-streaming upstream calls, in milliseconds. */
export function resolveConnectTimeoutMs(): number {
  const raw = Number(process.env.BACKEND_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

/** Build the absolute upstream URL for an allowlisted backend path. */
function upstreamUrl(backendPath: string): URL {
  const base = resolveBackendBaseUrl();
  // Join without letting a leading slash discard a base path prefix, so a backend mounted
  // under a sub-path still works.
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const url = new URL(base);
  const target = new URL(backendPath, "http://gateway.invalid");
  url.pathname = `${basePath}${target.pathname}`;
  url.search = target.search;
  return url;
}

/** Shape of a gateway failure, rendered as the same minimal error body the backend uses. */
function gatewayErrorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Forward one request upstream and return the backend's response.
 *
 * The response body is passed through as a stream. It is never buffered, which is what
 * makes an incremental answer incremental: buffering here would turn the streaming
 * endpoint into a slow non-streaming one without any error to explain why.
 *
 * Cancellation propagates. When the browser aborts, `request.signal` fires, the upstream
 * fetch is cancelled, the backend observes the disconnect, and it releases the run's
 * session lock and admission slot. The Stop button is therefore an execution-control
 * action, not a way of hiding output that keeps being generated.
 *
 * @param request - The incoming browser request.
 * @param backendPath - An allowlisted path from {@link BACKEND_ROUTES}.
 * @param options.streaming - Apply streaming response headers and disable proxy buffering.
 * @param options.timeoutMs - Abort a non-streaming call after this long. Streaming calls
 *   are not given a client-side timeout: the run deadline is the backend's to enforce, and
 *   a long analysis is not a stalled connection.
 */
export async function proxyBackend(
  request: Request,
  backendPath: string,
  options: { streaming?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  const { streaming = false } = options;
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let target: URL;
  try {
    target = upstreamUrl(backendPath);
  } catch (error) {
    // A configuration fault, not a client fault. Report it as such and log it for the
    // operator; the message never reaches the browser.
    console.error("[gateway] backend URL misconfigured:", (error as Error).message);
    return gatewayErrorResponse(
      500,
      "internal_error",
      "The frontend gateway is not configured to reach the backend.",
    );
  }

  const headers = buildBackendHeaders(
    request.headers,
    streaming ? { accept: "text/event-stream" } : {},
  );

  const signal = streaming
    ? request.signal
    : composeSignals(request.signal, options.timeoutMs ?? resolveConnectTimeoutMs());

  const startedAt = Date.now();

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await request.text() : undefined,
      signal,
      cache: "no-store",
      redirect: "manual",
      // Node's fetch requires this when a body is present on some runtimes; it is inert
      // otherwise.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);

    logProxy(method, backendPath, upstream.status, Date.now() - startedAt, streaming);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: streaming
        ? buildStreamingClientHeaders(upstream.headers)
        : buildClientHeaders(upstream.headers),
    });
  } catch (error) {
    if (request.signal.aborted) {
      // The browser went away. There is no one left to answer, and this is the normal
      // outcome of pressing Stop, so it is not logged as a failure.
      return new Response(null, { status: 499, headers: { "cache-control": "no-store" } });
    }

    const message = error instanceof Error ? error.message : String(error);
    logProxy(method, backendPath, 0, Date.now() - startedAt, streaming, message);

    return gatewayErrorResponse(
      503,
      "upstream_unavailable",
      "The P&ID backend could not be reached.",
    );
  }
}

/**
 * Forward a request addressed to one session, validating the identifier first.
 *
 * Validation happens before anything is sent, so a hostile identifier never reaches the
 * network. It duplicates the backend's own check deliberately: a path traversal attempt
 * should be refused at the first boundary that can recognise it.
 */
export async function proxySessionRequest(
  request: Request,
  sessionId: string,
  route: (id: string) => string,
  options: { streaming?: boolean } = {},
): Promise<Response> {
  let validated: string;
  try {
    validated = assertSessionId(sessionId);
  } catch {
    return gatewayErrorResponse(
      400,
      "invalid_session_id",
      "Session id must be 1-128 characters of letters, digits, '.', '_' or '-'.",
    );
  }
  return proxyBackend(request, route(validated), options);
}

/**
 * Combine the request's abort signal with a timeout.
 *
 * `AbortSignal.any` is used where available; the manual fallback keeps the gateway working
 * on runtimes that predate it.
 */
function composeSignals(requestSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([requestSignal, timeout]);
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/**
 * Record one forwarded request.
 *
 * Identifiers, status, duration and direction only. Request and response bodies carry the
 * user's question, the model's answer and corpus content, and none of that is logged.
 */
function logProxy(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  streaming: boolean,
  errorMessage?: string,
): void {
  if (process.env.FRONTEND_LOG_LEVEL === "silent") {
    return;
  }
  const outcome = errorMessage ? `error=${errorMessage}` : `status=${status}`;
  const line = `[gateway] ${method} ${path} ${outcome} duration_ms=${durationMs}${
    streaming ? " streaming=true" : ""
  }`;
  if (errorMessage || status >= 500) {
    console.error(line);
  } else if (process.env.FRONTEND_LOG_LEVEL === "debug") {
    // Debug-level proxy tracing is opt-in and carries identifiers only, never bodies.
    console.warn(line);
  }
}
