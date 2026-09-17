/**
 * URL safety for model-authored content.
 *
 * Assistant output is untrusted. Markdown is rendered with raw HTML disabled, which stops
 * script injection through tags, but a link href is still attacker-controlled text: a
 * `javascript:` URL in a Markdown link executes on click in an unguarded renderer.
 *
 * So every href and image src passes through here, and anything that is not plainly safe
 * becomes no link at all rather than a link to somewhere unexpected.
 */

/** Schemes a link may use. Everything else is rejected, including `javascript:` and `data:`. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * Report whether a string contains a C0 or DEL control character.
 *
 * Checked by code point rather than by a regex with escaped ranges, because a literal
 * control character in a source file is easy to mangle and hard to review. Control
 * characters matter here because `java\nscript:alert(1)` can slip past a scheme check that
 * only looks at the leading text.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Return a safe href, or `null` when the value cannot be trusted.
 *
 * Relative and fragment links are allowed: they stay inside this origin, and the router
 * governs where they go. A scheme-relative URL (`//host/path`) is rejected even though it
 * begins with a slash, because it inherits the current scheme and can point at any host.
 *
 * A corpus path such as `area_100/PID-100.png` is deliberately *not* turned into a link.
 * The backend exposes no file-serving route, so any URL built from it would 404 at best
 * and, at worst, point somewhere that is not the artifact the answer meant.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || hasControlCharacter(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("//")) {
    return null;
  }

  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return trimmed;
  }

  // Everything else must carry an explicit scheme, which is then checked against the
  // allowlist. Without this requirement a bare relative value resolves happily against any
  // base URL and is allowed through — so a corpus path such as `area_100/PID-100.png`
  // would become a link, resolved against the current session route, pointing at nothing.
  // Corpus paths require an explicit, validated canvas source URL; bare paths are references.
  if (!HAS_SCHEME.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return SAFE_SCHEMES.has(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

/** A URL that begins with an explicit scheme, per RFC 3986. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Attributes for an external link.
 *
 * `noopener` denies the opened page access to `window.opener`; `noreferrer` also withholds
 * the referrer. Both are applied to anything leaving this origin.
 */
export function externalLinkAttributes(href: string): {
  target?: "_blank";
  rel?: string;
} {
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./")) {
    return {};
  }
  return { target: "_blank", rel: "noopener noreferrer" };
}

/**
 * Collapse whitespace and bound a string for display in a single-line control.
 *
 * Applied to model- and user-authored text that appears in a title, a tab or a button,
 * where an embedded newline would break the layout.
 */
export function toSingleLine(value: string, maxLength = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}
