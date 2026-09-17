/**
 * Session identifier generation and validation.
 *
 * A session identifier is an opaque key into the backend's session store. It is never a
 * filesystem path and never part of a SQL statement, but it does travel from the browser
 * through a Node route handler and into a backend URL path, so it is validated on both
 * sides of that boundary.
 *
 * The accepted shape matches the backend's own policy exactly. Keeping the two in step is
 * what lets the gateway reject a hostile value before it reaches the network rather than
 * relying on the backend to reject it afterwards.
 */

/**
 * Accepted session identifier shape: 1 to 128 characters of letters, digits, `.`, `_` or
 * `-`, beginning with a letter or digit.
 *
 * This deliberately excludes path separators, `..`, quotes, whitespace and control
 * characters.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const SESSION_ID_MAX_LENGTH = 128;

/** Raised when a supplied session identifier does not satisfy {@link SESSION_ID_PATTERN}. */
export class InvalidSessionIdError extends Error {
  public override readonly name = "InvalidSessionIdError";

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Report whether a value is an acceptable session identifier.
 *
 * Use this for branching. Use {@link assertSessionId} where an unacceptable value should
 * stop the operation.
 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * Return the identifier unchanged, or throw when it is unacceptable.
 *
 * @throws {InvalidSessionIdError} when the value is not a conforming identifier.
 */
export function assertSessionId(value: unknown): string {
  if (!isValidSessionId(value)) {
    throw new InvalidSessionIdError(
      "Session id must be 1-128 characters of letters, digits, '.', '_' or '-', " +
        "and must start with a letter or digit.",
    );
  }
  return value;
}

/**
 * Generate a new session identifier.
 *
 * Prefers `crypto.randomUUID`. The fallback exists for older or restricted environments
 * where that is unavailable — an insecure context, for instance — and draws from
 * `crypto.getRandomValues` so the identifier is still unpredictable. Both forms satisfy
 * {@link SESSION_ID_PATTERN}.
 */
export function createSessionId(): string {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `s-${hex}`;
}

/**
 * Shorten an identifier for display, keeping both ends so two sessions stay distinguishable.
 *
 * Display only. The full identifier is what is sent to the backend and what the copy
 * action puts on the clipboard.
 */
export function shortenSessionId(sessionId: string, visible = 6): string {
  if (sessionId.length <= visible * 2 + 1) {
    return sessionId;
  }
  return `${sessionId.slice(0, visible)}…${sessionId.slice(-4)}`;
}
