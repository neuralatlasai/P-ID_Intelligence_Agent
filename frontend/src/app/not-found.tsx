import Link from "next/link";

/**
 * The not-found page.
 *
 * Reached mainly by a malformed session address. It offers the one useful action rather
 * than a dead end.
 */
export default function NotFound() {
  return (
    <div className="appFrame">
      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          justifyItems: "start",
          padding: "var(--space-8)",
          maxInlineSize: "60ch",
        }}
      >
        <h1 style={{ fontSize: "var(--text-xl)" }}>Session address not found</h1>
        <p style={{ color: "var(--text-secondary)", lineHeight: "var(--leading-relaxed)" }}>
          A session address is 1 to 128 characters of letters, digits, dots, underscores or
          hyphens. This one is not, so there is nothing to open.
        </p>
        <Link href="/" style={{ color: "var(--text-link)" }}>
          Start a new session
        </Link>
      </div>
    </div>
  );
}
